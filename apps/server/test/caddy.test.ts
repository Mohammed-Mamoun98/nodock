import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import type { GitHubClient } from '../src/auth/github';
import type { CaddyAdmin } from '../src/caddy/admin';
import { assertSafeHost, assertSafeUpstream, hostsIn, renderCaddyfile } from '../src/caddy/render';
import {
  allowedHosts,
  buildRoutes,
  reconcileCaddy,
  reconcileWithRetry,
} from '../src/caddy/service';
import { loadConfig } from '../src/config';
import { deployments, environments, projects, serviceEnvs, services } from '../src/db/schema';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const github: GitHubClient = {
  authorizeUrl: () => 'https://github.com/login/oauth/authorize',
  exchangeCode: async () => ({ accessToken: 'x', scopes: ['repo', 'workflow'] }),
  getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
  listRepos: async () => ({ repos: [], hasMore: false }),
  listBranches: async () => [],
};

function fakeAdmin(result: { ok: boolean } = { ok: true }) {
  const loads: string[] = [];
  const admin: CaddyAdmin = {
    async load(rendered) {
      loads.push(rendered);
      if (!result.ok) throw new Error('caddy is down');
    },
  };
  return { admin, loads };
}

/** Seeds a project, one service per host (UNIQUE(service_id, environment_id)). */
function seed(db: ReturnType<typeof testDb>['db'], hosts: string[], containerName?: string) {
  const project = db.insert(projects).values({ name: 'Milo', slug: 'milo' }).returning().get();
  const env = db
    .insert(environments)
    .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
    .returning()
    .get();

  const links = hosts.map((host, index) => {
    const service = db
      .insert(services)
      .values({
        projectId: project.id,
        name: `api-${index}`,
        slug: `api-${index}`,
        repoFullName: 'mohammed/milo',
        containerPort: 8080,
      })
      .returning()
      .get();

    return db
      .insert(serviceEnvs)
      .values({ serviceId: service.id, environmentId: env.id, branch: 'main', generatedHost: host })
      .returning()
      .get();
  });

  if (containerName && links[0]) {
    db.insert(deployments)
      .values({
        serviceEnvId: links[0].id,
        trigger: 'push',
        status: 'live',
        imageRef: 'ghcr.io/mohammed/milo:abc',
        containerName,
      })
      .run();
  }

  return { links };
}

describe('render', () => {
  test('renders the dashboard, sorted service routes, and an http-only fallback', () => {
    const rendered = renderCaddyfile({
      dashboardHost: 'panel.example.com',
      routes: [
        { host: 'web.apps.example.com', upstream: 'nodock-web:3000' },
        { host: 'api.apps.example.com', upstream: 'nodock-api:8080' },
      ],
    });

    expect(rendered).toContain('panel.example.com {');
    expect(rendered.indexOf('api.apps.example.com')).toBeLessThan(
      rendered.indexOf('web.apps.example.com'),
    );
    expect(rendered).toContain('\ttls {\n\t\ton_demand\n\t}');
    expect(rendered).toContain('reverse_proxy nodock-api:8080');
    expect(rendered).toContain('encode zstd gzip');
    expect(rendered).toContain('on_demand_tls');
    // /load replaces the whole config: dropping this locks nodock out of Caddy.
    expect(rendered).toContain('admin 0.0.0.0:2019');
    expect(rendered).toContain(':80 {');
    expect(rendered).not.toContain(':443 {');
    expect(hostsIn(rendered)).toEqual([
      'panel.example.com',
      'api.apps.example.com',
      'web.apps.example.com',
    ]);
  });

  test('de-duplicates hosts and keeps the dashboard owner', () => {
    const rendered = renderCaddyfile({
      dashboardHost: 'panel.example.com',
      routes: [
        { host: 'panel.example.com', upstream: 'evil:3000' },
        { host: 'api.apps.example.com', upstream: 'a:3000' },
        { host: 'api.apps.example.com', upstream: 'b:3000' },
      ],
    });

    expect(rendered.match(/panel\.example\.com \{/g)).toHaveLength(1);
    expect(rendered).not.toContain('evil:3000');
    expect(rendered.match(/api\.apps\.example\.com \{/g)).toHaveLength(1);
  });

  test('refuses config injection through a host or upstream', () => {
    expect(() => assertSafeHost('api.apps.example.com {\n\trespond "pwned"')).toThrow(
      /unsafe host/,
    );
    expect(() => assertSafeHost('api.example.com\n}\n:80')).toThrow(/unsafe host/);
    expect(() => assertSafeUpstream('nodock:3000 {\n\trespond 200')).toThrow(/unsafe upstream/);
    expect(() => assertSafeUpstream('nodock:99999')).toThrow(/out-of-range/);
    expect(() =>
      renderCaddyfile({
        dashboardHost: 'panel.example.com',
        routes: [{ host: 'a b', upstream: 'x:1' }],
      }),
    ).toThrow();
  });
});

describe('routes', () => {
  test('only live deployments with a container produce a route', () => {
    const { db } = testDb();
    seed(db, ['api.apps.example.com', 'api-staging.apps.example.com'], 'nodock-api-1');

    const routes = buildRoutes(db);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({ host: 'api.apps.example.com', upstream: 'nodock-api-1:8080' });
  });

  test('allowedHosts includes the panel, generated hosts and custom domains', () => {
    const { db } = testDb();
    const { links } = seed(db, ['api.apps.example.com']);
    if (links[0]) {
      db.update(serviceEnvs)
        .set({ customDomain: 'app.customer.dev' })
        .where(eq(serviceEnvs.id, links[0].id))
        .run();
    }

    const hosts = allowedHosts(db, config);
    expect(hosts.has('panel.example.com')).toBe(true);
    expect(hosts.has('api.apps.example.com')).toBe(true);
    expect(hosts.has('app.customer.dev')).toBe(true);
    expect(hosts.has('evil.example.com')).toBe(false);
  });
});

async function ask(host: string) {
  const { db } = testDb();
  seed(db, ['api.apps.example.com']);
  const app = createApp({ config, db, github });
  return app.request(`/internal/caddy/ask?domain=${encodeURIComponent(host)}`);
}

describe('ask endpoint', () => {
  test('allows known hosts and the panel host without a session', async () => {
    expect((await ask('api.apps.example.com')).status).toBe(200);
    expect((await ask('API.apps.example.com')).status).toBe(200);
    expect((await ask('panel.example.com')).status).toBe(200);
  });

  test('refuses unknown hosts, including lookalikes', async () => {
    expect((await ask('evil.example.com')).status).toBe(403);
    expect((await ask('api.apps.example.com.evil.dev')).status).toBe(403);
    expect((await ask('')).status).toBe(400);
  });
});

describe('reconcile', () => {
  test('loads the rendered config once and reports host count', async () => {
    const { db } = testDb();
    seed(db, ['api.apps.example.com'], 'nodock-api-1');
    const { admin, loads } = fakeAdmin();

    const result = await reconcileCaddy({ config, db, admin });

    expect(result).toEqual({ ok: true, hosts: 2 });
    expect(loads).toHaveLength(1);
    expect(loads[0]).toContain('reverse_proxy nodock-api-1:8080');
    expect(loads[0]).toContain('panel.example.com');
  });

  test('reports Caddy failures without throwing', async () => {
    const { db } = testDb();
    const { admin } = fakeAdmin({ ok: false });

    const result = await reconcileCaddy({ config, db, admin });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('caddy is down');
  });

  test('retries while Caddy is still starting', async () => {
    const { db } = testDb();
    let attempts = 0;
    const admin: CaddyAdmin = {
      async load() {
        attempts += 1;
        if (attempts < 3) throw new Error('connection refused');
      },
    };

    const result = await reconcileWithRetry({ config, db, admin }, 5, 1);
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

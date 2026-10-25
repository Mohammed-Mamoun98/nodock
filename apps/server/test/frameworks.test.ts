/* oxlint-disable unicorn/consistent-function-scoping -- each seed helper sits next to the describe it serves */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { decrypt, deriveKey, encrypt } from '../src/auth/crypto';
import type { GitHubClient } from '../src/auth/github';
import { SESSION_COOKIE } from '../src/auth/sessions';
import type { CaddyAdmin } from '../src/caddy/admin';
import { renderCaddyfile } from '../src/caddy/render';
import { buildRoutes } from '../src/caddy/service';
import { renderWorkflow } from '../src/ci/workflow';
import { loadConfig } from '../src/config';
import {
  deployments,
  environments,
  projects,
  repoHooks,
  serviceEnvs,
  services,
  variables,
} from '../src/db/schema';
import { extractArtifact, parseListing, writeUpload } from '../src/deploy/artifact';
import { runDeployment } from '../src/deploy/pipeline';
import { sweepRuntime } from '../src/deploy/runtime';
import type { DockerAdapter } from '../src/docker/adapter';
import { testDb } from './helpers';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'nodock-frameworks-'));
}

const configFor = (dir: string, extra: Record<string, string> = {}) =>
  loadConfig({
    NODOCK_SECRET: 'x'.repeat(32),
    NODOCK_URL: 'https://panel.example.com',
    BASE_DOMAIN: 'apps.example.com',
    DATA_DIR: dir,
    ADMIN_GITHUB_LOGIN: 'mohammed',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    ...extra,
  });

/** A real tarball, built the way the workflow builds one. */
function tarball(
  options: {
    files?: Record<string, string>;
    symlink?: string;
    transform?: string;
  } = {},
): string {
  const staging = mkdtempSync(join(tmpdir(), 'nodock-staging-'));
  const files = options.files ?? { 'index.html': '<h1>hi</h1>', 'assets/app.js': 'console.log(1)' };

  for (const [name, body] of Object.entries(files)) {
    const path = join(staging, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  if (options.symlink) symlinkSync(options.symlink, join(staging, 'link'));

  // Outside the directory being archived: a tarball written into its own input is
  // a moving target, and tar says so ("file changed as we read it").
  const out = join(mkdtempSync(join(tmpdir(), 'nodock-tar-')), 'site.tar.gz');
  const args = ['-czf', out, '-C', staging];
  if (options.transform) args.push(`--transform=${options.transform}`);
  args.push('.');

  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return out;
}

describe('artifact uploads', () => {
  test('the tar listing is parsed into type, size and name', () => {
    const listing = [
      'drwxr-xr-x 0/0               0 2026-10-25 20:36 ./',
      '-rw-r--r-- 0/0              12 2026-10-25 20:36 ./index.html',
      'lrwxrwxrwx 0/0               0 2026-10-25 20:36 ./link -> /etc/passwd',
      '-rw-r--r-- root root         2 2026-10-25 20:36 ./assets/app.js',
    ].join('\n');

    expect(parseListing(listing)).toEqual([
      { type: 'd', size: 0, name: './' },
      { type: '-', size: 12, name: './index.html' },
      { type: 'l', size: 0, name: './link -> /etc/passwd' },
      { type: '-', size: 2, name: './assets/app.js' },
    ]);
    // A format we cannot read is rejected, not guessed at.
    expect(parseListing('some other tar --list format')).toBeNull();
  });

  test('a normal tarball is extracted into its own directory', () => {
    const dir = dataDir();
    const result = extractArtifact({
      dataDir: dir,
      uploadsDir: join(dir, 'uploads'),
      artifactsDir: join(dir, 'artifacts'),
      deploymentId: '11111111-1111-1111-1111-111111111111',
      tarballPath: tarball(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactPath).toBe('artifacts/11111111-1111-1111-1111-111111111111/site');
    expect(readFileSync(join(dir, result.artifactPath, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(existsSync(join(dir, result.artifactPath, 'assets/app.js'))).toBe(true);
  });

  test('a path that climbs out of the site is refused, and nothing is written', () => {
    const dir = dataDir();
    const result = extractArtifact({
      dataDir: dir,
      uploadsDir: join(dir, 'uploads'),
      artifactsDir: join(dir, 'artifacts'),
      deploymentId: '22222222-2222-2222-2222-222222222222',
      tarballPath: tarball({ transform: 's,^\\./,,' }),
    });
    // The transform above is a no-op; this one is the hostile entry.
    const hostile = tarball({ transform: 's,^\\./index\\.html$,../escape,' });

    expect(result.ok).toBe(true);
    const escaped = extractArtifact({
      dataDir: dir,
      uploadsDir: join(dir, 'uploads'),
      artifactsDir: join(dir, 'artifacts'),
      deploymentId: '33333333-3333-3333-3333-333333333333',
      tarballPath: hostile,
    });

    if (escaped.ok) throw new Error('a parent-relative entry was accepted');
    expect(escaped.code).toBe('artifact_unsafe_entry');
    expect(existsSync(join(dir, 'artifacts', '33333333-3333-3333-3333-333333333333'))).toBe(false);
  });

  test('a symlink is refused', () => {
    const dir = dataDir();
    const result = extractArtifact({
      dataDir: dir,
      uploadsDir: join(dir, 'uploads'),
      artifactsDir: join(dir, 'artifacts'),
      deploymentId: '44444444-4444-4444-4444-444444444444',
      tarballPath: tarball({ symlink: '/etc/passwd' }),
    });

    if (result.ok) throw new Error('a symlink was accepted');
    expect(result.code).toBe('artifact_symlink');
  });

  test('the byte cap is enforced while reading, not after', async () => {
    const dir = dataDir();
    const path = join(dir, 'uploads', 'x.tar.gz');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });

    const written = await writeUpload(body, path, 1024);
    expect(written.ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe('runtime', () => {
  test('an artifact deployment is never inspected: it has no container', async () => {
    const dir = dataDir();
    const { db } = testDb();
    const project = db.insert(projects).values({ name: 'S', slug: 's' }).returning().get();
    const env = db
      .insert(environments)
      .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
      .returning()
      .get();
    const service = db
      .insert(services)
      .values({ projectId: project.id, name: 's', slug: 's', repoFullName: 'a/b' })
      .returning()
      .get();
    const serviceEnv = db
      .insert(serviceEnvs)
      .values({
        serviceId: service.id,
        environmentId: env.id,
        branch: 'main',
        generatedHost: 's.example.com',
      })
      .returning()
      .get();
    db.insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'live',
        mode: 'artifact',
        imageRef: 'ghcr.io/a/b:s-abc',
        artifactPath: `artifacts/${'99999999-9999-9999-9999-999999999999'}/site`,
      })
      .run();

    const inspected: string[] = [];
    const result = await sweepRuntime(db, {
      inspect: async (name) => {
        inspected.push(name);
        return { running: true, exitCode: 0, status: 'running' };
      },
    });

    expect(result.checked).toBe(0);
    expect(inspected).toEqual([]);
    void dir;
  });
});

describe('caddy', () => {
  const base = {
    dashboardHost: 'panel.example.com',
    askUrl: 'http://nodock:3000/internal/caddy/ask',
  };

  test('a static route serves a directory, with the SPA fallback and its own 404', () => {
    const config = renderCaddyfile({
      ...base,
      routes: [
        {
          host: 'app.example.com',
          root: '/srv/artifacts/11111111-1111-1111-1111-111111111111/site',
          spaFallback: true,
          notFound: true,
        },
      ],
    });

    expect(config).toContain('root * /srv/artifacts/11111111-1111-1111-1111-111111111111/site');
    expect(config).toContain('try_files {path} {path}/ /index.html');
    expect(config).toContain('file_server');
    expect(config).toContain('handle_errors {');
    expect(config).toContain('rewrite * /404.html');
  });

  test('an SPA fallback can be off: Astro and a Next export are not single pages', () => {
    const config = renderCaddyfile({
      ...base,
      routes: [
        {
          host: 'app.example.com',
          root: '/srv/artifacts/11111111-1111-1111-1111-111111111111/site',
        },
      ],
    });

    expect(config).not.toContain('try_files');
    expect(config).not.toContain('handle_errors');
  });

  test('a root outside the artifacts volume is not rendered at all', () => {
    for (const root of ['/etc', '/srv/artifacts/../../etc', '/srv/artifacts/not-a-uuid/site']) {
      expect(() =>
        renderCaddyfile({ ...base, routes: [{ host: 'app.example.com', root }] }),
      ).toThrow();
    }
  });

  test('a static health check is a file_server probe, not a proxy', () => {
    const config = renderCaddyfile({
      ...base,
      routes: [],
      probes: [
        {
          id: '55555555-5555-5555-5555-555555555555',
          root: '/srv/artifacts/55555555-5555-5555-5555-555555555555/site',
        },
      ],
    });

    expect(config).toContain('handle_path /probe/55555555-5555-5555-5555-555555555555/*');
    expect(config).toContain('file_server');
  });
});

describe('routes from artifacts', () => {
  function seedStatic(db: ReturnType<typeof testDb>['db'], dir: string) {
    const project = db.insert(projects).values({ name: 'Milo', slug: 'milo' }).returning().get();
    const env = db
      .insert(environments)
      .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
      .returning()
      .get();
    const service = db
      .insert(services)
      .values({
        projectId: project.id,
        name: 'site',
        slug: 'site',
        repoFullName: 'mohammed/site',
        strategy: 'static',
        spaFallback: true,
      })
      .returning()
      .get();
    const serviceEnv = db
      .insert(serviceEnvs)
      .values({
        serviceId: service.id,
        environmentId: env.id,
        branch: 'main',
        generatedHost: 'site.apps.example.com',
      })
      .returning()
      .get();

    const deployment = db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'live',
        mode: 'artifact',
        imageRef: 'ghcr.io/mohammed/site:site-abc',
        artifactPath: `artifacts/${'66666666-6666-6666-6666-666666666666'}/site`,
      })
      .returning()
      .get();

    mkdirSync(join(dir, 'artifacts', '66666666-6666-6666-6666-666666666666', 'site'), {
      recursive: true,
    });
    writeFileSync(
      join(dir, 'artifacts', '66666666-6666-6666-6666-666666666666', 'site', '404.html'),
      'not found',
    );

    return { service, serviceEnv, deployment };
  }

  test('a live artifact deployment becomes a root route, not an upstream', () => {
    const dir = dataDir();
    const { db } = testDb();
    seedStatic(db, dir);

    const routes = buildRoutes(db, { artifactsDir: join(dir, 'artifacts') });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.upstream).toBeUndefined();
    expect(routes[0]?.root).toBe('/srv/artifacts/66666666-6666-6666-6666-666666666666/site');
    expect(routes[0]?.spaFallback).toBe(true);
    expect(routes[0]?.notFound).toBe(true);
  });

  test('a pending static switch replaces the route with the new root', () => {
    const dir = dataDir();
    const { db } = testDb();
    seedStatic(db, dir);

    const routes = buildRoutes(db, {
      artifactsDir: join(dir, 'artifacts'),
      pending: {
        host: 'site.apps.example.com',
        root: '/srv/artifacts/77777777-7777-7777-7777-777777777777/site',
      },
    });

    expect(routes[0]?.root).toBe('/srv/artifacts/77777777-7777-7777-7777-777777777777/site');
    // No failover container: files cannot take over for each other.
    expect(routes[0]?.previous).toBeUndefined();
  });
});

describe('the artifact pipeline', () => {
  function seed(db: ReturnType<typeof testDb>['db'], dir: string, withFiles: boolean) {
    const project = db.insert(projects).values({ name: 'Milo', slug: 'milo' }).returning().get();
    const env = db
      .insert(environments)
      .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
      .returning()
      .get();
    const service = db
      .insert(services)
      .values({
        projectId: project.id,
        name: 'site',
        slug: 'site',
        repoFullName: 'mohammed/site',
        strategy: 'static',
        spaFallback: true,
      })
      .returning()
      .get();
    const serviceEnv = db
      .insert(serviceEnvs)
      .values({
        serviceId: service.id,
        environmentId: env.id,
        branch: 'main',
        generatedHost: 'site.apps.example.com',
      })
      .returning()
      .get();

    const previous = db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'live',
        mode: 'artifact',
        imageRef: 'ghcr.io/mohammed/site:site-old',
        artifactPath: `artifacts/${'88888888-8888-8888-8888-888888888888'}/site`,
      })
      .returning()
      .get();

    const deployment = db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'queued',
        mode: 'artifact',
        imageRef: 'ghcr.io/mohammed/site:site-new',
        artifactPath: 'artifacts/PLACEHOLDER/site',
        commitSha: 'abc123',
      })
      .returning()
      .get();

    const site = join(dir, 'artifacts', deployment.id, 'site');
    if (withFiles) {
      mkdirSync(site, { recursive: true });
      writeFileSync(join(site, 'index.html'), '<h1>new</h1>');
    }

    db.update(deployments)
      .set({ artifactPath: `artifacts/${deployment.id}/site` })
      .where(eq(deployments.id, deployment.id))
      .run();

    return { service, serviceEnv, deployment, previous };
  }

  function fakeDocker() {
    const calls: string[] = [];
    const docker: DockerAdapter = {
      async pull() {
        calls.push('pull');
        return { ok: true };
      },
      async run() {
        calls.push('run');
        return { id: 'x' };
      },
      async inspect() {
        return { running: true, exitCode: 0, status: 'running' };
      },
      async stop() {
        calls.push('stop');
      },
      async remove() {
        calls.push('remove');
      },
    };
    return { docker, calls };
  }

  function fakeAdmin(ok = true) {
    const loads: string[] = [];
    const admin: CaddyAdmin = {
      async load(rendered) {
        loads.push(rendered);
        if (!ok) throw new Error('caddy rejected');
      },
    };
    return { admin, loads };
  }

  test('a static deploy switches the route without touching docker', async () => {
    const dir = dataDir();
    const { db } = testDb();
    const { deployment } = seed(db, dir, true);
    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();

    const outcome = await runDeployment(
      { config: configFor(dir), db, docker, admin },
      deployment.id,
    );

    expect(outcome).toBe('live');
    expect(calls).toEqual([]);

    const row = db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
    expect(row?.status).toBe('live');
    // No container, so nothing for the runtime watchdog to inspect later.
    expect(row?.containerName).toBeNull();
    expect(row?.runtimeState).toBeNull();

    const last = loads[loads.length - 1] ?? '';
    expect(last).toContain(`root * /srv/artifacts/${deployment.id}/site`);
  });

  test('a missing artifact fails without touching the live route', async () => {
    const dir = dataDir();
    const { db } = testDb();
    const { deployment } = seed(db, dir, false);
    const { docker } = fakeDocker();
    const { admin, loads } = fakeAdmin();

    const outcome = await runDeployment(
      { config: configFor(dir), db, docker, admin },
      deployment.id,
    );

    expect(outcome).toBe('failed');
    expect(loads).toHaveLength(0);

    const row = db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
    expect(row?.error).toContain('no artifact to serve');
  });

  test('a static deploy is probed through Caddy when a probe URL exists', async () => {
    const dir = dataDir();
    const { db } = testDb();
    const { deployment } = seed(db, dir, true);
    const { docker } = fakeDocker();
    const { admin, loads } = fakeAdmin();
    const probed: string[] = [];

    const outcome = await runDeployment(
      {
        config: configFor(dir, { CADDY_PROBE_URL: 'http://caddy:8099' }),
        db,
        docker,
        admin,
        health: async (url) => {
          probed.push(url);
          return true;
        },
      },
      deployment.id,
    );

    expect(outcome).toBe('live');
    expect(probed).toEqual([`http://caddy:8099/probe/${deployment.id}/index.html`]);
    expect(loads[0]).toContain(`handle_path /probe/${deployment.id}/*`);
  });
});

// ---------------------------------------------------------------------------
// The CI side: what the workflow is allowed to ask for, and what it may send.
// ---------------------------------------------------------------------------

const ciConfig = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  DATA_DIR: '/tmp/nodock-frameworks-ci',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const TOKEN = 'ci-token-for-tests';

function githubClient(dispatches: { payload: Record<string, string> }[] = []): GitHubClient {
  return {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho_admin', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async () => ({ repos: [], hasMore: false }),
    listBranches: async () => ['main'],
    getRepo: async () => ({ fullName: 'mohammed/site', defaultBranch: 'main', private: false }),
    getBranchHead: async () => 'a3f9c21deadbeef',
    getFile: async () => ({ sha: 'blob-1', content: renderWorkflow(ciConfig.url) }),
    putFile: async () => ({ commitSha: 'c', contentSha: 's' }),
    putActionsSecret: async () => {},
    createWebhook: async () => ({ id: 1 }),
    dispatchBuild: async (_token, _repo, _event, payload) => {
      dispatches.push({ payload });
    },
  };
}

async function signedIn(
  db: ReturnType<typeof testDb>['db'],
  github: GitHubClient,
  options: { docker?: DockerAdapter; admin?: CaddyAdmin | null; config?: typeof ciConfig } = {},
) {
  const app = createApp({ config: ciConfig, ...options, db, github });

  const start = await app.request('/auth/github');
  const state = decodeURIComponent(
    start.headers
      .getSetCookie()
      .find((c) => c.startsWith('nodock_oauth_state='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  );
  const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `nodock_oauth_state=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${decodeURIComponent(
    callback.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  )}`;

  return {
    app,
    call: (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          cookie,
          origin: 'https://panel.example.com',
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    token: (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
  };
}

function seedCi(db: ReturnType<typeof testDb>['db'], strategy: string, workflowVersion = 2) {
  const project = db.insert(projects).values({ name: 'Site', slug: 'site' }).returning().get();
  const env = db
    .insert(environments)
    .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
    .returning()
    .get();
  const service = db
    .insert(services)
    .values({
      projectId: project.id,
      name: 'site',
      slug: 'site',
      repoFullName: 'mohammed/site',
      strategy: strategy as 'static',
      outputDir: strategy === 'static' ? 'dist' : null,
    })
    .returning()
    .get();
  const serviceEnv = db
    .insert(serviceEnvs)
    .values({
      serviceId: service.id,
      environmentId: env.id,
      branch: 'main',
      generatedHost: 'site.apps.example.com',
    })
    .returning()
    .get();

  db.insert(repoHooks)
    .values({
      repoFullName: 'mohammed/site',
      webhookSecretEnc: encrypt('secret', deriveKey(ciConfig.secret)),
      ciTokenHash: sha256(TOKEN),
      workflowVersion,
      ciEnabledAt: new Date(),
    })
    .run();

  const deployment = db
    .insert(deployments)
    .values({
      serviceEnvId: serviceEnv.id,
      trigger: 'push',
      status: 'queued',
      imageRef: 'ghcr.io/mohammed/site:site-abc',
    })
    .returning()
    .get();

  return { project, env, service, serviceEnv, deployment };
}

describe('CI: build-time variables', () => {
  test('only name-matched variables travel to the build', async () => {
    const { db } = testDb();
    const { serviceEnv } = seedCi(db, 'next');
    const key = deriveKey(ciConfig.secret);

    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_API_URL: 'https://api.example.com',
      VITE_FLAG: '1',
      DATABASE_URL: 'postgres://secret',
    })) {
      db.insert(variables)
        .values({ serviceEnvId: serviceEnv.id, key: name, valueEnc: encrypt(value, key) })
        .run();
    }

    const { token } = await signedIn(db, githubClient());
    const build = db.select().from(deployments).get();
    const response = await token(`/api/ci/build-env?buildId=${build?.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      vars: { NEXT_PUBLIC_API_URL: 'https://api.example.com', VITE_FLAG: '1' },
    });
    // The value is decryptable, which is what the test is really asserting.
    expect(
      decrypt(
        db.select().from(variables).where(eq(variables.key, 'DATABASE_URL')).get()!.valueEnc,
        key,
      ),
    ).toBe('postgres://secret');
  });

  test('no token, or a token for another repo, gets nothing', async () => {
    const { db } = testDb();
    seedCi(db, 'next');
    const build = db.select().from(deployments).get();

    const { app } = await signedIn(db, githubClient());
    const anonymous = await app.request(`/api/ci/build-env?buildId=${build?.id}`);
    expect(anonymous.status).toBe(401);

    db.update(repoHooks)
      .set({ ciTokenHash: sha256('another-token') })
      .run();
    const forged = await app.request(`/api/ci/build-env?buildId=${build?.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(forged.status).toBe(401);
  });
});

describe('CI: artifact upload', () => {
  test('a valid tarball is stored and the deployment becomes an artifact', async () => {
    const dir = dataDir();
    const config = configFor(dir);
    const { db } = testDb();
    const { deployment } = seedCi(db, 'static');
    const { token } = await signedIn(db, githubClient(), { config });

    const body = readFileSync(tarball());
    const response = await token(`/api/ci/artifact?buildId=${deployment.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        'x-artifact-sha256': createHash('sha256').update(body).digest('hex'),
      },
      body,
    });

    expect(response.status).toBe(201);
    const stored = db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
    expect(stored?.mode).toBe('artifact');
    expect(stored?.artifactPath).toBe(`artifacts/${deployment.id}/site`);
    expect(existsSync(join(dir, 'artifacts', deployment.id, 'site', 'index.html'))).toBe(true);
    // The upload is scratch space, not storage: it is gone once extracted.
    expect(existsSync(join(dir, 'uploads', `${deployment.id}.tar.gz`))).toBe(false);
  });

  test('a corrupted body is refused before anything is extracted', async () => {
    const dir = dataDir();
    const config = configFor(dir);
    const { db } = testDb();
    const { deployment } = seedCi(db, 'static');
    const { token } = await signedIn(db, githubClient(), { config });

    const response = await token(`/api/ci/artifact?buildId=${deployment.id}`, {
      method: 'PUT',
      headers: { 'x-artifact-sha256': 'a'.repeat(64) },
      body: readFileSync(tarball()),
    });

    expect(response.status).toBe(422);
    const stored = db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
    expect(stored?.mode).toBe('image');
    expect(existsSync(join(dir, 'artifacts', deployment.id))).toBe(false);
  });

  test('a hostile tarball fails the deployment with a sentence, not a stack trace', async () => {
    const dir = dataDir();
    const config = configFor(dir);
    const { db } = testDb();
    const { deployment } = seedCi(db, 'static');
    const { token } = await signedIn(db, githubClient(), { config });

    const body = readFileSync(tarball({ transform: 's,^\\./index\\.html$,../escape,' }));
    const response = await token(`/api/ci/artifact?buildId=${deployment.id}`, {
      method: 'PUT',
      headers: { 'x-artifact-sha256': createHash('sha256').update(body).digest('hex') },
      body,
    });

    expect(response.status).toBe(422);
    const stored = db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('Refusing');
  });
});

describe('CI: dispatch refuses a workflow it cannot trust', () => {
  test('a v1 workflow is not sent a Next.js build', async () => {
    const { db } = testDb();
    seedCi(db, 'next', 1);
    const dispatches: { payload: Record<string, string> }[] = [];
    const { call } = await signedIn(db, githubClient(dispatches));

    const service = db.select().from(services).get();
    const serviceEnv = db.select().from(serviceEnvs).get();

    const response = await call(
      `/api/services/${service?.id}/envs/${serviceEnv?.environmentId}/deploy`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('workflow_out_of_date');
    expect(dispatches).toHaveLength(0);
  });

  test('a v2 workflow gets the strategy and the output directory', async () => {
    const { db } = testDb();
    seedCi(db, 'static', 2);
    const dispatches: { payload: Record<string, string> }[] = [];
    const { call } = await signedIn(db, githubClient(dispatches));

    const service = db.select().from(services).get();
    const serviceEnv = db.select().from(serviceEnvs).get();

    const response = await call(
      `/api/services/${service?.id}/envs/${serviceEnv?.environmentId}/deploy`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(202);
    expect(dispatches[0]?.payload.strategy).toBe('static');
    expect(dispatches[0]?.payload.outputDir).toBe('dist');
  });
});

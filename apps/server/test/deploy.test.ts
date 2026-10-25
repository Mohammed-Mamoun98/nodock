import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { GitHubClient } from '../src/auth/github';
import type { CaddyAdmin } from '../src/caddy/admin';
import { renderCaddyfile } from '../src/caddy/render';
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
import {
  buildRunArgs,
  containerName,
  type ContainerSpec,
  type DockerAdapter,
} from '../src/docker/adapter';
import { runDeployment } from '../src/deploy/pipeline';
import { encrypt, deriveKey } from '../src/auth/crypto';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  DATA_DIR: '/tmp/nodock-pipeline-test',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

interface DockerCalls {
  pulled: string[];
  run: ContainerSpec[];
  stopped: string[];
  removed: string[];
  logins: string[];
}

function fakeDocker(
  options: { pullOk?: boolean; inspectRunning?: boolean; exposedPorts?: number[] } = {},
) {
  const calls: DockerCalls = { pulled: [], run: [], stopped: [], removed: [], logins: [] };

  const docker: DockerAdapter = {
    async exposedPorts() {
      return options.exposedPorts ?? [];
    },
    async logs() {
      return 'Error: listen EADDRINUSE';
    },
    async login(registry, username) {
      calls.logins.push(`${registry}:${username}`);
    },
    async pull(image) {
      calls.pulled.push(image);
      return options.pullOk === false ? { ok: false, error: 'manifest unknown' } : { ok: true };
    },
    async run(spec) {
      calls.run.push(spec);
      return { id: `container-${calls.run.length}` };
    },
    async inspect() {
      return { running: options.inspectRunning ?? true, exitCode: 0, status: 'running' };
    },
    async stop(name) {
      calls.stopped.push(name);
    },
    async remove(name) {
      calls.removed.push(name);
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

function seed(db: ReturnType<typeof testDb>['db'], opts: { liveContainer?: string } = {}) {
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
      name: 'api',
      slug: 'api',
      repoFullName: 'mohammed/milo',
      containerPort: 3000,
      memoryLimitMb: 768,
    })
    .returning()
    .get();
  const serviceEnv = db
    .insert(serviceEnvs)
    .values({
      serviceId: service.id,
      environmentId: env.id,
      branch: 'main',
      generatedHost: 'api.apps.example.com',
      healthPath: '/healthz',
    })
    .returning()
    .get();

  if (opts.liveContainer) {
    db.insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'live',
        imageRef: 'ghcr.io/mohammed/milo:api-old',
        containerName: opts.liveContainer,
        finishedAt: new Date(Date.now() - 60_000),
      })
      .run();
  }

  const pending = db
    .insert(deployments)
    .values({
      serviceEnvId: serviceEnv.id,
      trigger: 'push',
      status: 'queued',
      imageRef: 'ghcr.io/mohammed/milo:api-new',
      commitSha: 'a3f9c21',
    })
    .returning()
    .get();

  return { service, serviceEnv, pending };
}

describe('private registry', () => {
  const withCreds = loadConfig({
    NODOCK_SECRET: 'x'.repeat(32),
    NODOCK_URL: 'https://panel.example.com',
    BASE_DOMAIN: 'apps.example.com',
    DATA_DIR: '/tmp/nodock-pipeline-test',
    ADMIN_GITHUB_LOGIN: 'mohammed',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    GHCR_USER: 'mohammed',
    GHCR_TOKEN: 'ghp_readpackages',
  });

  test('logs in to ghcr before pulling when credentials exist', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin();

    await runDeployment(
      { config: withCreds, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(calls.logins).toEqual(['ghcr.io:mohammed']);
    expect(calls.pulled).toHaveLength(1);
  });

  test('does not log in without credentials', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin();

    await runDeployment({ config, db, docker, admin, health: async () => true }, pending.id);

    expect(calls.logins).toEqual([]);
  });

  test('an unauthorised pull explains the fix instead of echoing the daemon', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();

    const denying: DockerAdapter = {
      ...docker,
      pull: async () => ({
        ok: false,
        error: 'Error response from daemon: error from registry: unauthorized unauthorized',
      }),
    };

    await runDeployment(
      { config, db, docker: denying, admin, health: async () => true },
      pending.id,
    );

    const row = db.select().from(deployments).where(eq(deployments.id, pending.id)).get();
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('GHCR package is private');
    expect(row?.error).toContain('read:packages');
  });
});

describe('docker args', () => {
  test('never publishes a port and always constrains resources', () => {
    const args = buildRunArgs({
      name: 'nodock-api-production-abc12345',
      image: 'ghcr.io/mohammed/milo:api-a3f9c21',
      envFile: '/data/env/d1.env',
      network: 'nodock',
      memoryMb: 512,
      labels: { 'nodock.managed': 'true', 'nodock.deployment': 'd1' },
    });

    expect(args).not.toContain('-p');
    expect(args.join(' ')).toContain('--network nodock');
    expect(args.join(' ')).toContain('--memory 512m');
    expect(args.join(' ')).toContain('--pids-limit 256');
    expect(args.join(' ')).toContain('--stop-timeout 15');
    expect(args.join(' ')).toContain('--env-file /data/env/d1.env');
    // Labels are sorted, so the rendered command is deterministic.
    expect(args.indexOf('nodock.deployment=d1')).toBeGreaterThan(-1);
    expect(args.at(-1)).toBe('ghcr.io/mohammed/milo:api-a3f9c21');
  });

  test('container names are readable and unique per deployment', () => {
    expect(containerName('milo-api', 'prod', 'abcdef12-3456')).toBe(
      'nodock-milo-api-prod-abcdef12',
    );
  });
});

describe('caddy switch rendering', () => {
  test('lists the previous upstream as failover with lb retry directives', () => {
    const rendered = renderCaddyfile({
      dashboardHost: 'panel.example.com',
      routes: [
        {
          host: 'api.apps.example.com',
          upstream: 'nodock-api-new:3000',
          previous: 'nodock-api-old:3000',
        },
      ],
    });

    expect(rendered).toContain('reverse_proxy nodock-api-new:3000 nodock-api-old:3000 {');
    expect(rendered).toContain('lb_try_duration 5s');
    expect(rendered).toContain('fail_duration 30s');
  });
});

describe('deploy pipeline', () => {
  test('pulls, runs with the service env, switches, then drains the old container', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });

    const key = deriveKey(config.secret);
    const rows = db.select().from(serviceEnvs).all();
    if (rows[0]) {
      db.insert(variables)
        .values({
          serviceEnvId: rows[0].id,
          key: 'DATABASE_URL',
          valueEnc: encrypt('postgres://x', key),
        })
        .run();
    }

    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();
    const healths: string[] = [];

    const outcome = await runDeployment(
      {
        config,
        db,
        docker,
        admin,
        health: async (url) => {
          healths.push(url);
          return true;
        },
      },
      pending.id,
    );

    expect(outcome).toBe('live');
    expect(calls.pulled).toEqual(['ghcr.io/mohammed/milo:api-new']);
    expect(calls.run[0]?.memoryMb).toBe(768);
    expect(calls.run[0]?.labels['nodock.deployment']).toBe(pending.id);
    expect(healths[0]).toBe('http://nodock-api-prod-' + pending.id.slice(0, 8) + ':3000/healthz');

    // Route switched with the old container as failover…
    expect(loads[0]).toContain('lb_try_duration 5s');
    expect(loads[0]).toContain('nodock-api-prod-old00000:3000');

    // …then the old one was drained with a grace period, not hard-killed.
    expect(calls.stopped).toEqual(['nodock-api-prod-old00000']);

    const row = db.select().from(deployments).where(eq(deployments.id, pending.id)).get();
    expect(row?.status).toBe('live');
    expect(row?.containerName).toBe(containerName('api', 'prod', pending.id));
    // The container was just health-checked, so its runtime snapshot starts honest.
    expect(row?.runtimeState).toBe('running');
    expect(row?.runtimeRestarts).toBe(0);

    // And the deployment it replaced is history: leaving it `live` would list a
    // green row for a container that no longer exists.
    const old = db
      .select()
      .from(deployments)
      .where(eq(deployments.containerName, 'nodock-api-prod-old00000'))
      .get();
    expect(old?.status).toBe('superseded');
    expect(old?.runtimeState).toBeNull();
  });

  test('a failed pull never touches the old container', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker({ pullOk: false });
    const { admin } = fakeAdmin();

    const outcome = await runDeployment(
      { config, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.run).toHaveLength(0);
    expect(calls.stopped).toHaveLength(0);
    expect(
      db.select().from(deployments).where(eq(deployments.id, pending.id)).get()?.error,
    ).toContain('manifest unknown');

    // The old deployment keeps the route, so it stays live: superseding it here
    // would point the panel at a container that never took over.
    const old = db
      .select()
      .from(deployments)
      .where(eq(deployments.containerName, 'nodock-api-prod-old00000'))
      .get();
    expect(old?.status).toBe('live');
  });

  test("an unset port is taken from the image's EXPOSE", async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    // seed() leaves containerPort at 3000 via the service row; clear it first.
    db.update(services).set({ containerPort: null }).run();

    const { docker, calls } = fakeDocker({ exposedPorts: [3013] });
    const { admin } = fakeAdmin();

    const outcome = await runDeployment(
      { config, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(outcome).toBe('live');
    expect(calls.run[0]?.name).toBeTruthy();
    expect(db.select().from(services).get()?.containerPort).toBe(3013);
  });

  test('an explicit port wins over EXPOSE', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    db.update(services).set({ containerPort: 8080 }).run();

    const { docker } = fakeDocker({ exposedPorts: [3013] });
    const { admin } = fakeAdmin();

    await runDeployment({ config, db, docker, admin, health: async () => true }, pending.id);
    expect(db.select().from(services).get()?.containerPort).toBe(8080);
  });

  test('the running deployment is never superseded by itself', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();

    await runDeployment({ config, db, docker, admin, health: async () => true }, pending.id);

    const row = db.select().from(deployments).where(eq(deployments.id, pending.id)).get();
    expect(row?.status).toBe('live');
    expect(row?.error).toBeNull();
  });

  test('a failed health check includes the container output', async () => {
    const { db } = testDb();
    const { pending } = seed(db);
    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();

    await runDeployment({ config, db, docker, admin, health: async () => false }, pending.id);

    const row = db.select().from(deployments).where(eq(deployments.id, pending.id)).get();
    expect(row?.error).toContain('no HTTP response');
    expect(row?.error).toContain('EADDRINUSE');
    expect(row?.error).toContain('0.0.0.0');
  });

  test('an unhealthy container is removed and the route is left alone', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();

    const outcome = await runDeployment(
      { config, db, docker, admin, health: async () => false },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.removed).toContain(containerName('api', 'prod', pending.id));
    expect(calls.stopped).toHaveLength(0);
    expect(loads).toHaveLength(0);
  });

  test('a rejected route switch removes the new container and keeps the old route', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin(false);

    const outcome = await runDeployment(
      { config, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.removed).toContain(containerName('api', 'prod', pending.id));
    expect(calls.stopped).toHaveLength(0);
    expect(
      db.select().from(deployments).where(eq(deployments.id, pending.id)).get()?.error,
    ).toContain('Caddy rejected');
  });

  test('a newer deployment supersedes anything still queued', async () => {
    const { db } = testDb();
    const { serviceEnv, pending } = seed(db);

    const older = db
      .insert(deployments)
      .values({ serviceEnvId: serviceEnv.id, trigger: 'push', status: 'queued', imageRef: 'x:old' })
      .returning()
      .get();

    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();

    await runDeployment({ config, db, docker, admin, health: async () => true }, pending.id);

    const row = db.select().from(deployments).where(eq(deployments.id, older.id)).get();
    expect(row?.status).toBe('cancelled');
    expect(row?.error).toContain('superseded');
  });

  test('an undecryptable variable fails the deploy instead of starting blind', async () => {
    const { db } = testDb();
    const { pending, serviceEnv } = seed(db);

    const wrongKey = deriveKey('y'.repeat(32));
    db.insert(variables)
      .values({ serviceEnvId: serviceEnv.id, key: 'SECRET', valueEnc: encrypt('x', wrongKey) })
      .run();

    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin();

    const outcome = await runDeployment(
      { config, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.run).toHaveLength(0);
    expect(
      db.select().from(deployments).where(eq(deployments.id, pending.id)).get()?.error,
    ).toContain('Cannot decrypt');
  });
});

async function signedInApp(options: {
  docker: DockerAdapter;
  admin: CaddyAdmin;
  db: ReturnType<typeof testDb>['db'];
  github?: GitHubClient;
}) {
  const { createApp } = await import('../src/app');
  const { SESSION_COOKIE } = await import('../src/auth/sessions');

  const app = createApp({
    config,
    db: options.db,
    docker: options.docker,
    admin: options.admin,
    github: options.github ?? {
      authorizeUrl: () => 'https://github.com/login/oauth/authorize',
      exchangeCode: async () => ({ accessToken: 'gho', scopes: ['repo', 'workflow'] }),
      getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
      listRepos: async () => ({ repos: [], hasMore: false }),
      listBranches: async () => ['main'],
    },
  });

  const start = await app.request('/auth/github');
  const state = decodeURIComponent(
    start.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('nodock_oauth_state='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  );
  const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `nodock_oauth_state=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${decodeURIComponent(
    callback.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  )}`;

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        cookie,
        origin: 'https://panel.example.com',
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  return { call };
}

describe('teardown', () => {
  test('deleting a project stops its containers and drops its routes', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db, { liveContainer: 'nodock-api-prod-abc12345' });
    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();
    const { call } = await signedInApp({ db, docker, admin });

    const project = db.select().from(projects).get();

    const response = await call(`/api/projects/${project?.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(calls.stopped).toEqual(['nodock-api-prod-abc12345']);
    expect(calls.removed).toEqual(['nodock-api-prod-abc12345']);
    expect(db.select().from(services).all()).toHaveLength(0);
    expect(db.select().from(serviceEnvs).all()).toHaveLength(0);
    expect(loads.at(-1)).not.toContain('api.apps.example.com');
    void serviceEnv;
  });

  test('deleting a service stops only its own containers', async () => {
    const { db } = testDb();
    const { service } = seed(db, { liveContainer: 'nodock-api-prod-abc12345' });
    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin();
    const { call } = await signedInApp({ db, docker, admin });

    const response = await call(`/api/services/${service.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(calls.stopped).toEqual(['nodock-api-prod-abc12345']);
  });
});

function fakeRepoOps(existing: { hookId?: number } = {}) {
  const calls: string[] = [];
  const github = {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async () => ({ repos: [], hasMore: false }),
    listBranches: async () => ['main'],
    deleteWebhook: async (_token: string, repo: string, hookId: number) => {
      calls.push(`webhook ${repo} #${hookId}`);
      void existing;
    },
    deleteActionsSecret: async (_token: string, repo: string, name: string) => {
      calls.push(`secret ${repo} ${name}`);
    },
  };
  return { github, calls };
}

describe('repo cleanup on delete', () => {
  test('deleting the last service for a repo revokes the webhook and CI secret', async () => {
    const { db } = testDb();
    const { service } = seed(db, { liveContainer: 'nodock-api-prod-abc12345' });
    db.insert(repoHooks)
      .values({
        repoFullName: 'mohammed/milo',
        hookId: 99,
        webhookSecretEnc: 'v1.x.y.z',
        ciTokenHash: 'hash',
        ciEnabledAt: new Date(),
      })
      .run();

    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();
    const { github, calls } = fakeRepoOps();
    const { call } = await signedInApp({ db, docker, admin, github });

    const response = await call(`/api/services/${service.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(calls).toEqual(['webhook mohammed/milo #99', 'secret mohammed/milo NODOCK_CI_TOKEN']);
    expect(db.select().from(repoHooks).all()).toHaveLength(0);
  });

  test('a repo still used by another service keeps its credentials', async () => {
    const { db } = testDb();
    const { service } = seed(db, { liveContainer: 'nodock-api-prod-abc12345' });
    // second service on the same repo
    const other = db
      .insert(services)
      .values({
        projectId: service.projectId,
        name: 'worker',
        slug: 'worker',
        repoFullName: 'mohammed/milo',
      })
      .returning()
      .get();
    db.insert(repoHooks)
      .values({ repoFullName: 'mohammed/milo', hookId: 5, webhookSecretEnc: 'v1.a.b.c' })
      .run();

    const { docker } = fakeDocker();
    const { admin } = fakeAdmin();
    const { github, calls } = fakeRepoOps();
    const { call } = await signedInApp({ db, docker, admin, github });

    await call(`/api/services/${other.id}`, { method: 'DELETE' });

    expect(calls).toEqual([]);
    expect(db.select().from(repoHooks).all()).toHaveLength(1);
  });
});

describe('health checks without joining the app network', () => {
  const viaProxy = loadConfig({
    NODOCK_SECRET: 'x'.repeat(32),
    NODOCK_URL: 'https://panel.example.com',
    BASE_DOMAIN: 'apps.example.com',
    DATA_DIR: '/tmp/nodock-pipeline-test',
    ADMIN_GITHUB_LOGIN: 'mohammed',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    CADDY_ADMIN_SOCKET: '/run/caddy/admin.sock',
    CADDY_PROBE_URL: 'http://caddy:8099',
  });

  test('the probe route exists only for the health check, then the real switch happens', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();
    const healths: string[] = [];

    const outcome = await runDeployment(
      {
        config: viaProxy,
        db,
        docker,
        admin,
        health: async (url) => {
          healths.push(url);
          return true;
        },
      },
      pending.id,
    );

    expect(outcome).toBe('live');
    // nodock is not on the app network, so it reaches the container through Caddy.
    expect(healths[0]).toBe(`http://caddy:8099/probe/${pending.id}/healthz`);

    // First load: the probe, and the admin API on the socket. The public route is
    // untouched, so the old container keeps serving while we check.
    expect(loads[0]).toContain(`handle_path /probe/${pending.id}/*`);
    expect(loads[0]).toContain('reverse_proxy nodock-api-prod-' + pending.id.slice(0, 8) + ':3000');
    expect(loads[0]).toContain('admin unix//run/caddy/admin.sock');
    expect(loads[0]).not.toContain('lb_try_duration');

    // Second load: the switch, old container as failover, probe gone.
    expect(loads[1]).toContain('lb_try_duration 5s');
    expect(loads[1]).toContain('nodock-api-prod-old00000:3000');
    expect(loads[1]).not.toContain('handle_path /probe/');
    expect(calls.stopped).toEqual(['nodock-api-prod-old00000']);
  });

  test('a container that never answers has its probe route removed again', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker();
    const { admin, loads } = fakeAdmin();

    const outcome = await runDeployment(
      { config: viaProxy, db, docker, admin, health: async () => false },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.stopped).toEqual([]);
    expect(calls.removed).toEqual([containerName('api', 'prod', pending.id)]);
    expect(loads[0]).toContain('handle_path /probe/');
    expect(loads.at(-1)).not.toContain('handle_path /probe/');
  });

  test('a rejected probe route fails the deploy before the old container is touched', async () => {
    const { db } = testDb();
    const { pending } = seed(db, { liveContainer: 'nodock-api-prod-old00000' });
    const { docker, calls } = fakeDocker();
    const { admin } = fakeAdmin(false);

    const outcome = await runDeployment(
      { config: viaProxy, db, docker, admin, health: async () => true },
      pending.id,
    );

    expect(outcome).toBe('failed');
    expect(calls.stopped).toEqual([]);

    const row = db.select().from(deployments).where(eq(deployments.id, pending.id)).get();
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('health-check route');
  });
});

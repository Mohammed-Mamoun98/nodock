import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { sealSecret as _sealSecret } from '../src/ci/sealed-box';
import {
  imageRef,
  renderWorkflow,
  WORKFLOW_VERSION,
  workflowSupportsStrategy,
} from '../src/ci/workflow';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { loadConfig } from '../src/config';
import {
  deployments,
  environments,
  projects,
  repoHooks,
  serviceEnvs,
  services,
} from '../src/db/schema';
import { testDb } from './helpers';
import type { GitHubClient } from '../src/auth/github';
import type { CaddyAdmin } from '../src/caddy/admin';
import type { DockerAdapter } from '../src/docker/adapter';

void _sealSecret;

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  DATA_DIR: '/tmp/nodock-ci-test',
});

interface FakeCalls {
  putFile: unknown[];
  secrets: { name: string; value: string }[];
  hooks: { url: string; secret: string }[];
  dispatches: { eventType: string; payload: Record<string, string> }[];
}

function fakeGitHub(
  options: { file?: { sha: string; content: string } | null; workflowOnBranch?: string } = {},
) {
  const calls: FakeCalls = { putFile: [], secrets: [], hooks: [], dispatches: [] };

  const client: GitHubClient = {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho_admin', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async () => ({ repos: [], hasMore: false }),
    listBranches: async () => ['main'],
    getRepo: async () => ({ fullName: 'mohammed/milo', defaultBranch: 'main', private: false }),
    getBranchHead: async () => 'a3f9c21deadbeef',
    getFile: async () =>
      options.file === undefined
        ? { sha: 'blob-1', content: options.workflowOnBranch ?? renderWorkflow(config.url) }
        : options.file,
    putFile: async (_token, _repo, input) => {
      calls.putFile.push(input);
      return { commitSha: 'commit-1', contentSha: 'blob-2' };
    },
    putActionsSecret: async (_token, _repo, name, value) => {
      calls.secrets.push({ name, value });
    },
    createWebhook: async (_token, _repo, input) => {
      calls.hooks.push(input);
      return { id: 99 };
    },
    dispatchBuild: async (_token, _repo, eventType, payload) => {
      calls.dispatches.push({ eventType, payload });
    },
  };

  return { client, calls };
}

async function signedIn(
  github: GitHubClient,
  options: {
    docker?: DockerAdapter;
    admin?: CaddyAdmin | null;
    health?: (url: string) => Promise<boolean>;
  } = {},
) {
  const { db } = testDb();
  const app = createApp({
    config,
    db,
    github,
    docker: options.docker,
    admin: options.admin,
    health: options.health,
  });

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

  return { app, db, call, cookie };
}

async function seedService(db: ReturnType<typeof testDb>['db']) {
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
    })
    .returning()
    .get();

  return { service, serviceEnv, env };
}

describe('workflow', () => {
  test('bakes the nodock URL in and uses the pinned action versions', () => {
    const workflow = renderWorkflow('https://panel.example.com/');

    // The panel address is the one that wrote the file: every callback goes home.
    expect(workflow).toContain('NODOCK_URL: "https://panel.example.com"');
    expect(workflow).toContain('/api/ci/started');
    expect(workflow).toContain('/api/ci/finished');
    expect(workflow).not.toContain('panel.example.com//api');
    expect(workflow).toContain('types: [nodock-build]');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('secrets.NODOCK_CI_TOKEN');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('--retry 3');
  });

  test('carries every strategy, and the artifact upload for the static ones', () => {
    const workflow = renderWorkflow('https://panel.example.com');

    expect(workflow).toContain("strategy == 'dockerfile'");
    expect(workflow).toContain("strategy == 'next'");
    expect(workflow).toContain("strategy == 'static'");
    expect(workflow).toContain("strategy == 'railpack'");
    expect(workflow).toContain('/api/ci/artifact?buildId=');
    expect(workflow).toContain('/api/ci/build-env?buildId=');
    // The two Next variants, and the advisory that is the only difference between them.
    expect(workflow).toContain('.next/standalone/server.js');
    expect(workflow).toContain("output: 'standalone'");
    expect(workflow).toContain('BUILDKIT_SYNTAX=');
  });

  test('a workflow version gates the strategies a repo can be sent', () => {
    expect(workflowSupportsStrategy(1, 'dockerfile')).toBe(true);
    expect(workflowSupportsStrategy(null, 'dockerfile')).toBe(true);
    expect(workflowSupportsStrategy(1, 'next')).toBe(false);
    expect(workflowSupportsStrategy(1, 'static')).toBe(false);
    expect(workflowSupportsStrategy(2, 'railpack')).toBe(true);
    expect(WORKFLOW_VERSION).toBe(2);
  });

  test('image refs are lowercased and tag per service+commit', () => {
    expect(imageRef('Mohammed/Milo', 'milo-api', 'A3F9C21DEADBEEF')).toBe(
      'ghcr.io/mohammed/milo:milo-api-a3f9c21deadb',
    );
  });
});

describe('ci status', () => {
  test('reports not_enabled before CI is enabled', async () => {
    const { client } = fakeGitHub();
    const { call } = await signedIn(client);

    const response = await call('/api/repos/mohammed/milo/ci');
    expect(await response.json()).toEqual({
      status: 'not_enabled',
      workflowPath: '.github/workflows/nodock.yml',
    });
  });

  test('distinguishes enabled, modified and out_of_date', async () => {
    const enabled = fakeGitHub({ file: { sha: 'blob-2', content: renderWorkflow(config.url) } });
    const ctx = await signedIn(enabled.client);

    await ctx.call('/api/repos/mohammed/milo/ci/enable', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const ok = await ctx.call('/api/repos/mohammed/milo/ci');
    expect(((await ok.json()) as { status: string }).status).toBe('enabled');

    // Same content, different blob → the file was edited (even if identically).
    ctx.db
      .update(repoHooks)
      .set({ workflowSha: 'blob-1' })
      .where(eq(repoHooks.repoFullName, 'mohammed/milo'))
      .run();
    const edited = await ctx.call('/api/repos/mohammed/milo/ci');
    expect(((await edited.json()) as { status: string }).status).toBe('modified');
  });

  test('a deleted workflow reports modified', async () => {
    const deleted = fakeGitHub({ file: { sha: 'blob-2', content: renderWorkflow(config.url) } });
    const ctx = await signedIn(deleted.client);
    await ctx.call('/api/repos/mohammed/milo/ci/enable', { method: 'POST', body: '{}' });

    const withMissingFile = fakeGitHub({ file: null });
    const app2 = createApp({ config, db: ctx.db, github: withMissingFile.client });
    const response = await app2.request('/api/repos/mohammed/milo/ci', {
      headers: { cookie: ctx.cookie },
    });

    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe('modified');
    expect(body.reason).toContain('deleted');
  });
});

describe('ci enable', () => {
  test('commits the workflow, stores the secret, creates the webhook and records state', async () => {
    const { client, calls } = fakeGitHub({ file: null });
    const { call, db } = await signedIn(client);

    const response = await call('/api/repos/mohammed/milo/ci/enable', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(calls.putFile).toHaveLength(1);
    expect(calls.putFile[0]).toMatchObject({
      path: '.github/workflows/nodock.yml',
      branch: 'main',
    });
    expect(calls.secrets[0]?.name).toBe('NODOCK_CI_TOKEN');
    expect(calls.secrets[0]?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.hooks[0]?.url).toBe('https://panel.example.com/webhooks/github');

    const row = db.select().from(repoHooks).get();
    expect(row?.hookId).toBe(99);
    expect(row?.ciEnabledAt).toBeInstanceOf(Date);
    // The token and the webhook secret are never stored in the clear.
    expect(row?.ciTokenHash).toBe(
      createHash('sha256')
        .update(calls.secrets[0]?.value ?? '', 'utf8')
        .digest('hex'),
    );
    expect(row?.webhookSecretEnc).not.toContain(calls.hooks[0]?.secret ?? 'x');
  });

  test('refuses to overwrite a different existing workflow without confirmation', async () => {
    const { client, calls } = fakeGitHub({
      file: { sha: 'blob-x', content: 'name: my own pipeline\n' },
    });
    const { call } = await signedIn(client);

    const response = await call('/api/repos/mohammed/milo/ci/enable', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; details: { current: string; preview: string } };
    };
    expect(body.error.code).toBe('workflow_exists');
    expect(body.error.details.current).toContain('my own pipeline');
    expect(calls.putFile).toHaveLength(0);
  });

  test('overwrites when asked explicitly', async () => {
    const { client, calls } = fakeGitHub({
      file: { sha: 'blob-x', content: 'name: my own pipeline\n' },
    });
    const { call } = await signedIn(client);

    const response = await call('/api/repos/mohammed/milo/ci/enable', {
      method: 'POST',
      body: JSON.stringify({ overwrite: true }),
    });

    expect(response.status).toBe(200);
    expect(calls.putFile).toHaveLength(1);
  });
});

describe('deploy dispatch', () => {
  test('refuses when CI is not enabled for the repo', async () => {
    const { client, calls } = fakeGitHub();
    const { call, db } = await signedIn(client);
    const { service, serviceEnv } = await seedService(db);

    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deploy`,
      {
        method: 'POST',
        body: '{}',
      },
    );

    expect(response.status).toBe(409);
    expect(calls.dispatches).toHaveLength(0);
  });

  test('creates a queued deployment and dispatches the expected payload', async () => {
    const { client, calls } = fakeGitHub({ file: null });
    const { call, db } = await signedIn(client);
    const { service, serviceEnv } = await seedService(db);
    await call('/api/repos/mohammed/milo/ci/enable', { method: 'POST', body: '{}' });

    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deploy`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(202);
    const deployment = db.select().from(deployments).get();
    expect(deployment?.status).toBe('queued');
    expect(deployment?.commitSha).toBe('a3f9c21deadbeef');

    const dispatched = calls.dispatches[0];
    expect(dispatched?.eventType).toBe('nodock-build');
    expect(dispatched?.payload).toMatchObject({
      buildId: deployment?.id,
      ref: 'main',
      sha: 'a3f9c21deadbeef',
      image: 'ghcr.io/mohammed/milo:api-a3f9c21deadb',
      dockerfile: 'Dockerfile',
      context: '.',
      serviceSlug: 'api',
      strategy: 'dockerfile',
      outputDir: '',
    });
    // GitHub refuses a dispatch payload with more than ten keys.
    expect(Object.keys(dispatched?.payload ?? {})).toHaveLength(9);
  });

  test('marks the deployment failed when the dispatch itself fails', async () => {
    const { client } = fakeGitHub({ file: null });
    const failing: GitHubClient = {
      ...client,
      dispatchBuild: async () => {
        throw new Error('repository_dispatch failed (404)');
      },
    };
    const { call, db } = await signedIn(failing);
    const { service, serviceEnv } = await seedService(db);
    await call('/api/repos/mohammed/milo/ci/enable', { method: 'POST', body: '{}' });

    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deploy`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(502);
    expect(db.select().from(deployments).get()?.status).toBe('failed');
  });
});

const DIGEST = `sha256:${'c'.repeat(64)}`;

function fakeRollbackDocker() {
  const calls = { pulled: [] as string[], run: [] as string[] };
  const docker: DockerAdapter = {
    async pull(image) {
      calls.pulled.push(image);
      return { ok: true };
    },
    async run(spec) {
      calls.run.push(spec.image);
      return { id: 'container-1' };
    },
    async inspect() {
      return { running: true, exitCode: 0, status: 'running' };
    },
    async stop() {},
    async remove() {},
  };
  return { docker, calls };
}

/** The pipeline is deliberately not awaited by the route; wait for its first row. */
async function until<T>(read: () => T | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    // Sequential by design: poll, wait, poll again.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function enabledRepo() {
  const { client, calls } = fakeGitHub({ file: null });
  const ctx = await signedIn(client);
  await ctx.call('/api/repos/mohammed/milo/ci/enable', { method: 'POST', body: '{}' });
  const { service, serviceEnv } = await seedService(ctx.db);

  const deploy = await ctx.call(
    `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deploy`,
    { method: 'POST', body: '{}' },
  );
  const { deployment } = (await deploy.json()) as { deployment: { id: string } };

  return { ...ctx, calls, buildId: deployment.id, ciToken: calls.secrets[0]?.value ?? '' };
}

describe('ci callbacks', () => {
  test('records the run URL on started', async () => {
    const { app, db, buildId, ciToken } = await enabledRepo();

    const response = await app.request('/api/ci/started', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ciToken}` },
      body: JSON.stringify({
        buildId,
        repo: 'mohammed/milo',
        runUrl: 'https://github.com/mohammed/milo/actions/runs/1',
      }),
    });

    expect(response.status).toBe(200);
    expect(db.select().from(deployments).get()?.ciRunUrl).toContain('actions/runs/1');
  });

  test('a failed build marks the deployment failed and keeps the digest', async () => {
    const { app, db, buildId, ciToken } = await enabledRepo();

    await app.request('/api/ci/finished', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ciToken}` },
      body: JSON.stringify({ buildId, repo: 'mohammed/milo', conclusion: 'failure' }),
    });

    const row = db.select().from(deployments).get();
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('GitHub Actions build failure');
  });

  test('a wrong token or wrong repo is rejected', async () => {
    const { app, buildId, ciToken } = await enabledRepo();
    const payload = JSON.stringify({ buildId, repo: 'mohammed/milo' });

    const wrongToken = await app.request('/api/ci/finished', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer deadbeef' },
      body: payload,
    });
    expect(wrongToken.status).toBe(401);

    const wrongRepo = await app.request('/api/ci/finished', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ciToken}` },
      body: JSON.stringify({ buildId, repo: 'someone/else' }),
    });
    expect(wrongRepo.status).toBe(401);
  });
});

async function githubWebhookSetup() {
  const { client, calls } = fakeGitHub({ file: null });
  const ctx = await signedIn(client);
  await ctx.call('/api/repos/mohammed/milo/ci/enable', { method: 'POST', body: '{}' });
  const { service, serviceEnv } = await seedService(ctx.db);

  const secret = calls.hooks[0]?.secret ?? '';
  // The stored webhook secret is the one GitHub signs with.
  expect(secret.length).toBeGreaterThan(20);

  const push = (body: unknown, signatureSecret = secret) => {
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', signatureSecret).update(raw).digest('hex')}`;
    return ctx.app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
      body: raw,
    });
  };

  return { ...ctx, push, secret, service, serviceEnv, calls };
}

describe('push webhook', () => {
  test('a push to the deployed branch dispatches a build', async () => {
    const { push, calls, db } = await githubWebhookSetup();

    const response = await push({
      repository: { full_name: 'mohammed/milo' },
      ref: 'refs/heads/main',
      after: 'bbb',
      commits: [{ modified: ['src/index.ts'] }],
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: 1 });
    expect(calls.dispatches).toHaveLength(1);
    expect(db.select().from(deployments).get()?.trigger).toBe('push');
  });

  test('a push to another branch is ignored', async () => {
    const { push, calls } = await githubWebhookSetup();

    await push({
      repository: { full_name: 'mohammed/milo' },
      ref: 'refs/heads/feature',
      commits: [{ modified: ['src/index.ts'] }],
    });

    expect(calls.dispatches).toHaveLength(0);
  });

  test('a workflow-only push does not deploy itself', async () => {
    const { push, calls } = await githubWebhookSetup();

    const response = await push({
      repository: { full_name: 'mohammed/milo' },
      ref: 'refs/heads/main',
      commits: [{ added: ['.github/workflows/nodock.yml'] }],
    });

    expect(response.status).toBe(202);
    expect(calls.dispatches).toHaveLength(0);
  });

  test('a bad signature is rejected', async () => {
    const { push } = await githubWebhookSetup();

    const response = await push(
      { repository: { full_name: 'mohammed/milo' }, ref: 'refs/heads/main', commits: [] },
      'wrong-secret',
    );

    expect(response.status).toBe(401);
  });
});

describe('rollback', () => {
  test('runs a past image by digest with today’s service env', async () => {
    const { client, calls: githubCalls } = fakeGitHub();
    const { docker, calls } = fakeRollbackDocker();
    const ctx = await signedIn(client, { docker, admin: null, health: async () => true });
    const { service, serviceEnv } = await seedService(ctx.db);

    const source = ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'superseded',
        commitSha: '0123456789abcdef',
        commitMessage: 'the good one',
        imageRef: 'ghcr.io/mohammed/milo:api-0123456789ab',
        imageDigest: DIGEST,
      })
      .returning()
      .get();

    const response = await ctx.call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deployments/${source.id}/rollback`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(202);
    const created = ctx.db
      .select()
      .from(deployments)
      .where(eq(deployments.trigger, 'rollback'))
      .get();
    expect(created?.rollbackOf).toBe(source.id);
    expect(created?.commitSha).toBe(source.commitSha);
    expect(created?.commitMessage).toBe(source.commitMessage);
    expect(created?.imageRef).toBe(source.imageRef);
    expect(created?.imageDigest).toBe(DIGEST);

    // No CI is involved: the route kicks the normal pull/run/health/switch path.
    const finished = await until(() => {
      const row = ctx.db
        .select()
        .from(deployments)
        .where(eq(deployments.id, created?.id ?? ''))
        .get();
      return row?.status === 'live' ? row : undefined;
    }, 'the rollback to go live');
    expect(finished.status).toBe('live');
    expect(calls.pulled).toEqual([`ghcr.io/mohammed/milo@${DIGEST}`]);
    expect(calls.run).toEqual([`ghcr.io/mohammed/milo@${DIGEST}`]);
    // No rebuild: rollback never asks GitHub for anything.
    expect(githubCalls.dispatches).toHaveLength(0);
  });

  test('refuses a deployment that never ran', async () => {
    const { client } = fakeGitHub();
    const { docker } = fakeRollbackDocker();
    const ctx = await signedIn(client, { docker, admin: null });
    const { service, serviceEnv } = await seedService(ctx.db);

    const failed = ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'failed',
        imageRef: 'ghcr.io/mohammed/milo:api-broken',
      })
      .returning()
      .get();

    const response = await ctx.call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deployments/${failed.id}/rollback`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_rollbackable');
    expect(
      ctx.db.select().from(deployments).where(eq(deployments.trigger, 'rollback')).get(),
    ).toBeUndefined();
  });

  test('refuses the deployment that is already serving', async () => {
    const { client } = fakeGitHub();
    const { docker } = fakeRollbackDocker();
    const ctx = await signedIn(client, { docker, admin: null });
    const { service, serviceEnv } = await seedService(ctx.db);

    const live = ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'live',
        imageRef: 'ghcr.io/mohammed/milo:api-current',
      })
      .returning()
      .get();

    const response = await ctx.call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deployments/${live.id}/rollback`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('already_live');
  });

  test('does not touch a deployment from another environment', async () => {
    const { client } = fakeGitHub();
    const { docker } = fakeRollbackDocker();
    const ctx = await signedIn(client, { docker, admin: null });
    const { service, serviceEnv, env } = await seedService(ctx.db);

    const staging = ctx.db
      .insert(environments)
      .values({ projectId: env.projectId, name: 'Staging', slug: 'staging' })
      .returning()
      .get();
    const stagingEnv = ctx.db
      .insert(serviceEnvs)
      .values({
        serviceId: service.id,
        environmentId: staging.id,
        branch: 'main',
        generatedHost: 'api-staging.apps.example.com',
      })
      .returning()
      .get();
    const foreign = ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: stagingEnv.id,
        trigger: 'push',
        status: 'superseded',
        imageRef: 'ghcr.io/mohammed/milo:api-staging',
      })
      .returning()
      .get();

    const response = await ctx.call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deployments/${foreign.id}/rollback`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(404);
  });

  test('refuses while another deployment for the environment is moving', async () => {
    const { client } = fakeGitHub();
    const { docker } = fakeRollbackDocker();
    const ctx = await signedIn(client, { docker, admin: null });
    const { service, serviceEnv } = await seedService(ctx.db);

    const source = ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'superseded',
        imageRef: 'ghcr.io/mohammed/milo:api-old',
      })
      .returning()
      .get();
    ctx.db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        status: 'pulling',
        imageRef: 'ghcr.io/mohammed/milo:api-new',
      })
      .run();

    const response = await ctx.call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/deployments/${source.id}/rollback`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('deployment_in_progress');
  });
});

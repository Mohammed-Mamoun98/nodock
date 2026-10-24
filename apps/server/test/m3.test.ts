import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import type { GitHubClient } from '../src/auth/github';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { loadConfig } from '../src/config';
import { dockerfileOutsideContext } from '../src/lib/build';
import { generatedHost, slugify, uniqueValue } from '../src/lib/slug';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const ORIGIN = 'https://panel.example.com';

const github: GitHubClient = {
  authorizeUrl: () => 'https://github.com/login/oauth/authorize',
  exchangeCode: async () => ({ accessToken: 'gho_test', scopes: ['repo', 'workflow'] }),
  getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
};

async function signedIn() {
  const { db } = testDb();
  const app = createApp({ config, db, github });

  const start = await app.request('/auth/github');
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith('nodock_oauth_state='));
  const state = decodeURIComponent(stateCookie?.split(';')[0]?.split('=')[1] ?? '');

  const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `nodock_oauth_state=${state}` },
  });
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const cookie = `${SESSION_COOKIE}=${decodeURIComponent(sessionCookie?.split(';')[0]?.split('=')[1] ?? '')}`;

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  return { app, db, call };
}

describe('slug helpers', () => {
  test('slugify produces host-safe labels', () => {
    expect(slugify('Milo API!')).toBe('milo-api');
    expect(slugify('  --weird--  ')).toBe('weird');
    expect(slugify('123')).toBe('service-123');
    expect(slugify('!!!')).toBe('service');
  });

  test('uniqueValue suffixes until free', () => {
    const taken = new Set(['api', 'api-2']);
    expect(uniqueValue('api', (c) => taken.has(c))).toBe('api-3');
  });

  test('generatedHost omits the env for the default environment only', () => {
    expect(generatedHost('api', 'production', 'apps.example.com')).toBe('api.apps.example.com');
    expect(generatedHost('api', 'staging', 'apps.example.com')).toBe(
      'api-staging.apps.example.com',
    );
  });

  test('dockerfileOutsideContext matches docker build behaviour', () => {
    expect(dockerfileOutsideContext('Dockerfile', '.')).toBe(false);
    expect(dockerfileOutsideContext('app/Dockerfile', 'app')).toBe(false);
    expect(dockerfileOutsideContext('Dockerfile', 'app')).toBe(true);
    expect(dockerfileOutsideContext('../Dockerfile', 'app')).toBe(true);
  });
});

describe('projects', () => {
  test('creates a project with a default environment', async () => {
    const { call } = await signedIn();

    const created = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Milo' }),
    });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string; slug: string } };
    expect(project.slug).toBe('milo');

    const detail = await call(`/api/projects/${project.id}`);
    const body = (await detail.json()) as { environments: { slug: string; isDefault: boolean }[] };
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0]).toMatchObject({ slug: 'production', isDefault: true });
  });

  test('disambiguates duplicate names instead of failing', async () => {
    const { call } = await signedIn();
    await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Milo' }) });
    const second = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Milo' }),
    });
    const { project } = (await second.json()) as { project: { slug: string } };
    expect(project.slug).toBe('milo-2');
  });

  test('rejects an empty name', async () => {
    const { call } = await signedIn();
    const response = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '  ' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  test('the default environment cannot be deleted', async () => {
    const { call } = await signedIn();
    const created = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Milo' }),
    });
    const { project } = (await created.json()) as { project: { id: string } };

    const detail = (await (await call(`/api/projects/${project.id}`)).json()) as {
      environments: { id: string }[];
    };
    const envId = detail.environments[0]?.id ?? '';

    const response = await call(`/api/environments/${envId}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'default_environment' } });
  });
});

async function withProject() {
  const ctx = await signedIn();
  const created = await ctx.call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Milo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  return { ...ctx, projectId: project.id };
}

describe('services', () => {
  test('creates a service plus a service env with a generated host', async () => {
    const { call, projectId } = await withProject();

    const response = await call(`/api/projects/${projectId}/services`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Milo API', repoFullName: 'mohammed/milo', branch: 'main' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      service: { slug: string; dockerfilePath: string; contextPath: string };
      serviceEnv: { generatedHost: string; branch: string };
    };
    expect(body.service).toMatchObject({
      slug: 'milo-api',
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
    });
    expect(body.serviceEnv).toMatchObject({
      generatedHost: 'milo-api.apps.example.com',
      branch: 'main',
    });
  });

  test('rejects a Dockerfile outside the build context', async () => {
    const { call, projectId } = await withProject();

    const response = await call(`/api/projects/${projectId}/services`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'api',
        repoFullName: 'mohammed/milo',
        branch: 'main',
        contextPath: 'apps/api',
        dockerfilePath: 'Dockerfile',
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'dockerfile_outside_context' } });
  });

  test('non-default environments get a suffixed host', async () => {
    const { call, projectId } = await withProject();
    const envResponse = await call(`/api/projects/${projectId}/environments`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Staging' }),
    });
    const { environment } = (await envResponse.json()) as { environment: { id: string } };

    const response = await call(`/api/projects/${projectId}/services`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'api',
        repoFullName: 'mohammed/milo',
        branch: 'develop',
        environmentId: environment.id,
      }),
    });

    const body = (await response.json()) as { serviceEnv: { generatedHost: string } };
    expect(body.serviceEnv.generatedHost).toBe('api-staging.apps.example.com');
  });

  test('patches branch and port, keeping the host stable', async () => {
    const { call, projectId } = await withProject();
    const created = (await (
      await call(`/api/projects/${projectId}/services`, {
        method: 'POST',
        body: JSON.stringify({ name: 'api', repoFullName: 'mohammed/milo', branch: 'main' }),
      })
    ).json()) as { service: { id: string }; serviceEnv: { id: string; generatedHost: string } };

    const detail = (await (await call(`/api/projects/${projectId}`)).json()) as {
      environments: { id: string }[];
    };
    const envId = detail.environments[0]?.id ?? '';

    const patched = await call(`/api/services/${created.service.id}/envs/${envId}`, {
      method: 'PATCH',
      body: JSON.stringify({ branch: 'release', containerPort: 8080, healthPath: '/healthz' }),
    });
    const body = (await patched.json()) as {
      serviceEnv: { branch: string; generatedHost: string };
    };

    expect(patched.status).toBe(200);
    expect(body.serviceEnv.branch).toBe('release');
    expect(body.serviceEnv.generatedHost).toBe(created.serviceEnv.generatedHost);
  });
});

async function withService() {
  const ctx = await signedIn();
  const created = await ctx.call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Milo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const service = await ctx.call(`/api/projects/${project.id}/services`, {
    method: 'POST',
    body: JSON.stringify({ name: 'api', repoFullName: 'mohammed/milo', branch: 'main' }),
  });
  const body = (await service.json()) as { service: { id: string } };
  const detail = (await (await ctx.call(`/api/projects/${project.id}`)).json()) as {
    environments: { id: string }[];
  };
  return { ...ctx, serviceId: body.service.id, envId: detail.environments[0]?.id ?? '' };
}

describe('variables', () => {
  test('stores encrypted values and masks secrets on read', async () => {
    const { call, db, serviceId, envId } = await withService();

    const put = await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({
        variables: [
          { key: 'DATABASE_URL', value: 'postgres://secret', isSecret: true },
          { key: 'NODE_ENV', value: 'production', isSecret: false },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const raw = JSON.stringify(db.$client.query('SELECT * FROM variables').all());
    expect(raw).not.toContain('postgres://secret');

    const masked = (await (
      await call(`/api/services/${serviceId}/envs/${envId}/variables`)
    ).json()) as {
      variables: { key: string; value: string; hidden: boolean }[];
    };
    expect(masked.variables.find((v) => v.key === 'DATABASE_URL')).toMatchObject({ hidden: true });
    expect(masked.variables.find((v) => v.key === 'NODE_ENV')?.value).toBe('production');

    const revealed = (await (
      await call(`/api/services/${serviceId}/envs/${envId}/variables?reveal=1`)
    ).json()) as { variables: { key: string; value: string }[] };
    expect(revealed.variables.find((v) => v.key === 'DATABASE_URL')?.value).toBe(
      'postgres://secret',
    );
  });

  test('bulk replace is total, not additive', async () => {
    const { call, serviceId, envId } = await withService();

    await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({ variables: [{ key: 'A', value: '1', isSecret: false }] }),
    });
    await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({ variables: [{ key: 'B', value: '2', isSecret: false }] }),
    });

    const listed = (await (
      await call(`/api/services/${serviceId}/envs/${envId}/variables`)
    ).json()) as { variables: { key: string }[] };
    expect(listed.variables.map((v) => v.key)).toEqual(['B']);
  });

  test('rejects duplicate and shell-hostile keys', async () => {
    const { call, serviceId, envId } = await withService();

    const duplicate = await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({
        variables: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      }),
    });
    expect(duplicate.status).toBe(422);

    const hostile = await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({ variables: [{ key: 'BAD KEY;rm -rf', value: 'x' }] }),
    });
    expect(hostile.status).toBe(422);
  });
});

describe('authorization and cascades', () => {
  test('CRUD requires a session', async () => {
    const { db } = testDb();
    const app = createApp({ config, db, github });
    const response = await app.request('/api/projects');
    expect(response.status).toBe(401);
  });

  test('mutations require a same-origin Origin header', async () => {
    const { db } = testDb();
    const authed = createApp({ config, db, github });
    const response = await authed.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Milo' }),
    });
    expect(response.status).toBe(403);
  });

  test('deleting a project removes its services, envs and variables', async () => {
    const signedInCtx = await signedIn();
    const created = await signedInCtx.call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Milo' }),
    });
    const { project } = (await created.json()) as { project: { id: string } };

    const service = await signedInCtx.call(`/api/projects/${project.id}/services`, {
      method: 'POST',
      body: JSON.stringify({ name: 'api', repoFullName: 'mohammed/milo', branch: 'main' }),
    });
    const { service: createdService } = (await service.json()) as { service: { id: string } };
    const detail = (await (await signedInCtx.call(`/api/projects/${project.id}`)).json()) as {
      environments: { id: string }[];
    };

    await signedInCtx.call(
      `/api/services/${createdService.id}/envs/${detail.environments[0]?.id}/variables`,
      { method: 'PUT', body: JSON.stringify({ variables: [{ key: 'A', value: '1' }] }) },
    );

    const deleted = await signedInCtx.call(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const remaining = signedInCtx.db.$client
      .query('SELECT (SELECT count(*) FROM services) AS s, (SELECT count(*) FROM variables) AS v')
      .get() as { s: number; v: number };
    expect(remaining).toEqual({ s: 0, v: 0 });
  });
});

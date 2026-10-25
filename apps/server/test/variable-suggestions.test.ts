import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import type { GitHubClient, GitHubFile } from '../src/auth/github';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { loadConfig } from '../src/config';
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

const ENV_EXAMPLE = [
  '# Database connection',
  'DATABASE_URL=postgres://user:placeholder@db/app',
  'export NODE_ENV=production',
  '#STRIPE_SECRET=sk_test_disabled',
  'STRIPE_SECRET=',
  'PORT=3000',
  'LOG_LEVEL=info',
].join('\n');

interface Seen {
  refs: string[];
  paths: string[];
}

function fakeGitHub(
  files: Record<string, string>,
  opts: { paths?: string[]; fail?: Error; ops?: boolean } = {},
) {
  const seen: Seen = { refs: [], paths: [] };
  const paths = opts.paths ?? Object.keys(files);

  const client: GitHubClient = {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho_test', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async () => ({ repos: [], hasMore: false }),
    listBranches: async () => ['main', 'develop'],
    ...(opts.ops === false
      ? {}
      : {
          getRepo: async () => ({
            fullName: 'mohammed/milo',
            defaultBranch: 'main',
            private: false,
          }),
          listTree: async (_token: string, _repo: string, ref: string) => {
            seen.refs.push(ref);
            if (opts.fail) throw opts.fail;
            return { paths, truncated: false };
          },
          getFile: async (
            _token: string,
            _repo: string,
            path: string,
            ref: string,
          ): Promise<GitHubFile | null> => {
            seen.refs.push(ref);
            seen.paths.push(path);
            const content = files[path];
            return content === undefined ? null : { content, sha: 'sha' };
          },
        }),
  };

  return { client, seen };
}

async function signedIn(github: GitHubClient) {
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

/** A project with one service whose env tracks `branch`, which is what the scan reads. */
async function withService(github: GitHubClient, branch = 'main') {
  const ctx = await signedIn(github);

  const project = (await (
    await ctx.call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Milo' }) })
  ).json()) as { project: { id: string } };

  const service = (await (
    await ctx.call(`/api/projects/${project.project.id}/services`, {
      method: 'POST',
      body: JSON.stringify({ name: 'api', repoFullName: 'mohammed/milo', branch }),
    })
  ).json()) as { service: { id: string } };

  const detail = (await (await ctx.call(`/api/projects/${project.project.id}`)).json()) as {
    environments: { id: string }[];
  };

  return {
    ...ctx,
    serviceId: service.service.id,
    envId: detail.environments[0]?.id ?? '',
    suggestions: () =>
      ctx.call(
        `/api/services/${service.service.id}/envs/${detail.environments[0]?.id}/variable-suggestions`,
      ),
  };
}

describe('variable suggestions', () => {
  test('offers the names from .env.example with secret flags, never the values', async () => {
    const { client } = fakeGitHub({ '.env.example': ENV_EXAMPLE });
    const { suggestions, call, serviceId, envId } = await withService(client);

    const response = await suggestions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      source: string | null;
      values: { key: string; isSecret: boolean; comment: string | null }[];
      note: string | null;
    };

    expect(body.source).toBe('.env.example');
    expect(body.note).toBeNull();
    expect(body.values).toEqual([
      { key: 'DATABASE_URL', isSecret: false, comment: 'Database connection' },
      { key: 'NODE_ENV', isSecret: false, comment: null },
      { key: 'STRIPE_SECRET', isSecret: true, comment: null },
      { key: 'PORT', isSecret: false, comment: null },
      { key: 'LOG_LEVEL', isSecret: false, comment: null },
    ]);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('postgres://user:placeholder@db/app');
    expect(raw).not.toContain('sk_test_disabled');

    // Once one is set, the panel stops offering it.
    await call(`/api/services/${serviceId}/envs/${envId}/variables`, {
      method: 'PUT',
      body: JSON.stringify({ variables: [{ key: 'PORT', value: '8080', isSecret: false }] }),
    });

    const after = (await (await suggestions()).json()) as { values: { key: string }[] };
    expect(after.values.map((entry) => entry.key)).not.toContain('PORT');
  });

  test('reads the environment branch, not the default one', async () => {
    const { client, seen } = fakeGitHub({ '.env.example': ENV_EXAMPLE });
    const { suggestions } = await withService(client, 'develop');

    await suggestions();

    expect(seen.refs.length).toBeGreaterThan(0);
    expect(new Set(seen.refs)).toEqual(new Set(['develop']));
  });

  test('prefers the shallowest template and stops at the first hit', async () => {
    const { client, seen } = fakeGitHub(
      {
        'apps/api/.env.example': 'NESTED_ONLY=1',
        '.env.example': 'ROOT_ONLY=1',
      },
      { paths: ['apps/api/.env.example', '.env.example'] },
    );
    const { suggestions } = await withService(client);

    const body = (await (await suggestions()).json()) as { source: string; values: unknown[] };
    expect(body.source).toBe('.env.example');
    expect(body.values).toHaveLength(1);
    expect(seen.paths).toEqual(['.env.example']);
  });

  test('a repo with no template is an answer, not an error', async () => {
    const { client } = fakeGitHub({}, { paths: ['src/index.ts', 'Dockerfile'] });
    const { suggestions } = await withService(client);

    const response = await suggestions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { source: null; values: unknown[]; note: string };
    expect(body.source).toBeNull();
    expect(body.values).toEqual([]);
    expect(body.note).toContain('no .env.example');
  });

  test('GitHub failing never breaks the variables tab', async () => {
    const { client } = fakeGitHub({}, { fail: new Error('boom') });
    const { suggestions } = await withService(client);

    const response = await suggestions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { source: null; values: unknown[]; note: string };
    expect(body.source).toBeNull();
    expect(body.values).toEqual([]);
    expect(body.note).toContain('boom');
  });

  test('a client without the file ops degrades instead of throwing', async () => {
    const { client } = fakeGitHub({}, { ops: false });
    const { suggestions } = await withService(client);

    const response = await suggestions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { source: null; note: string };
    expect(body.source).toBeNull();
    expect(body.note).toContain('not available');
  });
});

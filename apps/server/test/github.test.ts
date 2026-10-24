import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { GitHubHttpError, type GitHubClient, type GitHubRepo } from '../src/auth/github';
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

const repo = (n: number): GitHubRepo => ({
  fullName: `mohammed/repo-${n}`,
  name: `repo-${n}`,
  owner: 'mohammed',
  private: n % 2 === 0,
  archived: false,
  defaultBranch: 'main',
  pushedAt: '2026-10-01T00:00:00Z',
});

function fakeGitHub(overrides: Partial<GitHubClient> = {}) {
  const calls = { listRepos: 0, listBranches: 0 };

  const client: GitHubClient = {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho_token', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async (_token, page = { page: 1, perPage: 100 }) => {
      calls.listRepos += 1;
      const repos = Array.from({ length: page.perPage === 100 ? 2 : 1 }, (_, i) =>
        repo(page.page * 10 + i),
      );
      // First page reports more; anything else ends the pagination.
      return { repos, hasMore: page.page === 1 };
    },
    listBranches: async () => {
      calls.listBranches += 1;
      return ['main', 'develop'];
    },
    ...overrides,
  };

  return { client, calls };
}

async function signedIn(github: GitHubClient) {
  const { db } = testDb();
  const app = createApp({ config, db, github });

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

  return { app, db, cookie };
}

describe('GET /api/github/repos', () => {
  test('paginates, reports truncation and maps repo fields', async () => {
    const { client } = fakeGitHub();
    const { app, cookie } = await signedIn(client);

    const response = await app.request('/api/github/repos', { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      repos: GitHubRepo[];
      truncated: boolean;
    };
    expect(body.repos.length).toBe(4); // 2 pages × 2
    expect(body.repos[0]).toMatchObject({ fullName: 'mohammed/repo-10', defaultBranch: 'main' });
    expect(body.truncated).toBe(false);
  });

  test('caches for a minute so reopening the wizard does not hit GitHub', async () => {
    const { client, calls } = fakeGitHub();
    const { app, cookie } = await signedIn(client);

    await app.request('/api/github/repos', { headers: { cookie } });
    const second = await app.request('/api/github/repos', { headers: { cookie } });

    expect(second.status).toBe(200);
    expect(calls.listRepos).toBe(2); // two pages, once — not four
  });

  test('a rejected token surfaces as 401 github_token_rejected', async () => {
    const { client } = fakeGitHub({
      listRepos: async () => {
        throw new GitHubHttpError(401, 'GitHub rejected the token');
      },
    });
    const { app, cookie } = await signedIn(client);

    const response = await app.request('/api/github/repos', { headers: { cookie } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'github_token_rejected' } });
  });

  test('a rate limit surfaces as 429', async () => {
    const { client } = fakeGitHub({
      listRepos: async () => {
        throw new GitHubHttpError(429, 'GitHub rate limit reached');
      },
    });
    const { app, cookie } = await signedIn(client);

    const response = await app.request('/api/github/repos', { headers: { cookie } });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'github_rate_limited' } });
  });

  test('requires a session', async () => {
    const { client } = fakeGitHub();
    const { app } = await signedIn(client);
    const response = await app.request('/api/github/repos');
    expect(response.status).toBe(401);
  });
});

describe('GET /api/github/repos/:owner/:repo/branches', () => {
  test('returns branch names and caches them', async () => {
    const { client, calls } = fakeGitHub();
    const { app, cookie } = await signedIn(client);

    const first = await app.request('/api/github/repos/mohammed/repo-10/branches', {
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ branches: ['main', 'develop'] });

    await app.request('/api/github/repos/mohammed/repo-10/branches', { headers: { cookie } });
    expect(calls.listBranches).toBe(1);
  });

  test('an inaccessible repo surfaces as 404', async () => {
    const { client } = fakeGitHub({
      listBranches: async () => {
        throw new GitHubHttpError(404, 'Repository not found');
      },
    });
    const { app, cookie } = await signedIn(client);

    const response = await app.request('/api/github/repos/mohammed/secret/branches', {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'github_not_found' } });
  });
});

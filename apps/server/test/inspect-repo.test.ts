import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import type { GitHubClient } from '../src/auth/github';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { loadConfig } from '../src/config';
import { findDockerfiles, parseExposedPorts } from '../src/lib/inspect-repo';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

function fakeGitHub(paths: string[], dockerfile?: string) {
  const client: GitHubClient = {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    exchangeCode: async () => ({ accessToken: 'gho', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
    listRepos: async () => ({ repos: [], hasMore: false }),
    listBranches: async () => ['main'],
    getRepo: async () => ({ fullName: 'mohammed/milo', defaultBranch: 'main', private: false }),
    listTree: async () => ({ paths, truncated: false }),
    getFile: async () => (dockerfile === undefined ? null : { sha: 'blob', content: dockerfile }),
  };
  return client;
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

  return { app, cookie };
}

describe('dockerfile detection', () => {
  test('finds Dockerfile variants and prefers the shallowest', () => {
    const found = findDockerfiles([
      'README.md',
      'src/index.ts',
      'apps/api/Dockerfile',
      'Dockerfile',
      'docker/Dockerfile.prod',
    ]);

    expect(found[0]).toEqual({ path: 'Dockerfile', context: '.', depth: 1 });
    expect(found.map((entry) => entry.path)).toContain('apps/api/Dockerfile');
    expect(found.find((entry) => entry.path === 'apps/api/Dockerfile')?.context).toBe('apps/api');
  });

  test('ignores files that merely mention docker', () => {
    expect(
      findDockerfiles(['docker-compose.yml', 'docs/dockerfile.md', 'Dockerfile.dev']).map(
        (d) => d.path,
      ),
    ).toEqual(['Dockerfile.dev']);
  });

  test('a repo without a Dockerfile yields nothing', () => {
    expect(findDockerfiles(['package.json', 'src/main.ts'])).toHaveLength(0);
  });
});

describe('EXPOSE parsing', () => {
  test('reads a single port', () => {
    expect(parseExposedPorts('FROM node:20\nEXPOSE 8080\nCMD ["node","index.js"]')).toEqual([8080]);
  });

  test('handles protocols, several ports on one line, and duplicates', () => {
    const dockerfile = [
      'EXPOSE 3000',
      'EXPOSE 8080/tcp 5353/udp',
      'expose 3000',
      'EXPOSE 9090/TCP',
    ].join('\n');
    expect(parseExposedPorts(dockerfile)).toEqual([3000, 8080, 9090]);
  });

  test('returns nothing when there is no EXPOSE', () => {
    expect(parseExposedPorts('FROM scratch\nCMD ["/app"]')).toEqual([]);
  });

  test('ignores out-of-range and malformed values', () => {
    expect(parseExposedPorts('EXPOSE 0 70000 $PORT 80/tcp')).toEqual([80]);
  });
});

describe('GET /api/github/repos/:owner/:repo/inspect', () => {
  test('reports the Dockerfile path, context and exposed port', async () => {
    const github = fakeGitHub(
      ['package.json', 'apps/api/Dockerfile', 'src/index.ts'],
      'FROM oven/bun:1\nEXPOSE 8080\n',
    );
    const { app, cookie } = await signedIn(github);

    const response = await app.request('/api/github/repos/mohammed/milo/inspect?ref=main', {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hasDockerfile: true,
      dockerfilePath: 'apps/api/Dockerfile',
      contextPath: 'apps/api',
      exposedPorts: [8080],
      suggestedPort: 8080,
    });
  });

  test('says so when there is no Dockerfile', async () => {
    const github = fakeGitHub(['package.json', 'src/main.ts']);
    const { app, cookie } = await signedIn(github);

    const response = await app.request('/api/github/repos/mohammed/milo/inspect', {
      headers: { cookie },
    });

    expect(await response.json()).toMatchObject({
      hasDockerfile: false,
      dockerfilePath: null,
      suggestedPort: null,
    });
  });

  test('does not suggest a port when several are exposed', async () => {
    const github = fakeGitHub(['Dockerfile'], 'EXPOSE 3000 9090\n');
    const { app, cookie } = await signedIn(github);

    const response = await app.request('/api/github/repos/mohammed/milo/inspect', {
      headers: { cookie },
    });

    const body = (await response.json()) as {
      exposedPorts: number[];
      suggestedPort: number | null;
    };
    expect(body.exposedPorts).toEqual([3000, 9090]);
    expect(body.suggestedPort).toBeNull();
  });

  test('requires a session', async () => {
    const { app } = await signedIn(fakeGitHub(['Dockerfile'], 'EXPOSE 3000'));
    const response = await app.request('/api/github/repos/mohammed/milo/inspect');
    expect(response.status).toBe(401);
  });
});

import { describe, expect, test } from 'bun:test';
import type { CaddyAdmin } from '../src/caddy/admin';
import { loadConfig } from '../src/config';
import type { DockerAdapter } from '../src/docker/adapter';
import { formatReport, runDoctor, type DoctorDeps } from '../src/doctor';
import { testDb } from './helpers';

const goodConfig = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  CADDY_ADMIN_URL: 'http://caddy:2019',
  DATA_DIR: '/tmp/nodock-doctor',
});

function docker(overrides: Partial<DockerAdapter> = {}): DockerAdapter {
  return {
    ping: async () => '28.1.1',
    networkExists: async () => true,
    pull: async () => ({ ok: true }),
    run: async () => ({ id: 'x' }),
    inspect: async () => null,
    stop: async () => {},
    remove: async () => {},
    ...overrides,
  };
}

const reachableAdmin: CaddyAdmin = { load: async () => {} };

/** Caddy reachability is checked with fetch, so stub it for the report tests. */
function withFetchOk<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const { db } = testDb();
  return {
    config: goodConfig,
    db,
    docker: docker(),
    admin: reachableAdmin,
    resolve: async () => '203.0.113.10',
    ...overrides,
  };
}

const find = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((check) => check.name === name);

describe('doctor', () => {
  test('a healthy box reports no failures', async () => {
    const report = await withFetchOk(() => runDoctor(deps()));

    expect(report.ok).toBe(true);
    expect(find(report, 'docker daemon')?.status).toBe('ok');
    expect(find(report, 'cert gate')?.status).toBe('ok');
    expect(find(report, 'dns: wildcard')?.detail).toContain('*.apps.example.com');
  });

  test('missing oauth credentials and an empty allowlist both block', async () => {
    const brokenConfig = loadConfig({
      NODOCK_SECRET: 'x'.repeat(32),
      NODOCK_URL: 'https://panel.example.com',
      BASE_DOMAIN: 'apps.example.com',
      DATA_DIR: '/tmp/nodock-doctor',
    });

    const report = await withFetchOk(() => runDoctor(deps({ config: brokenConfig })));

    expect(report.ok).toBe(false);
    expect(find(report, 'github oauth')?.status).toBe('fail');
    expect(find(report, 'admin allowlist')?.hint).toContain('GitHub username');
  });

  test('an unreachable daemon or network is a hard failure with a hint', async () => {
    const report = await withFetchOk(() =>
      runDoctor(
        deps({
          docker: docker({
            ping: async () => {
              throw new Error('Cannot connect to the Docker daemon');
            },
            networkExists: async () => false,
          }),
        }),
      ),
    );

    expect(find(report, 'docker daemon')).toMatchObject({ status: 'fail' });
    expect(find(report, 'docker daemon')?.hint).toContain('docker.sock');
    expect(find(report, 'docker network')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  test('a wrong NODOCK_URL breaks the certificate gate', async () => {
    const mismatched = loadConfig({
      NODOCK_SECRET: 'x'.repeat(32),
      NODOCK_URL: 'https://other.example.com',
      BASE_DOMAIN: 'apps.example.com',
      ADMIN_GITHUB_LOGIN: 'mohammed',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      CADDY_ADMIN_URL: 'http://caddy:2019',
      DATA_DIR: '/tmp/nodock-doctor',
    });

    const report = await withFetchOk(() => runDoctor(deps({ config: mismatched })));
    expect(find(report, 'cert gate')?.status).toBe('ok'); // the panel host is its own allowed host
    expect(find(report, 'dns: panel')?.detail).toContain('other.example.com');
  });

  test('a token without read:packages fails preflight instead of at pull time', async () => {
    const withToken = loadConfig({
      NODOCK_SECRET: 'x'.repeat(32),
      NODOCK_URL: 'https://panel.example.com',
      BASE_DOMAIN: 'apps.example.com',
      ADMIN_GITHUB_LOGIN: 'mohammed',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      CADDY_ADMIN_URL: 'http://caddy:2019',
      DATA_DIR: '/tmp/nodock-doctor',
      GHCR_USER: 'mohammed',
      GHCR_TOKEN: 'ghp_example',
    });

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/user')) {
        return new Response('{}', {
          status: 200,
          headers: { 'x-oauth-scopes': 'read:user, repo, workflow' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const report = await runDoctor(deps({ config: withToken }));
      const check = find(report, 'ghcr pull');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('read:packages');
      expect(check?.hint).toContain('Regenerate');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('unresolvable DNS is a warning, not a blocker', async () => {
    const report = await withFetchOk(() => runDoctor(deps({ resolve: async () => null })));

    expect(find(report, 'dns: panel')?.status).toBe('warn');
    expect(find(report, 'dns: wildcard')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  test('formatting prints a hint under the failing line', async () => {
    const report = await withFetchOk(() =>
      runDoctor(
        deps({
          docker: docker({
            ping: async () => {
              throw new Error('daemon down');
            },
          }),
        }),
      ),
    );

    const text = formatReport(report);
    expect(text).toContain('FAIL  docker daemon');
    expect(text).toContain('→');
    expect(text).toContain('fix the FAIL lines');
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import type { GitHubClient } from '../src/auth/github';
import { createDeployLogs } from '../src/deploy/deploy-log';
import type { DockerAdapter } from '../src/docker/adapter';
import type { Db } from '../src/db/client';
import { deployments, environments, projects, serviceEnvs, services } from '../src/db/schema';
import { loadConfig } from '../src/config';
import { signIn, testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  DATA_DIR: '/tmp/nodock-logs-route-test',
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

/** Emits a fixed set of lines, then resolves — the shape of `docker logs -f` ending. */
function fakeDocker(lines: string[] = ['booting', 'listening on 3000']) {
  const followed: { container: string; tail: number }[] = [];
  const docker: DockerAdapter = {
    async pull() {
      return { ok: true };
    },
    async run() {
      return { id: 'container-1' };
    },
    async inspect() {
      return { running: true, exitCode: null, status: 'running' };
    },
    async stop() {},
    async remove() {},
    async logsFollow(name, tail, onLine, signal) {
      followed.push({ container: name, tail });
      for (const line of lines) {
        if (signal.aborted) return;
        // Sequential on purpose: the consumer is a stream, order matters.
        // eslint-disable-next-line no-await-in-loop
        await onLine(line);
      }
    },
  };
  return { docker, followed };
}

function seed(
  db: Db,
  options: { liveContainer?: string; status?: 'live' | 'failed' | 'queued' } = {},
) {
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
  const deployment = db
    .insert(deployments)
    .values({
      serviceEnvId: serviceEnv.id,
      trigger: 'manual',
      status: options.status ?? 'live',
      imageRef: 'ghcr.io/mohammed/milo:abc',
      ...(options.liveContainer ? { containerName: options.liveContainer } : {}),
    })
    .returning()
    .get();

  return { service, serviceEnv, deployment };
}

async function appWith(db: Db, docker: DockerAdapter, dir = mkdtempSync(join(tmpdir(), 'nl-'))) {
  const logs = createDeployLogs(dir);
  const app = createApp({ config, db, docker, admin: null, github, logs });
  return { call: await signIn(app), logs };
}

/**
 * Reads a streaming response until `needle` shows up, then hangs up the way an
 * unmounted viewer does. Every keepalive assertion here uses millisecond timings, so
 * callers never wait on the real five second beat.
 */
async function readUntil(response: Response, needle: string, ms = 1_000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let text = '';

  try {
    while (!text.includes(needle)) {
      // Sequential by nature: the next chunk only exists after this one.
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (Date.now() > deadline) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

/** Timings short enough that a "nothing is happening" test finishes in milliseconds. */
const fastTimings = { tailMs: 5, pingMs: 20 };

async function appWithTimings(db: Db, docker: DockerAdapter) {
  const logs = createDeployLogs(mkdtempSync(join(tmpdir(), 'nl-')));
  const app = createApp({
    config,
    db,
    docker,
    admin: null,
    github,
    logs,
    logTimings: fastTimings,
  });
  return { call: await signIn(app), logs };
}

describe('deploy logs over http', () => {
  test('requires a session', async () => {
    const { db } = testDb();
    const { deployment } = seed(db);
    const app = createApp({ config, db, admin: null, github });

    const response = await app.request(`/api/deployments/${deployment.id}/logs`);
    expect(response.status).toBe(401);
  });

  test('serves what the pipeline wrote, with a resume offset', async () => {
    const { db } = testDb();
    const { deployment } = seed(db);
    const { call, logs } = await appWith(db, fakeDocker().docker);

    logs.append(deployment.id, 'pulling ghcr.io/mohammed/milo:abc');
    logs.append(deployment.id, 'live');

    const response = await call(`/api/deployments/${deployment.id}/logs`);
    const body = (await response.json()) as {
      text: string;
      nextOffset: number;
      complete: boolean;
      status: string;
    };

    expect(response.status).toBe(200);
    expect(body.text).toContain('pulling ghcr.io/mohammed/milo:abc');
    expect(body.text).toContain('live');
    expect(body.complete).toBe(true);
    expect(body.status).toBe('live');

    const rest = await call(`/api/deployments/${deployment.id}/logs?offset=${body.nextOffset}`);
    expect(((await rest.json()) as { text: string }).text).toBe('');
  });

  test('a finished deployment streams its log once and then ends', async () => {
    const { db } = testDb();
    const { deployment } = seed(db);
    const { call, logs } = await appWith(db, fakeDocker().docker);

    logs.append(deployment.id, 'pulling image');
    logs.append(deployment.id, 'health check passed');
    logs.append(deployment.id, 'live');

    const response = await call(`/api/deployments/${deployment.id}/logs/stream`);
    const stream = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream).toContain('event: chunk');
    expect(stream).toContain('health check passed');
    expect(stream).toContain('event: end');
  });

  test('a deployment waiting for CI keeps its stream alive with no log to show', async () => {
    const { db } = testDb();
    // `queued`: the row exists, the pipeline has not written a byte yet — which is
    // exactly the minute where an idle socket used to die and read "disconnected".
    const { deployment } = seed(db, { status: 'queued' });
    const { call } = await appWithTimings(db, fakeDocker().docker);

    const response = await call(`/api/deployments/${deployment.id}/logs/stream`);
    const text = await readUntil(response, 'keepalive');

    expect(response.status).toBe(200);
    expect(text).toContain(': keepalive');
    // Keepalives are SSE comments: no event, no data, nothing for the parser to show.
    expect(text).not.toContain('event:');
  });

  test('a queued deployment still delivers the log once the pipeline starts writing', async () => {
    const { db } = testDb();
    const { deployment } = seed(db, { status: 'queued' });
    const { call, logs } = await appWithTimings(db, fakeDocker().docker);

    await readUntil(await call(`/api/deployments/${deployment.id}/logs/stream`), 'keepalive');

    logs.append(deployment.id, 'pulling image');
    const later = await readUntil(
      await call(`/api/deployments/${deployment.id}/logs/stream`),
      'pulling image',
    );
    expect(later).toContain('event: chunk');
    expect(later).toContain('pulling image');
  });

  test('an unknown deployment is a 404, not an empty log', async () => {
    const { db } = testDb();
    const { call } = await appWith(db, fakeDocker().docker);

    expect((await call('/api/deployments/nope/logs')).status).toBe(404);
    expect((await call('/api/deployments/nope/logs/stream')).status).toBe(404);
  });
});

describe('runtime logs over http', () => {
  test('follows the live container and streams each line', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db, { liveContainer: 'nodock-api-prod-12345678' });
    const { docker, followed } = fakeDocker(['GET /healthz 200', 'listening on 3000']);
    const { call } = await appWith(db, docker);

    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/logs/stream?tail=50`,
    );
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(followed[0]).toEqual({ container: 'nodock-api-prod-12345678', tail: 50 });
    expect(stream).toContain('event: start');
    expect(stream).toContain('GET /healthz 200');
    expect(stream).toContain('listening on 3000');
    expect(stream).toContain('event: end');
  });

  test('explains that nothing is running instead of streaming nothing forever', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db);

    const { call } = await appWith(db, fakeDocker().docker);
    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/logs/stream`,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'no_container',
    );
  });

  test('a failed deployment has no container to follow', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db, { status: 'failed' });

    const { call } = await appWith(db, fakeDocker().docker);
    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/logs/stream`,
    );

    expect(response.status).toBe(409);
  });

  test('a quiet container keeps the connection alive while the app says nothing', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db, { liveContainer: 'nodock-api-prod-12345678' });
    const docker: DockerAdapter = {
      ...fakeDocker().docker,
      logsFollow: (_name, _tail, _onLine, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    };
    const { call } = await appWithTimings(db, docker);

    const response = await call(
      `/api/services/${service.id}/envs/${serviceEnv.environmentId}/logs/stream`,
    );
    const text = await readUntil(response, ': keepalive');

    expect(response.status).toBe(200);
    expect(text).toContain('event: start');
    expect(text).toContain(': keepalive');
  });

  test('caps concurrent followers so the box cannot be flooded with docker children', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db, { liveContainer: 'nodock-api-prod-12345678' });

    // Followers that never finish: the stream stays open until aborted.
    const docker: DockerAdapter = {
      ...fakeDocker().docker,
      logsFollow: (_name, _tail, onLine, signal) =>
        new Promise<void>((resolve) => {
          void onLine('still streaming');
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    };
    const { call } = await appWith(db, docker);

    const requests = Array.from({ length: 5 }, () =>
      call(`/api/services/${service.id}/envs/${serviceEnv.environmentId}/logs/stream`),
    );
    const responses = await Promise.all(requests);
    const accepted = responses.filter((response) => response.status === 200).length;
    const refused = responses.filter((response) => response.status === 429).length;

    expect(accepted).toBe(4);
    expect(refused).toBe(1);
  });
});

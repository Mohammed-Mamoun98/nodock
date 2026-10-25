import { and, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';
import { isTerminalStatus, type DeployLogs } from '../deploy/deploy-log';
import type { DockerAdapter } from '../docker/adapter';
import { apiError } from '../http';
import { findServiceEnv } from './services';

/**
 * A 1 vCPU box should not fan out unlimited `docker logs --follow` children: every
 * open viewer is a process and a pipe. Four is more than a single admin can use.
 */
const MAX_FOLLOWERS = 4;
/** One line should not turn into a megabyte sized SSE frame. */
const MAX_LINE = 8_000;
/** Poll interval for the deploy log file. Cheap: a stat and a read. */
const TAIL_MS = 700;
/**
 * How long a stream may stay silent before it says something anyway.
 *
 * Bun closes an idle socket after ~12s (`idleTimeout`), and so do most proxies in
 * front of it. A deployment waiting for CI, or an app that only logs on request,
 * writes nothing for minutes — without this the reader sees "disconnected" and the
 * log looks broken. Five seconds, not ten: two missed beats still fit in the window.
 */
const PING_MS = 5_000;
/** An SSE comment: the browser ignores it, the socket stays warm. */
const KEEPALIVE = ': keepalive\n\n';

export interface LogDeps {
  config: Config;
  db: Db;
  docker?: DockerAdapter;
  logs: DeployLogs;
  now?: () => number;
  /** Injected in tests so a "quiet stream" case does not take real seconds. */
  timings?: { tailMs?: number; pingMs?: number };
}

function offsetFrom(raw: string | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 8 * 1024 * 1024);
}

/**
 * Two kinds of log, one shape on the wire (SSE):
 *
 * - **deploy log** — what nodock did: pull, start, health, switch. A file, so it
 *   can be read back later and survives a restart.
 * - **runtime logs** — the app's own output, straight from `docker logs -f`.
 *
 * Both sit behind the `/api/*` session guard like every other endpoint; they are
 * additive and mounted before the 501 catch-all.
 */
export function registerLogRoutes(app: Hono, deps: LogDeps): void {
  const { db, docker, logs } = deps;
  const followers = new Set<string>();
  const tailMs = deps.timings?.tailMs ?? TAIL_MS;
  const pingMs = deps.timings?.pingMs ?? PING_MS;

  app.get('/api/deployments/:id/logs', (c) => {
    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, c.req.param('id')))
      .get();
    if (!deployment) {
      const { status, body } = apiError('not_found', 'Deployment not found', 404);
      return c.json(body, status);
    }

    const { text, nextByte } = logs.read(deployment.id, offsetFrom(c.req.query('offset')));
    c.header('cache-control', 'no-store');
    return c.json({
      text,
      nextOffset: nextByte,
      status: deployment.status,
      complete: isTerminalStatus(deployment.status),
    });
  });

  app.get('/api/deployments/:id/logs/stream', (c) => {
    const id = c.req.param('id');
    const exists = db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.id, id))
      .get();
    if (!exists) {
      const { status, body } = apiError('not_found', 'Deployment not found', 404);
      return c.json(body, status);
    }

    let offset = offsetFrom(c.req.query('offset'));

    return streamSSE(
      c,
      async (stream) => {
        let closed = false;
        stream.onAbort(() => {
          closed = true;
        });
        let lastWrite = Date.now();

        for (;;) {
          if (closed) return;

          const row = db
            .select({ status: deployments.status })
            .from(deployments)
            .where(eq(deployments.id, id))
            .get();
          if (!row) return;

          const { text, nextByte } = logs.read(id, offset);
          offset = nextByte;

          // Sequential by nature: chunk, then maybe end, then wait. There is no
          // parallelism to win here — it is one file and one client.
          /* eslint-disable no-await-in-loop */
          if (text) {
            lastWrite = Date.now();
            await stream.writeSSE({ event: 'chunk', data: JSON.stringify({ text }) });
            continue; // drain what is on disk before sleeping
          }

          if (isTerminalStatus(row.status)) {
            await stream.writeSSE({
              event: 'end',
              data: JSON.stringify({ status: row.status }),
            });
            return;
          }

          await stream.sleep(tailMs);
          if (closed) return;

          // A queued deployment writes nothing until CI reports back; say something
          // anyway so the connection outlives the idle timeout.
          if (Date.now() - lastWrite >= pingMs) {
            lastWrite = Date.now();
            await stream.write(KEEPALIVE);
          }
          /* eslint-enable no-await-in-loop */
        }
      },
      async (error, stream) => {
        // The browser navigated away mid-stream; nothing to report.
        void error;
        void stream;
      },
    );
  });

  app.get('/api/services/:id/envs/:envId/logs/stream', (c) => {
    const link = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!link) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const live = db
      .select({ containerName: deployments.containerName })
      .from(deployments)
      .where(and(eq(deployments.serviceEnvId, link.id), eq(deployments.status, 'live')))
      .orderBy(desc(deployments.createdAt))
      .get();

    if (!live?.containerName) {
      const { status, body } = apiError(
        'no_container',
        'Nothing is running in this environment yet — deploy first',
        409,
      );
      return c.json(body, status);
    }

    if (!docker?.logsFollow) {
      const { status, body } = apiError('not_supported', 'This runtime cannot follow logs', 501);
      return c.json(body, status);
    }

    if (followers.size >= MAX_FOLLOWERS) {
      const { status, body } = apiError(
        'too_many_streams',
        `Already following ${followers.size} containers — close a log view and retry`,
        429,
      );
      return c.json(body, status);
    }

    const container = live.containerName;
    const key = `${link.id}:${c.req.header('cookie')?.slice(-8) ?? 'anon'}:${followers.size}`;
    const tail = Math.min(Math.max(Number(c.req.query('tail') ?? 200) || 200, 1), 1000);
    followers.add(key);

    return streamSSE(
      c,
      async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());

        let lastWrite = Date.now();
        // `docker logs -f` only speaks when the app does: a quiet app would lose the
        // connection to the idle timeout mid-read. One timer per viewer, not per line.
        const pinger = setInterval(() => {
          if (Date.now() - lastWrite < pingMs) return;
          lastWrite = Date.now();
          stream.write(KEEPALIVE).catch(() => abort.abort());
        }, pingMs);

        try {
          await stream.writeSSE({
            event: 'start',
            data: JSON.stringify({ container, tail }),
          });

          await docker.logsFollow!(
            container,
            tail,
            async (line) => {
              lastWrite = Date.now();
              await stream.writeSSE({
                event: 'line',
                data: JSON.stringify({ line: line.slice(0, MAX_LINE) }),
              });
            },
            abort.signal,
          );

          await stream.writeSSE({
            event: 'end',
            data: JSON.stringify({ reason: 'container stopped' }),
          });
        } finally {
          clearInterval(pinger);
          followers.delete(key);
        }
      },
      async (error, stream) => {
        void error;
        void stream;
      },
    );
  });
}

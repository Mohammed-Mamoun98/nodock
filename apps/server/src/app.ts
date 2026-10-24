import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Config } from './config';
import type { Db } from './db/client';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Injected in tests; defaults to process start. */
  bootedAt?: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(
  code: string,
  message: string,
  status: ContentfulStatusCode = 400,
  details?: unknown,
) {
  return { status, body: { error: { code, message, details } } satisfies ApiError };
}

export function createApp(deps: AppDeps) {
  const { config, db } = deps;
  const bootedAt = deps.bootedAt ?? Date.now();
  const app = new Hono();

  app.get('/healthz', (c) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      db.$client.query('SELECT 1').get();
    } catch {
      database = 'error';
    }
    const ok = database === 'ok';
    return c.json(
      {
        ok,
        database,
        uptimeMs: Date.now() - bootedAt,
        version: Bun.version,
      },
      ok ? 200 : 503,
    );
  });

  // Deliberately tiny: the three numbers that decide whether this box is healthy.
  app.get('/metrics-lite', (c) => {
    const mem = process.memoryUsage();
    return c.json({
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      uptimeMs: Date.now() - bootedAt,
      sseClients: 0,
      baseDomain: config.baseDomain,
    });
  });

  // M2+ mounts real routers here; until then an explicit, typed 404 beats a silent SPA fallback.
  app.all('/api/*', (c) => {
    const { status, body } = apiError('not_implemented', `${c.req.method} ${c.req.path} is not implemented yet`, 501);
    return c.json(body, status);
  });

  app.notFound((c) => {
    const { status, body } = apiError('not_found', `No route for ${c.req.method} ${c.req.path}`, 404);
    return c.json(body, status);
  });

  app.onError((err, c) => {
    console.error('[nodock] unhandled error', err);
    const { status, body } = apiError('internal_error', 'Internal error', 500);
    return c.json(body, status);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

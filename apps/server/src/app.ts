import { Hono } from 'hono';
import { createGitHubClient, type GitHubClient } from './auth/github';
import { registerAuthRoutes } from './auth/routes';
import type { Config } from './config';
import type { Db } from './db/client';
import { apiError } from './http';
import { registerProjectRoutes } from './routes/projects';
import { registerServiceRoutes } from './routes/services';
import { registerVariableRoutes } from './routes/variables';

export { apiError, type ApiError } from './http';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Injected in tests; defaults to the real HTTP client. */
  github?: GitHubClient;
  /** Injected in tests so session expiry is deterministic. */
  now?: () => number;
  /** Injected in tests; defaults to process start. */
  bootedAt?: number;
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

  // Auth owns /auth/*, /api/me, /api/auth/*, plus the origin and session guards on /api/*.
  registerAuthRoutes(app, {
    config,
    db,
    github: deps.github ?? createGitHubClient(),
    now: deps.now,
  });

  // Everything below sits behind the guard registered above.
  registerProjectRoutes(app, { config, db });
  registerServiceRoutes(app, { config, db });
  registerVariableRoutes(app, { config, db });

  // Everything still unrouted behind the guard returns an explicit 501, not a silent SPA fallback.
  app.all('/api/*', (c) => {
    const { status, body } = apiError(
      'not_implemented',
      `${c.req.method} ${c.req.path} is not implemented yet`,
      501,
    );
    return c.json(body, status);
  });

  app.notFound((c) => {
    const { status, body } = apiError(
      'not_found',
      `No route for ${c.req.method} ${c.req.path}`,
      404,
    );
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

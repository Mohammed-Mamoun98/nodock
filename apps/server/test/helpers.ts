import { join } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { openDatabase } from '../src/db/client';

/** Fresh in-memory DB with the real migrations applied — no Docker, no network. */
export function testDb() {
  const { db, sqlite } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: join(import.meta.dir, '../drizzle') });
  return { db, sqlite };
}

/**
 * Completes the OAuth dance once and returns a `call` that carries the session
 * cookie and a same-origin header, so mutating and reading routes both work.
 */
export async function signIn(app: {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  const { SESSION_COOKIE } = await import('../src/auth/sessions');

  const start = await app.request('/auth/github');
  const state = decodeURIComponent(
    start.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('nodock_oauth_state='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  );

  const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `nodock_oauth_state=${state}` },
  });

  const cookie = `${SESSION_COOKIE}=${decodeURIComponent(
    callback.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0]
      ?.split('=')[1] ?? '',
  )}`;

  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        cookie,
        origin: 'https://panel.example.com',
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
}

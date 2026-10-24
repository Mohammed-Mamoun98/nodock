import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
});

describe('app', () => {
  test('GET /healthz reports the database', async () => {
    const { db } = testDb();
    const app = createApp({ config, db });

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: 'ok' });
  });

  test('GET /metrics-lite exposes rss and sse client count', async () => {
    const { db } = testDb();
    const app = createApp({ config, db });

    const body = (await (await app.request('/metrics-lite')).json()) as {
      rssMb: number;
      uptimeMs: number;
      sseClients: number;
    };
    expect(body).toHaveProperty('rssMb');
    expect(body).toHaveProperty('uptimeMs');
    expect(body.sseClients).toBe(0);
  });

  test('unmounted API routes are behind the auth guard', async () => {
    const { db } = testDb();
    const app = createApp({ config, db });

    const res = await app.request('/api/projects');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  test('unknown routes return a typed 404', async () => {
    const { db } = testDb();
    const app = createApp({ config, db });

    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { decrypt, deriveKey, encrypt } from '../src/auth/crypto';
import type { GitHubClient } from '../src/auth/github';
import {
  createSession,
  deleteExpiredSessions,
  findSessionUser,
  hashToken,
  SESSION_COOKIE,
} from '../src/auth/sessions';
import { createState, verifyState } from '../src/auth/state';
import { loadConfig } from '../src/config';
import { sessions, users } from '../src/db/schema';
import { testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

function fakeGitHub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&state=${state}`,
    exchangeCode: async () => ({ accessToken: 'gho_secret_token', scopes: ['repo', 'workflow'] }),
    getUser: async () => ({ id: 42, login: 'mohammed', avatarUrl: null }),
    ...overrides,
  };
}

function cookieFrom(response: Response, name: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

/** Drives the real OAuth flow against a fake GitHub and returns the session cookie. */
async function signIn(github: GitHubClient = fakeGitHub()) {
  const { db } = testDb();
  const app = createApp({ config, db, github });

  const start = await app.request('/auth/github');
  const state = cookieFrom(start, 'nodock_oauth_state');
  expect(start.status).toBe(302);
  expect(state).toBeTruthy();

  const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `nodock_oauth_state=${state}` },
  });

  return { app, db, callback, session: cookieFrom(callback, SESSION_COOKIE), github };
}

describe('crypto', () => {
  const key = deriveKey(config.secret);

  test('round-trips and is randomised per call', () => {
    const first = encrypt('gho_token_value', key);
    const second = encrypt('gho_token_value', key);

    expect(first).not.toBe(second);
    expect(decrypt(first, key)).toBe('gho_token_value');
    expect(decrypt(second, key)).toBe('gho_token_value');
  });

  test('rejects a tampered payload', () => {
    const payload = encrypt('gho_token_value', key);
    const tampered = `${payload.slice(0, -2)}AA`;
    expect(() => decrypt(tampered, key)).toThrow(/tampered|Malformed|Unrecognised/);
  });

  test('rejects the wrong key', () => {
    const other = deriveKey('y'.repeat(32));
    expect(() => decrypt(encrypt('value', key), other)).toThrow(/wrong key/);
  });
});

describe('oauth state', () => {
  test('verifies a fresh state and rejects a replay older than 10 minutes', () => {
    const issuedAt = Date.now();
    const state = createState(config.secret, issuedAt);

    expect(verifyState(config.secret, state, issuedAt)).toBe(true);
    expect(verifyState(config.secret, state, issuedAt + 11 * 60 * 1000)).toBe(false);
  });

  test('rejects a forged signature', () => {
    const state = createState(config.secret);
    expect(verifyState('z'.repeat(32), state)).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(verifyState(config.secret, 'nope')).toBe(false);
    expect(verifyState(config.secret, 'a.b')).toBe(false);
  });
});

describe('sessions', () => {
  test('stores only a hash and resolves the user with scopes', () => {
    const { db } = testDb();
    const user = db
      .insert(users)
      .values({ githubId: 42, login: 'mohammed', scopes: 'repo workflow' })
      .returning()
      .get();

    const { token } = createSession(db, user.id);
    const stored = db.select().from(sessions).get();

    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(db.select().from(sessions).all())).not.toContain(token);
    expect(findSessionUser(db, token)?.scopes).toEqual(['repo', 'workflow']);
  });

  test('expired sessions do not resolve and are pruned', () => {
    const { db } = testDb();
    const user = db.insert(users).values({ githubId: 7, login: 'mohammed' }).returning().get();

    const { token } = createSession(db, user.id, Date.now() - 31 * 24 * 60 * 60 * 1000);

    expect(findSessionUser(db, token)).toBeNull();
    expect(deleteExpiredSessions(db)).toBe(1);
  });
});

describe('github oauth flow', () => {
  test('signs in, reports the session, and logs out', async () => {
    const { app, db, callback, session } = await signIn();

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');
    expect(session).toBeTruthy();

    const me = await app.request('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      login: 'mohammed',
      scopes: ['repo', 'workflow'],
      missingScopes: [],
      needsReconnect: false,
    });

    const stored = db.select().from(users).get();
    expect(stored?.tokenEnc).not.toContain('gho_secret_token');
    expect(decrypt(String(stored?.tokenEnc), deriveKey(config.secret))).toBe('gho_secret_token');

    const logout = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${session}`,
        origin: 'https://panel.example.com',
      },
    });
    expect(logout.status).toBe(204);

    const after = await app.request('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(after.status).toBe(401);
  });

  test('rejects a login outside the allowlist', async () => {
    const { callback, session } = await signIn(
      fakeGitHub({ getUser: async () => ({ id: 9, login: 'stranger', avatarUrl: null }) }),
    );

    expect(callback.status).toBe(403);
    expect(session).toBeNull();
  });

  test('a reduced scope grant surfaces as needsReconnect', async () => {
    const { app, session } = await signIn(
      fakeGitHub({ exchangeCode: async () => ({ accessToken: 'gho_x', scopes: ['repo'] }) }),
    );

    const me = await app.request('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(await me.json()).toMatchObject({ missingScopes: ['workflow'], needsReconnect: true });
  });

  test('rejects a mismatched state', async () => {
    const { db } = testDb();
    const app = createApp({ config, db, github: fakeGitHub() });

    const start = await app.request('/auth/github');
    const state = cookieFrom(start, 'nodock_oauth_state');
    const forged = createState(config.secret);

    const callback = await app.request(`/auth/github/callback?code=abc&state=${forged}`, {
      headers: { cookie: `nodock_oauth_state=${state}` },
    });

    expect(callback.status).toBe(400);
    expect(db.select().from(users).all()).toHaveLength(0);
  });

  test('unauthenticated API calls get 401, not a redirect', async () => {
    const { app } = await signIn();
    const response = await app.request('/api/future-route');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });
});

describe('origin guard', () => {
  test('rejects a cross-origin mutation', async () => {
    const { app, session } = await signIn();
    const response = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_origin' } });
  });

  test('rejects a mutation with no Origin header', async () => {
    const { app, session } = await signIn();
    const response = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'missing_origin' } });
  });

  test('allows GET without an Origin header', async () => {
    const { app, session } = await signIn();
    const response = await app.request('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(response.status).toBe(200);
  });

  test('allows an origin listed in ALLOWED_ORIGINS (the Vite dev server)', async () => {
    const devConfig = loadConfig({
      NODOCK_SECRET: 'x'.repeat(32),
      NODOCK_URL: 'https://panel.example.com',
      BASE_DOMAIN: 'apps.example.com',
      ADMIN_GITHUB_LOGIN: 'mohammed',
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      ALLOWED_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
    });

    const { db } = testDb();
    const app = createApp({ config: devConfig, db, github: fakeGitHub() });

    const start = await app.request('/auth/github');
    const state = cookieFrom(start, 'nodock_oauth_state');
    const callback = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `nodock_oauth_state=${state}` },
    });
    const session = cookieFrom(callback, SESSION_COOKIE);

    const allowed = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(204);

    const blocked = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: 'http://localhost:9999' },
    });
    expect(blocked.status).toBe(403);
    expect(devConfig.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
});

describe('schema', () => {
  test('stores granted scopes on the user row', async () => {
    const { db } = await signIn();
    const stored = db.select().from(users).where(eq(users.githubId, 42)).get();
    expect(stored?.scopes).toBe('repo workflow');
  });
});

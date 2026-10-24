import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { apiError } from '../app';
import { deriveKey, encrypt } from './crypto';
import { missingScopes, type GitHubClient } from './github';
import {
  createSession,
  deleteSession,
  findSessionUser,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  serializeCookie,
  type SessionUser,
} from './sessions';
import { createState, verifyState } from './state';

const STATE_COOKIE = 'nodock_oauth_state';

export interface AuthDeps {
  config: Config;
  db: Db;
  github: GitHubClient;
  now?: () => number;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isHttps(config: Config): boolean {
  return config.url.startsWith('https://');
}

function page(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0d;color:#e8eae9;
    font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
  main{max-width:26rem;padding:2rem;border:1px solid #252a2f;border-radius:8px;background:#14171a}
  h1{margin:0 0 .5rem;font-size:15px}
  p{margin:0 0 1rem;color:#8b949a}
  a{color:#c8fa5f}
</style></head><body><main><h1>${title}</h1><p>${detail}</p><a href="/">Back to nodock</a></main></body></html>`;
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const { config, db, github } = deps;
  const now = deps.now ?? (() => Date.now());
  const key = deriveKey(config.secret);
  const secure = isHttps(config);
  const redirectUri = `${config.url}/auth/github/callback`;

  /** Same-origin enforcement for mutations. GET/HEAD are exempt. */
  app.use('/api/*', async (c, next) => {
    if (!MUTATING.has(c.req.method)) return next();

    const origin = c.req.header('origin');
    if (!origin) {
      const { status, body } = apiError(
        'missing_origin',
        'Mutating requests must carry an Origin header',
        403,
      );
      return c.json(body, status);
    }

    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).origin === new URL(config.url).origin;
    } catch {
      sameOrigin = false;
    }

    if (!sameOrigin) {
      const { status, body } = apiError('bad_origin', `Origin ${origin} is not allowed`, 403);
      return c.json(body, status);
    }

    return next();
  });

  function currentUser(c: {
    req: { header: (name: string) => string | undefined };
  }): SessionUser | null {
    const token = parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
    return token ? findSessionUser(db, token, now()) : null;
  }

  // Registered before the auth guard so unauthenticated clients get a clean 401
  // they can act on, instead of a redirect.
  app.get('/api/me', (c) => {
    const user = currentUser(c);
    if (!user) {
      const { status, body } = apiError('unauthenticated', 'Sign in with GitHub', 401);
      return c.json(body, status);
    }

    const missing = missingScopes(user.scopes);
    return c.json({
      login: user.login,
      avatarUrl: user.avatarUrl,
      scopes: user.scopes,
      missingScopes: missing,
      needsReconnect: missing.length > 0,
    });
  });

  app.use('/api/*', async (c, next) => {
    if (!currentUser(c)) {
      const { status, body } = apiError('unauthenticated', 'Sign in with GitHub', 401);
      return c.json(body, status);
    }
    return next();
  });

  app.get('/auth/github', (c) => {
    if (!config.github.clientId || !config.github.clientSecret) {
      return c.html(
        page(
          'GitHub OAuth is not configured',
          'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart nodock.',
        ),
        503,
      );
    }

    const state = createState(config.secret, now());
    const url = github.authorizeUrl({ clientId: config.github.clientId, redirectUri, state });

    c.header(
      'set-cookie',
      serializeCookie(STATE_COOKIE, state, {
        maxAgeSeconds: 600,
        secure,
        sameSite: 'Lax',
      }),
    );
    return c.redirect(url, 302);
  });

  app.get('/auth/github/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const cookies = parseCookies(c.req.header('cookie'));

    const clearState = serializeCookie(STATE_COOKIE, '', { maxAgeSeconds: 0, secure });

    if (
      !code ||
      !state ||
      state !== cookies[STATE_COOKIE] ||
      !verifyState(config.secret, state, now())
    ) {
      c.header('set-cookie', clearState);
      return c.html(
        page('Sign-in failed', 'The OAuth state was missing, expired, or did not match.'),
        400,
      );
    }

    if (!config.github.clientId || !config.github.clientSecret) {
      return c.html(page('GitHub OAuth is not configured', 'Set the client id and secret.'), 503);
    }

    let token: { accessToken: string; scopes: string[] };
    let profile: { id: number; login: string; avatarUrl: string | null };

    try {
      token = await github.exchangeCode({
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        code,
        redirectUri,
      });
      profile = await github.getUser(token.accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown GitHub error';
      return c.html(page('GitHub sign-in failed', message), 502);
    }

    // Fail closed: an empty allowlist means nobody is an admin.
    if (!config.adminLogins.includes(profile.login.toLowerCase())) {
      c.header('set-cookie', clearState);
      return c.html(
        page(
          'Not authorised',
          `${profile.login} is not in ADMIN_GITHUB_LOGIN. Add the login in .env and restart nodock.`,
        ),
        403,
      );
    }

    const existing = db.select().from(users).where(eq(users.githubId, profile.id)).get();
    const values = {
      login: profile.login,
      avatarUrl: profile.avatarUrl,
      tokenEnc: encrypt(token.accessToken, key),
      scopes: token.scopes.join(' '),
    };

    const user = existing
      ? db.update(users).set(values).where(eq(users.id, existing.id)).returning().get()
      : db
          .insert(users)
          .values({ githubId: profile.id, ...values })
          .returning()
          .get();

    const session = createSession(db, user.id, now());

    // Two Set-Cookie values must be two headers. Joining them with a comma makes
    // the browser (and any parser) treat the pair as one malformed cookie.
    const headers = new Headers({ location: '/' });
    headers.append('set-cookie', clearState);
    headers.append(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, session.token, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        secure,
        sameSite: 'Lax',
      }),
    );

    return new Response(null, { status: 302, headers });
  });

  app.post('/api/auth/logout', (c) => {
    const token = parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
    if (token) deleteSession(db, token);

    return new Response(null, {
      status: 204,
      headers: {
        'set-cookie': serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure }),
      },
    });
  });
}

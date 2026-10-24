import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { decrypt, deriveKey } from '../auth/crypto';
import { GitHubHttpError, type GitHubClient, type GitHubRepo } from '../auth/github';
import { parseCookies, SESSION_COOKIE, findSessionUser } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { apiError } from '../http';
import { findDockerfiles, parseExposedPorts } from '../lib/inspect-repo';

function respondToGitHubError(c: Context, error: unknown) {
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) {
      const { status, body } = apiError('github_token_rejected', error.message, 401);
      return c.json(body, status);
    }
    if (error.status === 404) {
      const { status, body } = apiError('github_not_found', error.message, 404);
      return c.json(body, status);
    }
    if (error.status === 429) {
      const { status, body } = apiError('github_rate_limited', error.message, 429);
      return c.json(body, status);
    }
  }

  const { status, body } = apiError(
    'github_error',
    error instanceof Error ? error.message : 'GitHub request failed',
    502,
  );
  return c.json(body, status);
}

const TTL_MS = 60_000;
const MAX_PAGES = 3;
const PER_PAGE = 100;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface GitHubRouteDeps {
  config: Config;
  db: Db;
  github: GitHubClient;
  now?: () => number;
}

export function registerGitHubRoutes(app: Hono, deps: GitHubRouteDeps): void {
  const { config, db, github } = deps;
  const now = deps.now ?? (() => Date.now());
  const key = deriveKey(config.secret);

  // GitHub is 5000 requests/hour, but the picker refetches on every wizard open.
  const repoCache = new Map<string, CacheEntry<{ repos: GitHubRepo[]; truncated: boolean }>>();
  const branchCache = new Map<string, CacheEntry<string[]>>();

  function cached<T>(cache: Map<string, CacheEntry<T>>, cacheKey: string): T | null {
    const hit = cache.get(cacheKey);
    if (!hit) return null;
    if (hit.expiresAt < now()) {
      cache.delete(cacheKey);
      return null;
    }
    return hit.value;
  }

  function store<T>(cache: Map<string, CacheEntry<T>>, cacheKey: string, value: T): T {
    cache.set(cacheKey, { value, expiresAt: now() + TTL_MS });
    return value;
  }

  /** The token lives encrypted; decrypt per request rather than caching plaintext. */
  function session(cookieHeader: string | undefined): { token: string; userId: string } | null {
    const sessionToken = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!sessionToken) return null;

    const user = findSessionUser(db, sessionToken, now());
    if (!user) return null;

    const row = db
      .select({ tokenEnc: users.tokenEnc })
      .from(users)
      .where(eq(users.id, user.id))
      .get();
    if (!row?.tokenEnc) return null;

    try {
      return { token: decrypt(row.tokenEnc, key), userId: user.id };
    } catch {
      return null;
    }
  }

  app.get('/api/github/repos', async (c) => {
    const auth = session(c.req.header('cookie'));
    if (!auth) {
      const { status, body } = apiError(
        'github_not_connected',
        'No GitHub token on this session — sign in again',
        409,
      );
      return c.json(body, status);
    }

    const cacheKey = `repos:${auth.userId}`;
    const cachedValue = cached(repoCache, cacheKey);
    if (cachedValue) return c.json(cachedValue);

    try {
      const repos: GitHubRepo[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= MAX_PAGES) {
        // Sequential by necessity: the next page depends on this one's hasMore.
        // eslint-disable-next-line no-await-in-loop
        const result = await github.listRepos(auth.token, { page, perPage: PER_PAGE });
        repos.push(...result.repos);
        hasMore = result.hasMore;
        page += 1;
      }

      return c.json(store(repoCache, cacheKey, { repos, truncated: hasMore }));
    } catch (error) {
      return respondToGitHubError(c, error);
    }
  });

  /**
   * What the wizard needs to fill itself in: Dockerfile presence/location and the
   * port it exposes. One tree call plus one contents call, cached like branches.
   */
  app.get('/api/github/repos/:owner/:repo/inspect', async (c) => {
    const auth = session(c.req.header('cookie'));
    if (!auth) {
      const { status, body } = apiError('github_not_connected', 'Sign in again', 409);
      return c.json(body, status);
    }

    const repoFullName = `${c.req.param('owner')}/${c.req.param('repo')}`;
    const missing = (['listTree', 'getFile', 'getRepo'] as const).filter(
      (name) => typeof github[name] !== 'function',
    );
    if (missing.length > 0) {
      const { status, body } = apiError(
        'github_ops_unavailable',
        `GitHub client is missing: ${missing.join(', ')}`,
        501,
      );
      return c.json(body, status);
    }

    try {
      const ref =
        c.req.query('ref') || (await github.getRepo!(auth.token, repoFullName)).defaultBranch;
      const tree = await github.listTree!(auth.token, repoFullName, ref);
      const candidates = findDockerfiles(tree.paths);
      const best = candidates[0] ?? null;

      let exposedPorts: number[] = [];
      if (best) {
        const file = await github.getFile!(auth.token, repoFullName, best.path, ref);
        if (file) exposedPorts = parseExposedPorts(file.content);
      }

      return c.json({
        ref,
        hasDockerfile: candidates.length > 0,
        dockerfilePath: best?.path ?? null,
        contextPath: best?.context ?? null,
        candidates: candidates.map((candidate) => candidate.path).slice(0, 10),
        exposedPorts,
        suggestedPort: exposedPorts.length === 1 ? exposedPorts[0] : null,
        treeTruncated: tree.truncated,
      });
    } catch (error) {
      return respondToGitHubError(c, error);
    }
  });

  app.get('/api/github/repos/:owner/:repo/branches', async (c) => {
    const auth = session(c.req.header('cookie'));
    if (!auth) {
      const { status, body } = apiError(
        'github_not_connected',
        'No GitHub token on this session — sign in again',
        409,
      );
      return c.json(body, status);
    }

    const repoFullName = `${c.req.param('owner')}/${c.req.param('repo')}`;
    const cacheKey = `branches:${auth.userId}:${repoFullName}`;
    const cachedValue = cached(branchCache, cacheKey);
    if (cachedValue) return c.json({ branches: cachedValue });

    try {
      const branches = await github.listBranches(auth.token, repoFullName);
      return c.json({ branches: store(branchCache, cacheKey, branches) });
    } catch (error) {
      return respondToGitHubError(c, error);
    }
  });
}

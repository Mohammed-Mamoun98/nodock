import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { services, variables } from '../db/schema';
import { decrypt, deriveKey, encrypt } from '../auth/crypto';
import type { GitHubClient } from '../auth/github';
import { readSessionToken } from '../auth/session-token';
import { apiError, validationError } from '../http';
import { BUILD_TIME_PREFIXES } from '../lib/framework';
import { findEnvFiles, looksSecret, parseEnvKeys } from '../lib/env-example';
import { findServiceEnv } from './services';
import { variableListSchema } from './schemas';

export interface VariableDeps {
  config: Config;
  db: Db;
  /** Optional: the repo scan is a convenience, and the tab works without it. */
  github?: GitHubClient;
}

/** Parsed templates, cached because the panel refetches on every open. */
const SUGGESTION_TTL_MS = 60_000;

interface Suggestion {
  key: string;
  isSecret: boolean;
  comment: string | null;
}

/** A scan that could not run is still an answer: no names, and a sentence saying why. */
function noSuggestions(note: string): { source: null; values: Suggestion[]; note: string } {
  return { source: null, values: [], note };
}

const MASK = '••••••••';

export function registerVariableRoutes(app: Hono, deps: VariableDeps): void {
  const { db, config, github } = deps;
  const key = deriveKey(config.secret);
  const suggestionCache = new Map<
    string,
    { expiresAt: number; source: string; values: Suggestion[] }
  >();

  /**
   * "The repo's .env.example lists these names — want them?"
   *
   * Names only. A placeholder value in a template (`sk_test_xxxx`) is not a secret and
   * not a default, so it never leaves the repo; the user supplies the real value.
   *
   * Every failure answers 200 with a `note`: a scan that cannot run must never turn the
   * variables tab into an error page.
   */
  app.get('/api/services/:id/envs/:envId/variable-suggestions', async (c) => {
    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const missing = (['listTree', 'getFile'] as const).filter(
      (name) => typeof github?.[name] !== 'function',
    );
    if (missing.length > 0) {
      return c.json(noSuggestions(`GitHub file access is not available (${missing.join(', ')})`));
    }

    const service = db.select().from(services).where(eq(services.id, serviceEnv.serviceId)).get();
    if (!service) return c.json(noSuggestions('This service no longer exists'));

    const auth = readSessionToken(db, key, c.req.header('cookie'));
    if (!auth) return c.json(noSuggestions('Sign in again to scan the repo'));

    const cacheKey = `suggest:${auth.userId}:${service.repoFullName}:${serviceEnv.branch}`;
    let parsed = suggestionCache.get(cacheKey);
    if (parsed && parsed.expiresAt < Date.now()) parsed = undefined;

    if (!parsed) {
      try {
        const tree = await github!.listTree!(auth.token, service.repoFullName, serviceEnv.branch);
        const source = findEnvFiles(tree.paths)[0];
        if (!source) {
          return c.json(
            noSuggestions(
              `no .env.example (or .env.sample / .env.template) on ${serviceEnv.branch} — nothing to read`,
            ),
          );
        }

        const file = await github!.getFile!(
          auth.token,
          service.repoFullName,
          source,
          serviceEnv.branch,
        );
        if (!file)
          return c.json(noSuggestions(`${source} vanished between the listing and the read`));

        parsed = {
          expiresAt: Date.now() + SUGGESTION_TTL_MS,
          source,
          values: parseEnvKeys(file.content).map((entry) => ({
            key: entry.key,
            isSecret: looksSecret(entry.key),
            comment: entry.comment,
          })),
        };
        suggestionCache.set(cacheKey, parsed);
      } catch (error) {
        return c.json(noSuggestions(error instanceof Error ? error.message : String(error)));
      }
    }

    const already = new Set(
      db
        .select({ key: variables.key })
        .from(variables)
        .where(eq(variables.serviceEnvId, serviceEnv.id))
        .all()
        .map((row) => row.key),
    );

    return c.json({
      source: parsed.source,
      values: parsed.values.filter((entry) => !already.has(entry.key)),
      note: null,
    });
  });

  app.get('/api/services/:id/envs/:envId/variables', (c) => {
    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const reveal = c.req.query('reveal') === '1';
    const rows = db.select().from(variables).where(eq(variables.serviceEnvId, serviceEnv.id)).all();

    return c.json({
      // Shipped with the list so the panel tags rows with the same rule the build
      // endpoint selects them by: one constant, two readers, no drift.
      buildTimePrefixes: [...BUILD_TIME_PREFIXES],
      variables: rows.map((row) => {
        const isSecret = row.isSecret;
        const plaintext = reveal ? decrypt(row.valueEnc, key) : null;
        return {
          key: row.key,
          isSecret,
          value: reveal ? plaintext : isSecret ? MASK : decrypt(row.valueEnc, key),
          hidden: isSecret && !reveal,
        };
      }),
    });
  });

  app.put('/api/services/:id/envs/:envId/variables', async (c) => {
    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const parsed = variableListSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const seen = new Set<string>();
    for (const variable of parsed.data.variables) {
      if (seen.has(variable.key)) {
        const { status, body } = apiError(
          'duplicate_key',
          `Duplicate variable key: ${variable.key}`,
          422,
        );
        return c.json(body, status);
      }
      seen.add(variable.key);
    }

    // Bulk replace inside one transaction: a partial write here would leave an
    // app without the variable it needs to boot.
    db.transaction((tx) => {
      tx.delete(variables).where(eq(variables.serviceEnvId, serviceEnv.id)).run();
      for (const variable of parsed.data.variables) {
        tx.insert(variables)
          .values({
            serviceEnvId: serviceEnv.id,
            key: variable.key,
            valueEnc: encrypt(variable.value, key),
            isSecret: variable.isSecret,
          })
          .run();
      }
    });

    return c.json({ count: seen.size });
  });

  app.delete('/api/services/:id/envs/:envId/variables/:key', (c) => {
    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const deleted = db
      .delete(variables)
      .where(and(eq(variables.serviceEnvId, serviceEnv.id), eq(variables.key, c.req.param('key'))))
      .returning({ id: variables.id })
      .get();

    if (!deleted) {
      const { status, body } = apiError('not_found', 'Variable not found', 404);
      return c.json(body, status);
    }
    return c.body(null, 204);
  });
}

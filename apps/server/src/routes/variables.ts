import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { variables } from '../db/schema';
import { decrypt, deriveKey, encrypt } from '../auth/crypto';
import { apiError, validationError } from '../http';
import { findServiceEnv } from './services';
import { variableListSchema } from './schemas';

export interface VariableDeps {
  config: Config;
  db: Db;
}

const MASK = '••••••••';

export function registerVariableRoutes(app: Hono, deps: VariableDeps): void {
  const { db, config } = deps;
  const key = deriveKey(config.secret);

  app.get('/api/services/:id/envs/:envId/variables', (c) => {
    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const reveal = c.req.query('reveal') === '1';
    const rows = db.select().from(variables).where(eq(variables.serviceEnvId, serviceEnv.id)).all();

    return c.json({
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

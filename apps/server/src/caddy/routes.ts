import type { Hono } from 'hono';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { allowedHosts } from './service';

/**
 * Caddy calls this before issuing a certificate for an unknown SNI.
 *
 * Anyone can point DNS at this box, so the only thing standing between the
 * internet and unlimited certificate issuance is this check. It answers for the
 * dashboard host and hosts that exist in the database — nothing else.
 */
export function registerCaddyRoutes(app: Hono, deps: { config: Config; db: Db }): void {
  app.get('/internal/caddy/ask', (c) => {
    const raw = c.req.query('domain');
    if (!raw) return c.text('missing domain', 400);

    const host = raw.toLowerCase().replace(/\.$/, '');
    if (allowedHosts(deps.db, deps.config).has(host)) {
      return c.body(null, 200);
    }

    // No detail in the body: an attacker learns only "no".
    return c.body(null, 403);
  });
}

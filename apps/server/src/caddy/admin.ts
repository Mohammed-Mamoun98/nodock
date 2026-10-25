export interface CaddyAdmin {
  /** Replaces the running config atomically; Caddy rejects and keeps the old one on error. */
  load(config: string): Promise<void>;
}

/** `fetch` with Bun's unix-socket option; not in the DOM/Node RequestInit types. */
type UnixInit = RequestInit & { unix?: string };

/**
 * Two ways in, and the difference matters:
 *
 * - **unix socket** (preferred): no TCP listener exists, so nothing on a docker
 *   network can reach the admin API — not apps, not a compromised container.
 * - **TCP** (legacy / explicit): the admin API is unauthenticated and rebuilds
 *   the whole routing table, so anyone who can reach that port is root-equivalent.
 */
export function createCaddyAdmin(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  unixSocket: string | null = null,
): CaddyAdmin {
  const base = baseUrl.replace(/\/$/, '');
  const init: UnixInit = unixSocket ? { unix: unixSocket } : {};

  return {
    async load(config) {
      const response = await fetchImpl(`${base}/load`, {
        method: 'POST',
        headers: {
          // The Caddyfile adapter is compiled into the stock image; sending JSON
          // would mean hand-building the on-demand TLS graph.
          'content-type': 'text/caddyfile',
          'cache-control': 'must-revalidate',
        },
        body: config,
        ...init,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Caddy rejected the config (${response.status}): ${detail.slice(0, 400)}`);
      }
    },
  };
}

/**
 * Builds the client from config, preferring the socket. Returns null when the
 * host runs without a proxy (plain `bun run dev:server`), which every caller
 * already treats as "no routing to manage".
 */
export function createCaddyAdminFromConfig(caddy: {
  adminSocket: string | null;
  adminUrl: string | null;
}): CaddyAdmin | null {
  if (caddy.adminSocket) {
    return createCaddyAdmin('http://localhost', fetch, caddy.adminSocket);
  }
  if (caddy.adminUrl) return createCaddyAdmin(caddy.adminUrl);
  return null;
}

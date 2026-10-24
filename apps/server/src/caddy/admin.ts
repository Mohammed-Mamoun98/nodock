export interface CaddyAdmin {
  /** Replaces the running config atomically; Caddy rejects and keeps the old one on error. */
  load(config: string): Promise<void>;
}

export function createCaddyAdmin(baseUrl: string, fetchImpl: typeof fetch = fetch): CaddyAdmin {
  const base = baseUrl.replace(/\/$/, '');

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
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Caddy rejected the config (${response.status}): ${detail.slice(0, 400)}`);
      }
    },
  };
}

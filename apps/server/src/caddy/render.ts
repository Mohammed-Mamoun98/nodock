/**
 * Renders the entire Caddy config from DB state. Text (Caddyfile), not JSON:
 * the Caddyfile adapter is compiled into the stock image, the output is
 * reviewable in a snapshot test, and there is no way to emit a subtly invalid
 * JSON graph for `tls { on_demand }`.
 */

export interface CaddyRoute {
  /** Public hostname, already lowercased. */
  host: string;
  /** `container:port` on the shared docker network. */
  upstream: string;
}

export interface CaddyConfigInput {
  /** The panel host (NODOCK_URL's host). Always routed first. */
  dashboardHost: string;
  /** The panel's upstream inside the compose network. */
  dashboardUpstream?: string;
  /** Service hosts, in deterministic order. */
  routes: CaddyRoute[];
  askUrl?: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const UPSTREAM = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?:[0-9]{1,5}$/;

/**
 * The Caddyfile is a text format, so a hostile host or container name would be
 * *config injection*, not an escaping bug. Reject anything that is not the
 * exact shape we generate.
 */
export function assertSafeHost(host: string): string {
  const normalised = host.toLowerCase().replace(/\.$/, '');
  if (!HOST.test(normalised) || normalised.length > 253) {
    throw new Error(`Refusing to render an unsafe host: ${JSON.stringify(host)}`);
  }
  return normalised;
}

export function assertSafeUpstream(upstream: string): string {
  if (!UPSTREAM.test(upstream)) {
    throw new Error(`Refusing to render an unsafe upstream: ${JSON.stringify(upstream)}`);
  }
  const port = Number(upstream.split(':')[1]);
  if (port < 1 || port > 65535) {
    throw new Error(`Refusing to render an out-of-range port: ${port}`);
  }
  return upstream;
}

export function renderCaddyfile(input: CaddyConfigInput): string {
  const askUrl = input.askUrl ?? 'http://nodock:3000/internal/caddy/ask';
  const dashboardHost = assertSafeHost(input.dashboardHost);
  const dashboardUpstream = assertSafeUpstream(input.dashboardUpstream ?? 'nodock:3000');

  const blocks: string[] = [];

  blocks.push(
    [dashboardHost + ' {', '\tencode zstd gzip', `\treverse_proxy ${dashboardUpstream}`, '}'].join(
      '\n',
    ),
  );

  // Sorted + de-duplicated: one writer, stable output, reviewable diffs.
  const seen = new Set<string>([dashboardHost]);
  const routes = [...input.routes]
    .map((route) => ({
      host: assertSafeHost(route.host),
      upstream: assertSafeUpstream(route.upstream),
    }))
    .filter((route) => {
      if (seen.has(route.host)) return false;
      seen.add(route.host);
      return true;
    })
    .toSorted((a, b) => a.host.localeCompare(b.host));

  for (const route of routes) {
    blocks.push(
      [
        route.host + ' {',
        '\ttls {',
        '\t\ton_demand',
        '\t}',
        '\tencode zstd gzip',
        `\treverse_proxy ${route.upstream}`,
        '}',
      ].join('\n'),
    );
  }

  // HTTP-only catch-all. Deliberately not :443 — a 443 catch-all would make
  // Caddy ask for certificates for arbitrary SNI, and /ask would 403 every time.
  blocks.push([':80 {', '\trespond "nodock: unknown host" 404', '}'].join('\n'));

  const globals = [
    '{',
    '\temail {$ACME_EMAIL}',
    '\ton_demand_tls {',
    `\t\task ${askUrl}`,
    '\t}',
    '}',
  ].join('\n');

  return `${globals}\n\n${blocks.join('\n\n')}\n`;
}

/** Extract every host the rendered config serves — used to assert completeness. */
export function hostsIn(config: string): string[] {
  return (
    config
      .split('\n')
      // Top-level directives only: nested blocks are indented.
      .filter((line) => line === line.trimStart())
      .map((line) => line.trim())
      .filter((line) => line.endsWith('{') && line !== '{')
      .map((line) => line.slice(0, -1).trim())
      .filter((host) => host !== ':80')
  );
}

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
  /**
   * The previous container, kept during the switch window only. Caddy retries
   * against it if the new upstream refuses connections, which covers the case
   * where a container is "up" but crashing on first real request.
   */
  previous?: string;
}

export interface CaddyConfigInput {
  /** The panel host (NODOCK_URL's host). Always routed first. */
  dashboardHost: string;
  /** The panel's upstream inside the compose network. */
  dashboardUpstream?: string;
  /** Service hosts, in deterministic order. */
  routes: CaddyRoute[];
  askUrl?: string;
  /**
   * Admin API on a unix socket (preferred). When set, no TCP admin listener
   * exists at all, which is the only way a container on the app network cannot
   * reach it.
   */
  adminSocket?: string | null;
  /** Fallback only: TCP admin, reachable by anything sharing a network with Caddy. */
  adminUrl?: string | null;
  /** Health-check probes, served on the private listener and nothing else. */
  probes?: CaddyProbe[];
}

/**
 * A container published on no port is still reachable from the proxy's networks.
 * These probes exist so the deploy pipeline can health-check a *new* container
 * while the public route still points at the old one: nodock itself never joins
 * the app network. The listener exposes nothing the public route does not.
 */
export interface CaddyProbe {
  /** Deployment id; becomes the `/probe/<id>/` prefix. */
  id: string;
  /** `container:port` on the app network. */
  upstream: string;
}

export const PROBE_PORT = 8099;

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const UPSTREAM = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?:[0-9]{1,5}$/;
/** Deployment ids are uuids; anything else is not ours to render. */
const PROBE_ID = /^[a-z0-9-]{1,64}$/;
const SOCKET_PATH = /^\/[A-Za-z0-9._\-/]+$/;
/** `host:port` for the TCP admin fallback — an IP, so it is not an UPSTREAM. */
const ADMIN_ADDR = /^[A-Za-z0-9.:[\]]+:[0-9]{1,5}$/;

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

/** The admin binding goes into a text file too, so it gets the same treatment. */
export function assertSafeSocketPath(path: string): string {
  if (!SOCKET_PATH.test(path) || path.includes('..') || path.length > 200) {
    throw new Error(`Refusing to render an unsafe admin socket path: ${JSON.stringify(path)}`);
  }
  return path;
}

function adminBinding(input: CaddyConfigInput): string {
  // Socket wins: with no TCP listener there is nothing for a container to reach.
  if (input.adminSocket) return `admin unix/${assertSafeSocketPath(input.adminSocket)}`;

  const address = input.adminUrl ?? '0.0.0.0:2019';
  const port = Number(address.split(':').pop());
  if (!ADMIN_ADDR.test(address) || !(port > 0 && port <= 65535)) {
    throw new Error(`Refusing to render an unsafe admin address: ${JSON.stringify(address)}`);
  }
  return `admin ${address}`;
}

function probeBlock(probes: CaddyProbe[]): string | null {
  if (probes.length === 0) return null;

  const lines = [`:${PROBE_PORT} {`];
  for (const probe of probes) {
    if (!PROBE_ID.test(probe.id)) {
      throw new Error(`Refusing to render an unsafe probe id: ${JSON.stringify(probe.id)}`);
    }
    lines.push(
      `\thandle_path /probe/${probe.id}/* {`,
      `\t\treverse_proxy ${assertSafeUpstream(probe.upstream)}`,
      '\t}',
    );
  }
  lines.push('\trespond "nodock: unknown probe" 404', '}');
  return lines.join('\n');
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
      previous: route.previous ? assertSafeUpstream(route.previous) : undefined,
    }))
    .filter((route) => {
      if (seen.has(route.host)) return false;
      seen.add(route.host);
      return true;
    })
    .toSorted((a, b) => a.host.localeCompare(b.host));

  for (const route of routes) {
    const proxy = route.previous
      ? [
          `\treverse_proxy ${route.upstream} ${route.previous} {`,
          // Only for the switch window: retry the old container, and remember a
          // failing upstream briefly instead of hammering it.
          '\t\tlb_try_duration 5s',
          '\t\tfail_duration 30s',
          '\t}',
        ]
      : [`\treverse_proxy ${route.upstream}`];

    blocks.push(
      [
        route.host + ' {',
        '\ttls {',
        '\t\ton_demand',
        '\t}',
        '\tencode zstd gzip',
        ...proxy,
        '}',
      ].join('\n'),
    );
  }

  // HTTP-only catch-all. Deliberately not :443 — a 443 catch-all would make
  // Caddy ask for certificates for arbitrary SNI, and /ask would 403 every time.
  blocks.push([':80 {', '\trespond "nodock: unknown host" 404', '}'].join('\n'));

  const probes = probeBlock(input.probes ?? []);
  if (probes) blocks.push(probes);

  // /load replaces the ENTIRE config, so the admin binding has to be restated
  // every time. Without it Caddy falls back to 127.0.0.1:2019 and the first
  // reconcile silently locks nodock out of its own proxy.
  const globals = [
    '{',
    `\t${adminBinding(input)}`,
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
      // `:80` and the probe listener are port listeners, not hosts.
      .filter((host) => !host.startsWith(':'))
  );
}

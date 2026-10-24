import { lookup } from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import type { CaddyAdmin } from './caddy/admin';
import { allowedHosts } from './caddy/service';
import type { Config } from './config';
import type { Db } from './db/client';
import { settings } from './db/schema';
import type { DockerAdapter } from './docker/adapter';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  config: Config;
  db: Db;
  docker?: DockerAdapter;
  admin?: CaddyAdmin | null;
  /** Injectable for tests: the real one is a DNS lookup. */
  resolve?: (host: string) => Promise<string | null>;
  now?: () => number;
}

async function defaultResolve(host: string): Promise<string | null> {
  try {
    const result = await lookup(host);
    return result.address;
  } catch {
    return null;
  }
}

/**
 * Preconditions for a first deploy, in the order they actually bite:
 * daemon → network → Caddy admin → certificate gate → DNS → config.
 * Every check is read-only and safe to run on a live box.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { config, db, docker, admin } = deps;
  const resolve = deps.resolve ?? defaultResolve;
  const checks: DoctorCheck[] = [];

  const add = (check: DoctorCheck) => checks.push(check);

  // --- config -------------------------------------------------------------
  const githubReady = Boolean(config.github.clientId && config.github.clientSecret);
  add(
    githubReady
      ? { name: 'github oauth', status: 'ok', detail: 'client id and secret set' }
      : {
          name: 'github oauth',
          status: 'fail',
          detail: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing',
          hint: 'Create an OAuth App (docs/DEPLOY.md §3) and restart nodock',
        },
  );

  add(
    config.adminLogins.length > 0
      ? { name: 'admin allowlist', status: 'ok', detail: config.adminLogins.join(', ') }
      : {
          name: 'admin allowlist',
          status: 'fail',
          detail: 'ADMIN_GITHUB_LOGIN is empty, so nobody can sign in',
          hint: 'Set it to your GitHub username (not your email)',
        },
  );

  const isLocal = config.url.startsWith('http://localhost');
  add(
    config.url.startsWith('https://') || isLocal
      ? { name: 'public url', status: 'ok', detail: config.url }
      : {
          name: 'public url',
          status: 'warn',
          detail: `${config.url} is not https — session cookies will not be Secure`,
          hint: 'Use the https origin you registered as the OAuth callback',
        },
  );

  add(
    config.caddy.adminUrl
      ? { name: 'caddy admin', status: 'ok', detail: config.caddy.adminUrl }
      : {
          name: 'caddy admin',
          status: 'warn',
          detail: 'CADDY_ADMIN_URL is unset — routing is not managed',
          hint: 'Set CADDY_ADMIN_URL=http://caddy:2019 (compose does this)',
        },
  );

  add(
    config.ghcr.token
      ? {
          name: 'ghcr pull',
          status: 'ok',
          detail: `token set for ${config.ghcr.user ?? 'unknown user'}`,
        }
      : {
          name: 'ghcr pull',
          status: 'warn',
          detail: 'no GHCR_TOKEN — only public packages can be pulled',
          hint: 'Add a classic PAT with read:packages if your images are private',
        },
  );

  // --- database -----------------------------------------------------------
  try {
    db.insert(settings)
      .values({ key: 'doctor:probe', value: String((deps.now ?? Date.now)()) })
      .run();
    db.delete(settings).where(eq(settings.key, 'doctor:probe')).run();
    add({ name: 'database', status: 'ok', detail: `${config.paths.dbFile} is writable` });
  } catch (error) {
    add({
      name: 'database',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'write failed',
      hint: 'Check that /data is mounted and writable by the container user',
    });
  }

  // --- docker -------------------------------------------------------------
  if (!docker?.ping) {
    add({ name: 'docker daemon', status: 'warn', detail: 'adapter cannot report a version' });
  } else {
    try {
      const version = await docker.ping();
      add({ name: 'docker daemon', status: 'ok', detail: `server ${version}` });
    } catch (error) {
      add({
        name: 'docker daemon',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'unreachable',
        hint: 'Is /var/run/docker.sock mounted into the nodock container?',
      });
    }
  }

  if (docker?.networkExists) {
    const exists = await docker.networkExists(config.dockerNetwork).catch(() => false);
    add(
      exists
        ? { name: 'docker network', status: 'ok', detail: config.dockerNetwork }
        : {
            name: 'docker network',
            status: 'fail',
            detail: `network "${config.dockerNetwork}" missing`,
            hint: 'App containers and Caddy must share one network for name-based routing',
          },
    );
  }

  // --- caddy --------------------------------------------------------------
  if (admin) {
    try {
      const response = await fetch(`${config.caddy.adminUrl}/config/`, {
        signal: AbortSignal.timeout(3000),
      });
      add(
        response.ok
          ? { name: 'caddy reachable', status: 'ok', detail: 'admin API answered' }
          : {
              name: 'caddy reachable',
              status: 'fail',
              detail: `admin API returned ${response.status}`,
              hint: 'Caddy must have `admin 0.0.0.0:2019` and share the network',
            },
      );
    } catch (error) {
      add({
        name: 'caddy reachable',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'unreachable',
        hint: 'Check CADDY_ADMIN_URL and that the caddy container is running',
      });
    }
  }

  // The certificate gate: Caddy will not issue a cert unless /ask says yes.
  // hostname, not host: Caddy's /ask passes the hostname without a port.
  const panelHost = new URL(config.url).hostname.toLowerCase();
  add(
    allowedHosts(db, config).has(panelHost)
      ? { name: 'cert gate', status: 'ok', detail: `${panelHost} is allowed by /ask` }
      : {
          name: 'cert gate',
          status: 'fail',
          detail: `${panelHost} is not in the allowed host set`,
          hint: 'NODOCK_URL must match the host Caddy serves the panel on',
        },
  );

  // --- DNS ----------------------------------------------------------------
  const panelAddress = isLocal ? null : await resolve(panelHost);
  add(
    isLocal
      ? { name: 'dns: panel', status: 'ok', detail: 'local development, DNS not required' }
      : panelAddress
        ? { name: 'dns: panel', status: 'ok', detail: `${panelHost} → ${panelAddress}` }
        : {
            name: 'dns: panel',
            status: 'warn',
            detail: `${panelHost} does not resolve`,
            hint: 'Add an A record for the panel host (docs/DEPLOY.md §1)',
          },
  );

  if (!isLocal) {
    const probeHost = `nodock-probe.${config.baseDomain}`;
    const probeAddress = await resolve(probeHost);
    add(
      probeAddress
        ? {
            name: 'dns: wildcard',
            status: 'ok',
            detail: `*.${config.baseDomain} → ${probeAddress}`,
          }
        : {
            name: 'dns: wildcard',
            status: 'warn',
            detail: `*.${config.baseDomain} does not resolve`,
            hint: 'Service hosts need a wildcard A record; certificates are issued per host on demand',
          },
    );
  }

  return { ok: checks.every((check) => check.status !== 'fail'), checks };
}

export function formatReport(report: DoctorReport): string {
  const badge: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = report.checks.map(
    (check) =>
      `${badge[check.status]}  ${check.name.padEnd(16)} ${check.detail}${
        check.hint ? `\n      → ${check.hint}` : ''
      }`,
  );

  return `nodock doctor\n\n${lines.join('\n')}\n\n${
    report.ok ? 'no blocking problems found' : 'fix the FAIL lines before deploying'
  }`;
}

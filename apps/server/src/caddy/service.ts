import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments, serviceEnvs, services } from '../db/schema';
import type { CaddyAdmin } from './admin';
import { artifactRoot, renderCaddyfile, type CaddyRoute } from './render';

export interface CaddyDeps {
  config: Config;
  db: Db;
  admin: CaddyAdmin;
}

/** Hosts the panel is allowed to issue certificates for. */
export function allowedHosts(db: Db, config: Config): Set<string> {
  const hosts = new Set<string>([new URL(config.url).host.toLowerCase()]);

  const rows = db
    .select({ generatedHost: serviceEnvs.generatedHost, customDomain: serviceEnvs.customDomain })
    .from(serviceEnvs)
    .all();

  for (const row of rows) {
    hosts.add(row.generatedHost.toLowerCase());
    if (row.customDomain) hosts.add(row.customDomain.toLowerCase());
  }

  return hosts;
}

/**
 * The route a deploy is switching to. Either a container that was just health
 * checked, or a directory that was just extracted — never both.
 */
export interface PendingRoute {
  host: string;
  upstream?: string;
  /** Absolute path in Caddy's filesystem. */
  root?: string;
  spaFallback?: boolean;
}

export interface BuildRoutesOptions {
  /** Present while a deployment is switching: it becomes the primary route. */
  pending?: PendingRoute;
  /** Where Caddy sees the artifacts volume. */
  artifactsRoot?: string;
  /** Root on disk for the artifacts, so `404.html` can be looked for. */
  artifactsDir?: string;
}

interface LiveDeployment {
  containerName: string | null;
  createdAt: Date;
  mode: string;
  artifactPath: string | null;
}

/**
 * Routes point at the newest live deployment of each service env: the container
 * it started, or the directory it delivered. A host with no live deployment still
 * gets a certificate (it is in `allowedHosts`) but no route, so it 404s until the
 * first successful deploy.
 */
export function buildRoutes(db: Db, options: BuildRoutesOptions = {}): CaddyRoute[] {
  const artifactsRoot = options.artifactsRoot ?? '/srv/artifacts';
  const artifactsDir = options.artifactsDir ?? './.data/artifacts';
  const pending = options.pending;

  const envRows = db
    .select({
      id: serviceEnvs.id,
      serviceId: serviceEnvs.serviceId,
      generatedHost: serviceEnvs.generatedHost,
      customDomain: serviceEnvs.customDomain,
    })
    .from(serviceEnvs)
    .all();

  const newestLive = new Map<string, LiveDeployment>();
  for (const row of db
    .select({
      serviceEnvId: deployments.serviceEnvId,
      containerName: deployments.containerName,
      createdAt: deployments.createdAt,
      mode: deployments.mode,
      artifactPath: deployments.artifactPath,
    })
    .from(deployments)
    .where(eq(deployments.status, 'live'))
    .all()) {
    const current = newestLive.get(row.serviceEnvId);
    if (!current || row.createdAt > current.createdAt) {
      newestLive.set(row.serviceEnvId, {
        containerName: row.containerName,
        createdAt: row.createdAt,
        mode: row.mode,
        artifactPath: row.artifactPath,
      });
    }
  }

  const serviceById = new Map(
    db
      .select({
        id: services.id,
        containerPort: services.containerPort,
        spaFallback: services.spaFallback,
      })
      .from(services)
      .all()
      .map((row) => [row.id, row] as const),
  );

  const routes: CaddyRoute[] = [];
  for (const row of envRows) {
    const live = newestLive.get(row.id);
    const host = row.customDomain ?? row.generatedHost;
    const service = serviceById.get(row.serviceId);
    const port = service?.containerPort ?? 3000;

    // During a switch the pending deployment becomes primary and the live one is
    // kept as failover, so a container that is healthy at the HTTP level but
    // crashes on the first real request does not take the host down. That trick
    // has no meaning for files: there is nothing to fail over to.
    if (pending && pending.host === host) {
      if (pending.root) {
        routes.push({
          host,
          root: pending.root,
          spaFallback: pending.spaFallback ?? service?.spaFallback ?? false,
        });
        continue;
      }

      routes.push({
        host,
        upstream: pending.upstream,
        ...(live?.containerName ? { previous: `${live.containerName}:${port}` } : {}),
      });
      continue;
    }

    if (live?.mode === 'artifact' && live.artifactPath) {
      routes.push({
        host,
        root: artifactRoot(live.artifactPath, artifactsRoot),
        spaFallback: service?.spaFallback ?? false,
        // The build's own 404 page, when it shipped one.
        notFound: existsSync(
          join(artifactsDir, live.artifactPath.replace(/^artifacts\//, ''), '404.html'),
        ),
      });
      continue;
    }

    if (!live?.containerName) continue;
    routes.push({ host, upstream: `${live.containerName}:${port}` });
  }

  return routes;
}

export function renderCurrentConfig(deps: {
  config: Config;
  db: Db;
  /** Present only while a deployment is being health-checked or switched. */
  probe?: { deploymentId: string; upstream?: string; root?: string };
}): string {
  const { artifactsDir } = deps.config.paths;
  const options: BuildRoutesOptions = {
    artifactsRoot: deps.config.caddy.artifactsRoot,
    artifactsDir,
  };

  return renderCaddyfile({
    dashboardHost: new URL(deps.config.url).host,
    dashboardUpstream: 'nodock:3000',
    askUrl: deps.config.caddy.askUrl,
    adminSocket: deps.config.caddy.adminSocket,
    adminUrl: deps.config.caddy.adminUrl,
    artifactsRoot: deps.config.caddy.artifactsRoot,
    routes: buildRoutes(deps.db, options),
    ...(deps.probe
      ? {
          probes: [
            {
              id: deps.probe.deploymentId,
              // Exactly one of the two, as the probe renderer expects.
              ...(deps.probe.root ? { root: deps.probe.root } : { upstream: deps.probe.upstream }),
            },
          ],
        }
      : {}),
  });
}

export interface ReconcileResult {
  ok: boolean;
  hosts: number;
  error?: string;
}

/** One writer: renders everything and loads it, atomically. */
export async function reconcileCaddy(deps: CaddyDeps): Promise<ReconcileResult> {
  try {
    const config = renderCurrentConfig(deps);
    await deps.admin.load(config);
    const routes = buildRoutes(deps.db, {
      artifactsRoot: deps.config.caddy.artifactsRoot,
      artifactsDir: deps.config.paths.artifactsDir,
    });
    return { ok: true, hosts: routes.length + 1 };
  } catch (error) {
    return { ok: false, hosts: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Boot: Caddy may still be starting, so retry with a short backoff. */
export async function reconcileWithRetry(
  deps: CaddyDeps,
  attempts = 5,
  delayMs = 1000,
): Promise<ReconcileResult> {
  let last: ReconcileResult = { ok: false, hosts: 0, error: 'not attempted' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Sequential by design: these are retries with backoff, not parallel work.
    // eslint-disable-next-line no-await-in-loop
    last = await reconcileCaddy(deps);
    if (last.ok) return last;
    // eslint-disable-next-line no-await-in-loop
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return last;
}

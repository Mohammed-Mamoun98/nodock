import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments, serviceEnvs, services } from '../db/schema';
import type { CaddyAdmin } from './admin';
import { renderCaddyfile, type CaddyRoute } from './render';

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
 * Routes point at the container of each service env's newest live deployment.
 * A host with no live deployment still gets a certificate (it is in `allowedHosts`)
 * but no route, so it 404s until the first successful deploy.
 */
export function buildRoutes(db: Db): CaddyRoute[] {
  const envRows = db
    .select({
      id: serviceEnvs.id,
      serviceId: serviceEnvs.serviceId,
      generatedHost: serviceEnvs.generatedHost,
      customDomain: serviceEnvs.customDomain,
    })
    .from(serviceEnvs)
    .all();

  const newestLive = new Map<string, { containerName: string | null; createdAt: Date }>();
  for (const row of db
    .select({
      serviceEnvId: deployments.serviceEnvId,
      containerName: deployments.containerName,
      createdAt: deployments.createdAt,
    })
    .from(deployments)
    .where(eq(deployments.status, 'live'))
    .all()) {
    const current = newestLive.get(row.serviceEnvId);
    if (!current || row.createdAt > current.createdAt) {
      newestLive.set(row.serviceEnvId, {
        containerName: row.containerName,
        createdAt: row.createdAt,
      });
    }
  }

  const portByServiceId = new Map(
    db
      .select({ id: services.id, containerPort: services.containerPort })
      .from(services)
      .all()
      .map((row) => [row.id, row.containerPort] as const),
  );

  const routes: CaddyRoute[] = [];
  for (const row of envRows) {
    const live = newestLive.get(row.id);
    if (!live?.containerName) continue;

    const port = portByServiceId.get(row.serviceId) ?? 3000;
    routes.push({
      host: row.customDomain ?? row.generatedHost,
      upstream: `${live.containerName}:${port}`,
    });
  }

  return routes;
}

export function renderCurrentConfig(deps: { config: Config; db: Db }): string {
  return renderCaddyfile({
    dashboardHost: new URL(deps.config.url).host,
    dashboardUpstream: 'nodock:3000',
    askUrl: deps.config.caddy.askUrl,
    routes: buildRoutes(deps.db),
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
    const routes = buildRoutes(deps.db);
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

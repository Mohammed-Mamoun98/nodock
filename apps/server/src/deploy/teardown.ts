import { eq, inArray } from 'drizzle-orm';
import type { CaddyAdmin } from '../caddy/admin';
import { renderCurrentConfig } from '../caddy/service';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments, serviceEnvs, services } from '../db/schema';
import type { DockerAdapter } from '../docker/adapter';

export interface TeardownDeps {
  config: Config;
  db: Db;
  docker?: DockerAdapter;
  admin?: CaddyAdmin | null;
}

export interface TeardownResult {
  stopped: string[];
  errors: string[];
}

/**
 * Collects container names before rows disappear, because after the cascade there
 * is nothing left to look them up by. Rows are deleted by the caller; this only
 * answers "which containers belonged to these service envs".
 */
export function containerNamesFor(db: Db, serviceEnvIds: string[]): string[] {
  if (serviceEnvIds.length === 0) return [];

  const rows = db
    .select({ containerName: deployments.containerName })
    .from(deployments)
    .where(inArray(deployments.serviceEnvId, serviceEnvIds))
    .all();

  return [
    ...new Set(
      rows.map((row) => row.containerName).filter((name): name is string => Boolean(name)),
    ),
  ];
}

/** Stops and removes containers, tolerating a missing daemon or already-gone boxes. */
export async function stopContainers(
  docker: DockerAdapter | undefined,
  names: string[],
): Promise<TeardownResult> {
  const stopped: string[] = [];
  const errors: string[] = [];
  if (!docker) return { stopped, errors };

  for (const name of names) {
    try {
      // Sequential on purpose: stopping many containers at once on a 1 vCPU box
      // trades a few seconds for a burst of daemon work nobody asked for.
      // eslint-disable-next-line no-await-in-loop
      await docker.stop(name, 15);
      // eslint-disable-next-line no-await-in-loop
      await docker.remove(name);
      stopped.push(name);
    } catch (error) {
      // A container that is already gone is not a failure worth blocking on.
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { stopped, errors };
}

/** Re-renders Caddy from the remaining rows. Called after the delete commits. */
export async function reconcileRoutes(deps: TeardownDeps): Promise<string | null> {
  if (!deps.admin) return null;

  try {
    await deps.admin.load(renderCurrentConfig({ config: deps.config, db: deps.db }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Service env ids for a project / service / environment, gathered before the cascade. */
export function serviceEnvIdsForProject(db: Db, projectId: string): string[] {
  return db
    .select({ id: serviceEnvs.id })
    .from(serviceEnvs)
    .innerJoin(services, eq(services.id, serviceEnvs.serviceId))
    .where(eq(services.projectId, projectId))
    .all()
    .map((row) => row.id);
}

export function serviceEnvIdsForService(db: Db, serviceId: string): string[] {
  return db
    .select({ id: serviceEnvs.id })
    .from(serviceEnvs)
    .where(eq(serviceEnvs.serviceId, serviceId))
    .all()
    .map((row) => row.id);
}

export function serviceEnvIdsForEnvironment(db: Db, environmentId: string): string[] {
  return db
    .select({ id: serviceEnvs.id })
    .from(serviceEnvs)
    .where(eq(serviceEnvs.environmentId, environmentId))
    .all()
    .map((row) => row.id);
}

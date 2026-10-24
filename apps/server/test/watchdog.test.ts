import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config';
import { deployments, environments, projects, serviceEnvs, services } from '../src/db/schema';
import {
  markInterruptedOnBoot,
  startWatchdog,
  sweepStaleDeployments,
} from '../src/deploy/watchdog';
import { testDb } from './helpers';

void loadConfig;

function seed(db: ReturnType<typeof testDb>['db']) {
  const project = db.insert(projects).values({ name: 'Milo', slug: 'milo' }).returning().get();
  const env = db
    .insert(environments)
    .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
    .returning()
    .get();
  const service = db
    .insert(services)
    .values({ projectId: project.id, name: 'api', slug: 'api', repoFullName: 'mohammed/milo' })
    .returning()
    .get();
  const serviceEnv = db
    .insert(serviceEnvs)
    .values({
      serviceId: service.id,
      environmentId: env.id,
      branch: 'main',
      generatedHost: 'api.apps.example.com',
    })
    .returning()
    .get();

  return serviceEnv;
}

function addDeployment(
  db: ReturnType<typeof testDb>['db'],
  serviceEnvId: string,
  status: 'queued' | 'pulling' | 'starting' | 'switching' | 'live' | 'failed',
  ageMs: number,
) {
  const when = new Date(Date.now() - ageMs);
  return db
    .insert(deployments)
    .values({
      serviceEnvId,
      trigger: 'push',
      status,
      imageRef: 'ghcr.io/mohammed/milo:api-x',
      createdAt: when,
      startedAt: status === 'queued' ? null : when,
    })
    .returning()
    .get();
}

describe('sweep', () => {
  test('fails a queued deployment whose CI callback never arrived', () => {
    const { db } = testDb();
    const serviceEnv = seed(db);
    const stale = addDeployment(db, serviceEnv.id, 'queued', 45 * 60 * 1000);
    const fresh = addDeployment(db, serviceEnv.id, 'queued', 2 * 60 * 1000);

    const result = sweepStaleDeployments(db);

    expect(result.queuedFailed).toBe(1);
    expect(db.select().from(deployments).where(eq(deployments.id, stale.id)).get()).toMatchObject({
      status: 'failed',
      error: 'CI never reported back',
    });
    expect(db.select().from(deployments).where(eq(deployments.id, fresh.id)).get()?.status).toBe(
      'queued',
    );
  });

  test('fails a deployment stuck mid-flight, and leaves live ones alone', () => {
    const { db } = testDb();
    const serviceEnv = seed(db);
    const stuck = addDeployment(db, serviceEnv.id, 'pulling', 20 * 60 * 1000);
    const live = addDeployment(db, serviceEnv.id, 'live', 40 * 60 * 1000);

    const result = sweepStaleDeployments(db);

    expect(result.inFlightFailed).toBe(1);
    expect(db.select().from(deployments).where(eq(deployments.id, stuck.id)).get()?.error).toBe(
      'deployment stalled',
    );
    expect(db.select().from(deployments).where(eq(deployments.id, live.id)).get()?.status).toBe(
      'live',
    );
  });

  test('does nothing when everything is healthy', () => {
    const { db } = testDb();
    const serviceEnv = seed(db);
    addDeployment(db, serviceEnv.id, 'queued', 1000);
    addDeployment(db, serviceEnv.id, 'starting', 5000);

    expect(sweepStaleDeployments(db)).toEqual({ queuedFailed: 0, inFlightFailed: 0 });
  });
});

describe('boot recovery', () => {
  test('marks every in-flight deployment as interrupted', () => {
    const { db } = testDb();
    const serviceEnv = seed(db);
    addDeployment(db, serviceEnv.id, 'pulling', 5000);
    addDeployment(db, serviceEnv.id, 'switching', 8000);
    addDeployment(db, serviceEnv.id, 'live', 60_000);

    expect(markInterruptedOnBoot(db)).toBe(2);

    const rows = db.select().from(deployments).all();
    const interrupted = rows.filter((row) => row.error === 'interrupted by a nodock restart');
    expect(interrupted).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'live')).toHaveLength(1);
  });

  test('the interval watchdog runs and can be stopped', async () => {
    const { db } = testDb();
    const serviceEnv = seed(db);
    const stale = addDeployment(db, serviceEnv.id, 'queued', 45 * 60 * 1000);

    const stop = startWatchdog(db, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(db.select().from(deployments).where(eq(deployments.id, stale.id)).get()?.status).toBe(
      'failed',
    );
  });
});

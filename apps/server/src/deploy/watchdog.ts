import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';

/** A CI callback normally lands within minutes; half an hour means it was lost. */
const QUEUED_TIMEOUT_MS = 30 * 60 * 1000;

/** A pull/start/switch that never finished is a hung daemon or a dead process. */
const IN_FLIGHT_TIMEOUT_MS = 15 * 60 * 1000;

const IN_FLIGHT = ['pulling', 'starting', 'healthchecking', 'switching'] as const;

/**
 * Anything mid-flight when the process died can never complete: nothing is
 * waiting on it, and its status would otherwise look like progress forever.
 */
export function markInterruptedOnBoot(db: Db, now: number = Date.now()): number {
  const stale = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, [...IN_FLIGHT]))
    .all();

  if (stale.length === 0) return 0;

  db.update(deployments)
    .set({
      status: 'failed',
      error: 'interrupted by a nodock restart',
      finishedAt: new Date(now),
    })
    .where(
      inArray(
        deployments.id,
        stale.map((row) => row.id),
      ),
    )
    .run();

  return stale.length;
}

export interface SweepResult {
  queuedFailed: number;
  inFlightFailed: number;
}

/**
 * Runs on boot and every minute. Deliberately conservative: a deployment that is
 * merely slow is left alone, and a failed one is never resurrected.
 */
export function sweepStaleDeployments(db: Db, now: number = Date.now()): SweepResult {
  const queuedCutoff = new Date(now - QUEUED_TIMEOUT_MS);
  const inFlightCutoff = new Date(now - IN_FLIGHT_TIMEOUT_MS);

  const staleQueued = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.status, 'queued'), lt(deployments.createdAt, queuedCutoff)))
    .all();

  if (staleQueued.length > 0) {
    db.update(deployments)
      .set({
        status: 'failed',
        error: 'CI never reported back',
        finishedAt: new Date(now),
      })
      .where(
        inArray(
          deployments.id,
          staleQueued.map((row) => row.id),
        ),
      )
      .run();
  }

  const staleInFlight = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(inArray(deployments.status, [...IN_FLIGHT]), lt(deployments.startedAt, inFlightCutoff)),
    )
    .all();

  if (staleInFlight.length > 0) {
    db.update(deployments)
      .set({
        status: 'failed',
        error: 'deployment stalled',
        finishedAt: new Date(now),
      })
      .where(
        inArray(
          deployments.id,
          staleInFlight.map((row) => row.id),
        ),
      )
      .run();
  }

  return { queuedFailed: staleQueued.length, inFlightFailed: staleInFlight.length };
}

/** Boot + interval. Returns a stop function so tests and shutdown can clean up. */
export function startWatchdog(db: Db, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    const result = sweepStaleDeployments(db);
    if (result.queuedFailed > 0 || result.inFlightFailed > 0) {
      console.log(
        `[nodock] watchdog: ${result.queuedFailed} stale queued, ${result.inFlightFailed} stalled`,
      );
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

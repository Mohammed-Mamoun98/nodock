import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { deployments, type RuntimeState } from '../db/schema';
import type { ContainerState, DockerAdapter } from '../docker/adapter';

/** What `docker inspect` can legitimately say. Anything else is recorded as unknown. */
const KNOWN: ReadonlySet<string> = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

/**
 * One inspect is a process spawn; a box with more than this many live deployments
 * is not a case worth optimising for, but an unbounded loop on a slow daemon is.
 */
const MAX_INSPECTS = 25;

export function runtimeStateOf(state: ContainerState | null): RuntimeState {
  if (!state) return 'missing';
  return KNOWN.has(state.status) ? (state.status as RuntimeState) : 'unknown';
}

export interface RuntimeChange {
  deploymentId: string;
  containerName: string;
  from: RuntimeState | null;
  to: RuntimeState;
}

export interface RuntimeSweepResult {
  checked: number;
  changed: RuntimeChange[];
  /** The daemon refused to answer: nothing was concluded this round. */
  unreachable: boolean;
}

/**
 * Asks Docker what the containers behind the `live` deployments are actually doing.
 *
 * The deployment status is the record of a deploy: it says the pull, the health
 * check and the route switch all worked, and it stays true. It cannot say that the
 * process died ten minutes later — only the daemon knows that, and `--restart
 * unless-stopped` means a crash-looping app looks alive from the outside. This
 * writes what the daemon says onto the row so the panel can stop calling a dead
 * container "live".
 *
 * Deliberately read-only towards status: a crashed container does not retroactively
 * make the deployment a failure, and nothing here touches Caddy. A daemon we cannot
 * reach is `unknown`, never `crashed` — we do not invent outages.
 */
export async function sweepRuntime(
  db: Db,
  docker: Pick<DockerAdapter, 'inspect'>,
  now: number = Date.now(),
): Promise<RuntimeSweepResult> {
  const rows = db
    .select()
    .from(deployments)
    .where(eq(deployments.status, 'live'))
    .all()
    .filter((row) => Boolean(row.containerName))
    .slice(0, MAX_INSPECTS);

  const changed: RuntimeChange[] = [];
  let checked = 0;
  let unreachable = false;

  for (const row of rows) {
    const containerName = row.containerName!;
    let state: ContainerState | null;

    try {
      // Sequential on purpose: a handful of spawns, and the write below must not
      // race the read. Parallelism here would only add ways to block the loop.
      // eslint-disable-next-line no-await-in-loop
      state = await docker.inspect(containerName);
    } catch {
      unreachable = true;
      db.update(deployments)
        .set({ runtimeState: 'unknown', runtimeCheckedAt: new Date(now) })
        .where(eq(deployments.id, row.id))
        .run();
      continue;
    }

    const next = runtimeStateOf(state);
    checked += 1;

    if (next !== row.runtimeState) {
      changed.push({ deploymentId: row.id, containerName, from: row.runtimeState, to: next });
    }

    db.update(deployments)
      .set({
        runtimeState: next,
        runtimeExitCode: state?.exitCode ?? null,
        runtimeRestarts: state?.restartCount ?? 0,
        runtimeOom: state?.oomKilled ?? false,
        runtimeCheckedAt: new Date(now),
      })
      .where(eq(deployments.id, row.id))
      .run();
  }

  return { checked, changed, unreachable };
}

/**
 * The sentence the panel shows instead of a green "live" it cannot back up.
 * `null` means "nothing to say": the container is running as deployed.
 */
export function runtimeWarning(row: {
  runtimeState: string | null;
  runtimeRestarts: number | null;
  runtimeExitCode: number | null;
  runtimeOom: boolean | null;
}): string | null {
  const restarts = row.runtimeRestarts ?? 0;
  const restarted = restarts > 0 ? ` (${restarts} restart${restarts === 1 ? '' : 's'})` : '';

  switch (row.runtimeState) {
    case null:
    case 'running':
      return null;
    case 'restarting':
      return `container keeps restarting${restarted} — check the logs`;
    case 'exited':
      return row.runtimeOom
        ? `container killed by the OOM killer, exit ${row.runtimeExitCode ?? '—'}`
        : `container exited with code ${row.runtimeExitCode ?? '—'}${restarted}`;
    case 'dead':
      return `container is dead${restarted} — the daemon gave up on it`;
    case 'missing':
      return 'container is gone — nothing is running for this deployment';
    case 'unknown':
      return 'cannot reach the docker daemon to check this container';
    default:
      return `container is ${row.runtimeState}${restarted}`;
  }
}

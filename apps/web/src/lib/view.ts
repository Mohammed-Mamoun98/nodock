import type { LatestDeployment, ServiceSummary } from './api';

export type ServiceState =
  | 'live'
  | 'building'
  | 'failed'
  | 'crashed'
  | 'restarting'
  | 'stopped'
  | 'undeployed';

/**
 * A "live" deployment whose container is not running is not live. The deployment
 * status records that the deploy worked; this is the part that can change afterwards.
 */
function runtimeStateOf(latest: LatestDeployment): ServiceState {
  switch (latest.runtimeState) {
    // Absent means a server from before the sweep existed: assume healthy rather
    // than invent a crash the panel cannot back up.
    case null:
    case undefined:
    case 'running':
    case 'created':
    case 'paused':
      return 'live';
    case 'restarting':
      return 'restarting';
    default:
      // exited, dead, missing, unknown, removing
      return 'crashed';
  }
}

export interface ServiceView {
  id: string;
  name: string;
  repo: string;
  branch: string;
  sha: string;
  state: ServiceState;
  age: string;
  failure: string | null;
  host: string;
  envId: string;
  runUrl: string | null;
}

/** "42s ago" — enough precision to be useful, never a wall of digits. */
export function relativeAge(iso: string | null): string {
  if (!iso) return 'never';
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.floor(deltaMs / 1000))}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The deployment state machine collapsed into what a card can say. */
export function deriveState(latest: LatestDeployment | null): ServiceState {
  if (!latest) return 'undeployed';
  switch (latest.status) {
    case 'live':
      return runtimeStateOf(latest);
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'superseded':
      return 'stopped';
    default:
      return 'building';
  }
}

export function toServiceView(service: ServiceSummary): ServiceView {
  const link = service.serviceEnvs[0] ?? null;
  const latest = link?.latestDeployment ?? null;

  return {
    id: service.id,
    name: service.name,
    repo: service.repoFullName,
    branch: link?.branch ?? 'main',
    sha: latest?.commitSha?.slice(0, 7) ?? '—',
    state: deriveState(latest),
    age: relativeAge(latest?.createdAt ?? null),
    failure: latest?.runtimeWarning ?? latest?.error ?? null,
    host: link?.customDomain ?? link?.generatedHost ?? '',
    envId: link?.environmentId ?? '',
    runUrl: latest?.ciRunUrl ?? null,
  };
}

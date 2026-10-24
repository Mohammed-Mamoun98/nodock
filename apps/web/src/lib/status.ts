import type { DeploymentStatus, ServiceState } from './types';

export type Tone = 'lime' | 'amber' | 'red' | 'steel';

/** Status → what the operator reads. Never colour alone: every state has a word. */
export const statusMeta: Record<DeploymentStatus, { label: string; tone: Tone; inFlight: boolean }> = {
  queued: { label: 'queued', tone: 'amber', inFlight: true },
  pulling: { label: 'pulling', tone: 'amber', inFlight: true },
  starting: { label: 'starting', tone: 'amber', inFlight: true },
  healthchecking: { label: 'health check', tone: 'amber', inFlight: true },
  switching: { label: 'switching', tone: 'amber', inFlight: true },
  live: { label: 'live', tone: 'lime', inFlight: false },
  failed: { label: 'failed', tone: 'red', inFlight: false },
  cancelled: { label: 'cancelled', tone: 'steel', inFlight: false },
};

export const stateMeta: Record<ServiceState, { label: string; tone: Tone; inFlight: boolean }> = {
  live: { label: 'live', tone: 'lime', inFlight: false },
  building: { label: 'building on github', tone: 'amber', inFlight: true },
  failed: { label: 'failed', tone: 'red', inFlight: false },
  stopped: { label: 'stopped', tone: 'steel', inFlight: false },
};

/** Card action label follows state — one primary action, never a menu of maybes. */
export function primaryAction(state: ServiceState): { label: string; kind: 'primary' | 'secondary' } {
  switch (state) {
    case 'building':
      return { label: 'View build', kind: 'primary' };
    case 'failed':
      return { label: 'Redeploy', kind: 'secondary' };
    case 'stopped':
      return { label: 'Start', kind: 'secondary' };
    case 'live':
      return { label: 'Open URL', kind: 'secondary' };
  }
}

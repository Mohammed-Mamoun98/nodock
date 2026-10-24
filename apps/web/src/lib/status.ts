export type Tone = 'lime' | 'amber' | 'red' | 'steel';

import type { ServiceState } from '../lib/view';

export const stateMeta: Record<ServiceState, { label: string; tone: Tone; inFlight: boolean }> = {
  live: { label: 'live', tone: 'lime', inFlight: false },
  building: { label: 'building on github', tone: 'amber', inFlight: true },
  failed: { label: 'failed', tone: 'red', inFlight: false },
  stopped: { label: 'stopped', tone: 'steel', inFlight: false },
  undeployed: { label: 'not deployed', tone: 'steel', inFlight: false },
};
/** Card action follows state — one primary action, never a menu of maybes. */
export function primaryAction(state: ServiceState): {
  label: string;
  kind: 'primary' | 'secondary';
} {
  switch (state) {
    case 'building':
      return { label: 'View build', kind: 'primary' };
    case 'failed':
      return { label: 'Redeploy', kind: 'secondary' };
    case 'stopped':
      return { label: 'Start', kind: 'secondary' };
    case 'undeployed':
      return { label: 'Deploy', kind: 'primary' };
    case 'live':
      return { label: 'Open URL', kind: 'secondary' };
  }
}

export const deploymentStatusMeta: Record<
  | 'queued'
  | 'pulling'
  | 'starting'
  | 'healthchecking'
  | 'switching'
  | 'live'
  | 'failed'
  | 'cancelled',
  { label: string; tone: Tone }
> = {
  queued: { label: 'queued', tone: 'amber' },
  pulling: { label: 'pulling', tone: 'amber' },
  starting: { label: 'starting', tone: 'amber' },
  healthchecking: { label: 'health check', tone: 'amber' },
  switching: { label: 'switching', tone: 'amber' },
  live: { label: 'live', tone: 'lime' },
  failed: { label: 'failed', tone: 'red' },
  cancelled: { label: 'cancelled', tone: 'steel' },
};

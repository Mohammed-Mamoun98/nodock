/** Mirrors apps/server/src/db/schema.ts — the DB is the source of truth. */
export type DeploymentStatus =
  | 'queued'
  | 'pulling'
  | 'starting'
  | 'healthchecking'
  | 'switching'
  | 'live'
  | 'failed'
  | 'cancelled';

export type ServiceState = 'live' | 'building' | 'failed' | 'stopped';

export interface Service {
  id: string;
  name: string;
  repo: string;
  branch: string;
  sha: string;
  state: ServiceState;
  /** Most recent deployment status, when there is one. */
  status: DeploymentStatus | null;
  /** e.g. "42s ago" — produced by the server or formatted at render. */
  age: string;
  /** Set when state is 'failed'; the design shows cause + fix, never "something broke". */
  failure: string | null;
  currentDeploymentId: string | null;
}

export interface Deployment {
  id: string;
  number: number;
  status: DeploymentStatus;
  sha: string;
  branch: string;
  trigger: 'manual' | 'push' | 'rollback';
  age: string;
  duration: string;
  runUrl: string | null;
  /** Already shipped once, so rollback is meaningful. */
  rollbackable: boolean;
}

export interface Variable {
  key: string;
  value: string;
  secret: boolean;
}

export interface Project {
  id: string;
  name: string;
  serviceCount: number;
  active: boolean;
}

export interface EnvironmentRef {
  id: string;
  name: string;
  serviceCount: number;
  active: boolean;
}

export interface LogLine {
  /** Monotonic id from the stream; the render key. */
  seq: number;
  time: string;
  text: string;
}

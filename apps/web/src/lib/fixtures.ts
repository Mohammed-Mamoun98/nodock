import type { Deployment, EnvironmentRef, LogLine, Project, Service, Variable } from './types';

/**
 * Mock data while the API lands. Shapes match apps/server/src/db/schema.ts so the
 * swap to real endpoints is a fetch, not a refactor.
 */
export const projects: Project[] = [
  { id: 'milo', name: 'milo', serviceCount: 5, active: true },
  { id: 'shim', name: 'shim', serviceCount: 0, active: false },
  { id: 'new-project', name: 'new-project', serviceCount: 0, active: false },
  { id: 'scratch', name: 'scratch', serviceCount: 0, active: false },
];

export const environments: EnvironmentRef[] = [
  { id: 'production', name: 'Production', serviceCount: 5, active: true },
  { id: 'staging', name: 'Staging', serviceCount: 2, active: false },
];

export const services: Service[] = [
  {
    id: 'milo-web',
    name: 'milo-web',
    repo: 'mohammed/milo',
    branch: 'main',
    sha: '5f684a0',
    state: 'live',
    status: 'live',
    age: '1m ago',
    failure: null,
    currentDeploymentId: '1841',
  },
  {
    id: 'milo-api',
    name: 'milo-api',
    repo: 'mohammed/milo',
    branch: 'main',
    sha: 'a3f9c21',
    state: 'building',
    status: 'healthchecking',
    age: '42s ago',
    failure: null,
    currentDeploymentId: '1842',
  },
  {
    id: 'milo-bot',
    name: 'milo-bot',
    repo: 'mohammed/milo-bot',
    branch: 'main',
    sha: '7c1e002',
    state: 'live',
    status: 'live',
    age: '2d ago',
    failure: null,
    currentDeploymentId: '1802',
  },
  {
    id: 'milo-docs',
    name: 'milo-docs',
    repo: 'mohammed/milo-docs',
    branch: 'main',
    sha: 'e42b118',
    state: 'failed',
    status: 'failed',
    age: '3h ago',
    failure: 'pull 401 · add GHCR_TOKEN',
    currentDeploymentId: '1795',
  },
  {
    id: 'milo-worker',
    name: 'milo-worker',
    repo: 'mohammed/milo',
    branch: 'feat/queues',
    sha: '9d02f11',
    state: 'stopped',
    status: null,
    age: '5d ago',
    failure: null,
    currentDeploymentId: '1780',
  },
];

export const deployments: Deployment[] = [
  {
    id: '1842',
    number: 1842,
    status: 'healthchecking',
    sha: 'a3f9c21',
    branch: 'main',
    trigger: 'push',
    age: '42s ago',
    duration: '42s',
    runUrl: 'https://github.com/mohammed/milo/actions',
    rollbackable: false,
  },
  {
    id: '1841',
    number: 1841,
    status: 'live',
    sha: '5f684a0',
    branch: 'main',
    trigger: 'push',
    age: '1m ago',
    duration: '1m 12s',
    runUrl: null,
    rollbackable: true,
  },
  {
    id: '1840',
    number: 1840,
    status: 'cancelled',
    sha: 'd2f1a3b',
    branch: 'main',
    trigger: 'push',
    age: '2m ago',
    duration: '1m 40s',
    runUrl: null,
    rollbackable: true,
  },
  {
    id: '1839',
    number: 1839,
    status: 'failed',
    sha: 'k9l0m1n',
    branch: 'main',
    trigger: 'manual',
    age: '3m ago',
    duration: '38s',
    runUrl: 'https://github.com/mohammed/milo/actions',
    rollbackable: false,
  },
  {
    id: '1838',
    number: 1838,
    status: 'live',
    sha: 'z8x7c6v',
    branch: 'main',
    trigger: 'push',
    age: '5m ago',
    duration: '2m 05s',
    runUrl: null,
    rollbackable: true,
  },
];

export const deployLog: LogLine[] = [
  { time: '12:04:01', text: 'pulling ghcr.io/mohammed/milo/milo-api:a3f9c21' },
  { time: '12:04:19', text: 'healthcheck /healthz 200' },
  { time: '12:04:20', text: 'starting server...' },
];

export const variables: Variable[] = [
  { key: 'DATABASE_URL', value: 'postgres://milo@db.internal:5432/milo', secret: true },
  { key: 'SESSION_SECRET', value: 'f3a1c9d2e7b4', secret: true },
  { key: 'SENTRY_DSN', value: 'https://key@sentry.io/123', secret: true },
  { key: 'NODE_ENV', value: 'production', secret: false },
  { key: 'PORT', value: '3000', secret: false },
  { key: 'LOG_LEVEL', value: 'info', secret: false },
];

export const stagingOnlyKeys = ['FEATURE_QUEUES', 'STAGING_API_BASE'];

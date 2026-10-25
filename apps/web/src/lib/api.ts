export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = parsed as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `Request failed with ${response.status}`,
      body?.error?.details,
    );
  }

  return parsed as T;
}

export interface Me {
  login: string;
  avatarUrl: string | null;
  scopes: string[];
  missingScopes: string[];
  needsReconnect: boolean;
}

export async function fetchMe(): Promise<Me | null> {
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status, 'http_error', 'Could not load session');
  return (await response.json()) as Me;
}

export function signOut(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function fetchControlPlaneRss(): Promise<number | null> {
  return fetch('/metrics-lite')
    .then((response) => (response.ok ? (response.json() as Promise<{ rssMb: number }>) : null))
    .then((data) => data?.rssMb ?? null)
    .catch(() => null);
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  serviceCount?: number;
  createdAt?: string;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  serviceCount: number;
}

export type DeploymentStatus =
  | 'queued'
  | 'pulling'
  | 'starting'
  | 'healthchecking'
  | 'switching'
  | 'live'
  | 'failed'
  | 'cancelled'
  /** Was live, then a newer deployment took the route. */
  | 'superseded';

/** `docker inspect` on the deployment's container. Null before the first check. */
export type RuntimeState =
  | 'running'
  | 'restarting'
  | 'created'
  | 'paused'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'missing'
  | 'unknown';

export interface LatestDeployment {
  id: string;
  status: DeploymentStatus;
  trigger: 'manual' | 'push' | 'rollback';
  commitSha: string | null;
  ciRunUrl: string | null;
  error: string | null;
  createdAt: string | null;
  runtimeState: RuntimeState | null;
  /** The sentence to show instead of a green "live"; null when nothing is wrong. */
  runtimeWarning: string | null;
}

export interface ServiceEnvSummary {
  id: string;
  environmentId: string;
  branch: string;
  healthPath: string | null;
  generatedHost: string;
  customDomain: string | null;
  latestDeployment: LatestDeployment | null;
}

export interface ServiceSummary {
  id: string;
  name: string;
  slug: string;
  repoFullName: string;
  dockerfilePath: string;
  contextPath: string;
  containerPort: number | null;
  memoryLimitMb: number | null;
  serviceEnvs: ServiceEnvSummary[];
}

export interface ProjectOverview {
  project: ProjectSummary;
  environments: EnvironmentSummary[];
  services: ServiceSummary[];
}

export interface VariableRow {
  key: string;
  value: string;
  isSecret: boolean;
  hidden?: boolean;
}

export function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  return request('/api/projects');
}

export function createProject(name: string): Promise<{ project: ProjectSummary }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
}

export function getProjectOverview(projectId: string): Promise<ProjectOverview> {
  return request(`/api/projects/${projectId}`);
}

export function createService(
  projectId: string,
  input: {
    name: string;
    repoFullName: string;
    branch: string;
    dockerfilePath?: string;
    contextPath?: string;
    containerPort?: number;
  },
): Promise<{ service: { id: string }; serviceEnv: { generatedHost: string } }> {
  return request(`/api/projects/${projectId}/services`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getVariables(
  serviceId: string,
  envId: string,
  reveal = false,
): Promise<{ variables: VariableRow[] }> {
  return request(`/api/services/${serviceId}/envs/${envId}/variables${reveal ? '?reveal=1' : ''}`);
}

export function saveVariables(
  serviceId: string,
  envId: string,
  variables: { key: string; value: string; isSecret: boolean }[],
): Promise<{ count: number }> {
  return request(`/api/services/${serviceId}/envs/${envId}/variables`, {
    method: 'PUT',
    body: JSON.stringify({ variables }),
  });
}

export interface VariableSuggestion {
  key: string;
  isSecret: boolean;
  /** The comment above the name in the template, when there was one. */
  comment: string | null;
}

/**
 * Names the repo's .env.example asks for. `source` is the file that answered and `note`
 * says why nothing came back — a failed scan is an answer, never an error page.
 */
export function getVariableSuggestions(
  serviceId: string,
  envId: string,
): Promise<{ source: string | null; values: VariableSuggestion[]; note: string | null }> {
  return request(`/api/services/${serviceId}/envs/${envId}/variable-suggestions`);
}

export type ServiceRecord = Omit<ServiceSummary, 'serviceEnvs'>;

export function getService(
  serviceId: string,
): Promise<{ service: ServiceRecord; serviceEnvs: ServiceEnvSummary[] }> {
  return request(`/api/services/${serviceId}`);
}

export interface RepoOption {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

export function listRepos(): Promise<{ repos: RepoOption[]; truncated: boolean }> {
  return request('/api/github/repos');
}

export function listBranches(owner: string, repo: string): Promise<{ branches: string[] }> {
  return request(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
  );
}

export interface DeploymentRow {
  id: string;
  serviceEnvId: string;
  status: DeploymentStatus;
  trigger: 'manual' | 'push' | 'rollback';
  commitSha: string | null;
  commitMessage: string | null;
  imageRef: string;
  imageDigest: string | null;
  containerName: string | null;
  ciRunUrl: string | null;
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  runtimeState: RuntimeState | null;
  runtimeExitCode: number | null;
  runtimeRestarts: number | null;
  runtimeOom: boolean | null;
  runtimeCheckedAt: string | null;
  runtimeWarning: string | null;
}

export function listDeployments(serviceId: string): Promise<{ deployments: DeploymentRow[] }> {
  return request(`/api/services/${serviceId}/deployments`);
}

export function deployService(
  serviceId: string,
  envId: string,
): Promise<{ deployment: { id: string; status: DeploymentStatus } }> {
  return request(`/api/services/${serviceId}/envs/${envId}/deploy`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function rollbackDeployment(
  serviceId: string,
  envId: string,
  deploymentId: string,
): Promise<{ deployment: { id: string; status: DeploymentStatus } }> {
  return request(`/api/services/${serviceId}/envs/${envId}/deployments/${deploymentId}/rollback`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export type CiStatus = 'not_enabled' | 'enabled' | 'out_of_date' | 'modified' | 'unknown';

export interface CiState {
  status: CiStatus;
  reason?: string;
  workflowPath?: string;
}

export function getCiStatus(owner: string, repo: string): Promise<CiState> {
  return request(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/ci`);
}

export function enableCi(
  owner: string,
  repo: string,
  overwrite = false,
): Promise<{ status: 'enabled'; workflowSha: string }> {
  return request(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/ci/enable`, {
    method: 'POST',
    body: JSON.stringify({ overwrite }),
  });
}

export interface RepoInspection {
  ref: string;
  hasDockerfile: boolean;
  dockerfilePath: string | null;
  contextPath: string | null;
  candidates: string[];
  exposedPorts: number[];
  suggestedPort: number | null;
  treeTruncated: boolean;
}

export function inspectRepo(owner: string, repo: string, ref?: string): Promise<RepoInspection> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return request(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/inspect${query}`,
  );
}

export function deleteProject(projectId: string): Promise<void> {
  return request<void>(`/api/projects/${projectId}`, { method: 'DELETE' });
}

export function deleteService(serviceId: string): Promise<void> {
  return request<void>(`/api/services/${serviceId}`, { method: 'DELETE' });
}

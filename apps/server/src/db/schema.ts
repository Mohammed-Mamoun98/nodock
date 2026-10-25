import { randomUUID } from 'node:crypto';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { STRATEGIES, type Strategy } from '../lib/framework';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date());

export const DEPLOYMENT_STATUSES = [
  'queued',
  'pulling',
  'starting',
  'healthchecking',
  'switching',
  'live',
  'failed',
  'cancelled',
  /** Was live, then a newer deployment took the route. Kept apart from `cancelled`,
   * which means "never ran": a superseded deployment served real traffic once. */
  'superseded',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * `docker inspect .State.Status`, plus `missing` for a container that is not there
 * and `unknown` for a daemon we could not ask. The deployment status says what the
 * *deploy* did; this says what the *container* is doing now, which is the part that
 * goes stale and makes a crash loop look healthy.
 */
export const RUNTIME_STATES = [
  'running',
  'restarting',
  'created',
  'paused',
  'removing',
  'exited',
  'dead',
  'missing',
  'unknown',
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const DEPLOYMENT_TRIGGERS = ['manual', 'push', 'rollback'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/**
 * How a service is built. `dockerfile` is the default, so every service created
 * before this column existed keeps behaving exactly as it did.
 */
export { STRATEGIES, type Strategy };

/**
 * What a deployment delivered. The deploy pipeline's two paths differ in more
 * than a status: an `artifact` has no container to pull, start, or inspect.
 */
export const DEPLOYMENT_MODES = ['image', 'artifact'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const users = sqliteTable(
  'users',
  {
    id: id(),
    githubId: integer('github_id').notNull(),
    login: text('login').notNull(),
    avatarUrl: text('avatar_url'),
    tokenEnc: text('token_enc'),
    /** Space-separated scopes GitHub actually granted (users can grant less than asked). */
    scopes: text('scopes'),
    createdAt: createdAt().notNull(),
  },
  (t) => [uniqueIndex('users_github_id').on(t.githubId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt().notNull(),
  },
  (t) => [uniqueIndex('sessions_token_hash').on(t.tokenHash)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt().notNull(),
  },
  (t) => [uniqueIndex('projects_slug').on(t.slug)],
);

export const environments = sqliteTable(
  'environments',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt().notNull(),
  },
  (t) => [
    uniqueIndex('environments_project_slug').on(t.projectId, t.slug),
    index('environments_project').on(t.projectId),
  ],
);

export const services = sqliteTable(
  'services',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Globally unique: it is the leftmost label of the generated host. */
    slug: text('slug').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    dockerfilePath: text('dockerfile_path').notNull().default('Dockerfile'),
    contextPath: text('context_path').notNull().default('.'),
    /** Nullable; prefilled from the image's first EXPOSE after pull. */
    containerPort: integer('container_port'),
    /** Per-service override for the 512 MB default container limit. */
    memoryLimitMb: integer('memory_limit_mb'),
    strategy: text('strategy', { enum: STRATEGIES }).notNull().default('dockerfile'),
    /** Static only; null means "the recipe's default for that framework". */
    outputDir: text('output_dir'),
    /** Static only; null means "decide from detection" (SPA vs 404). */
    spaFallback: integer('spa_fallback', { mode: 'boolean' }),
    createdAt: createdAt().notNull(),
  },
  (t) => [
    uniqueIndex('services_slug').on(t.slug),
    index('services_project').on(t.projectId),
    index('services_repo').on(t.repoFullName),
  ],
);

export const serviceEnvs = sqliteTable(
  'service_envs',
  {
    id: id(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    healthPath: text('health_path'),
    generatedHost: text('generated_host').notNull(),
    customDomain: text('custom_domain'),
    createdAt: createdAt().notNull(),
  },
  (t) => [
    uniqueIndex('service_envs_unique').on(t.serviceId, t.environmentId),
    uniqueIndex('service_envs_generated_host').on(t.generatedHost),
    uniqueIndex('service_envs_custom_domain').on(t.customDomain),
    index('service_envs_environment').on(t.environmentId),
  ],
);

export const variables = sqliteTable(
  'variables',
  {
    id: id(),
    serviceEnvId: text('service_env_id')
      .notNull()
      .references(() => serviceEnvs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    valueEnc: text('value_enc').notNull(),
    /** Display only: every value is encrypted regardless. */
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt().notNull(),
  },
  (t) => [
    uniqueIndex('variables_key').on(t.serviceEnvId, t.key),
    index('variables_service_env').on(t.serviceEnvId),
  ],
);

/** One row per repo: one webhook, one CI token, one workflow file. Services share it. */
export const repoHooks = sqliteTable(
  'repo_hooks',
  {
    id: id(),
    repoFullName: text('repo_full_name').notNull(),
    hookId: integer('hook_id'),
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    ciTokenHash: text('ci_token_hash'),
    workflowSha: text('workflow_sha'),
    /**
     * Contract version of the workflow committed to the repo. A v1 workflow must
     * never receive a v2 payload: it would silently build the wrong thing. Absent
     * means 1, which is what every row written before the column existed is.
     */
    workflowVersion: integer('workflow_version').notNull().default(1),
    ciEnabledAt: integer('ci_enabled_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt().notNull(),
  },
  (t) => [uniqueIndex('repo_hooks_repo').on(t.repoFullName)],
);

export const deployments = sqliteTable(
  'deployments',
  {
    id: id(),
    serviceEnvId: text('service_env_id')
      .notNull()
      .references(() => serviceEnvs.id, { onDelete: 'cascade' }),
    status: text('status', { enum: DEPLOYMENT_STATUSES }).notNull().default('queued'),
    trigger: text('trigger', { enum: DEPLOYMENT_TRIGGERS }).notNull(),
    commitSha: text('commit_sha'),
    commitMessage: text('commit_message'),
    imageRef: text('image_ref').notNull(),
    /** `sha256:…` — immutable, so rollback survives tag churn and pruning. */
    imageDigest: text('image_digest'),
    /** `image` runs a container; `artifact` is files Caddy serves directly. */
    mode: text('mode', { enum: DEPLOYMENT_MODES }).notNull().default('image'),
    /** What the build reported it built: `next`, `go`, `vite`, `standalone`, … */
    framework: text('framework'),
    /** Static only: `DATA_DIR/artifacts/<deployment id>/site`. */
    artifactPath: text('artifact_path'),
    artifactBytes: integer('artifact_bytes'),
    /** Image size, when the build reported it. The panel shows it next to the deploy. */
    imageBytes: integer('image_bytes'),
    containerName: text('container_name'),
    ciRunUrl: text('ci_run_url'),
    rollbackOf: text('rollback_of'),
    error: text('error'),
    logPath: text('log_path'),
    /** Last `docker inspect` of this deployment's container; see RUNTIME_STATES. */
    runtimeState: text('runtime_state', { enum: RUNTIME_STATES }),
    runtimeExitCode: integer('runtime_exit_code'),
    runtimeRestarts: integer('runtime_restarts'),
    /** Whether that inspect said the kernel killed it (1 GB boxes run out of memory). */
    runtimeOom: integer('runtime_oom', { mode: 'boolean' }),
    runtimeCheckedAt: integer('runtime_checked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt().notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('deployments_service_env_created').on(t.serviceEnvId, t.createdAt),
    index('deployments_status').on(t.status),
  ],
);

export type Project = typeof projects.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Service = typeof services.$inferSelect;
export type ServiceEnv = typeof serviceEnvs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Variable = typeof variables.$inferSelect;
export type RepoHook = typeof repoHooks.$inferSelect;

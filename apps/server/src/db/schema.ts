import { randomUUID } from 'node:crypto';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_TRIGGERS = ['manual', 'push', 'rollback'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

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
    containerName: text('container_name'),
    ciRunUrl: text('ci_run_url'),
    rollbackOf: text('rollback_of'),
    error: text('error'),
    logPath: text('log_path'),
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

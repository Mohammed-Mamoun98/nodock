CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`service_env_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`commit_sha` text,
	`commit_message` text,
	`image_ref` text NOT NULL,
	`image_digest` text,
	`container_name` text,
	`ci_run_url` text,
	`rollback_of` text,
	`error` text,
	`log_path` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`service_env_id`) REFERENCES `service_envs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployments_service_env_created` ON `deployments` (`service_env_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deployments_status` ON `deployments` (`status`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_slug` ON `environments` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `environments_project` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `repo_hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_full_name` text NOT NULL,
	`hook_id` integer,
	`webhook_secret_enc` text NOT NULL,
	`ci_token_hash` text,
	`workflow_sha` text,
	`ci_enabled_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_hooks_repo` ON `repo_hooks` (`repo_full_name`);--> statement-breakpoint
CREATE TABLE `service_envs` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`branch` text NOT NULL,
	`health_path` text,
	`generated_host` text NOT NULL,
	`custom_domain` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_envs_unique` ON `service_envs` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_envs_generated_host` ON `service_envs` (`generated_host`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_envs_custom_domain` ON `service_envs` (`custom_domain`);--> statement-breakpoint
CREATE INDEX `service_envs_environment` ON `service_envs` (`environment_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`dockerfile_path` text DEFAULT 'Dockerfile' NOT NULL,
	`context_path` text DEFAULT '.' NOT NULL,
	`container_port` integer,
	`memory_limit_mb` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug` ON `services` (`slug`);--> statement-breakpoint
CREATE INDEX `services_project` ON `services` (`project_id`);--> statement-breakpoint
CREATE INDEX `services_repo` ON `services` (`repo_full_name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`login` text NOT NULL,
	`avatar_url` text,
	`token_enc` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id` ON `users` (`github_id`);--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`service_env_id` text NOT NULL,
	`key` text NOT NULL,
	`value_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_env_id`) REFERENCES `service_envs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_key` ON `variables` (`service_env_id`,`key`);--> statement-breakpoint
CREATE INDEX `variables_service_env` ON `variables` (`service_env_id`);
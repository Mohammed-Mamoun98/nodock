ALTER TABLE `deployments` ADD `runtime_state` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `runtime_exit_code` integer;--> statement-breakpoint
ALTER TABLE `deployments` ADD `runtime_restarts` integer;--> statement-breakpoint
ALTER TABLE `deployments` ADD `runtime_oom` integer;--> statement-breakpoint
ALTER TABLE `deployments` ADD `runtime_checked_at` integer;
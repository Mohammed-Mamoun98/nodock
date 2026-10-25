ALTER TABLE `deployments` ADD `mode` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `deployments` ADD `framework` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `artifact_path` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `artifact_bytes` integer;--> statement-breakpoint
ALTER TABLE `deployments` ADD `image_bytes` integer;--> statement-breakpoint
ALTER TABLE `repo_hooks` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `strategy` text DEFAULT 'dockerfile' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `output_dir` text;--> statement-breakpoint
ALTER TABLE `services` ADD `spa_fallback` integer;
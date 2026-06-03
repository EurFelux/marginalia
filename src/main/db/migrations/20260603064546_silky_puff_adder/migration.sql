ALTER TABLE `providers` ADD `compatible_apis` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_providers` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`compatible_apis` text,
	`label` text,
	`base_url` text,
	`api_key_encrypted` blob,
	`models` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "providers_type_check" CHECK("type" in ('openai-responses','openai-chat-completions','anthropic','google-generate-content'))
);
--> statement-breakpoint
INSERT INTO `__new_providers`(`id`, `type`, `label`, `base_url`, `api_key_encrypted`, `models`, `is_builtin`, `created_at`) SELECT `id`, `type`, `label`, `base_url`, `api_key_encrypted`, `models`, `is_builtin`, `created_at` FROM `providers`;--> statement-breakpoint
DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
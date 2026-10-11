CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	`purpose` text NOT NULL,
	`model` text,
	`book_id` text,
	`requests` integer DEFAULT 1 NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`no_cache_tokens` integer,
	`reasoning_tokens` integer,
	CONSTRAINT "ai_usage_purpose_check" CHECK("purpose" in ('chat','summary','report','compaction','memory','naming'))
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_at_idx` ON `ai_usage` (`created_at`);
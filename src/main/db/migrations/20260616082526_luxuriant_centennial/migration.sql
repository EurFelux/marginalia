PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memories` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_memories`(`id`, `slug`, `title`, `description`, `body`, `created_at`, `updated_at`) SELECT `id`, `slug`, `title`, `description`, `body`, `created_at`, `updated_at` FROM `memories`;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `memories_source_book_id_idx`;

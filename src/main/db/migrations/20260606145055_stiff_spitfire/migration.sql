ALTER TABLE `annotations` RENAME COLUMN `cfi_range` TO `locator_range`;--> statement-breakpoint
ALTER TABLE `progress` RENAME COLUMN `cfi` TO `locator`;--> statement-breakpoint
ALTER TABLE `books` ADD `format` text DEFAULT 'epub' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `page_count` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `has_text_layer` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `chapters` ADD `start_page` integer;--> statement-breakpoint
ALTER TABLE `chapters` ADD `end_page` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_books` (
	`id` text PRIMARY KEY,
	`title` text,
	`author` text,
	`cover` blob,
	`toc` text,
	`summary` text,
	`format` text DEFAULT 'epub' NOT NULL,
	`page_count` integer,
	`has_text_layer` integer DEFAULT true NOT NULL,
	`added_at` integer NOT NULL,
	CONSTRAINT "books_format_check" CHECK("format" in ('epub','pdf'))
);
--> statement-breakpoint
INSERT INTO `__new_books`(`id`, `title`, `author`, `cover`, `toc`, `summary`, `added_at`) SELECT `id`, `title`, `author`, `cover`, `toc`, `summary`, `added_at` FROM `books`;--> statement-breakpoint
DROP TABLE `books`;--> statement-breakpoint
ALTER TABLE `__new_books` RENAME TO `books`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

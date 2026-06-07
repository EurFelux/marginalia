ALTER TABLE `books` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `progress` ADD `percent` real;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_progress` (
	`book_id` text PRIMARY KEY,
	`locator` text NOT NULL,
	`percent` real,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_progress_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT "progress_percent_check" CHECK("percent" is null or ("percent" >= 0 and "percent" <= 1))
);
--> statement-breakpoint
INSERT INTO `__new_progress`(`book_id`, `locator`, `updated_at`) SELECT `book_id`, `locator`, `updated_at` FROM `progress`;--> statement-breakpoint
DROP TABLE `progress`;--> statement-breakpoint
ALTER TABLE `__new_progress` RENAME TO `progress`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

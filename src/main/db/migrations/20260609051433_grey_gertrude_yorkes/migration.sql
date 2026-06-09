CREATE TABLE `reading_daily` (
	`id` text PRIMARY KEY,
	`book_id` text,
	`day` text NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_reading_daily_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE SET NULL,
	CONSTRAINT `reading_daily_book_day_unique` UNIQUE(`book_id`,`day`)
);
--> statement-breakpoint
CREATE INDEX `reading_daily_day_idx` ON `reading_daily` (`day`);--> statement-breakpoint
CREATE INDEX `reading_daily_book_id_idx` ON `reading_daily` (`book_id`);

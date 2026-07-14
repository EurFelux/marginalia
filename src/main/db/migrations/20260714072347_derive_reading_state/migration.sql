PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reading_daily` (
	`id` text PRIMARY KEY,
	`book_id` text,
	`reading_session_id` text,
	`day` text NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_reading_daily_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_reading_daily_reading_session_id_reading_sessions_id_fk` FOREIGN KEY (`reading_session_id`) REFERENCES `reading_sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_reading_daily`(`id`, `book_id`, `reading_session_id`, `day`, `seconds`) SELECT `id`, `book_id`, `reading_session_id`, `day`, `seconds` FROM `reading_daily`;--> statement-breakpoint
DROP TABLE `reading_daily`;--> statement-breakpoint
ALTER TABLE `__new_reading_daily` RENAME TO `reading_daily`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `reading_daily_session_day_unique` ON `reading_daily` (`reading_session_id`,`day`) WHERE "reading_daily"."reading_session_id" is not null;--> statement-breakpoint
CREATE INDEX `reading_daily_day_idx` ON `reading_daily` (`day`);--> statement-breakpoint
CREATE INDEX `reading_daily_book_id_idx` ON `reading_daily` (`book_id`);--> statement-breakpoint
CREATE INDEX `reading_daily_session_id_idx` ON `reading_daily` (`reading_session_id`);--> statement-breakpoint
ALTER TABLE `books` DROP COLUMN `is_finished`;
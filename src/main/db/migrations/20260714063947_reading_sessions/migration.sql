CREATE TABLE `reading_sessions` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`report` text,
	CONSTRAINT `fk_reading_sessions_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT "reading_sessions_completed_after_start_check" CHECK("completed_at" is null or "completed_at" >= "started_at"),
	CONSTRAINT "reading_sessions_report_requires_completion_check" CHECK("report" is null or "completed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE `reading_daily` ADD `reading_session_id` text REFERENCES reading_sessions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reading_sessions_one_active_per_book` ON `reading_sessions` (`book_id`) WHERE "reading_sessions"."completed_at" is null;--> statement-breakpoint
CREATE INDEX `reading_sessions_book_id_idx` ON `reading_sessions` (`book_id`);
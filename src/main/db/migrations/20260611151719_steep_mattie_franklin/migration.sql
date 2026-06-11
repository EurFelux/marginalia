CREATE TABLE `book_notes` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_book_notes_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `book_notes_book_id_idx` ON `book_notes` (`book_id`);

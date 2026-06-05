PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`assistant_id` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_assistant_id_assistants_id_fk` FOREIGN KEY (`assistant_id`) REFERENCES `assistants`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `book_id`, `assistant_id`, `title`, `created_at`, `updated_at`) SELECT `id`, `book_id`, `assistant_id`, `title`, `created_at`, `updated_at` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversations_book_id_idx` ON `conversations` (`book_id`);

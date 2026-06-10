CREATE TABLE `memories` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`source_book_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_memories_source_book_id_books_id_fk` FOREIGN KEY (`source_book_id`) REFERENCES `books`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `memory_links` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	CONSTRAINT `memory_links_pk` PRIMARY KEY(`from_id`, `to_id`),
	CONSTRAINT `fk_memory_links_from_id_memories_id_fk` FOREIGN KEY (`from_id`) REFERENCES `memories`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_links_to_id_memories_id_fk` FOREIGN KEY (`to_id`) REFERENCES `memories`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `memories_source_book_id_idx` ON `memories` (`source_book_id`);--> statement-breakpoint
CREATE INDEX `memory_links_to_id_idx` ON `memory_links` (`to_id`);

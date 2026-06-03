PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chapters` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`title` text,
	`order_index` integer,
	`href` text NOT NULL,
	`summary` text,
	CONSTRAINT `fk_chapters_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`),
	CONSTRAINT `chapters_book_id_href_unique` UNIQUE(`book_id`,`href`)
);
--> statement-breakpoint
INSERT INTO `__new_chapters`(`id`, `book_id`, `title`, `order_index`, `href`, `summary`) SELECT `id`, `book_id`, `title`, `order_index`, `href`, `summary` FROM `chapters`;--> statement-breakpoint
DROP TABLE `chapters`;--> statement-breakpoint
ALTER TABLE `__new_chapters` RENAME TO `chapters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chapters_book_id_idx` ON `chapters` (`book_id`);

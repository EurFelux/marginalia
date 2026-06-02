CREATE TABLE `annotations` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`style` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`selected_text` text NOT NULL,
	`cfi_range` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_annotations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`),
	CONSTRAINT "annotations_style_check" CHECK("style" in ('yellow','green','blue','pink','purple','underline'))
);
--> statement-breakpoint
CREATE INDEX `annotations_book_id_idx` ON `annotations` (`book_id`);

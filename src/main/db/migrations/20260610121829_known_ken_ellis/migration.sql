INSERT INTO `preferences`(`key`, `value`, `updated_at`)
SELECT 'chatModel', json_object('providerId', `provider_id`, 'model', `model`), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `assistants`
WHERE `provider_id` IS NOT NULL AND `model` IS NOT NULL
ORDER BY `created_at` ASC LIMIT 1
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `preferences`(`key`, `value`, `updated_at`)
SELECT 'instructions', json_quote(`system_prompt`), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `assistants`
WHERE `system_prompt` IS NOT NULL
  AND `system_prompt` != 'You are a reading assistant embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.'
ORDER BY `created_at` ASC LIMIT 1
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`title` text,
	`context_summary` text,
	`summarized_through_seq` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `book_id`, `title`, `context_summary`, `summarized_through_seq`, `created_at`, `updated_at`) SELECT `id`, `book_id`, `title`, `context_summary`, `summarized_through_seq`, `created_at`, `updated_at` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversations_book_id_idx` ON `conversations` (`book_id`);--> statement-breakpoint
DROP TABLE `assistants`;

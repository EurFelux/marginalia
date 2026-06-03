PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_annotations` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`style` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`selected_text` text NOT NULL,
	`cfi_range` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_annotations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT "annotations_style_check" CHECK("style" in ('yellow','green','blue','pink','purple','underline'))
);
--> statement-breakpoint
INSERT INTO `__new_annotations`(`id`, `book_id`, `style`, `note`, `selected_text`, `cfi_range`, `created_at`, `updated_at`) SELECT `id`, `book_id`, `style`, `note`, `selected_text`, `cfi_range`, `created_at`, `updated_at` FROM `annotations`;--> statement-breakpoint
DROP TABLE `annotations`;--> statement-breakpoint
ALTER TABLE `__new_annotations` RENAME TO `annotations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chapters` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`title` text,
	`order_index` integer,
	`href` text NOT NULL,
	`summary` text,
	CONSTRAINT `fk_chapters_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT `chapters_book_id_href_unique` UNIQUE(`book_id`,`href`)
);
--> statement-breakpoint
INSERT INTO `__new_chapters`(`id`, `book_id`, `title`, `order_index`, `href`, `summary`) SELECT `id`, `book_id`, `title`, `order_index`, `href`, `summary` FROM `chapters`;--> statement-breakpoint
DROP TABLE `chapters`;--> statement-breakpoint
ALTER TABLE `__new_chapters` RENAME TO `chapters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`assistant_id` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_chapter_id_chapters_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_assistant_id_assistants_id_fk` FOREIGN KEY (`assistant_id`) REFERENCES `assistants`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `book_id`, `chapter_id`, `assistant_id`, `title`, `created_at`, `updated_at`) SELECT `id`, `book_id`, `chapter_id`, `assistant_id`, `title`, `created_at`, `updated_at` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `messages_conversation_seq_unique` UNIQUE(`conversation_id`,`seq`),
	CONSTRAINT "messages_role_check" CHECK("role" in ('system','user','assistant')),
	CONSTRAINT "messages_status_check" CHECK("status" in ('complete','error','aborted'))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `conversation_id`, `role`, `parts`, `metadata`, `status`, `seq`, `created_at`) SELECT `id`, `conversation_id`, `role`, `parts`, `metadata`, `status`, `seq`, `created_at` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_progress` (
	`book_id` text PRIMARY KEY,
	`cfi` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_progress_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_progress`(`book_id`, `cfi`, `updated_at`) SELECT `book_id`, `cfi`, `updated_at` FROM `progress`;--> statement-breakpoint
DROP TABLE `progress`;--> statement-breakpoint
ALTER TABLE `__new_progress` RENAME TO `progress`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `annotations_book_id_idx` ON `annotations` (`book_id`);--> statement-breakpoint
CREATE INDEX `chapters_book_id_idx` ON `chapters` (`book_id`);--> statement-breakpoint
CREATE INDEX `conversations_book_id_idx` ON `conversations` (`book_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);

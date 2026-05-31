CREATE TABLE `assistants` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`system_prompt` text,
	`provider_id` text,
	`model` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_assistants_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`)
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY,
	`path` text NOT NULL,
	`title` text,
	`author` text,
	`cover` blob,
	`toc` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`title` text,
	`order_index` integer,
	`href` text NOT NULL,
	`summary` text,
	`summary_status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT `fk_chapters_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`),
	CONSTRAINT `chapters_book_id_href_unique` UNIQUE(`book_id`,`href`),
	CONSTRAINT "chapters_summary_status_check" CHECK("summary_status" in ('pending','generating','ready','unavailable'))
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY,
	`book_id` text,
	`chapter_id` text,
	`assistant_id` text,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`),
	CONSTRAINT `fk_conversations_chapter_id_chapters_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`),
	CONSTRAINT `fk_conversations_assistant_id_assistants_id_fk` FOREIGN KEY (`assistant_id`) REFERENCES `assistants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`),
	CONSTRAINT "messages_role_check" CHECK("role" in ('system','user','assistant'))
);
--> statement-breakpoint
CREATE TABLE `progress` (
	`book_id` text PRIMARY KEY,
	`cfi` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_progress_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`label` text,
	`base_url` text,
	`api_key_encrypted` blob,
	`created_at` integer NOT NULL,
	CONSTRAINT "providers_type_check" CHECK("type" in ('openai','anthropic','google','openai-compatible'))
);

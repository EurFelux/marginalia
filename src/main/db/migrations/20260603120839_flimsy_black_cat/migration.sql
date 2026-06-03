ALTER TABLE `messages` ADD `status` text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
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
	CONSTRAINT `fk_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`),
	CONSTRAINT `messages_conversation_seq_unique` UNIQUE(`conversation_id`,`seq`),
	CONSTRAINT "messages_role_check" CHECK("role" in ('system','user','assistant')),
	CONSTRAINT "messages_status_check" CHECK("status" in ('complete','error','aborted'))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `conversation_id`, `role`, `parts`, `metadata`, `seq`, `created_at`) SELECT `id`, `conversation_id`, `role`, `parts`, `metadata`, `seq`, `created_at` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);

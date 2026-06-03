ALTER TABLE `providers` DROP COLUMN `api_key_encrypted`;--> statement-breakpoint
ALTER TABLE `providers` ADD `api_key` text;

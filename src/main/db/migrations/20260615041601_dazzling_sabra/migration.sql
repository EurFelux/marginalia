CREATE TABLE `blob` (
	`id` text PRIMARY KEY,
	`data` blob NOT NULL,
	`mime_type` text NOT NULL,
	`created_at` integer NOT NULL
);

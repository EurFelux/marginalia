CREATE TABLE `selection_actions` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`label` text,
	`icon` text,
	`prompt` text,
	`enabled` integer DEFAULT true NOT NULL,
	`auto_send` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "selection_actions_kind_check" CHECK("kind" in ('builtin','custom')),
	CONSTRAINT "selection_actions_shape_check" CHECK(("kind" = 'builtin' and "label" is null and "icon" is null) or ("kind" = 'custom' and "label" is not null and "icon" is not null and "prompt" is not null))
);

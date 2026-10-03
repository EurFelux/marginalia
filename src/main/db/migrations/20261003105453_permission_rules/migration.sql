CREATE TABLE `permission_rules` (
	`id` text PRIMARY KEY,
	`tool` text NOT NULL,
	`decision` text NOT NULL,
	`pattern` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `permission_rules_unique` UNIQUE(`tool`,`decision`,`pattern`),
	CONSTRAINT "permission_rules_tool_check" CHECK("tool" in ('bash')),
	CONSTRAINT "permission_rules_decision_check" CHECK("decision" in ('allow','deny'))
);

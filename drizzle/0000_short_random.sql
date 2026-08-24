CREATE TABLE `drawings` (
	`id` text PRIMARY KEY NOT NULL,
	`svg` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

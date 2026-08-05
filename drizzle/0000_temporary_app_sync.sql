CREATE TABLE IF NOT EXISTS `app_sync_records` (
	`owner_id` text NOT NULL,
	`app_id` text NOT NULL,
	`collection_name` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `app_id`, `collection_name`, `record_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `app_sync_records_updated_at_idx` ON `app_sync_records` (`owner_id`,`app_id`,`updated_at`);

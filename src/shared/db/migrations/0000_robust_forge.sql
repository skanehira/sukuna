CREATE TABLE `conversation_events` (
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`sdk_uuid` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `seq`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_conversation_id_sdk_uuid_unique` ON `conversation_events` (`conversation_id`,`sdk_uuid`) WHERE "conversation_events"."sdk_uuid" is not null;--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`issue_id` text,
	`parent_conversation_id` text,
	`title` text,
	`session_id` text,
	`cwd` text NOT NULL,
	`worktree_id` text,
	`run_state` text DEFAULT 'idle' NOT NULL,
	`stop_reason` text,
	`resets_at` integer,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`last_position` integer,
	`recap_seq` integer DEFAULT 0 NOT NULL,
	`recap_failed_at` integer,
	`last_activity_at` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `conversations_project_id_closed_at_index` ON `conversations` (`project_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `conversations_issue_id_index` ON `conversations` (`issue_id`);--> statement-breakpoint
CREATE INDEX `conversations_parent_conversation_id_index` ON `conversations` (`parent_conversation_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_dependencies` (
	`issue_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `depends_on_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_events` (
	`issue_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `seq`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`kind` text,
	`state` text NOT NULL,
	`stop_reason` text,
	`parent_id` text,
	`priority` text,
	`designed` integer DEFAULT false NOT NULL,
	`confirm_before_merge` integer DEFAULT false NOT NULL,
	`pr_url` text,
	`github_number` integer,
	`created_conversation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `issues_project_id_state_index` ON `issues` (`project_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_project_id_number_unique` ON `issues` (`project_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_project_id_github_number_unique` ON `issues` (`project_id`,`github_number`) WHERE "issues"."github_number" is not null;--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE TABLE `pending_answers` (
	`conversation_id` text NOT NULL,
	`question_seq` integer NOT NULL,
	`answers` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `question_seq`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pr_snapshots` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`pr_url` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`uses_github` integer DEFAULT false NOT NULL,
	`default_branch` text NOT NULL,
	`permission_mode` text DEFAULT 'bypassPermissions' NOT NULL,
	`model` text,
	`design_merge_mode` text DEFAULT 'direct' NOT NULL,
	`auto_stages` text DEFAULT '["triage","design","impl"]' NOT NULL,
	`impl_concurrency` integer DEFAULT 5 NOT NULL,
	`confirm_before_merge_default` integer DEFAULT false NOT NULL,
	`flow_paused` integer DEFAULT false NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`keys` text NOT NULL,
	`user_agent` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`answered` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `queued_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`text` text NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	`stock_item_id` text,
	`client_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_items` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`quote` text,
	`state` text NOT NULL,
	`sent_at` integer,
	`sent_seq` integer,
	`thread_conversation_id` text,
	`github_comment_url` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stock_items_conversation_id_state_index` ON `stock_items` (`conversation_id`,`state`);--> statement-breakpoint
CREATE TABLE `toc_entries` (
	`conversation_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`start_seq` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `position`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`branch_created` integer DEFAULT false NOT NULL,
	`origin` text NOT NULL,
	`issue_id` text,
	`port_slot` integer,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_project_id_path_unique` ON `worktrees` (`project_id`,`path`) WHERE "worktrees"."removed_at" is null;
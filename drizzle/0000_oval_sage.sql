CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"rate_limit_per_min" integer,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_post_id" text NOT NULL,
	"platform_meta" jsonb,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"username" text NOT NULL,
	"auth_variant" text,
	"credentials_ciphertext" "bytea" NOT NULL,
	"credentials_key_version" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_limit_monthly" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_health" (
	"social_account_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_sync_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comment_sync_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"post_id" uuid,
	"platform_post_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"last_error" text,
	"manual_cooldown_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"post_id" uuid,
	"platform" text NOT NULL,
	"platform_post_id" text NOT NULL,
	"parent_comment_id" uuid,
	"root_comment_id" uuid,
	"depth" smallint NOT NULL,
	"platform_comment_id" text,
	"platform_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_own" boolean NOT NULL,
	"source" text NOT NULL,
	"author_platform_id" text,
	"author_username" text,
	"author_display_name" text,
	"text" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_started_at" timestamp with time zone,
	"idempotency_key" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comments_posted_has_platform_comment_id" CHECK ("comments"."status" <> 'posted' or "comments"."platform_comment_id" is not null),
	CONSTRAINT "comments_depth_matches_parent" CHECK (("comments"."parent_comment_id" is null) = ("comments"."depth" = 0))
);
--> statement-breakpoint
CREATE TABLE "contact_quota_usage" (
	"workspace_id" uuid NOT NULL,
	"period" text NOT NULL,
	"platform" text NOT NULL,
	"contact_platform_id" text NOT NULL,
	"comment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_quota_usage_workspace_id_period_platform_contact_platform_id_pk" PRIMARY KEY("workspace_id","period","platform","contact_platform_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "comment_sync_jobs" ADD CONSTRAINT "comment_sync_jobs_target_id_comment_sync_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."comment_sync_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_comment_id_comments_id_fk" FOREIGN KEY ("root_comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_sync_jobs_active_target_key" ON "comment_sync_jobs" USING btree ("target_id") WHERE "comment_sync_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "comment_sync_targets_social_account_platform_post_id_key" ON "comment_sync_targets" USING btree ("social_account_id","platform_post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_social_account_platform_comment_id_key" ON "comments" USING btree ("social_account_id","platform_comment_id") WHERE "comments"."platform_comment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "comments_workspace_idempotency_key_key" ON "comments" USING btree ("workspace_id","idempotency_key") WHERE "comments"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "comments_post_top_level_idx" ON "comments" USING btree ("post_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "comments"."parent_comment_id" is null;--> statement-breakpoint
CREATE INDEX "comments_replies_idx" ON "comments" USING btree ("parent_comment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "comments_social_account_idx" ON "comments" USING btree ("social_account_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_last_activity_idx" ON "comments" USING btree ("last_activity_at") WHERE "comments"."parent_comment_id" is null;--> statement-breakpoint
CREATE INDEX "comments_stuck_work_idx" ON "comments" USING btree ("status","last_attempt_started_at") WHERE "comments"."status" in ('queued', 'processing');
DROP INDEX "comments_replies_idx";--> statement-breakpoint
CREATE INDEX "comment_sync_targets_due_idx" ON "comment_sync_targets" USING btree ("next_sync_at") WHERE "comment_sync_targets"."next_sync_at" is not null;--> statement-breakpoint
CREATE INDEX "comment_sync_targets_post_idx" ON "comment_sync_targets" USING btree ("post_id") WHERE "comment_sync_targets"."post_id" is not null;--> statement-breakpoint
CREATE INDEX "comments_sync_post_idx" ON "comments" USING btree ("social_account_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "comments_root_comment_idx" ON "comments" USING btree ("root_comment_id") WHERE "comments"."root_comment_id" is not null;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_unprocessed_idx" ON "webhook_deliveries" USING btree ("received_at") WHERE "webhook_deliveries"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "comments_replies_idx" ON "comments" USING btree ("parent_comment_id","occurred_at","id") WHERE "comments"."parent_comment_id" is not null;
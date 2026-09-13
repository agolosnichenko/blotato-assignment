DROP INDEX "comments_post_top_level_idx";--> statement-breakpoint
DROP INDEX "comments_social_account_idx";--> statement-breakpoint
DROP INDEX "comments_workspace_idx";--> statement-breakpoint
CREATE INDEX "comments_post_top_level_idx" ON "comments" USING btree ("post_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "comments"."parent_comment_id" is null;--> statement-breakpoint
CREATE INDEX "comments_social_account_idx" ON "comments" USING btree ("social_account_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "comments_workspace_idx" ON "comments" USING btree ("workspace_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
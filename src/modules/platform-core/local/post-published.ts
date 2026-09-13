/**
 * {@link PostPublished} against the local projection (§7.3, T023, T039).
 *
 * Mirrors the publish event into the `posts` projection, the same way a platform event would keep
 * it in sync in the real deployment. Idempotent on `id` so a redelivered event does not fail: a
 * second `notify` for the same post id is a no-op rather than an error.
 *
 * §7.3 names this port as one of the two ways a post becomes an active sync target (the other is
 * the first ingested comment on an external post, `ingest-comments.ts`). A published post's
 * `age_anchor_at` is its `published_at` (§18's `comment_sync_targets.age_anchor_at` addition) —
 * unlike an external post's anchor, this one is an exact publish time, not a lower bound. Only
 * comment-capable platforms (`registry.ts`) get a target: `SyncTargetRepository.ensureTarget`'s
 * schedule math has no band table for a platform comments were never built for, and a post on one
 * of those platforms has no comment thread for the scheduler to ever refresh.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { posts } from '#src/modules/platform-core/schema.ts';
import type { PostPublished, PublishedPostInput } from '#src/modules/platform-core/ports.ts';
import { platformRegistry } from '#src/platforms/registry.ts';
import type { Platform } from '#src/platforms/types.ts';

function supportsCommentSync(platform: string): platform is Platform {
  const capabilities = platformRegistry[platform as Platform] as
    | (typeof platformRegistry)[Platform]
    | undefined;
  return capabilities?.supportsComments === true;
}

export function createLocalPostPublished(
  db: NodePgDatabase,
  syncTargetRepository: SyncTargetRepository,
): PostPublished {
  return {
    async notify(post: PublishedPostInput): Promise<void> {
      await db
        .insert(posts)
        .values({
          id: post.id,
          workspaceId: post.workspaceId,
          socialAccountId: post.socialAccountId,
          platform: post.platform,
          platformPostId: post.platformPostId,
          platformMeta: post.platformMeta ?? null,
          publishedAt: post.publishedAt,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: posts.id });

      if (!supportsCommentSync(post.platform)) {
        return;
      }

      await syncTargetRepository.ensureTarget({
        workspaceId: post.workspaceId,
        socialAccountId: post.socialAccountId,
        platform: post.platform,
        postId: post.id,
        platformPostId: post.platformPostId,
        ageAnchorAt: post.publishedAt,
      });
    },
  };
}

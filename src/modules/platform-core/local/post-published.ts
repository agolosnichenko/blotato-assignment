/**
 * {@link PostPublished} against the local projection (§7.3, T023).
 *
 * Mirrors the publish event into the `posts` projection, the same way a platform event would keep
 * it in sync in the real deployment. Idempotent on `id` so a redelivered event does not fail: a
 * second `notify` for the same post id is a no-op rather than an error.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { posts } from '#src/modules/platform-core/schema.ts';
import type { PostPublished, PublishedPostInput } from '#src/modules/platform-core/ports.ts';

export function createLocalPostPublished(db: NodePgDatabase): PostPublished {
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
    },
  };
}

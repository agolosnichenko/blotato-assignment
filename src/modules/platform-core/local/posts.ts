/** {@link Posts} against the local projection (D8, D29, T023). */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { posts } from '#src/modules/platform-core/schema.ts';
import {
  found,
  NOT_FOUND,
  type Found,
  type PostRecord,
  type Posts,
} from '#src/modules/platform-core/ports.ts';

export function createLocalPosts(db: NodePgDatabase): Posts {
  return {
    async findById(postId: string): Promise<Found<PostRecord>> {
      const [row] = await db
        .select({
          id: posts.id,
          workspaceId: posts.workspaceId,
          socialAccountId: posts.socialAccountId,
          platform: posts.platform,
          platformPostId: posts.platformPostId,
          publishedAt: posts.publishedAt,
        })
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);

      return row === undefined ? NOT_FOUND : found(row);
    },
  };
}

/** {@link ApiKeys} against the local projection (D8, D29, T023). */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { apiKeys } from '#src/modules/platform-core/schema.ts';
import {
  found,
  NOT_FOUND,
  type ApiKeyRecord,
  type ApiKeys,
  type Found,
} from '#src/modules/platform-core/ports.ts';

export function createLocalApiKeys(db: NodePgDatabase): ApiKeys {
  return {
    async findByPrefix(prefix: string): Promise<Found<ApiKeyRecord>> {
      const [row] = await db
        .select({
          id: apiKeys.id,
          workspaceId: apiKeys.workspaceId,
          keyHash: apiKeys.keyHash,
          rateLimitPerMin: apiKeys.rateLimitPerMin,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.prefix, prefix))
        .limit(1);

      return row === undefined ? NOT_FOUND : found(row);
    },
  };
}

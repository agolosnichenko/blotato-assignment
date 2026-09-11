/**
 * {@link Accounts} against the local projection, composing the **effective** status (D30, T023).
 *
 * `social_accounts.status` is owned by the accounts service and read-only here; an `AuthError`
 * this service observes is instead recorded as its own `account_health` row (§18 D30,
 * `src/modules/comments/infrastructure/account-health.ts`). This is the one place that composes
 * the two into the status every other caller sees — deliberately with **two separate queries**,
 * never a SQL join, so `comments`' `account_health` table is read but never joined against the
 * platform-core projection (Principle II; verified by `local-ports.integration.test.ts`, T024).
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accountHealth } from '#src/modules/comments/infrastructure/schema.ts';
import { socialAccounts } from '#src/modules/platform-core/schema.ts';
import {
  found,
  NOT_FOUND,
  type Accounts,
  type Found,
  type SocialAccountRecord,
} from '#src/modules/platform-core/ports.ts';

export function createLocalAccounts(db: NodePgDatabase): Accounts {
  return {
    async findById(socialAccountId: string): Promise<Found<SocialAccountRecord>> {
      const [row] = await db
        .select({
          id: socialAccounts.id,
          workspaceId: socialAccounts.workspaceId,
          platform: socialAccounts.platform,
          platformAccountId: socialAccounts.platformAccountId,
          username: socialAccounts.username,
          status: socialAccounts.status,
        })
        .from(socialAccounts)
        .where(eq(socialAccounts.id, socialAccountId))
        .limit(1);
      if (row === undefined) {
        return NOT_FOUND;
      }

      const [health] = await db
        .select({ state: accountHealth.state })
        .from(accountHealth)
        .where(eq(accountHealth.socialAccountId, socialAccountId))
        .limit(1);
      const effectiveStatus =
        row.status === 'active' && health?.state !== 'auth_failed' ? 'active' : 'disconnected';

      return found({
        id: row.id,
        workspaceId: row.workspaceId,
        platform: row.platform,
        platformAccountId: row.platformAccountId,
        username: row.username,
        status: effectiveStatus,
      });
    },
  };
}

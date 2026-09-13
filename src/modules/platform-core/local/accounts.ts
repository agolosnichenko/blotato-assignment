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

import { and, eq } from 'drizzle-orm';
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
import type { Platform } from '#src/platforms/types.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

const ACCOUNT_COLUMNS = {
  id: socialAccounts.id,
  workspaceId: socialAccounts.workspaceId,
  platform: socialAccounts.platform,
  platformAccountId: socialAccounts.platformAccountId,
  username: socialAccounts.username,
  status: socialAccounts.status,
} as const;

/** Composes `social_accounts.status` with this service's own `account_health` row (D30) — the
 * one place both {@link findById} and {@link listByPlatformAccount} derive the effective status
 * from, so a caller can never reach the raw projection column instead. */
async function toEffectiveRecord(
  db: NodePgDatabase,
  row: {
    id: string;
    workspaceId: WorkspaceId;
    platform: string;
    platformAccountId: string;
    username: string;
    status: string;
  },
): Promise<SocialAccountRecord> {
  const [health] = await db
    .select({ state: accountHealth.state })
    .from(accountHealth)
    .where(eq(accountHealth.socialAccountId, row.id))
    .limit(1);
  const effectiveStatus =
    row.status === 'active' && health?.state !== 'auth_failed' ? 'active' : 'disconnected';

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    username: row.username,
    status: effectiveStatus,
  };
}

export function createLocalAccounts(db: NodePgDatabase): Accounts {
  return {
    async findById(socialAccountId: string): Promise<Found<SocialAccountRecord>> {
      const [row] = await db
        .select(ACCOUNT_COLUMNS)
        .from(socialAccounts)
        .where(eq(socialAccounts.id, socialAccountId))
        .limit(1);
      if (row === undefined) {
        return NOT_FOUND;
      }
      return found(await toEffectiveRecord(db, row));
    },

    async listByPlatformAccount(
      platform: Platform,
      platformAccountId: string,
    ): Promise<readonly SocialAccountRecord[]> {
      const rows = await db
        .select(ACCOUNT_COLUMNS)
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.platform, platform),
            eq(socialAccounts.platformAccountId, platformAccountId),
          ),
        );
      // Sequential, not `Promise.all`: two workspaces sharing one `platformAccountId` is the rare
      // case this method exists for (spec.md §18) — a handful of rows at most, so there is nothing
      // here worth parallelizing against `toEffectiveRecord`'s own `account_health` query.
      const records: SocialAccountRecord[] = [];
      for (const row of rows) {
        // oxlint-disable-next-line no-await-in-loop
        records.push(await toEffectiveRecord(db, row));
      }
      return records;
    },
  };
}

/**
 * Writer for this service's own `account_health` table (D30, T023a).
 *
 * `social_accounts.status` is owned by the accounts service and read-only here (Principle II), so
 * an `AuthError` observed against a platform token cannot be recorded by updating it. Instead this
 * module owns a small table of its own, and `src/modules/platform-core/local/accounts.ts` composes
 * it with the projection on read to produce the effective status every caller sees. This module
 * never issues an `UPDATE` (or any other write) against `social_accounts` — only against
 * `account_health`.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accountHealth } from '#src/modules/comments/infrastructure/schema.ts';

export interface MarkAuthFailedInput {
  readonly socialAccountId: string;
  readonly workspaceId: string;
  readonly reason: string;
}

export interface AccountHealth {
  /** Upserts an `auth_failed` row for the account, e.g. after an adapter's `AuthError`. */
  markAuthFailed(input: MarkAuthFailedInput): Promise<void>;
  /** Removes the account's `account_health` row, e.g. once the accounts service reconnects it. */
  clear(socialAccountId: string): Promise<void>;
}

export function createAccountHealth(db: NodePgDatabase): AccountHealth {
  return {
    async markAuthFailed({
      socialAccountId,
      workspaceId,
      reason,
    }: MarkAuthFailedInput): Promise<void> {
      const detectedAt = new Date();
      await db
        .insert(accountHealth)
        .values({ socialAccountId, workspaceId, state: 'auth_failed', reason, detectedAt })
        .onConflictDoUpdate({
          target: accountHealth.socialAccountId,
          set: { state: 'auth_failed', reason, detectedAt },
        });
    },

    async clear(socialAccountId: string): Promise<void> {
      await db.delete(accountHealth).where(eq(accountHealth.socialAccountId, socialAccountId));
    },
  };
}

/**
 * The `ContactQuota` port (T057; spec.md D16, A8, §7.1 step 3; plan.md §Project Structure).
 *
 * The monthly allowance counts *people contacted*, not messages sent: replying to the same
 * platform contact twice in one period consumes the allowance once. `reserve` is therefore not a
 * counter increment but a conditional insert into `contact_quota_usage`, keyed on
 * `(workspace_id, period, platform, contact_platform_id)` — a second reservation for a contact
 * already recorded this period is a no-op success, not a fresh spend.
 *
 * `reserve` takes the caller's transaction rather than opening its own — §7.1 step 3 is explicit
 * that the reservation, the comment insert, the parent/root bookkeeping and the outbox write are
 * "a single transaction". Committing the reservation separately would leak an allowance: if the
 * process dies (or the comment insert fails) between the two commits, the `contact_quota_usage`
 * row survives pointing at a `comment_id` that was never written, and `release` — keyed on that
 * `comment_id` — can never find it to reclaim it. Composing into one transaction is also what lets
 * the advisory lock (below) cover the whole write, not just the reservation half of it.
 *
 * The concurrency case (R-08) is two replies to the same *new* contact racing each other: without
 * serialization both would see the row missing, both would pass the limit check, and both would
 * insert, spending two allowances for one person. `pg_advisory_xact_lock(workspace_id, period)`
 * closes that window — the lock is scoped to one workspace and one period, so two different
 * workspaces, or the same workspace in two different months, never serialize against each other
 * for no reason. The lock is taken with the two-key form (`hashtext(workspaceId)`,
 * `hashtext(period)`) rather than a single combined key, matching D16's "(workspace_id, period)"
 * pairing directly instead of folding it into one hash that could collide across pairs. Because
 * the lock now lives for the *caller's* transaction, it stays held until the whole reply — not
 * just the reservation — commits or rolls back.
 *
 * `release`, unlike `reserve`, takes no transaction: it runs on a comment's final failure, long
 * after the accepting transaction (and `reserve` inside it) already committed, from the publish
 * worker rather than the accept path, so there is no caller transaction left to join. It needs
 * none of its own either — it is a single `DELETE`, atomic on its own. It
 * frees a reply that never reached the platform from having permanently spent a contact's
 * allowance, scoped to `(workspace_id, comment_id)` rather than `(workspace_id,
 * contact_platform_id)`: the usage row for a contact is owned by whichever comment first reserved
 * it, and a later reply to the same contact in the same period is a no-op reservation (see
 * `reserve`) that owns no row of its own — deleting by contact instead of by comment would risk
 * releasing a still-live reservation that a *different* comment for the same person depends on.
 */

import { and, count, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { OutboxTransaction } from '#src/modules/comments/infrastructure/outbox.ts';
import { contactQuotaUsage } from '#src/modules/comments/infrastructure/schema.ts';
import type { Workspaces } from '#src/modules/platform-core/ports.ts';
import type { Platform } from '#src/platforms/types.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

export interface ReserveInput {
  readonly workspaceId: WorkspaceId;
  readonly platform: Platform;
  /** The platform's identifier for the person being contacted — not our own comment author id. */
  readonly contactPlatformId: string;
  readonly commentId: string;
}

/**
 * `{ ok: true }` on a successful (or already-covered) reservation. `{ ok: false, reason:
 * 'QUOTA_EXCEEDED' }` — never a thrown error — when the workspace has no allowance left for a new
 * contact this period; a caller turns that into `FR-0xx`'s quota-exceeded response.
 */
export type ReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'QUOTA_EXCEEDED' };

export interface ReleaseInput {
  readonly workspaceId: WorkspaceId;
  readonly commentId: string;
}

export interface ContactQuota {
  /** Joins `tx` — see the module docstring for why this must not open its own transaction. */
  reserve(tx: OutboxTransaction, input: ReserveInput): Promise<ReserveResult>;
  release(input: ReleaseInput): Promise<void>;
}

/** `YYYY-MM` in UTC — the granularity `contact_quota_usage.period` stores (D16). */
function currentPeriod(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

async function countReservedThisPeriod(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  period: string,
): Promise<number> {
  // Counted in Postgres: the primary key's `(workspace_id, period)` prefix answers it, and a
  // workspace near its limit would otherwise ship every contact it reached this month to the
  // process on each reply, while holding the advisory lock.
  const [row] = await tx
    .select({ reserved: count() })
    .from(contactQuotaUsage)
    .where(
      and(eq(contactQuotaUsage.workspaceId, workspaceId), eq(contactQuotaUsage.period, period)),
    );
  return row?.reserved ?? 0;
}

/**
 * Runs after {@link reserve} takes the advisory lock — split out so each function stays small,
 * not because it is reusable on its own.
 */
async function attemptReservation(
  tx: OutboxTransaction,
  workspaces: Workspaces,
  input: ReserveInput,
  period: string,
): Promise<ReserveResult> {
  const [existing] = await tx
    .select({ contactPlatformId: contactQuotaUsage.contactPlatformId })
    .from(contactQuotaUsage)
    .where(
      and(
        eq(contactQuotaUsage.workspaceId, input.workspaceId),
        eq(contactQuotaUsage.period, period),
        eq(contactQuotaUsage.platform, input.platform),
        eq(contactQuotaUsage.contactPlatformId, input.contactPlatformId),
      ),
    )
    .limit(1);

  // Already counted this period — a second reply to the same person spends nothing further.
  if (existing !== undefined) {
    return { ok: true };
  }

  const workspace = await workspaces.findById(input.workspaceId);
  if (!workspace.found) {
    throw new Error(`ContactQuota.reserve: workspace ${input.workspaceId} not found`);
  }

  const usedThisPeriod = await countReservedThisPeriod(tx, input.workspaceId, period);
  if (usedThisPeriod >= workspace.value.contactLimitMonthly) {
    return { ok: false, reason: 'QUOTA_EXCEEDED' };
  }

  await tx.insert(contactQuotaUsage).values({
    workspaceId: input.workspaceId,
    period,
    platform: input.platform,
    contactPlatformId: input.contactPlatformId,
    commentId: input.commentId,
  });

  return { ok: true };
}

async function reserve(
  tx: OutboxTransaction,
  workspaces: Workspaces,
  input: ReserveInput,
): Promise<ReserveResult> {
  const period = currentPeriod();

  // Takes the caller's transaction's lifetime (R-08, §7.1 step 3) — held until the whole reply
  // commits or rolls back, which is what makes two concurrent reservations for the same new
  // contact serialize instead of racing, and what keeps a comment insert failure from leaving a
  // reservation with nothing to reclaim it.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${input.workspaceId}), hashtext(${period}))`,
  );
  return attemptReservation(tx, workspaces, input, period);
}

async function release(db: NodePgDatabase, input: ReleaseInput): Promise<void> {
  await db
    .delete(contactQuotaUsage)
    .where(
      and(
        eq(contactQuotaUsage.workspaceId, input.workspaceId),
        eq(contactQuotaUsage.commentId, input.commentId),
      ),
    );
}

/**
 * Backs {@link ContactQuota}. `workspaces` is required even though `release` never reads it —
 * `reserve` needs `contactLimitMonthly` on every call, and a constructor that accepts an
 * incomplete wiring only to fail inside `reserve` would make an invalid `ContactQuota` instance
 * representable, deferring the failure to whichever call happens to reach it first.
 */
export function createContactQuota(db: NodePgDatabase, workspaces: Workspaces): ContactQuota {
  return {
    reserve: (tx, input) => reserve(tx, workspaces, input),
    release: (input) => release(db, input),
  };
}

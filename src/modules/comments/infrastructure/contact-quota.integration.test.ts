/**
 * Contract tests for the `ContactQuota` port (T053, V3; spec.md D16, A8; plan.md §Project
 * Structure "ContactQuota is implemented in comments/infrastructure").
 *
 * The shape asserted here (`reserve` / `release`, `{ ok: true } | { ok: false, reason:
 * 'QUOTA_EXCEEDED' }`) is a contract decision this file makes, not one the design documents state
 * outright — plan.md names the responsibility (`pg_advisory_xact_lock` on `(workspace_id,
 * period)`, `contact_quota_usage`, `release` on final failure) but not the port's TypeScript
 * shape. See the report for why this shape and not another.
 *
 * The load-bearing case is concurrency (R-08): two replies to the same new audience member, fired
 * with genuine `Promise.all` concurrency (not sequentially — a sequential test would pass against
 * an implementation with no locking at all), must consume the monthly allowance exactly once.
 */

// oxlint-disable max-dependencies -- an integration test's import count reflects the surface it
// exercises (the not-yet-built port under test, the schema table it reads, the Workspaces port it
// composes with, the harness); see the same reasoning in container.ts and api.ts.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createContactQuota,
  type ContactQuota,
  type ReserveInput,
  type ReserveResult,
} from '#src/modules/comments/infrastructure/contact-quota.ts';
import { contactQuotaUsage } from '#src/modules/comments/infrastructure/schema.ts';
import { createLocalWorkspaces } from '#src/modules/platform-core/local/workspaces.ts';
import { workspaces } from '#src/modules/platform-core/schema.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  quota: ContactQuota;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const db = drizzle(pool);
  const quota = createContactQuota(db, createLocalWorkspaces(db));
  return { containers, pool, db, quota };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.pool.end();
  await harness.containers.stop();
}

async function seedWorkspace(
  db: NodePgDatabase,
  contactLimitMonthly: number,
): Promise<WorkspaceId> {
  const workspaceId = asWorkspaceId(generateId());
  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly,
    createdAt: new Date(),
  });
  return workspaceId;
}

/** Rows this period for `workspaceId` — the count that matters is "people contacted", not messages. */
async function countUsageRows(db: NodePgDatabase, workspaceId: WorkspaceId): Promise<number> {
  const rows = await db
    .select({ contactPlatformId: contactQuotaUsage.contactPlatformId })
    .from(contactQuotaUsage)
    .where(eq(contactQuotaUsage.workspaceId, workspaceId));
  return rows.length;
}

function newContactId(): string {
  return `contact-${randomUUID()}`;
}

/**
 * `reserve` now joins the caller's transaction (spec.md §7.1 step 3) instead of opening its own —
 * this harness stands in for the accepting transaction the real accept path composes it into.
 * Each call opens its own `db.transaction`, so two calls fired via `Promise.all` are still two
 * genuinely independent, concurrently-committing transactions — the property the concurrency case
 * below depends on.
 */
function reserveInOwnTransaction(harness: Harness, input: ReserveInput): Promise<ReserveResult> {
  return harness.db.transaction((tx) => harness.quota.reserve(tx, input));
}

/**
 * Each case is a standalone top-level function, called once from the outer `describe` (same shape
 * as `local-ports.integration.test.ts`'s `registerUnknownEntityTests` etc.) rather than nested
 * inline, so the outer `describe` callback stays a short list of registrations.
 */

function registerConcurrentReservationTest(getHarness: () => Harness): void {
  it('consumes the monthly allowance exactly once for two concurrent reservations of the same new contact', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.db, 10);
    const contactPlatformId = newContactId();

    // Genuinely concurrent — Promise.all, not two sequential awaits — so this only passes if the
    // implementation actually serializes on pg_advisory_xact_lock(workspace_id, period) (R-08).
    const [resultA, resultB] = await Promise.all([
      reserveInOwnTransaction(harness, {
        workspaceId,
        platform: 'instagram',
        contactPlatformId,
        commentId: generateId(),
      }),
      reserveInOwnTransaction(harness, {
        workspaceId,
        platform: 'instagram',
        contactPlatformId,
        commentId: generateId(),
      }),
    ]);

    expect(resultA).toEqual({ ok: true });
    expect(resultB).toEqual({ ok: true });
    expect(await countUsageRows(harness.db, workspaceId)).toBe(1);
  });
}

function registerExhaustedAllowanceTest(getHarness: () => Harness): void {
  it('rejects a new contact once the allowance is exhausted, while an already-counted contact still succeeds (D16)', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.db, 1);
    const existingContact = newContactId();
    const newContact = newContactId();

    const first = await reserveInOwnTransaction(harness, {
      workspaceId,
      platform: 'instagram',
      contactPlatformId: existingContact,
      commentId: generateId(),
    });
    expect(first).toEqual({ ok: true });

    const rejected = await reserveInOwnTransaction(harness, {
      workspaceId,
      platform: 'instagram',
      contactPlatformId: newContact,
      commentId: generateId(),
    });
    expect(rejected).toEqual({ ok: false, reason: 'QUOTA_EXCEEDED' });

    // The limit counts people contacted, not messages sent — a second reply to the same person
    // this period is not a new contact and must not be blocked by the same exhausted allowance.
    const repeatContact = await reserveInOwnTransaction(harness, {
      workspaceId,
      platform: 'instagram',
      contactPlatformId: existingContact,
      commentId: generateId(),
    });
    expect(repeatContact).toEqual({ ok: true });

    expect(await countUsageRows(harness.db, workspaceId)).toBe(1);
  });
}

function registerReleaseTest(getHarness: () => Harness): void {
  it('releases the reservation on a final failure, freeing the allowance for a new contact', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.db, 1);
    const contactPlatformId = newContactId();
    const commentId = generateId();

    const reserved = await reserveInOwnTransaction(harness, {
      workspaceId,
      platform: 'instagram',
      contactPlatformId,
      commentId,
    });
    expect(reserved).toEqual({ ok: true });

    await harness.quota.release({ workspaceId, commentId });

    expect(await countUsageRows(harness.db, workspaceId)).toBe(0);

    const afterRelease = await reserveInOwnTransaction(harness, {
      workspaceId,
      platform: 'instagram',
      contactPlatformId: newContactId(),
      commentId: generateId(),
    });
    expect(afterRelease).toEqual({ ok: true });
  });
}

describe('ContactQuota', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupHarness();
  });

  afterAll(async () => {
    await teardownHarness(harness);
  });

  registerConcurrentReservationTest(() => harness);
  registerExhaustedAllowanceTest(() => harness);
  registerReleaseTest(() => harness);
});

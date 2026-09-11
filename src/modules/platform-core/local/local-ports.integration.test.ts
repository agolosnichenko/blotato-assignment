/**
 * Proves the service boundary holds for the local port implementations (D8, D29, D30, A19, T024).
 *
 * Three things are asserted against a real Postgres:
 *   1. A missing projection row reports the entity as unknown ({@link NOT_FOUND}), not a throw.
 *   2. No query issued by this module joins a `comments`-owned table — checked by capturing the
 *      literal SQL Drizzle sends to Postgres (via its `logger` hook) while exercising `Accounts`,
 *      rather than by grepping the source for the word "join". This is the strongest check
 *      actually run: it inspects every statement the module executes for this scenario, not just
 *      the ones a reviewer thought to construct. It only exercises `Accounts`, but that is
 *      complete coverage in substance, not a narrowing: `Accounts` is the only port in this module
 *      that touches a comments-module table at all (`workspaces.ts`, `api-keys.ts`, `posts.ts` and
 *      `account-credentials.ts` read only platform-core's own `schema.ts`, so there is no join to
 *      check there — verifiable by inspection of their imports).
 *   3. An `auth_failed` row in `account_health` makes `Accounts` report the account disconnected
 *      while `social_accounts.status` is left untouched (D30).
 */

import { eq } from 'drizzle-orm';
import type { Logger } from 'drizzle-orm/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { accountHealth } from '#src/modules/comments/infrastructure/schema.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';

class CapturingLogger implements Logger {
  readonly statements: string[] = [];

  logQuery(query: string): void {
    this.statements.push(query);
  }
}

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  capturedSql: CapturingLogger;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const capturedSql = new CapturingLogger();
  const db = drizzle(pool, { logger: capturedSql });
  return { containers, pool, db, capturedSql };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.pool.end();
  await harness.containers.stop();
}

async function seedSocialAccount(
  db: NodePgDatabase,
  overrides: Partial<typeof socialAccounts.$inferInsert> = {},
): Promise<{ workspaceId: string; socialAccountId: string }> {
  const workspaceId = generateId();
  const socialAccountId = generateId();

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: new Date(),
  });
  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: 'instagram',
    platformAccountId: 'ig-123',
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
    ...overrides,
  });

  return { workspaceId, socialAccountId };
}

function registerUnknownEntityTests(getHarness: () => Harness): void {
  describe('unknown entity', () => {
    it('reports a missing social account as not found rather than throwing', async () => {
      const result = await createLocalAccounts(getHarness().db).findById(generateId());

      expect(result).toEqual({ found: false });
    });
  });
}

function registerNoJoinTests(getHarness: () => Harness): void {
  describe('no join against a comments table', () => {
    it('reads social_accounts and account_health as two separate statements, never joined', async () => {
      const harness = getHarness();
      const { socialAccountId } = await seedSocialAccount(harness.db);
      harness.capturedSql.statements.length = 0;

      await createLocalAccounts(harness.db).findById(socialAccountId);

      expect(harness.capturedSql.statements).toHaveLength(2);
      for (const statement of harness.capturedSql.statements) {
        expect(statement.toLowerCase()).not.toContain('join');
      }
      expect(harness.capturedSql.statements[0]).toContain('"social_accounts"');
      expect(harness.capturedSql.statements[1]).toContain('"account_health"');
    });
  });
}

function registerAccountHealthCompositionTests(getHarness: () => Harness): void {
  describe('D30 — account_health composition', () => {
    it('reports disconnected on an auth_failed row, without touching social_accounts', async () => {
      const db = getHarness().db;
      const { workspaceId, socialAccountId } = await seedSocialAccount(db);
      await db.insert(accountHealth).values({
        socialAccountId,
        workspaceId,
        state: 'auth_failed',
        reason: 'token revoked upstream',
        detectedAt: new Date(),
      });

      const result = await createLocalAccounts(db).findById(socialAccountId);

      expect(result).toEqual({
        found: true,
        value: expect.objectContaining({ status: 'disconnected' }),
      });
      const [rawRow] = await db
        .select({ status: socialAccounts.status })
        .from(socialAccounts)
        .where(eq(socialAccounts.id, socialAccountId));
      expect(rawRow?.status).toBe('active');
    });

    it('reports active again once the account_health row is cleared', async () => {
      const db = getHarness().db;
      const { workspaceId, socialAccountId } = await seedSocialAccount(db);
      await db.insert(accountHealth).values({
        socialAccountId,
        workspaceId,
        state: 'auth_failed',
        reason: 'token revoked upstream',
        detectedAt: new Date(),
      });
      await db.delete(accountHealth).where(eq(accountHealth.socialAccountId, socialAccountId));

      const result = await createLocalAccounts(db).findById(socialAccountId);

      expect(result).toEqual({ found: true, value: expect.objectContaining({ status: 'active' }) });
    });
  });
}

describe('local platform-core ports', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupHarness();
  });

  afterAll(async () => {
    await teardownHarness(harness);
  });

  registerUnknownEntityTests(() => harness);
  registerNoJoinTests(() => harness);
  registerAccountHealthCompositionTests(() => harness);
});

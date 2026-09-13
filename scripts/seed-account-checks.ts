/**
 * Pure decision functions for `scripts/seed-account.ts` (see its module docstring).
 *
 * Two things: resolving an environment override with a documented default, and detecting when a
 * row already in the database disagrees with what this run would seed it as. Kept separate so
 * both are testable without a database (see `scripts/seed-account.test.ts`) and so
 * `seed-account.ts` stays well under the project's 300-line-per-file limit.
 */

/** One overridable value, and whether it came from the environment or the default. */
export interface ResolvedValue {
  readonly value: string;
  readonly fromEnv: boolean;
}

/**
 * Resolves one overridable value from the environment.
 *
 * Args:
 *   env: Environment to read.
 *   varName: The variable an operator can set to override the default.
 *   defaultValue: What to use when `varName` is unset or empty.
 *
 * Returns:
 *   `defaultValue` (with `fromEnv: false`) when `varName` is unset or an empty string, else the
 *   variable's value (with `fromEnv: true`).
 */
export function resolveOverride(
  env: NodeJS.ProcessEnv,
  varName: string,
  defaultValue: string,
): ResolvedValue {
  const raw = env[varName];
  if (raw === undefined || raw.length === 0) {
    return { value: defaultValue, fromEnv: false };
  }
  return { value: raw, fromEnv: true };
}

/** One demo account seeded by `scripts/seed-account.ts` — shared with `seed-account-writes.ts`. */
export interface DemoAccount extends AccountEnvKeys {
  readonly id: string;
  readonly platform: 'instagram' | 'facebook' | 'bluesky';
  readonly authVariant: 'facebook_login' | 'instagram_login' | null;
  readonly postId: string;
}

/** The environment-override wiring for one demo account's non-secret fields. */
export interface AccountEnvKeys {
  readonly accountIdEnvVar: string;
  readonly defaultAccountId: string;
  readonly usernameEnvVar: string;
  readonly defaultUsername: string;
  readonly platformPostIdEnvVar: string;
  readonly defaultPlatformPostId: string;
  readonly tokenEnvVar: string;
  readonly placeholderToken: string;
}

/** What this run resolved for one demo account, before any database access. */
export interface ResolvedAccountValues {
  readonly platformAccountId: ResolvedValue;
  readonly username: ResolvedValue;
  readonly platformPostId: ResolvedValue;
  readonly token: ResolvedValue;
}

/** Resolves every overridable field for one demo account in one place. */
export function resolveAccountValues(
  env: NodeJS.ProcessEnv,
  keys: AccountEnvKeys,
): ResolvedAccountValues {
  return {
    platformAccountId: resolveOverride(env, keys.accountIdEnvVar, keys.defaultAccountId),
    username: resolveOverride(env, keys.usernameEnvVar, keys.defaultUsername),
    platformPostId: resolveOverride(env, keys.platformPostIdEnvVar, keys.defaultPlatformPostId),
    token: resolveOverride(env, keys.tokenEnvVar, keys.placeholderToken),
  };
}

/** One field that differs between a stored row and what this run would seed. */
export interface FieldConflict {
  readonly field: string;
  readonly stored: string;
  readonly desired: string;
}

/**
 * Compares a stored row's script-owned fields against what this run would seed.
 *
 * A row that does not exist yet has nothing to conflict with; a field the stored row does not
 * carry (should not happen for the columns this script reads, but keeps the function total) is
 * likewise not a conflict — only a field present on both sides with different values is.
 *
 * Args:
 *   stored: The row's current values for the fields this script owns, or `undefined` when the row
 *     does not exist yet.
 *   desired: The values this run is about to write.
 *
 * Returns:
 *   One `FieldConflict` per differing field, in `desired`'s key order. Empty when the row is new
 *   or every owned field already matches.
 */
export function detectConflicts(
  stored: Readonly<Record<string, string>> | undefined,
  desired: Readonly<Record<string, string>>,
): FieldConflict[] {
  if (stored === undefined) {
    return [];
  }
  const conflicts: FieldConflict[] = [];
  for (const [field, desiredValue] of Object.entries(desired)) {
    const storedValue = stored[field];
    if (storedValue !== undefined && storedValue !== desiredValue) {
      conflicts.push({ field, stored: storedValue, desired: desiredValue });
    }
  }
  return conflicts;
}

/**
 * Formats a refusal message an operator can act on without reading source: which row, which
 * field(s) disagree, the stored value, the value this run supplied, and what to do about it.
 */
export function formatConflictMessage(
  rowLabel: string,
  conflicts: readonly FieldConflict[],
): string {
  const lines = conflicts
    .map(
      (conflict) =>
        `  ${conflict.field}: stored "${conflict.stored}", supplied "${conflict.desired}"`,
    )
    .join('\n');
  return (
    `${rowLabel} already exists with different values than this run would seed:\n${lines}\n` +
    'Re-running this script never updates an existing row (ON CONFLICT DO NOTHING) — clear the ' +
    'demo workspace first, then re-run with the real values.'
  );
}

/** One line of the end-of-run summary: where this account's credential and ids came from. */
export function formatAccountStatus(platform: string, resolved: ResolvedAccountValues): string {
  const idsOverridden =
    resolved.platformAccountId.fromEnv ||
    resolved.username.fromEnv ||
    resolved.platformPostId.fromEnv;
  const credentialSource = resolved.token.fromEnv ? 'environment' : 'placeholder';
  return `  ${platform}: credential from ${credentialSource}; ids ${idsOverridden ? 'overridden' : 'default'}.`;
}

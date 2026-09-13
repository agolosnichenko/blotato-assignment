/* oxlint-disable no-console -- this module exists to print a script's failure to stderr; it is
   the one place in `scripts/` that formats operator-facing output, and every other module keeps
   no-console enabled. */
/**
 * How every script in this directory reports a failure and tears down.
 *
 * Two habits were repeated across all of them and both lose evidence at the worst moment.
 *
 * `console.error(error.message)` prints one line: no stack, and no `cause` chain — so a wrapped
 * error says "seed failed" and nothing about what actually threw. `migrate.ts` is the sharp case,
 * since it runs as Railway's pre-deploy command and that one line is the entire forensic record of
 * a failed production migration.
 *
 * `finally { await pool.end() }` lets a cleanup failure *replace* the original error: if the body
 * threw and `end()` throws too, the caller sees only the teardown error, and the reason the script
 * failed is gone.
 */

/** Prints `error` with its stack and its full `cause` chain, then marks the process failed. */
export function reportFatal(error: unknown): void {
  console.error(formatFailure(error));
  process.exitCode = 1;
}

function formatFailure(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current !== undefined && current !== null && depth < 10) {
    const prefix = depth === 0 ? '' : 'caused by: ';
    if (current instanceof Error) {
      lines.push(`${prefix}${current.stack ?? `${current.name}: ${current.message}`}`);
      current = current.cause;
    } else {
      lines.push(`${prefix}${String(current)}`);
      current = undefined;
    }
    depth += 1;
  }

  return lines.join('\n');
}

/**
 * Runs a teardown step without letting it mask why the script is already failing.
 *
 * Args:
 *   label: What is being closed, for the warning line if it fails.
 *   close: The teardown itself.
 */
export async function closeQuietly(label: string, close: () => Promise<unknown>): Promise<void> {
  try {
    await close();
  } catch (error) {
    console.error(`warning: failed to close ${label}\n${formatFailure(error)}`);
  }
}

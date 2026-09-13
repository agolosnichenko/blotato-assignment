/* oxlint-disable no-console -- a CI gate reports by printing; every other module keeps no-console
   enabled. */
/**
 * Fails when a document claims something is unbuilt that the tree says is built.
 *
 * A statement like "the webhook path is not yet wired" is true until the code moves in one
 * particular direction — and moving it is the whole job, so every such statement goes stale at the
 * moment its wave lands, all of them at once. That is why this defect appeared three times on this
 * branch and was caught each time by a reviewer rather than a test: the phrases rot systematically,
 * while the sentences around them stay true.
 *
 * So this gate does not check prose. It checks the *claims* against a small table of things that
 * either exist or do not, and asks CI the question a reviewer kept having to ask by hand.
 *
 * Adding a claim is the point: when you write "X is not built" in a document, add the file that
 * would exist once it is. When someone builds X, this fails and names the sentence to update.
 */

import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

/** A phrase that claims something is unbuilt, and the path whose existence would falsify it. */
interface StatusClaim {
  /** Substring to search for, matched case-insensitively. */
  readonly phrase: string;
  /** Repo-relative path that must NOT exist while the phrase is present. */
  readonly falsifiedBy: string;
  /** What to do when the gate fires. */
  readonly hint: string;
}

const DOCUMENTS = [
  'README.md',
  'DESIGN.md',
  'scripts/spikes/README.md',
  'specs/001-multi-platform-comments/quickstart.md',
];

const CLAIMS: readonly StatusClaim[] = [
  {
    phrase: 'webhook not yet wired',
    falsifiedBy: 'src/modules/comments/http/webhook-routes.ts',
    hint: 'the webhook routes exist; describe what the path does, and what D23 means for deliveries',
  },
  {
    phrase: 'not yet implemented',
    falsifiedBy: 'src/modules/comments/http/webhook-routes.ts',
    hint: 'check whether this still refers to the webhook path, which is built',
  },
  {
    phrase: 'webhook verifier (not yet built)',
    falsifiedBy: 'src/modules/comments/http/webhook-routes.ts',
    hint: 'the verifier is built and accepts either configured secret',
  },
  {
    phrase: 'instagram read path is gated',
    falsifiedBy: 'src/platforms/meta/__fixtures__/s2-facebook-login-comments.json',
    hint: 'spike S2 ran; the read path is built against its recorded fixture',
  },
  {
    phrase: 'its script does not exist yet',
    falsifiedBy: 'scripts/smoke.ts',
    hint: 'T108 landed; describe what `pnpm smoke` runs and which variables it needs',
  },
];

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Whether the file that would falsify a claim exists.
 *
 * Only `ENOENT` counts as "not yet". Swallowing every error instead made this gate fail *open* in
 * exactly the situation it exists for: a typo in `falsifiedBy`, a renamed file or an `EACCES`
 * read as "still unimplemented" drops the claim from `live`, the scan then finds nothing, and the
 * check prints "no stale statements" and exits zero — over precisely the outdated text it was
 * written to catch. A gate that cannot fail is worse than no gate, because it is trusted.
 */
async function exists(relativePath: string): Promise<boolean> {
  const absolute = path.join(ROOT, relativePath);
  try {
    await access(absolute);
    return true;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  // A missing file is only meaningful if its directory is real; otherwise `falsifiedBy` is a typo
  // or points into a directory that has moved, and this claim would silently never be checked.
  const parent = path.dirname(absolute);
  try {
    await access(parent);
  } catch (error) {
    throw new Error(
      `check-status-claims: falsifiedBy "${relativePath}" names a directory that does not exist ` +
        `(${path.relative(ROOT, parent)}) — fix the path rather than leaving the claim unchecked`,
      { cause: error },
    );
  }
  return false;
}

interface Violation {
  readonly document: string;
  readonly line: number;
  readonly claim: StatusClaim;
}

async function scanDocument(document: string, live: readonly StatusClaim[]): Promise<Violation[]> {
  const contents = await readFile(path.join(ROOT, document), 'utf8');
  const violations: Violation[] = [];
  for (const [index, line] of contents.split('\n').entries()) {
    const lowered = line.toLowerCase();
    for (const claim of live) {
      if (lowered.includes(claim.phrase.toLowerCase())) {
        violations.push({ document, line: index + 1, claim });
      }
    }
  }
  return violations;
}

async function main(): Promise<void> {
  // Only claims whose falsifying file now exists are worth searching for: the rest are statements
  // that are still true, and this gate has nothing to say about them.
  const live: StatusClaim[] = [];
  for (const claim of CLAIMS) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of stats, run once in CI
    if (await exists(claim.falsifiedBy)) {
      live.push(claim);
    }
  }

  const found = await Promise.all(DOCUMENTS.map((document) => scanDocument(document, live)));
  const violations = found.flat();

  if (violations.length === 0) {
    console.log(`check-status-claims: ${live.length} claim(s) checked, no stale statements.`);
    return;
  }

  for (const { document, line, claim } of violations) {
    console.error(
      `${document}:${line} claims "${claim.phrase}", but ${claim.falsifiedBy} exists — ${claim.hint}`,
    );
  }
  console.error(`\n${violations.length} stale status claim(s). Update the prose or drop the file.`);
  process.exitCode = 1;
}

await main();

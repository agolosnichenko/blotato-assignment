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
import { access, readdir } from 'node:fs/promises';
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
  {
    phrase: '(T057) does not exist yet',
    falsifiedBy: 'src/modules/comments/infrastructure/contact-quota.ts',
    hint: 'T057 landed; describe the contract this file pins rather than its absence',
  },
  {
    phrase: 'this spike gates does not exist yet',
    falsifiedBy: 'src/modules/comments/http/webhook-routes.ts',
    hint: 'the verifier this spike gated is built; say what it does with the recorded secret',
  },
];

/**
 * A phrase no committed file under {@link SOURCE_TREES} may contain, with no falsifying path to
 * check — the phrase is wrong the moment it is committed, so there is nothing to compare it against.
 *
 * These are the sentences a file writes about *itself* while it is being written test-first: "no
 * route is registered at this path", "the schema accepts none of these keys yet", "this fails
 * today". Each is true in the working tree for as long as it takes to write the implementation, and
 * false in every commit that contains the implementation — which is the same commit, or the one
 * after. Unlike the claims above, no file appears to mark the transition: `routes.ts` exists before
 * and after, so {@link CLAIMS} cannot express this — and thirty such lines across eleven files, two
 * of them from the previous feature, survived until a reviewer read the docstrings against the code.
 *
 * A test file is the strongest case: a committed test that says it fails today is either skipped or
 * lying, and a reader who believes it stops trusting the suite. Describe what the test pins, not
 * what the tree looked like on the way there.
 *
 * Every phrase here must be one that cannot also describe *data*. "does not exist yet" was tried and
 * removed: `seed-account-checks.ts` uses it correctly about a database row that has not been seeded,
 * and a gate with false positives gets weakened rather than obeyed. A phrase about a missing *module*
 * belongs in {@link CLAIMS} instead, where naming the falsifying path supplies the precision.
 */
interface ForbiddenPhrase {
  /** Substrings to search for, matched case-insensitively; they share one {@link hint}. */
  readonly phrases: readonly string[];
  /** What to do when the gate fires. */
  readonly hint: string;
}

const SOURCE_TREES = ['src', 'scripts'];

const FORBIDDEN_IN_SOURCE: readonly ForbiddenPhrase[] = [
  {
    phrases: ['fails today', 'fail today', 'red failure'],
    hint: 'a committed file cannot describe its own failure — say what the test pins instead',
  },
  {
    phrases: ['is a later task', 'in a later task'],
    hint: 'name what the code does now; a task ordering is in tasks.md, not in a docstring',
  },
  {
    phrases: ['this route yet', 'handler today'],
    hint: 'the route is registered; describe what it answers',
  },
  {
    phrases: ['accepts none of these', 'unfiltered today'],
    hint: 'the schema accepts these keys; describe the narrowed result they produce',
  },
  {
    phrases: ['ignores every', 'given today'],
    hint: 'the predicate applies these keys; describe the selection it builds',
  },
  {
    phrases: ['been written yet', 'di graph yet'],
    hint: 'the module exists and is wired; describe the contract rather than its absence',
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

/** One searchable substring and what to do about it, from either list. */
interface SearchablePhrase {
  readonly phrase: string;
  readonly hint: string;
}

interface SourceViolation {
  readonly file: string;
  readonly line: number;
  readonly found: SearchablePhrase;
}

/**
 * Both lists flattened to one pair per substring: the phrases that are wrong in any commit
 * containing them, and the document claims whose falsifying file now exists — prose rots in a
 * docstring exactly as it does in a markdown file, and this branch is where it did.
 */
function searchablePhrases(live: readonly StatusClaim[]): readonly SearchablePhrase[] {
  const forbidden = FORBIDDEN_IN_SOURCE.flatMap((entry) =>
    entry.phrases.map((phrase) => ({ phrase, hint: entry.hint })),
  );
  return [...forbidden, ...live.map(({ phrase, hint }) => ({ phrase, hint }))];
}

/**
 * This file, which is the one source file that must not be scanned: it contains every phrase the
 * gate searches for, so scanning it reports each one against itself and the gate can never pass.
 */
const SELF = path.relative(ROOT, import.meta.filename);

/** Every `.ts` file under one tree, repo-relative, except {@link SELF}. */
async function sourceFiles(tree: string): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, tree), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .filter((file) => file !== SELF);
}

async function scanSourceFile(
  file: string,
  searched: readonly SearchablePhrase[],
): Promise<SourceViolation[]> {
  const contents = await readFile(path.join(ROOT, file), 'utf8');
  const violations: SourceViolation[] = [];
  for (const [index, line] of contents.split('\n').entries()) {
    const lowered = line.toLowerCase();
    for (const found of searched) {
      if (lowered.includes(found.phrase.toLowerCase())) {
        violations.push({ file, line: index + 1, found });
      }
    }
  }
  return violations;
}

/** The source half of the gate, over every `.ts` file in {@link SOURCE_TREES}. */
async function scanSourceTrees(live: readonly StatusClaim[]): Promise<SourceViolation[]> {
  const searched = searchablePhrases(live);
  const trees = await Promise.all(SOURCE_TREES.map((tree) => sourceFiles(tree)));
  const found = await Promise.all(trees.flat().map((file) => scanSourceFile(file, searched)));
  return found.flat();
}

function reportSourceViolations(violations: readonly SourceViolation[]): void {
  for (const { file, line, found } of violations) {
    console.error(`${file}:${line} says "${found.phrase}" — ${found.hint}`);
  }
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
  const sourceViolations = await scanSourceTrees(live);

  if (violations.length === 0 && sourceViolations.length === 0) {
    console.log(
      `check-status-claims: ${live.length} document claim(s) and ` +
        `${searchablePhrases(live).length} source phrase(s) checked, no stale statements.`,
    );
    return;
  }

  for (const { document, line, claim } of violations) {
    console.error(
      `${document}:${line} claims "${claim.phrase}", but ${claim.falsifiedBy} exists — ${claim.hint}`,
    );
  }
  reportSourceViolations(sourceViolations);
  const total = violations.length + sourceViolations.length;
  console.error(`\n${total} stale status claim(s). Update the prose or drop the file.`);
  process.exitCode = 1;
}

await main();

// ── THE NEW-BRANCH NAME, CHECKED WHILE YOU TYPE ──────────────────────────────────────────────
//
// The landing step's "Commit to a new branch" field. Nothing here is a guarantee: the commit
// route validates the same name again and refuses with `InvalidBranch` / `ReservedBranch` /
// `BranchExists`. This exists so the reader finds out at the keystroke rather than after the
// server has already spent a clone and a fetch on a name it was always going to refuse.
//
// ⚠ THE BACKEND IS THE AUTHORITY AND THE PATTERN IS COPIED FROM IT.
// `apps/backend/src/coding/git-ops.ts`'s `commitFilesAndOpenPr` check is the original;
// `test/branchName.test.ts` reads that file and fails if the two literals stop being
// byte-identical, because a mirror that has drifted is worse than no mirror at all — it refuses
// names the server would take, and takes names the server will refuse.
//
// ⚠ IT IS A NAMING CONVENTION, NOT A PUSH GUARD, AND THE DIFFERENCE MATTERS. `feature/#123`,
// `user's-branch`, `a+b` and `ünicode/x` are all real GitHub branches that this refuses. That is
// correct HERE — this names a branch we are about to INVENT — and wrong in `pushRef`, which is
// handed head refs somebody else chose. The push guard is `assertPushTarget`.

/** ⚠ BYTE-IDENTICAL TO `coding/git-ops.ts`. See the module header. */
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type BranchNameRefusal =
  | 'empty'
  | 'malformed'
  /** The PR's own head ref — pushing there is the OTHER option, by name. */
  | 'pr_branch'
  /** The PR's base ref. */
  | 'base_branch'
  /** Any other name on `session.reservedBranchNames` — the repo's default branch. */
  | 'default_branch';

export interface BranchNameContext {
  headRef: string;
  baseRef: string;
  /** `ConflictSession.reservedBranchNames` — the repo default branch and the PR base ref. */
  reserved: readonly string[];
}

/** Case-insensitive, matching `assertPushTarget`'s `protect` comparison: on a case-insensitive
 *  filesystem `Main` and `main` are one ref, and a guard that disagrees with the push is not a
 *  guard. */
function sameRef(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * `null` ⇒ this name is offerable. Ordered most specific first: a name that is both the base ref
 * and the repo default is named as the base ref, because that is the one the reader can see on
 * this screen.
 */
export function checkBranchName(raw: string, ctx: BranchNameContext): BranchNameRefusal | null {
  const name = raw.trim();
  if (name === '') return 'empty';
  // `..` is legal under the character class and illegal as a ref, so it is a separate clause in
  // the backend too. Kept as two tests rather than folded into one pattern, so the copy above
  // stays a copy.
  if (!BRANCH_NAME_PATTERN.test(name) || name.includes('..')) return 'malformed';
  if (sameRef(name, ctx.headRef)) return 'pr_branch';
  if (sameRef(name, ctx.baseRef)) return 'base_branch';
  if (ctx.reserved.some((r) => sameRef(name, r))) return 'default_branch';
  return null;
}

/** One sentence per refusal. Each names the fact and stops — no "try something like…", because
 *  the reader is looking at the field they typed it into. */
export function branchNameMessage(refusal: BranchNameRefusal, ctx: BranchNameContext): string {
  switch (refusal) {
    case 'empty':
      return 'Name the branch.';
    case 'malformed':
      return 'Branch names start with a letter or digit and can use letters, digits, . _ / and -.';
    case 'pr_branch':
      return `That’s this PR’s branch — use “Push to ${ctx.headRef}” instead.`;
    case 'base_branch':
      return 'That’s this PR’s base branch. Pick another name.';
    case 'default_branch':
      return 'That’s the default branch. Pick another name.';
  }
}

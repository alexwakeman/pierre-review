// THE PR CHIPS — two facts about an open pull request that ride the Open PRs rows, the Pending cards
// and the PR detail header (docs/FRONTEND.md § PR chips; the third chip, "Large", is the existing
// large-PR flag and its `codeLoc`, see LARGE_PR_CODE_LOC_DEFAULT in types.ts).
//
//   • STACKED PRs — a PR whose base branch is another OPEN PR's head branch in the same repo is
//     stacked on it (it lands after it). Folded server-side from synced columns
//     (`db/pr-stacks.ts`), never fetched.
//   • ACCEPTANCE CRITERIA — the latest SUCCEEDED ticket review (Story check) that read this PR, per
//     ticket: how many of the ticket's criteria it judged `met`. Read from the DB
//     (`db/pr-criteria.ts`); no AI run, no tracker call.
//
// ⚠ BOTH ARE TRAILING OPTIONAL on the wire types that carry them: absent = "not asked" (an older
// server, the lean timeline), and the chip renders nothing. Unknown is never zero.

/** One open PR of a stack. */
export interface PrStackMember {
  prId: number;
  number: number;
  title: string;
}

/**
 * Where an open PR sits in a stack of open PRs (each one targets the head branch of the one below
 * it, in the same repository).
 *
 * `chain` runs from the BOTTOM (the PR whose base is a branch no open PR owns — usually the default
 * branch) up through this PR, then on up while exactly ONE open PR targets the branch above. A
 * branch with two PRs on it ends the chain there; those PRs are `children`.
 *
 * Present (non-null) only when this PR has a parent or at least one child.
 */
export interface PrBranchStack {
  /** 1-based position of THIS PR in `chain`, from the bottom. */
  position: number;
  /** The stack, bottom first; `chain.length` is the size the chip names. */
  chain: PrStackMember[];
  /** The open PR this one lands after (its base branch is that PR's head branch). Null at the bottom. */
  parent: PrStackMember | null;
  /** The open PRs that target this PR's head branch (land after it). Number order. */
  children: PrStackMember[];
}

/**
 * One ticket's acceptance-criteria judgement covering a PR — from the latest SUCCEEDED ticket
 * review of that ticket that had this PR as a member.
 *
 * "DONE" IS THE SHARED `criterionDone`: `met` (a PR delivers it) or `met_outside_code` (a person's
 * ticket comment says it was done outside the code), each counted apart. `partly_met`, `not_met`,
 * `unclear` and `not_checked` are NOT done: "partly" or "could not tell" is not delivered. The colour:
 * every criterion done → green; any `not_met` → red; else (only partly met / unclear / not checked
 * short of all done) → amber.
 */
export interface PrCriteriaCheck {
  /** `trackerTicketIdent` of the ticket (`manual:…` for a pasted story). */
  ident: string;
  /** The tracker key ("BMD-7"), null for a pasted story. */
  key: string | null;
  title: string | null;
  /** The ticket review run (`GET /api/ticket-reviews/:id`). */
  reviewId: number;
  met: number;
  /** "Met outside code changes" — done, named apart. Absent from an older server (read as 0). */
  metOutsideCode?: number;
  partlyMet: number;
  notMet: number;
  /** `unclear` + `not_checked`. */
  unsettled: number;
  /** Every criterion the check listed; > 0 on every entry (a check with no criteria is no chip). */
  total: number;
  /** ISO-8601 of the run's completion. */
  checkedAt: string;
  /** The run read an OLDER commit of this PR than its current synced head. */
  olderHead: boolean;
}

/** The chip's tone, from the counts. Pure — the SPA's colour and its tests read this one rule. */
export function criteriaCheckTone(
  c: Pick<PrCriteriaCheck, 'met' | 'notMet' | 'total'> & { metOutsideCode?: number },
): 'met' | 'not_met' | 'partly' {
  if (c.total > 0 && c.met + (c.metOutsideCode ?? 0) === c.total) return 'met';
  return c.notMet > 0 ? 'not_met' : 'partly';
}

/** The PR this one lands after, when it is stacked on an open PR — the ONE input `mergeVerdict()`'s
 *  "Lands after #N" reads. Null when there is no stack or this PR is at its bottom. */
export function landsAfterOf(stack: PrBranchStack | null | undefined): number | null {
  return stack?.parent?.number ?? null;
}

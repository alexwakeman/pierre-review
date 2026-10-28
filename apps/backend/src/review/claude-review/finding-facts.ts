// PURE FACTS ABOUT A STORED FINDING, shared by persist.ts, the verdict rule (./auto-verdict.ts) and
// the pair's consolidated view (./pair-view.ts). No imports, so any of them may read these without a
// cycle. persist.ts re-exports all three under their old names.

type IncludedFacts = { included?: boolean | null; postedAt?: unknown; priorFindingId?: number | null };

/**
 * The server's own left-out re-raise: `included: false` stored on a RE-RAISE (a `priorFindingId`)
 * of a comment already posted on this same commit (follow-up.ts `isAlreadyOnThisCommit`, written
 * by persist.ts) — an issue still OPEN, just not posted twice.
 */
export function isAlreadyPostedReraise(f: IncludedFacts): boolean {
  return f.included === false && f.postedAt == null && f.priorFindingId != null;
}

/**
 * `included = false` is TWO facts, and only one is a READER'S IGNORE — every reader of the flag
 * meaning "the reader ignored it" goes through this, never a bare `included === false`.
 */
export function isReaderIgnoredFinding(f: IncludedFacts): boolean {
  return f.included === false && !isAlreadyPostedReraise(f);
}

/**
 * A CLAUDE + CODEX PAIR'S MERGED-AWAY DUPLICATE (`claude_review_findings.merged_into`, migration
 * 0137): the other half's finding stands for it. It stays stored but is never shown, posted, counted
 * in a verdict or sent to AI Fix — every read of a run's findings leaves it out.
 */
export function isMergedAway(f: { mergedInto?: number | null }): boolean {
  return f.mergedInto != null;
}

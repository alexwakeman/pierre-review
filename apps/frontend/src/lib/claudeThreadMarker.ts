import type {
  ClaudeThreadAddressed,
  ClaudeThreadJudgementsForPr,
  ClaudeThreadValidity,
  DerivedState,
} from '@pierre-review/shared';

// WHICH PILL A THREAD CARD WEARS: its own derived state ("Likely addressed" + the confidence
// marker), or the latest Claude review's judgement in their place.
//
// The rule, in order:
//   1. A RESOLVED thread keeps "Resolved". Resolving is a fact on GitHub, not a judgement.
//   2. A thread the latest review JUDGED wears ONE Claude marker, replacing the derived-state pill
//      AND the confidence marker (the two are the heuristic's answer to the same question).
//   3. Anything else — no review, a review that did not look at threads, a thread it did not
//      judge, data still loading — keeps the derived pills. A missing judgement never makes a claim.
//
// A judgement made at an older head is still shown, marked as from an earlier commit.

export type ClaudeThreadVerdict =
  | 'addressed'
  | 'partly_addressed'
  | 'not_addressed'
  | 'not_valid'
  | 'unsure';

export interface ClaudeThreadMarker {
  verdict: ClaudeThreadVerdict;
  /** The pill's words, e.g. "Claude: addressed". */
  label: string;
  /** Judged at a head other than the PR's synced head. */
  stale: boolean;
  reviewId: number;
  finishedAt: string | null;
  assessedAtHead: string;
  validity: ClaudeThreadValidity;
  addressed: ClaudeThreadAddressed;
  explanation: string | null;
}

export type ThreadPill = { kind: 'derived' } | { kind: 'claude'; marker: ClaudeThreadMarker };

export const CLAUDE_THREAD_VERDICT_LABEL: Record<ClaudeThreadVerdict, string> = {
  addressed: 'Claude: addressed',
  partly_addressed: 'Claude: partly addressed',
  not_addressed: 'Claude: not addressed',
  not_valid: 'Claude: not valid',
  unsure: 'Claude: unsure',
};

export function claudeThreadVerdict(
  validity: ClaudeThreadValidity,
  addressed: ClaudeThreadAddressed,
): ClaudeThreadVerdict | null {
  if (validity === 'not_checked' && addressed === 'not_checked') return null;
  // A comment Claude judged wrong is not "still to fix", whatever the code did since.
  if (validity === 'not_valid') return 'not_valid';
  if (addressed === 'addressed') return 'addressed';
  if (addressed === 'partly_addressed') return 'partly_addressed';
  if (addressed === 'not_addressed') return 'not_addressed';
  return 'unsure';
}

export function threadPillFor(
  thread: { id: number; derivedState: DerivedState },
  pr: ClaudeThreadJudgementsForPr | null | undefined,
): ThreadPill {
  if (thread.derivedState === 'resolved') return { kind: 'derived' };
  if (pr == null) return { kind: 'derived' };
  const j = pr.judgements.find((x) => x.threadId === thread.id);
  if (j == null) return { kind: 'derived' };
  const verdict = claudeThreadVerdict(j.validity, j.addressed);
  if (verdict == null) return { kind: 'derived' };
  return {
    kind: 'claude',
    marker: {
      verdict,
      label: CLAUDE_THREAD_VERDICT_LABEL[verdict],
      // An unknown synced head is never "moved" (the Open PRs column's rule).
      stale: pr.currentHeadSha != null && j.assessedAtHead !== pr.currentHeadSha,
      reviewId: pr.reviewId,
      finishedAt: pr.finishedAt,
      assessedAtHead: j.assessedAtHead,
      validity: j.validity,
      addressed: j.addressed,
      explanation: j.explanation,
    },
  };
}

/**
 * The Threads tab's state chips count and filter by what the card SHOWS: a thread wearing a Claude
 * marker sits under "Claude judged", never under the derived state its card no longer displays
 * (a "Likely addressed" chip listing cards that read "Claude: not addressed" contradicts itself).
 */
export type ThreadStateBucket = DerivedState | 'claude';

export function threadStateBucket(
  thread: { id: number; derivedState: DerivedState },
  pr: ClaudeThreadJudgementsForPr | null | undefined,
): ThreadStateBucket {
  return threadPillFor(thread, pr).kind === 'claude' ? 'claude' : thread.derivedState;
}

export function threadStateBucketCounts(
  threads: ReadonlyArray<{ id: number; derivedState: DerivedState }>,
  pr: ClaudeThreadJudgementsForPr | null | undefined,
): Record<ThreadStateBucket, number> {
  const out: Record<ThreadStateBucket, number> = {
    untouched: 0,
    replied_unresolved: 0,
    likely_addressed: 0,
    resolved: 0,
    claude: 0,
  };
  for (const t of threads) out[threadStateBucket(t, pr)] += 1;
  return out;
}

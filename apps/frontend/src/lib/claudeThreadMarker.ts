import type {
  ClaudeThreadAddressed,
  ClaudeThreadJudgementsForPr,
  ClaudeThreadValidity,
  DerivedState,
} from '@pierre-review/shared';

// WHICH PILLS A THREAD WEARS: its own derived state ("Likely addressed" + the confidence marker),
// or the freshest Claude judgement (the latest Claude review, or a later Check threads run — the
// server folds the two per thread) as TWO pills in their place, plus Claude's one-line reason.
//
// THE ONE VOCABULARY. Every thread surface (ThreadCard, the Feed's collapsed thread row, search,
// the Timeline popover, the Changes tab's inline pill) prints these words and no others:
//
//   validity  Holds up · Partly · Doesn't hold · Unclear       (is the comment right?)
//   state     Resolved · Addressed · Partly addressed · Open   (where does the code stand?)
//             + "· earlier commit" when the PR's head has moved since the judgement
//
// The rule, in order:
//   1. No judgement for the thread (no run, the run did not judge it, both halves `not_checked`,
//      data still loading) keeps the derived pills. A missing judgement never makes a claim.
//   2. A judged thread wears the Claude pills, replacing the derived-state pill AND the confidence
//      marker (the two are the heuristic's answer to the same question).
//   3. "Resolved" is read off the THREAD as it is NOW (a GitHub fact, not a judgement) — so a
//      thread resolved after it was judged reads "Resolved", and one unresolved since reads the
//      judged state of its code.
//
// A judgement made at an older head is still shown, marked as from an earlier commit.

export type ClaudeValidityPill = 'holds_up' | 'partly' | 'doesnt_hold' | 'unclear';
export type ClaudeStatePill = 'resolved' | 'addressed' | 'partly_addressed' | 'open';

export const CLAUDE_VALIDITY_LABEL: Record<ClaudeValidityPill, string> = {
  holds_up: 'Holds up',
  partly: 'Partly',
  doesnt_hold: 'Doesn’t hold',
  unclear: 'Unclear',
};

export const CLAUDE_STATE_LABEL: Record<ClaudeStatePill, string> = {
  resolved: 'Resolved',
  addressed: 'Addressed',
  partly_addressed: 'Partly addressed',
  open: 'Open',
};

/** The validity pill, or null when Claude did not judge the comment itself. */
export function claudeValidityPill(v: ClaudeThreadValidity): ClaudeValidityPill | null {
  switch (v) {
    case 'valid':
      return 'holds_up';
    case 'partly_valid':
      return 'partly';
    case 'not_valid':
      return 'doesnt_hold';
    case 'unclear':
      return 'unclear';
    case 'not_checked':
      return null;
  }
}

/**
 * The state pill. `resolvedNow` is the thread's CURRENT GitHub state and always wins. null when
 * Claude did not read the code for this thread (`not_checked`): "Open" would claim a reading it
 * never made (rule 1), so only the validity pill shows.
 */
export function claudeStatePill(a: ClaudeThreadAddressed, resolvedNow: boolean): ClaudeStatePill | null {
  if (resolvedNow) return 'resolved';
  if (a === 'addressed') return 'addressed';
  if (a === 'partly_addressed') return 'partly_addressed';
  if (a === 'not_checked') return null;
  return 'open';
}

export interface ClaudeThreadMarker {
  /** null when Claude judged only the code, not the comment. */
  validity: ClaudeValidityPill | null;
  /** null when Claude judged only the comment, not the code (never both null). */
  state: ClaudeStatePill | null;
  /** Both pills as words, e.g. "Holds up · Open" — for a title or a one-line summary. */
  label: string;
  /** Judged at a head other than the PR's synced head. */
  stale: boolean;
  /** ONE line (≤ 120 chars) saying why. null on older judgements. */
  reason: string | null;
  /** The longer explanation, shown only when the reader expands the Claude row. */
  explanation: string | null;
  /** null when only a Check threads run has judged the PR's threads. */
  reviewId: number | null;
  checkId: number | null;
  finishedAt: string | null;
  assessedAtHead: string;
}

export type ThreadPill = { kind: 'derived' } | { kind: 'claude'; marker: ClaudeThreadMarker };

export function claudeMarkerLabel(m: Pick<ClaudeThreadMarker, 'validity' | 'state'>): string {
  return [
    m.validity != null ? CLAUDE_VALIDITY_LABEL[m.validity] : null,
    m.state != null ? CLAUDE_STATE_LABEL[m.state] : null,
  ]
    .filter((x): x is string => x != null)
    .join(' · ');
}

export function threadPillFor(
  thread: { id: number; derivedState: DerivedState },
  pr: ClaudeThreadJudgementsForPr | null | undefined,
): ThreadPill {
  if (pr == null) return { kind: 'derived' };
  const j = pr.judgements.find((x) => x.threadId === thread.id);
  if (j == null) return { kind: 'derived' };
  if (j.validity === 'not_checked' && j.addressed === 'not_checked') return { kind: 'derived' };
  const validity = claudeValidityPill(j.validity);
  const state = claudeStatePill(j.addressed, thread.derivedState === 'resolved');
  return {
    kind: 'claude',
    marker: {
      validity,
      state,
      label: claudeMarkerLabel({ validity, state }),
      // An unknown synced head is never "moved" (the Open PRs column's rule).
      stale: pr.currentHeadSha != null && j.assessedAtHead !== pr.currentHeadSha,
      reason: j.reason?.trim() ? j.reason.trim() : null,
      explanation: j.explanation,
      reviewId: pr.reviewId,
      checkId: pr.checkId,
      finishedAt: pr.finishedAt,
      assessedAtHead: j.assessedAtHead,
    },
  };
}

/**
 * The Threads tab's state chips count and filter by what the card SHOWS: an UNRESOLVED thread
 * wearing Claude pills sits under "Claude judged", never under the derived state its card no longer
 * displays. A resolved thread stays under "Resolved" — its state pill still says so.
 */
export type ThreadStateBucket = DerivedState | 'claude';

export function threadStateBucket(
  thread: { id: number; derivedState: DerivedState },
  pr: ClaudeThreadJudgementsForPr | null | undefined,
): ThreadStateBucket {
  if (thread.derivedState === 'resolved') return 'resolved';
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

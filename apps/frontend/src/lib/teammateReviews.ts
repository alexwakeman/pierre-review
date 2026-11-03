// TEAMMATES' POSTED REVIEWS on the AI Review tab (docs/CLAUDE-REVIEW.md § Teammates' reviews): the
// words, pure, so they can be tested. The card is components/TeammateReviews.tsx.
import { aiRunLabel, PAIR_RUN_LABEL, type ClaudeFollowUpItemRecord, type ClaudeReviewFollowUpRecord, type ClaudeTeammateReview } from '@pierre-review/shared';

/** "Robin's review" — the teammate's first name when GitHub has one, else "@robin-dev's review". */
export function teammateReviewTitle(r: Pick<ClaudeTeammateReview, 'poster'>): string {
  const first = r.poster.displayName?.trim().split(/\s+/)[0];
  return `${first ? first : `@${r.poster.login}`}’s review`;
}

/** What ran it: "Claude + Codex", or the ONE run label ("Claude · Opus 5.5 · medium"); null when the
 *  post carried no metadata (a legacy post). */
export function teammateRunLabel(r: Pick<ClaudeTeammateReview, 'pair' | 'runs'>): string | null {
  if (r.pair) return PAIR_RUN_LABEL;
  const run = r.runs[0];
  if (run == null || run.model == null) return null;
  return aiRunLabel(run.provider, run.model, run.effort);
}

/** The meta line: "Posted on GitHub · abc1234 · Auto review · Claude · Opus 5.5". */
export function teammateReviewMeta(r: Pick<ClaudeTeammateReview, 'headSha' | 'run' | 'pair' | 'runs'>): string {
  const parts = ['Posted on GitHub', r.headSha.slice(0, 7)];
  if (r.run === 'auto') parts.push('Auto review');
  const label = teammateRunLabel(r);
  if (label != null) parts.push(label);
  return parts.join(' · ');
}

/**
 * The follow-up section's heading: "Previous review", or — when the previous review was the PR
 * author's own Limn review (docs/CLAUDE-REVIEW.md § The author's own review) — "@carol-dev’s review".
 */
export function followUpSectionTitle(f: Pick<ClaudeReviewFollowUpRecord, 'teammate'> | null | undefined): string {
  const login = f?.teammate?.login;
  return login ? `@${login}’s review` : 'Previous review';
}

/** Limn writes on a follow-up's threads (Post reply, Resolve) only when they are the reader's own. */
export function followUpThreadsWritable(f: Pick<ClaudeReviewFollowUpRecord, 'teammate'> | null | undefined): boolean {
  return f?.teammate == null;
}

/**
 * The same rule PER ITEM. In a follow-up anchored on the PR author's review, the author's findings
 * are the previous review's own (`carried: false`) and the reader's own earlier findings are merged
 * in as CARRIED (`mergeAuthorAnchor`): those threads are still the reader's, so they keep their
 * Post reply / Resolve.
 */
export function followUpItemWritable(
  f: Pick<ClaudeReviewFollowUpRecord, 'teammate'> | null | undefined,
  item: Pick<ClaudeFollowUpItemRecord, 'carried'>,
): boolean {
  return followUpThreadsWritable(f) || item.carried === true;
}

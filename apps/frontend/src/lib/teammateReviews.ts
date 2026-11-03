// TEAMMATES' POSTED REVIEWS on the AI Review tab (docs/CLAUDE-REVIEW.md § Teammates' reviews): the
// words, pure, so they can be tested. The pieces are components/TeammateReviews.tsx.
import { aiRunLabel, PAIR_RUN_LABEL, type ClaudeFollowUpItemRecord, type ClaudeReviewFollowUpRecord, type ClaudeTeammatePoster, type ClaudeTeammateReview, type ClaudeTeamReviewCount, type ClaudeTeamReviewView } from '@pierre-review/shared';

/** A teammate's name as the tab shows it: the first name when GitHub has one, else "@robin-dev". */
export function teammateName(p: Pick<ClaudeTeammatePoster, 'login' | 'displayName'>): string {
  const first = p.displayName?.trim().split(/\s+/)[0];
  return first ? first : `@${p.login}`;
}

/** "Robin", "Robin and Sam", "Robin, Sam and Kai". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who raised a teammate finding in the one findings list: "Robin", "Robin and Sam". */
export function teamFindingByLabel(by: readonly Pick<ClaudeTeammatePoster, 'login' | 'displayName'>[]): string {
  return joinNames(by.map(teammateName));
}

/** One of the reader's findings a teammate raised too: "You and Robin". */
export function alsoRaisedLabel(by: readonly Pick<ClaudeTeammatePoster, 'login' | 'displayName'>[]): string {
  return joinNames(['You', ...by.map(teammateName)]);
}

/** "Robin's review" — the teammate's first name when GitHub has one, else "@robin-dev's review". */
export function teammateReviewTitle(r: Pick<ClaudeTeammateReview, 'poster'>): string {
  return `${teammateName(r.poster)}’s review`;
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

/** The teammate review that heads the tab (the newest review is theirs), or null. */
export function leadingTeammateReview(
  view: Pick<ClaudeTeamReviewView, 'lead' | 'teammateReviewId'> | null | undefined,
  reviews: readonly ClaudeTeammateReview[] | null | undefined,
): ClaudeTeammateReview | null {
  if (view?.lead !== 'teammate' || view.teammateReviewId == null) return null;
  return reviews?.find((r) => r.reviewId === view.teammateReviewId) ?? null;
}

/** The reader's findings a teammate raised too: finding id → the teammates. */
export function alsoRaisedByFinding(
  view: Pick<ClaudeTeamReviewView, 'alsoRaisedBy'> | null | undefined,
): ReadonlyMap<number, readonly ClaudeTeammatePoster[]> {
  return new Map((view?.alsoRaisedBy ?? []).map((a) => [a.findingId, a.by]));
}

/**
 * THE REVIEW COUNT line (the server's `teamView.reviewCount`, full reviews only): "4 Limn reviews so
 * far · 1 by Robin", "1 Limn review so far". null when none has run (or an older server).
 */
export function reviewCountLine(count: ClaudeTeamReviewCount | null | undefined): string | null {
  if (count == null || count.total <= 0) return null;
  const head = `${count.total} Limn ${count.total === 1 ? 'review' : 'reviews'} so far`;
  if (count.byTeammate.length === 0) return head;
  return [head, count.byTeammate.map((t) => `${t.count} by ${teammateName(t.poster)}`).join(', ')].join(' · ');
}

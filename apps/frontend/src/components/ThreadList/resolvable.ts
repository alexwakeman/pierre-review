import type { ReviewBotKind, ReviewerRole, ThreadDetail, User } from '@pierre-review/shared';
import { reviewBotKind } from '@pierre-review/shared';

/** Which review vendor (if any) opened a thread — by its originating commenter's login. */
export function threadBotKind(
  t: ThreadDetail,
  usersById: Map<number, User>,
): ReviewBotKind | null {
  const authorId = threadAuthorId(t);
  if (authorId == null) return null;
  return reviewBotKind(usersById.get(authorId)?.githubLogin);
}

/** Who opened the thread — the same anchor the server matches on (originalCommenterId). */
export function threadAuthorId(t: ThreadDetail): number | null {
  return t.originalCommenterId ?? t.comments[0]?.authorId ?? null;
}

/** The one thing this module needs off a DetectedReviewer's classification. */
export interface ReviewerRoleInfo {
  automated: boolean;
  role: ReviewerRole;
}

/**
 * The threads the per-PR bulk resolve may OFFER — i.e. the ones
 * `POST /api/prs/:id/resolve-bot-threads` will actually accept.
 *
 * The button states a count and then asks the user to confirm resolving exactly that many
 * threads on GitHub, so this predicate has to agree with the server's. The server re-derives
 * eligibility from the `repo_reviewers` judgement rows for the PR's OWN repo, NOT from the
 * vendor login — so a login the user has marked "quality check" (SonarQube-style; and three
 * REVIEW_BOTS vendors are deliberately left user-flippable) or "not a bot" THERE is silently
 * dropped. Classifying here by login alone offered a count the server then refused, and the
 * result banner only renders when something was resolved, so the confirm collapsed and the
 * button re-rendered with the SAME count: a dead control with no explanation.
 *
 * `classification` must therefore be built from the rows of THIS PR'S REPO — a bot is a per-repo
 * object, and another repo's judgement is a different answer to a different question (see the
 * caller in ThreadList/index.tsx). A user with NO row for that repo is left in: the vendor-login
 * test is the server's own fallback for exactly that case, and excluding on absent data would
 * hide threads the resolve would have accepted. `null` = no listing / no repo in hand; same
 * reasoning.
 */
export function resolvableBotThreadIds(
  threads: readonly ThreadDetail[],
  usersById: Map<number, User>,
  botFilter: ReviewBotKind | null,
  classification: Map<number, ReviewerRoleInfo> | null,
): number[] {
  const out: number[] = [];
  for (const t of threads) {
    if (t.isResolved || t.derivedState !== 'likely_addressed') continue;
    const kind = threadBotKind(t, usersById);
    if (kind == null) continue;
    if (botFilter != null && kind !== botFilter) continue;
    const authorId = threadAuthorId(t);
    const cls = authorId != null ? classification?.get(authorId) : undefined;
    if (cls != null && (!cls.automated || cls.role !== 'review')) continue;
    out.push(t.id);
  }
  return out;
}

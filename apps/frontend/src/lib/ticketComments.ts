// THE STORY VIEW'S COMMENTS — the pure half of `StoryComments` (components/TicketComments.tsx;
// docs/FRONTEND.md § The story view → Comments). The people's comments ride the story view's stored
// read (`GET /api/ticket-story` `comments`, oldest first, bots already left out by the server).
import type { TicketComment } from '@pierre-review/shared';

/** Comments shown before "Show all n" — the newest ones. */
export const STORY_COMMENTS_SHOWN = 3;

/** The comments drawn, in the stored order (oldest first): every one when `all`, else the newest
 *  `shown`. A citation of an older one opens the list in full first (`citedIsHidden`). */
export function shownStoryComments(
  comments: readonly TicketComment[],
  all: boolean,
  shown: number = STORY_COMMENTS_SHOWN,
): readonly TicketComment[] {
  if (all || comments.length <= shown) return comments;
  return comments.slice(comments.length - shown);
}

/** Is the cited comment hidden while the list is collapsed? (Then the list opens in full.) */
export function citedIsHidden(comments: readonly TicketComment[], commentId: string, shown: number = STORY_COMMENTS_SHOWN): boolean {
  const i = comments.findIndex((c) => c.id === commentId);
  return i >= 0 && i < comments.length - shown;
}

/**
 * The ids of comments written after the latest story check — "New since the check". Only when the
 * check's state says it missed some (`newComments > 0`, the server's count against what the run saw)
 * and it has a finish time; then the comments created after `checkedAt`. Empty otherwise (never
 * checked, or the check saw them all).
 */
export function newSinceCheckIds(
  comments: readonly TicketComment[],
  state: { checkedAt: string | null; newComments?: number } | null | undefined,
): ReadonlySet<string> {
  if (state == null || state.checkedAt == null || (state.newComments ?? 0) <= 0) return new Set();
  const at = Date.parse(state.checkedAt);
  if (!Number.isFinite(at)) return new Set();
  return new Set(comments.filter((c) => Date.parse(c.createdAt) > at).map((c) => c.id));
}

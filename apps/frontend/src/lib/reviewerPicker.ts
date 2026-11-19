import type { AskablePerson } from '@pierre-review/shared';
import { orderMentionSuggestions } from '../components/MentionTextarea.js';

// THE "SOMEONE ELSE" PICKER — the pure half (components/ReviewerPicker.tsx; docs/FRONTEND.md § The
// "Someone else" picker). Pinned by test/reviewerPicker.test.ts.

/** GitHub's ceiling on the people a PR can have requested at once. Enforced here, in the client; the
 *  server passes GitHub's own refusal through if it is ever reached. */
export const REVIEW_REQUEST_LIMIT = 15;

/** How many MORE people the reader may pick: the ceiling, less who is already requested and who is
 *  already on a chip. Never negative. */
export function pickRoom(requestedCount: number, pickedCount: number): number {
  return Math.max(0, REVIEW_REQUEST_LIMIT - requestedCount - pickedCount);
}

/** The dropdown: everyone not already picked who matches what is typed, in the server's order
 *  (mergers first), through the ONE people matcher. */
export function pickerOptions(
  people: readonly AskablePerson[],
  pickedIds: ReadonlySet<number>,
  query: string,
): AskablePerson[] {
  return orderMentionSuggestions(
    people.filter((p) => !pickedIds.has(p.id)),
    query.trim().replace(/^@/, ''),
  );
}

/** One chip's request: its own mutation key, so one refusal never sinks the others and its state
 *  survives a remount. */
export function pickKey(login: string): string {
  return `pick:${login.toLowerCase()}`;
}

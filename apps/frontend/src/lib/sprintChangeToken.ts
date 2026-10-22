// THE "SPRINT HAS CHANGED" RULE (This Sprint's auto-refresh: SprintView re-fetches the board when it
// holds). Pure, so it is pinned by
// test/sprintChangeToken.test.ts; `useSprintChangeToken` is its only caller.
//
// True only when ALL of these hold:
//   • both tokens are real strings (an older server's catch-all answers `{}`: never suggests anything);
//   • the token was read AFTER the graph on screen was loaded (a token older than a refetched graph,
//     e.g. right after the reader's own Refresh, describes a board that is no longer there);
//   • the graph is not being refetched right now (its answer is about to replace the board, so the
//     refetch is already on its way — never a second one);
//   • the two differ.

export interface SprintTokenInput {
  /** The token the loaded graph carried. */
  seed: string | undefined;
  /** The latest polled token. */
  token: string | undefined;
  tokenUpdatedAt: number;
  graphUpdatedAt: number;
  graphFetching: boolean;
}

export function sprintTokenChanged(i: SprintTokenInput): boolean {
  if (typeof i.seed !== 'string' || typeof i.token !== 'string') return false;
  if (i.graphFetching) return false;
  if (i.tokenUpdatedAt <= i.graphUpdatedAt) return false;
  return i.token !== i.seed;
}

/**
 * Should SprintView re-fetch the board now? At most ONCE PER OBSERVED TOKEN: `lastActedAt` is the
 * `tokenUpdatedAt` the previous automatic re-fetch was issued for. A FAILED re-fetch leaves the
 * graph's `dataUpdatedAt` old, so `changed` comes back true the moment it settles — without this it
 * re-fired every second or two for as long as the endpoint failed. Now it waits for the next poll.
 */
export function sprintShouldAutoRefetch(i: { changed: boolean; tokenUpdatedAt: number; lastActedAt: number | null }): boolean {
  return i.changed && i.lastActedAt !== i.tokenUpdatedAt;
}

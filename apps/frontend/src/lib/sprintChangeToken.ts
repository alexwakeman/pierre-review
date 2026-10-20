// THE "SPRINT HAS CHANGED" RULE (This Sprint, the quiet Refresh line). Pure, so it is pinned by
// test/sprintChangeToken.test.ts; `useSprintChangeToken` is its only caller.
//
// True only when ALL of these hold:
//   • both tokens are real strings (an older server's catch-all answers `{}`: never suggests anything);
//   • the token was read AFTER the graph on screen was loaded (a token older than a refetched graph,
//     e.g. right after the reader's own Refresh, describes a board that is no longer there);
//   • the graph is not being refetched right now (its answer is about to replace the board, so the
//     line would flash and vanish on its own);
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

// The onboarding's one line about first-sync time. The first sync runs every chosen repo's recent
// PRs first and their 90 days of history after (docs/SYNC.md § Breadth-first first sync), so a
// long list still fills the board early — but the whole sync takes longer, and past this many
// repos that is worth one plain sentence. The choice stays the user's: nothing is unchecked.

/** More than this many chosen repos shows the note. */
export const MANY_REPOS_FOR_FIRST_SYNC = 10;

export function firstSyncNote(chosenCount: number): string | null {
  return chosenCount > MANY_REPOS_FOR_FIRST_SYNC
    ? 'The first sync will take longer with this many repositories.'
    : null;
}

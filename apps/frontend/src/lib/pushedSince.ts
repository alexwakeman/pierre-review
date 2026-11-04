import type { MyLastAction, PushedCommit } from '@pierre-review/shared';

// The words of a "Pushed since" My Turn card's disclosure (AttentionCards.tsx `PushedSinceCommits`).
// The anchor is the reader's last ACTION on the PR — a review (any state), a comment or a push of
// their own (backend `lastActionClocks`). Viewing is never an action, so the words never say
// "since you last looked".

const SINCE: Record<MyLastAction, string> = {
  approved: 'since you approved',
  changes_requested: 'since you requested changes',
  reviewed: 'since you last reviewed',
  commented: 'since you last commented',
  pushed: 'since you last pushed',
};

/** "since you approved" — the anchor in words; an older response with no action named falls back
 *  to the rule itself. */
export function pushedSinceAnchor(lastAction: MyLastAction | null | undefined): string {
  return lastAction != null ? SINCE[lastAction] : 'since your last review or comment';
}

/** "3 commits since you last reviewed" — the disclosure's label. */
export function pushedSinceLabel(count: number, lastAction: MyLastAction | null | undefined): string {
  return `${count} commit${count === 1 ? '' : 's'} ${pushedSinceAnchor(lastAction)}`;
}

/** What the open disclosure lists, and how many it cannot: the full list once fetched, else the
 *  newest few the card carried inline. `more` is always `total − listed`, so the count and the list
 *  agree ("and N more"). */
export function pushedSinceRows(
  inline: readonly PushedCommit[],
  inlineTotal: number,
  fetched: { total: number; commits: readonly PushedCommit[] } | null | undefined,
): { commits: readonly PushedCommit[]; total: number; more: number } {
  const commits = fetched?.commits ?? inline;
  const total = fetched?.total ?? Math.max(inlineTotal, inline.length);
  return { commits, total, more: Math.max(0, total - commits.length) };
}

/** The line under the list: "Loading the rest…" only while the fetch can still add a commit (the
 *  card's inline list is not already all of them), else "and N more" when some stay unlisted. */
export function pushedSinceTail(rows: { more: number }, loading: boolean): string | null {
  if (rows.more <= 0) return null;
  return loading ? 'Loading the rest…' : `and ${rows.more} more`;
}

/** A commit on GitHub, under its PR (`<pr url>/commits/<sha>`); null for an unusable sha. */
export function pushedCommitHref(prUrl: string | null | undefined, sha: string): string | null {
  if (prUrl == null || prUrl === '' || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  return `${prUrl.replace(/\/+$/, '')}/commits/${sha}`;
}

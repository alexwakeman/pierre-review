import {
  HOTFIX_PORT_FILES_WORDS,
  HOTFIX_PORT_FLAG_WORDS,
  hotfixPortLine,
  type StoryBuildHotfixBase,
  type StoryBuildHotfixBranch,
  type StoryBuildRepo,
} from '@pierre-review/shared';

// HOTFIX BUILDS in the build tab (docs/STORY-BUILD.md § Hotfix builds; docs/RELEASES.md § Hotfix). Pure words:
// the Start panel's base list, the two diffs' labels, the moved-branch line and the push button.

/** "12 Nov" (the tagged commit's day, local time); null when unknown. */
export function hotfixDayWords(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** One base line of the Start panel: "from v2.4.0-rc (12 Nov) → PRs into hotfix/v2.4.0-rc and main",
 *  "not released from this workspace — read only" or "no release yet — read only". The repository's name
 *  is shown beside it. */
export function hotfixBaseLine(b: Pick<StoryBuildHotfixBase, 'release' | 'hotfixBranch' | 'defaultBranch'> & { releasable?: boolean }): string {
  if (b.releasable === false) return 'not released from this workspace — read only';
  if (b.release == null || b.hotfixBranch == null) return 'no release yet — read only';
  const day = hotfixDayWords(b.release.committedAt);
  return `from ${b.release.tagName}${day != null ? ` (${day})` : ''} → PRs into ${b.hotfixBranch} and ${b.defaultBranch ?? 'the default branch'}`;
}

/** The two diffs of one repository. */
export const HOTFIX_DIFF_LABEL = { release: 'Release fix', main: 'Main fix' } as const;

/** The diffs a hotfix repository card offers, in order (only those with a stored change). */
export function hotfixDiffTargets(r: Pick<StoryBuildRepo, 'hasPatch' | 'hotfix'>): Array<'release' | 'main'> {
  if (r.hotfix == null) return r.hasPatch ? ['release'] : [];
  return [...(r.hasPatch ? (['release'] as const) : []), ...(r.hotfix.mainHasPatch ? (['main'] as const) : [])];
}

/** The line under a repository whose `hotfix/<tag>` already existed when Push ran: moved past the
 *  release commit, or still at it with pull requests already open on it (an earlier hotfix off the
 *  same release). Names those pull requests. Null when the branch was made by this push, or was there
 *  untouched with nothing open on it. */
export function hotfixMovedLine(branch: StoryBuildHotfixBranch | null | undefined): string | null {
  if (branch == null || branch.created) return null;
  const shown = branch.prs.slice(0, 5).map((p) => `#${p.number}${p.title ? ` ${p.title}` : ''}`);
  const more = branch.prs.length > shown.length ? ` and ${branch.prs.length - shown.length} more` : '';
  const already = `Already on it: ${shown.join(', ')}${more}.`;
  if (branch.movedToSha == null) {
    return branch.prs.length === 0 ? null : `${branch.name} already exists. ${already}`;
  }
  const head = `${branch.name} has moved past the release, so your pull request targets the branch as it is now.`;
  if (branch.prs.length === 0) return `${head} No other pull request is open on it.`;
  return `${head} ${already}`;
}

/** The push button of a hotfix repository: both pull requests at once, or the one left. */
export function hotfixPushWords(r: Pick<StoryBuildRepo, 'hasPatch' | 'pushedPrNumber' | 'hotfix'>, draft: boolean): string {
  const release = r.hasPatch && r.pushedPrNumber == null;
  const main = r.hotfix?.mainHasPatch === true && r.hotfix.mainPushedPrNumber == null;
  if (release && main) return draft ? 'Push both as drafts' : 'Push both';
  return draft ? 'Push as draft' : 'Push';
}

/** THE PORT REPORT of one hotfix repository card (docs/STORY-BUILD.md § Hotfix builds → The port report): the
 *  agent's outcome line ("Applied to both", "Applied to both, adapted for main — <reason>", "Not applied to
 *  main — <reason>", or "No report from the agent"), the contradiction flag, the files compared. Null on a
 *  read-only repository and on one with neither a change nor a claim. */
export function hotfixPortView(
  r: Pick<StoryBuildRepo, 'hasPatch' | 'hotfix'>,
): { line: string; outcome: 'same' | 'adapted' | 'not_needed' | null; flag: string | null; files: string | null } | null {
  const hf = r.hotfix;
  if (hf == null || hf.readOnly || hf.port == null) return null;
  const p = hf.port;
  if (p.claim == null && !r.hasPatch && !hf.mainHasPatch) return null;
  return {
    line: hotfixPortLine(p.claim),
    outcome: p.claim?.outcome ?? null,
    flag: p.flag != null ? HOTFIX_PORT_FLAG_WORDS[p.flag] : null,
    files: p.files != null ? HOTFIX_PORT_FILES_WORDS[p.files] : null,
  };
}

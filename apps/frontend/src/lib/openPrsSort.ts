import type { ClaudeReviewPrState, TimelinePr, User } from '@pierre-review/shared';
import { userLabel } from './ui.js';
import { findingsRank, reviewCellFor, reviewCellRank } from './claudeReviewColumn.js';

// The Open PRs cards' sort orders. The list has no column headings any more, so every order is
// picked from ONE "Sort" menu in the tab's header: a key, plus a direction the reader can reverse.
// `null` is the default — `sortOpenPrsByActivity`, the order the inline open-PR lists use.
//
// Each key has a "natural" first direction (the most pressing end first) and plain words for both
// directions, so the menu's trigger always says the order on screen ("Opened, oldest first").

export type OpenPrsSortKey =
  | 'pr'
  | 'repo'
  | 'author'
  | 'age'
  | 'updated'
  | 'loc'
  | 'threads'
  | 'ci'
  | 'approval'
  | 'claude'
  | 'findings';

export type OpenPrsSortDir = 'asc' | 'desc';

export interface OpenPrsSort {
  key: OpenPrsSortKey;
  dir: OpenPrsSortDir;
}

export interface OpenPrsSortOption {
  key: OpenPrsSortKey;
  /** The menu row's name. */
  name: string;
  /** The direction a pick lands on. */
  natural: OpenPrsSortDir;
  /** The words for each direction, after the name. */
  words: Record<OpenPrsSortDir, string>;
  /** Only where Claude Review runs (`me.ai.enabled`). */
  claude?: true;
}

export const OPEN_PRS_SORT_OPTIONS: readonly OpenPrsSortOption[] = [
  { key: 'updated', name: 'Updated', natural: 'desc', words: { desc: 'latest first', asc: 'earliest first' } },
  { key: 'age', name: 'Opened', natural: 'asc', words: { asc: 'oldest first', desc: 'newest first' } },
  { key: 'loc', name: 'Size', natural: 'desc', words: { desc: 'largest first', asc: 'smallest first' } },
  { key: 'threads', name: 'Untouched threads', natural: 'desc', words: { desc: 'most first', asc: 'fewest first' } },
  { key: 'ci', name: 'CI', natural: 'asc', words: { asc: 'failing first', desc: 'failing last' } },
  { key: 'approval', name: 'Approval', natural: 'asc', words: { asc: 'changes requested first', desc: 'approved first' } },
  { key: 'claude', name: 'Claude review', natural: 'asc', words: { asc: 'not reviewed first', desc: 'reviewed first' }, claude: true },
  { key: 'findings', name: 'Claude findings', natural: 'desc', words: { desc: 'most severe first', asc: 'least severe first' }, claude: true },
  { key: 'repo', name: 'Repo', natural: 'asc', words: { asc: 'A to Z', desc: 'Z to A' } },
  { key: 'author', name: 'Author', natural: 'asc', words: { asc: 'A to Z', desc: 'Z to A' } },
  { key: 'pr', name: 'PR number', natural: 'desc', words: { desc: 'highest first', asc: 'lowest first' } },
];

/** The default order's name (no key picked). */
export const DEFAULT_SORT_LABEL = 'Recent activity';

export function sortOption(key: OpenPrsSortKey): OpenPrsSortOption {
  return OPEN_PRS_SORT_OPTIONS.find((o) => o.key === key)!;
}

/** The menu rows to offer: the Claude keys only where Claude Review runs. */
export function sortOptionsFor(claudeOn: boolean): OpenPrsSortOption[] {
  return OPEN_PRS_SORT_OPTIONS.filter((o) => claudeOn || o.claude !== true);
}

/** The words on the trigger: "Recent activity", or "Opened, oldest first". */
export function sortLabel(sort: OpenPrsSort | null): string {
  if (sort == null) return DEFAULT_SORT_LABEL;
  const o = sortOption(sort.key);
  return `${o.name}, ${o.words[sort.dir]}`;
}

/** Picking a key lands on its natural direction; the reverse button flips it. */
export function pickSort(key: OpenPrsSortKey): OpenPrsSort {
  return { key, dir: sortOption(key).natural };
}

export function reverseSort(sort: OpenPrsSort): OpenPrsSort {
  return { key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
}

/** A Claude key once Claude Review is off reads as the default order (no stale sort on data the
 *  page no longer draws). */
export function effectiveSort(sort: OpenPrsSort | null, claudeOn: boolean): OpenPrsSort | null {
  if (sort == null) return null;
  return !claudeOn && sortOption(sort.key).claude === true ? null : sort;
}

// CI rollup → a rank (failing first under 'asc').
const CI_RANK: Record<TimelinePr['ciStatus'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  expected: 3,
  unknown: 4,
};

// Approval standing → a rank (changes-requested first under 'asc').
function approvalRank(pr: TimelinePr): number {
  if (pr.isChangesRequested) return 0;
  if (pr.isApproved) return 2;
  return 1;
}

export interface SortContext {
  usersById: Map<number, User>;
  repoNameById: Map<number, string>;
  claudeStates: Map<number, ClaudeReviewPrState>;
}

/** One PR's value for a key. ISO-8601 timestamps sort chronologically as strings. */
export function sortValue(pr: TimelinePr, key: OpenPrsSortKey, ctx: SortContext): number | string {
  switch (key) {
    case 'pr':
      return pr.number;
    case 'repo':
      return ctx.repoNameById.get(pr.repoId) ?? '';
    case 'author': {
      // What the card SHOWS — userLabel's display-name-then-login answer, not the raw login.
      const u = pr.authorId != null ? ctx.usersById.get(pr.authorId) : undefined;
      return userLabel(u, pr.authorId).toLowerCase();
    }
    case 'age':
      return pr.openedAt;
    case 'updated':
      return pr.updatedAt;
    case 'loc':
      return pr.additions + pr.deletions;
    case 'threads':
      return pr.threadCounts.untouched;
    case 'ci':
      return CI_RANK[pr.ciStatus];
    case 'approval':
      return approvalRank(pr);
    case 'claude':
      // The stored state, not a click in flight (a sort must not jump under the cursor).
      return reviewCellRank(reviewCellFor(ctx.claudeStates.get(pr.id), false));
    case 'findings':
      return findingsRank(ctx.claudeStates.get(pr.id));
  }
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return (a as number) - (b as number);
}

/** The cards in `sort` order, the PR number (highest first) breaking ties. */
export function sortOpenPrs(prs: readonly TimelinePr[], sort: OpenPrsSort, ctx: SortContext): TimelinePr[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...prs].sort(
    (a, b) => mul * compare(sortValue(a, sort.key, ctx), sortValue(b, sort.key, ctx)) || b.number - a.number,
  );
}

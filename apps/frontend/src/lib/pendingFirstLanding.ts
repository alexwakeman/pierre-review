// PENDING ON THE FIRST LANDING — the pure halves (docs/FRONTEND.md § Pending on the first landing).
//
// Everything here reads the board response the page already holds (`GET /api/attention`); nothing
// fetches. The components are in Activity/PendingFirstLanding.tsx.
import { pendingTabIsReference } from '@pierre-review/shared';
import type {
  MergeVerdictInfo,
  PendingAuthorLens,
  PendingOwnPr,
  PendingTab,
  PendingTabKey,
} from '@pierre-review/shared';
import { mergeVerdict } from './ui.js';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Each tab's phrase in the summary line — the figure is the tab's own badge count. */
const SUMMARY_PHRASE: Record<PendingTabKey, (n: number) => string> = {
  my_turn: (n) => `${n} waiting on you`,
  claude: (n) => `${n} new AI ${plural(n, 'review', 'reviews')}`,
  fixing: (n) => `${n} to fix`,
  review: (n) => `${n} waiting on review`,
  threads: (n) => `${n} unanswered ${plural(n, 'thread', 'threads')}`,
  land: (n) => `${n} ready to land`,
  deps: (n) => `${n} dependency ${plural(n, 'update', 'updates')}`,
  waiting: (n) => `${n} of yours waiting on others`,
};

export interface PendingSummaryPart {
  tab: PendingTabKey;
  count: number;
  text: string;
}

/**
 * THE FIGURE ON A TAB'S BADGE — ONE rule for the tab strip and the summary line: the tab's `total`,
 * or under the People / Automation lens that side's own count. "AI reviews" (`newTotal` set) is a
 * stable reference list, so its badge is the rows NEW since the last look — never the list's length
 * (its rows are all opened by people, so the Automation side is 0).
 */
export function pendingTabBadge(tab: PendingTab, lens: PendingAuthorLens | null): number {
  if (tab.newTotal != null) return lens === 'automation' ? 0 : tab.newTotal;
  return lens != null && tab.authorTotals != null ? tab.authorTotals[lens] : tab.total;
}

/**
 * THE ONE-LINE SUMMARY: one part per tab that holds anything, in tab order. Each figure is EXACTLY
 * the tab's badge (`pendingTabBadge`), so a part and the tab it links to can never disagree. Empty
 * when every tab is empty.
 */
export function pendingSummaryParts(
  tabs: readonly PendingTab[],
  lens: PendingAuthorLens | null,
): PendingSummaryPart[] {
  const out: PendingSummaryPart[] = [];
  for (const t of tabs) {
    const count = pendingTabBadge(t, lens);
    if (count > 0) out.push({ tab: t.key, count, text: SUMMARY_PHRASE[t.key](count) });
  }
  return out;
}

/** Every tab is empty — the board's own totals, never the listed cards. The read-only tabs
 *  (`pendingTabIsReference`: "Waiting on others", "AI reviews") are not asked: they are information. */
export function pendingBoardEmpty(tabs: readonly PendingTab[]): boolean {
  return (
    tabs.length > 0 &&
    tabs.every((t) => t.total === 0 || pendingTabIsReference(t.key))
  );
}

/**
 * WHERE ONE OF THE READER'S PRS STANDS — the PLAIN `mergeVerdict()` over the synced fields the board
 * sent: its label ("blocked", "checks failing", "behind base", "conflicts", "ready to merge", …) and
 * its own detail. ⚠ NO `blockFacts`: the ranked `blockers[]` are derived for PR DETAIL ONLY
 * (CLAUDE.md § Merge), so a `blocked` PR reads "blocked" here and its title opens the PR, where they
 * are. `lines` is what the row prints after the label.
 */
export function ownPrVerdict(pr: PendingOwnPr): { verdict: MergeVerdictInfo; lines: string[] } {
  const verdict = mergeVerdict({
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    inMergeQueue: pr.inMergeQueue,
  });
  return { verdict, lines: verdict.detail != null ? [verdict.detail] : [] };
}

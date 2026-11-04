import type { DependencyAutomationLogItem } from '@pierre-review/shared';

// The words of Pending → Dependencies' "What automation did" rows (DependencyAutomationLog.tsx).
// "Merged" is a LANDED merge only (`merge_landed`, written from the watcher's outcome); arming is
// "Armed to merge". A teammate's Limn holding the PR is a skip, never a failure.

type Item = DependencyAutomationLogItem;

const VERB: Record<Item['action'], Record<Item['state'], string>> = {
  approve: { done: 'Approved', failed: 'Couldn’t approve', running: 'Approving', skipped: 'Skipped approval' },
  rebase_request: {
    done: 'Asked to rebase',
    failed: 'Couldn’t ask to rebase',
    running: 'Asking to rebase',
    skipped: 'Skipped rebase request',
  },
  ai_resolve: {
    done: 'Resolved conflicts',
    failed: 'Couldn’t resolve conflicts',
    running: 'Resolving conflicts',
    skipped: 'Skipped conflicts',
  },
  ai_fix: { done: 'Fixed CI with AI', failed: 'Couldn’t fix CI', running: 'Fixing CI with AI', skipped: 'Skipped AI fix' },
  arm_merge: { done: 'Armed to merge', failed: 'Couldn’t arm', running: 'Arming', skipped: 'Skipped merge' },
  merge_landed: { done: 'Merged', failed: 'Merge failed', running: 'Merging', skipped: 'Skipped merge' },
};

/** The row's one line of detail: the teammate holding it, else the stored sentence. */
export function automationDetail(i: Item): string | null {
  if (i.state === 'skipped' && i.teammate) {
    const who = i.teammate.name?.trim() || i.teammate.login;
    return i.teammate.handled ? `${who} handled this` : `${who} is handling this`;
  }
  return i.detail;
}

export function automationVerb(i: Item): string {
  return VERB[i.action]?.[i.state] ?? i.action;
}


/** One PR in "What automation did": the PR once, its actions under it. */
export interface AutomationPrGroup {
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  /** Newest first. */
  items: Item[];
}

const atMs = (i: Item): number => {
  const t = Date.parse(i.at);
  return Number.isFinite(t) ? t : 0;
};

/** Groups the log by PR so no PR repeats: each PR's actions newest first, the PRs ordered by their
 *  newest action (ties by the higher row id, the later write). Never drops a row. */
export function groupAutomationByPr(items: readonly Item[]): AutomationPrGroup[] {
  const newestFirst = (a: Item, b: Item): number => atMs(b) - atMs(a) || b.id - a.id;
  const byPr = new Map<number, AutomationPrGroup>();
  for (const i of [...items].sort(newestFirst)) {
    let g = byPr.get(i.prId);
    if (!g) {
      g = { prId: i.prId, repoFullName: i.repoFullName, prNumber: i.prNumber, prTitle: i.prTitle, items: [] };
      byPr.set(i.prId, g);
    }
    g.items.push(i);
  }
  // Map insertion order follows the sorted rows, so the groups are already ordered by newest action.
  return [...byPr.values()];
}

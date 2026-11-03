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


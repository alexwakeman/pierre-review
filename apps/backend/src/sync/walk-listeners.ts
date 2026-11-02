// AFTER A REPOSITORY'S WALK (docs/SYNC.md § After a walk). A tiny seam so work that is NOT the sync's —
// today the docs offers (reference-docs/repo-offers.ts), which exist only where the agentic features
// do — can follow a walk without the sync importing it. Called when a first sync's foreground pass
// ends and when any other walk (queued, manual or SCHEDULED) ends. ⚠ THIS function decides, from
// the walk's own result: a CANCELLED walk notifies nobody, so every caller passes what the walk
// returned and none re-implements the check. Each listener is called synchronously and must not
// block: it queues its own background work. A throwing listener is ignored, never the walk's error.

export type RepoWalkedListener = (accountId: number, repoId: number) => void;

const listeners: RepoWalkedListener[] = [];

export function onRepoWalked(fn: RepoWalkedListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Tell the listeners a walk of this repo ended — only when it was not cancelled. */
export function notifyRepoWalked(accountId: number, repoId: number, walk: { cancelled: boolean }): void {
  if (walk.cancelled) return;
  for (const fn of [...listeners]) {
    try {
      fn(accountId, repoId);
    } catch {
      // a listener's failure is never the walk's
    }
  }
}

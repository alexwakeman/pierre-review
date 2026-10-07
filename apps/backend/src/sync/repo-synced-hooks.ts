// Core's "a repo walk completed" seam — the tracker's ticket worker registers a kick here
// (tracker/index.ts `startTracker`) so a PR's tickets are read when the PR is RECEIVED, not when
// somebody opens it. (It was a plugin seam, `ProContext.registerRepoSyncedHook`, until apiVersion 23
// moved the tracker into core; nothing outside core registers here any more.)
//
// ⚠ A KICK, NEVER A STEP: `notifyRepoSynced` is called from `runSyncForRepo`'s post-walk chain,
// outside every transaction, and does not await the handlers — a slow or failing handler can
// never hold the repo's `running` slot, delay `clearSyncProgress`, or fail the sync.
export type RepoSyncedHook = (args: { accountId: number; repoId: number }) => void | Promise<void>;

const hooks: RepoSyncedHook[] = [];

export function registerRepoSyncedHook(handler: RepoSyncedHook): void {
  hooks.push(handler);
}

export function notifyRepoSynced(args: { accountId: number; repoId: number }, log: { warn: (msg: string) => void }): void {
  for (const h of hooks) {
    try {
      const r = h(args);
      if (r != null && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((err: unknown) =>
          log.warn(`repo-synced hook failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    } catch (err) {
      log.warn(`repo-synced hook failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Test hook. */
export function _resetRepoSyncedHooksForTest(): void {
  hooks.length = 0;
}

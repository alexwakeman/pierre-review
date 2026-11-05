// Core's "a PR's teammate Limn reviews were imported" seam (db/teammate-reviews-import.ts, run by
// sync/upsert.ts after a PR walk that saw a Limn review summary). The agentic layer registers a kick
// here at boot (review/agentic.ts → claude-review/teammate-resolve.ts): on the reader's OWN PR it
// resolves the reader's own Limn threads a teammate's posted review found addressed (gap 13,
// docs/TEAM-REVIEW.md § 6 Resolving).
//
// ⚠ A KICK, NEVER A STEP: called outside every transaction and NOT awaited — a slow or failing
// handler (it makes GitHub writes) can never hold a walk, delay a sync, or fail it.
export type TeammateReviewsImportedHook = (args: { accountId: number; prId: number }) => void | Promise<void>;

const hooks: TeammateReviewsImportedHook[] = [];

export function registerTeammateReviewsImportedHook(handler: TeammateReviewsImportedHook): void {
  hooks.push(handler);
}

export function notifyTeammateReviewsImported(args: { accountId: number; prId: number }): void {
  for (const h of hooks) {
    try {
      const r = h(args);
      if (r != null && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).catch(() => {});
    } catch {
      /* non-fatal: the next walk kicks again */
    }
  }
}

/** Test hook. */
export function _resetTeammateReviewsImportedHooksForTest(): void {
  hooks.length = 0;
}

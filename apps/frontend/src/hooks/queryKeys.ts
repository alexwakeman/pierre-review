// Query-key literals that more than one hook module needs.
//
// ⚠ A LEAF MODULE: it imports nothing. `prCacheSync.ts` needs the armed-merges key and
// `useAutoMerge.ts` needs `invalidateAfterPrWrite`, so defining the key in either of them makes
// the two import each other. That cycle works only while both bindings are read inside
// functions; the first module-level use would read an uninitialised binding during module
// evaluation, and with no error boundary that blanks the whole app.

/** The account-wide "merge when ready" list (`useArmedMerges`). */
export const ARMED_MERGES_KEY = ['auto-merge'] as const;

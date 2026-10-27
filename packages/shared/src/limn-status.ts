// LIMN'S OWN COMMIT STATUSES ARE NOT CI (docs/CLAUDE-REVIEW.md § Team claims).
//
// With "Mark auto reviews on GitHub" on, an auto review posts a commit status on the PR's head
// (`limn/review-claude`, `limn/review-codex`) so teammates' Limn skips a commit someone is already
// reviewing. GitHub folds those lines into the commit's check rollup like any CI, so every place
// Limn reads CI must take them out again — or a pending "free to claim" line would read as CI
// running, a red one as CI failing (My Turn's ci_failing card, the CI review, the merge verdict,
// dependency auto-merge's red-CI back-off, the auto-merge runner, trunk status).
//
// ⚠ ALWAYS ON, no setting. ONE predicate (`isLimnStatusContext`) and ONE rollup fold
// (`rollupStateWithoutLimn`). The PR details pane still LISTS the lines (`CheckRun.limnOwned`), with
// a small "Limn" label, and never counts them.

/** Every context name Limn posts starts with this. */
export const LIMN_STATUS_PREFIX = 'limn/';

/** Is this check / status context one of Limn's own lines (never CI)? */
export function isLimnStatusContext(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(LIMN_STATUS_PREFIX);
}

/** A check's state as `checkContextState` maps it (sync/upsert.ts). */
type ContextState = 'success' | 'failure' | 'error' | 'pending' | 'neutral' | 'skipped' | 'unknown';

/**
 * GitHub's rollup state (SUCCESS / FAILURE / ERROR / PENDING / EXPECTED, or null for "no checks")
 * with Limn's own lines taken out, recomputed from the commit's contexts.
 *
 *   • no contexts received (`null` / `undefined`) → GitHub's state unchanged (nothing to recompute);
 *   • no Limn line among them → GitHub's state unchanged;
 *   • only Limn lines → null (the commit has no CI);
 *   • otherwise the worst of the rest: any failure → FAILURE, else any error → ERROR, else any
 *     pending → PENDING (EXPECTED kept when GitHub said EXPECTED: a required check has not
 *     reported), else SUCCESS. A remaining context in a state Limn does not model keeps GitHub's
 *     answer — never guess green.
 *
 * ⚠ `complete === false` (the contexts are ONE PAGE of more — `contexts(first:100)` on a head with
 * more checks): GitHub's state unchanged. A recompute from part of the checks could miss a failing
 * one past the page and report green where GitHub says red.
 */
export function rollupStateWithoutLimn(
  state: string | null | undefined,
  contexts: ReadonlyArray<{ name: string; state: ContextState }> | null | undefined,
  complete?: boolean,
): string | null {
  const github = state ?? null;
  if (contexts == null || complete === false) return github;
  if (!contexts.some((c) => isLimnStatusContext(c.name))) return github;
  const rest = contexts.filter((c) => !isLimnStatusContext(c.name));
  if (rest.length === 0) return null;
  if (rest.some((c) => c.state === 'unknown')) return github;
  if (rest.some((c) => c.state === 'failure')) return 'FAILURE';
  if (rest.some((c) => c.state === 'error')) return 'ERROR';
  if ((github ?? '').toUpperCase() === 'EXPECTED') return 'EXPECTED';
  if (rest.some((c) => c.state === 'pending')) return 'PENDING';
  return 'SUCCESS';
}

/**
 * GitHub's mergeStateStatus with Limn's own lines taken out. GitHub reports UNSTABLE for ANY
 * non-passing status that is not required — a pending or unfinished `limn/review-*` line included —
 * so a PR whose real CI is all green would read "checks failing" / "non-required checks are red".
 * When the CI WITHOUT Limn's lines is green (`ciWithoutLimn === 'success'`) or there is no other CI
 * at all (`'none'`), only Limn's lines can have made it UNSTABLE: it reads CLEAN. Every other state,
 * and UNSTABLE over any other CI reading, passes through unchanged (never guess green). Applied
 * where the column is WRITTEN (sync/upsert.ts `persistPr`, db/pr-liveness.ts `applyPrLiveness`), so
 * every reader — the merge verdict, the Pending headings, the merge caveat — sees one answer.
 */
export function mergeStateWithoutLimn<T extends string | null | undefined>(
  mergeStateStatus: T,
  ciWithoutLimn: string | null | undefined,
): T | 'clean' {
  if (typeof mergeStateStatus !== 'string' || mergeStateStatus.toLowerCase() !== 'unstable') return mergeStateStatus;
  return ciWithoutLimn === 'success' || ciWithoutLimn === 'none' ? 'clean' : mergeStateStatus;
}

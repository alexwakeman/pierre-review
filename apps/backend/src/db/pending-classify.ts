// ── THE PENDING BOARD'S SHARED CLASSIFIERS (CORE, pure) ─────────────────────────────────────
//
// "Is this build red?" and "does this branch conflict?", spelled ONCE for every card that asks:
// the home cards in `getWorkspaceInsights` (ci_failing, conflicts, the merge-candidate loop) and the
// Dependencies tab's cards (db/dependency-cards.ts). Two spellings of either would let a PR be
// "conflicting" on one card and "ready" on the card beside it.
//
// ⚠ PURE ON PURPOSE: no `db/client`, no `db/triage` (which opens the DB client at load). The
// Dependencies modules are unit-tested without a database, and they import this.
import type { CiStatus } from '@pierre-review/shared';

/**
 * IS THIS BUILD RED? — and RED IS ALWAYS THE PAIR `failure` | `error`, never one of them.
 *
 * GitHub reports an infrastructure/permissions problem as `error` and a genuine check failure as
 * `failure`, and every layer of this app that asks "is it red" has to accept both: db/triage.ts's
 * reason tags, getWorkspaceMetricsDetail's own local `isRed`, and the SPA's lib/ui.ts. A fold that
 * tested only 'failure' would silently drop every errored build — which is the half that most
 * often needs a human.
 */
export const RED_CI_STATUSES = ['failure', 'error'] as const;

export function isRedCiStatus(ci: CiStatus | string | null): boolean {
  return (RED_CI_STATUSES as readonly string[]).includes(ci ?? '');
}

/**
 * DOES THE HEAD CONFLICT WITH THE BASE? An OR over two columns, because they are two views of one
 * fact: `mergeStateStatus = 'dirty'` is GitHub's protection-aware verdict, `mergeable =
 * 'conflicting'` its conflict-only one, and they agree on every real row we have measured.
 *
 * ⚠ NULL IN EITHER IS NOT OBSERVED, never a conflict — and never "fine" either. That is why this is
 * a JS fold and not a SQL predicate: `mergeable <> 'conflicting'` in SQL silently drops the NULL
 * rows, which are exactly the ones we have not asked about yet.
 */
export function isConflicting(p: {
  mergeStateStatus: string | null;
  mergeable: string | null;
}): boolean {
  return p.mergeStateStatus === 'dirty' || p.mergeable === 'conflicting';
}

/**
 * WHICH FORWARD CARD IS THIS PR? — `'update_branch'` when GitHub wants the branch updated first,
 * `'merge'` when it will merge now, else null. The Ready to land tab's two kinds, spelled ONCE for
 * the merge-candidate loop in `getWorkspaceInsights` and for My Turn's `own_ready` promotion, so a
 * PR promoted into My turn is classified by the very test its home card was.
 *
 * ⚠ CONFLICTS OUTRANK 'behind' — GitHub's own `canUpdateBranch` is "behind AND NOT conflicting",
 * so an Update-branch button on a conflicting PR is a button GitHub refuses.
 * ⚠ `readyToMerge` is `READY_MERGE_STATES.has(mergeStateStatus)`, evaluated by the CALLER: that set
 * lives in db/triage.ts, which opens the DB client at load, and this module stays pure.
 */
export function forwardKindOf(
  p: { mergeStateStatus: string | null; mergeable: string | null },
  readyToMerge: boolean,
): 'merge' | 'update_branch' | null {
  if (p.mergeStateStatus == null) return null;
  if (isConflicting(p)) return null;
  if (p.mergeStateStatus === 'behind') return 'update_branch';
  return readyToMerge ? 'merge' : null;
}

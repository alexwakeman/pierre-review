import { useEffect, useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  DEPENDENCY_MERGE_ALL_MAX,
  DEPENDENCY_MERGE_SKIP_LABEL,
  type DependencyMergeItem,
  type InsightCard,
} from '@pierre-review/shared';
import {
  DEPENDENCY_MERGE_ALL_KEY,
  useDependencyMergeAll,
  useDependencyMergePlan,
  useDependencyMergeToast,
} from '../../hooks/useDependencyMergeAll.js';
import { CloseIcon } from '../Icons.js';

// ── PENDING → DEPENDENCIES: "MERGE OR ARM ALL" ──────────────────────────────────────────────────
//
// One button over the tab's LISTED dependency updates (never a person's PR a security tool
// flagged — those carry no merge actions). The confirm dialog prints the SERVER's dry run: how
// many land now, how many wait armed, and every skip with its reason. Nothing fetches until the
// dialog opens (the board may not fetch on mount).

/** The listed cards that are dependency automation — the ones with merge actions. */
export function dependencyPrIdsOf(cards: readonly InsightCard[]): number[] {
  const ids: number[] = [];
  for (const c of cards) {
    if (c.kind === 'dependency_bump' || (c.kind === 'security' && c.dependencyUpdate)) {
      if (!ids.includes(c.prId)) ids.push(c.prId);
    }
  }
  return ids;
}

const label = (i: DependencyMergeItem): string =>
  i.repoFullName ? `${i.repoFullName} #${i.prNumber}` : `PR ${i.prId}`;

export function DependencyMergeAll({
  cards,
  workspaceId,
}: {
  cards: readonly InsightCard[];
  workspaceId: number | null;
}): JSX.Element | null {
  const allIds = useMemo(() => dependencyPrIdsOf(cards), [cards]);
  // The route takes at most DEPENDENCY_MERGE_ALL_MAX (the most the tab can list). Send the first
  // that many, in the tab's order, and say how many were left out rather than meeting a 400.
  const prIds = useMemo(() => allIds.slice(0, DEPENDENCY_MERGE_ALL_MAX), [allIds]);
  const leftOut = allIds.length - prIds.length;
  const [open, setOpen] = useState(false);
  const plan = useDependencyMergePlan(workspaceId, prIds, open);
  const run = useDependencyMergeAll(workspaceId);
  // The SHARED key, so a remount mid-run still shows the run.
  const running = useIsMutating({ mutationKey: DEPENDENCY_MERGE_ALL_KEY }) > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (prIds.length === 0) return null;

  const items = plan.data?.items ?? [];
  // (`?? []` also covers a body with no `items` — the SPA has no error boundary.)
  const toMerge = items.filter((i) => i.outcome.action === 'merge').length;
  const toArm = items.filter((i) => i.outcome.action === 'arm').length;
  const skipped = items.filter((i) => i.outcome.action === 'skipped');
  const actionable = toMerge + toArm;

  return (
    <>
      <button
        type="button"
        disabled={running || workspaceId == null}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="rounded border border-gray-300 px-2 py-0.5 text-[12px] font-medium text-gray-800 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-500"
      >
        {running ? 'Merging and arming…' : 'Merge or arm all'}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-24"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dep-merge-all-title"
            className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
              <h2 id="dep-merge-all-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Merge or arm all dependency updates
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="space-y-2 px-4 py-3 text-[12px] text-gray-700 dark:text-gray-300">
              {plan.isLoading ? (
                <p>Checking {prIds.length} pull requests…</p>
              ) : plan.isError ? (
                <p className="text-red-600 dark:text-red-400">Couldn’t check these pull requests.</p>
              ) : (
                <>
                  <p>
                    {toMerge > 0 && <>Merges {toMerge} now. </>}
                    {toArm > 0 && <>Sets {toArm} to merge when their checks pass. </>}
                    {actionable === 0 && <>Nothing here can be merged or armed.</>}
                  </p>
                  {actionable > 0 && (
                    <p className="text-gray-500 dark:text-gray-400">
                      Each one goes out under your GitHub account. A PR GitHub can’t land yet is armed instead.
                    </p>
                  )}
                  {leftOut > 0 && (
                    <p className="text-gray-500 dark:text-gray-400">
                      Leaves out {leftOut} more; run it again after these land.
                    </p>
                  )}
                  {skipped.length > 0 && (
                    <div>
                      <p className="font-medium">Skips {skipped.length}:</p>
                      <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto">
                        {skipped.map((i) => (
                          <li key={i.prId}>
                            {label(i)} — {i.outcome.action === 'skipped' ? DEPENDENCY_MERGE_SKIP_LABEL[i.outcome.reason] : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-2.5 dark:border-gray-800">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-gray-300 px-2.5 py-1 text-[12px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200"
              >
                Cancel
              </button>
              {actionable > 0 && (
                <button
                  type="button"
                  disabled={running}
                  onClick={() => {
                    const ids = items
                      .filter((i) => i.outcome.action === 'merge' || i.outcome.action === 'arm')
                      .map((i) => i.prId);
                    run.mutate(ids);
                    setOpen(false);
                  }}
                  className="rounded bg-gray-900 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                >
                  {toMerge > 0 && toArm > 0
                    ? `Merge ${toMerge}, arm ${toArm}`
                    : toMerge > 0
                      ? `Merge ${toMerge}`
                      : `Arm ${toArm}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Long enough to read the counts; the card closes itself after that. */
const TOAST_MS = 15_000;

/**
 * The run's summary — a plain card for App.tsx's ONE bottom-right toast column, never its own
 * `fixed` element.
 */
export function DependencyMergeToast(): JSX.Element | null {
  const last = useDependencyMergeToast((s) => s.last);
  const clear = useDependencyMergeToast((s) => s.clear);
  useEffect(() => {
    if (last == null) return;
    const t = setTimeout(clear, TOAST_MS);
    return () => clearTimeout(t);
  }, [last, clear]);
  if (last == null) return null;

  const count = (a: DependencyMergeItem['outcome']['action']) =>
    last.filter((i) => i.outcome.action === a).length;
  const merged = count('merged');
  const armed = count('armed');
  const skipped = count('skipped');
  const failed = last.filter((i) => i.outcome.action === 'failed');
  const parts = [
    merged > 0 ? `${merged} merged` : null,
    armed > 0 ? `${armed} set to merge when ready` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    failed.length > 0 ? `${failed.length} failed` : null,
  ].filter((p): p is string => p != null);

  return (
    <div
      role="status"
      className="pointer-events-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-gray-500 dark:text-gray-400">Dependency updates</div>
          <div className="text-[12px] text-gray-800 dark:text-gray-100">
            {parts.length > 0 ? parts.join(' · ') : 'Nothing changed.'}
          </div>
          {failed.slice(0, 3).map((i) => (
            <div key={i.prId} className="truncate text-[11px] text-red-600 dark:text-red-400">
              {label(i)}: {i.outcome.action === 'failed' ? i.outcome.message : ''}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={clear}
          title="Close"
          aria-label="Close"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}

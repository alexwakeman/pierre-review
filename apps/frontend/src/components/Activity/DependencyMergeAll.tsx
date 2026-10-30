import { useEffect, useId, useMemo, useState } from 'react';
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
import { CloseIcon, PendingDependencyIcon, WarningIcon } from '../Icons.js';
import { HeaderToast, ToastList, ToastRow, ToastShowMore } from '../HeaderToasts.js';

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
        className="inline-flex h-7 items-center rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50 touch:h-10 touch:px-3"
      >
        {running ? 'Merging and arming…' : 'Merge or arm all'}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-ui-scrim/40 p-4 pt-24 max-md:items-end max-md:p-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dep-merge-all-title"
            className="w-full max-w-md rounded-[10px] bg-ui-raise shadow-xl motion-safe:animate-ui-pop max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-xl max-md:pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <h2 id="dep-merge-all-title" className="text-title text-ui-ink">
                Merge or arm all dependency updates
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-7 w-7 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10"
              >
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="space-y-2 px-4 py-3 text-body text-ui-mute">
              {plan.isLoading ? (
                <p>Checking {prIds.length} pull requests…</p>
              ) : plan.isError ? (
                <p className="text-ui-danger">Couldn’t check these pull requests.</p>
              ) : (
                <>
                  <p>
                    {toMerge > 0 && <>Merges {toMerge} now. </>}
                    {toArm > 0 && <>Sets {toArm} to merge when their checks pass. </>}
                    {actionable === 0 && <>Nothing here can be merged or armed.</>}
                  </p>
                  {actionable > 0 && (
                    <p className="text-ui-mute">
                      Each one goes out under your GitHub account. A PR GitHub can’t land yet is armed instead.
                    </p>
                  )}
                  {leftOut > 0 && (
                    <p className="text-ui-mute">
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
            <div className="flex justify-end gap-2 px-4 pb-4 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 items-center rounded-ui bg-ui-surface px-3 text-body text-ui-ink hover:bg-ui-hover touch:h-11"
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
                  className="inline-flex h-8 items-center rounded-ui bg-ui-accent-fill px-3 text-body font-medium text-ui-on-accent hover:brightness-110 disabled:opacity-50 touch:h-11"
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

// Failed rows drawn before the rest fold into a "Show N more" control.
const FAILED_ROWS = 3;

/**
 * The run's summary — a card in the ONE header toast strip (HeaderToasts.tsx), never its own
 * `fixed` element.
 */
export function DependencyMergeToast(): JSX.Element | null {
  const last = useDependencyMergeToast((s) => s.last);
  const clear = useDependencyMergeToast((s) => s.clear);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  useEffect(() => {
    setShowAll(false);
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
    <HeaderToast
      testId="dependency-merge-toast"
      tone="merge"
      label="Dependency updates"
      icon={<PendingDependencyIcon size={13} />}
      summary={parts.length > 0 ? parts.join(' · ') : 'Nothing changed.'}
      onDismiss={clear}
      dismissLabel="Dismiss dependency update results"
      footer={
        failed.length > FAILED_ROWS ? (
          <ToastShowMore
            hidden={Math.max(0, failed.length - FAILED_ROWS)}
            showAll={showAll}
            onToggle={() => setShowAll((v) => !v)}
            controls={listId}
          />
        ) : undefined
      }
    >
      {failed.length > 0 ? (
        <ToastList id={listId}>
          {(showAll ? failed : failed.slice(0, FAILED_ROWS)).map((i) => (
            <ToastRow key={i.prId}>
              <span className="text-ui-danger">
                <WarningIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
                Failed — {label(i)}: {i.outcome.action === 'failed' ? i.outcome.message : ''}
              </span>
            </ToastRow>
          ))}
        </ToastList>
      ) : undefined}
    </HeaderToast>
  );
}

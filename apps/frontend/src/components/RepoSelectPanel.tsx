import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CheckboxBox } from './ui/FormControls.js';
import { CaretIcon, CloseIcon, WarningIcon } from './Icons.js';

// Show/hide dropdown for the ACTIVE WORKSPACE's repos — the only narrowing left inside a
// workspace, and the reason this panel is mounted rather than merely defined. Each repo is a
// checkbox row showing the full `owner/name` (so same-named repos under different owners are
// distinguishable). A checked row is visible; unchecking hides it. Committed state lives in the
// store's `repoIds`, where `null` now means "every repo IN THIS WORKSPACE" — the workspace already
// bounds the set — and "all" / "none" therefore mean all-or-none of the workspace, not of the
// account. Toggling is immediate (no Apply): this is a visibility control, not a staged
// multi-select.
//
// ⚠ THIS PANEL IS TIMELINE-ONLY, AND SO IS WHAT IT CONTROLS. `repoIds` narrows the TIMELINE
// board and nothing else: Activity, the Feed, Bots and Compare always cover every repo in the
// selected workspace, and you narrow Activity by clicking a repo row in its rail. A visibility
// control must not silently scope screens that cannot see it, so this is mounted only while the
// Timeline board is the active tab.
//
// ⚠ THERE IS NO PER-ROW REMOVE. Removing a repo lives in the workspace manager and nowhere else:
// a visibility panel that deletes a repo is a footgun, and under one-workspace-per-repo the
// gesture people actually want from here is a MOVE, which this panel cannot express.
//
// There is no per-row WATCH toggle either — "watched" is gone as a concept. A workspace IS the
// scope, so every repo in it is fully live (Feed, Activity, My Turn, Bots); a second visibility
// axis on top of the workspace was only ever confusing.
export function RepoSelectPanel({
  repos,
  repoIds,
  onToggle,
  onOnly,
  onShowAll,
}: {
  repos: Repo[]; // the active workspace's repos ONLY, never the account's
  repoIds: number[] | null; // committed visibility filter (null = every repo in the workspace)
  onToggle: (id: number) => void; // immediate show/hide of one repo
  onOnly: (id: number) => void; // isolate to just this repo (deselect the rest)
  onShowAll: () => void; // clear the filter → show every repo in the workspace
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const total = repos.length;
  const isVisible = (id: number): boolean =>
    repoIds == null || repoIds.includes(id);
  const shownCount = repoIds == null ? total : repoIds.length;
  const filtered = repoIds != null && shownCount < total;

  // Outside-click dismiss via the shared hook. Escape stays INLINE below: it must
  // stopPropagation() so it doesn't bubble to the global keyboard handler (which
  // would clear the selection), so it can't be folded into the mousedown hook.
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const q = filter.trim().toLowerCase();
  const rows = repos.filter((r) => !q || r.fullName.toLowerCase().includes(q));

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger + (when filtered) a clear-✕. Sibling buttons in one pill. */}
      <span className="inline-flex items-center whitespace-nowrap rounded-ui bg-ui-raise text-body text-ui-mute hover:text-ui-ink">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex h-7 items-center gap-1 rounded-ui pl-2.5 touch:h-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${
            filtered ? 'pr-1' : 'pr-2.5'
          }`}
        >
          Repos
          {total > 0 ? ` (${filtered ? `${shownCount}/${total}` : total})` : ''}
          <CaretIcon dir="down" />
        </button>
        {filtered && (
          <button
            type="button"
            onClick={() => onShowAll()}
            title="Show every repo in this workspace"
            aria-label="Show every repo in this workspace"
            className="flex items-center self-stretch rounded-ui pl-0.5 pr-2 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:px-3"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Repositories in this workspace"
          className="absolute left-0 top-full z-[60] mt-1 w-[28rem] max-w-[calc(100vw-2rem)] rounded-ui bg-ui-raise p-2 text-ui-ink shadow-xl shadow-black/30 ring-1 ring-ui-line motion-safe:animate-ui-pop max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[75vh] max-sm:w-auto max-sm:max-w-none max-sm:overflow-y-auto max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          {total > 8 && (
            <input
              autoFocus
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter repos…"
              aria-label="Filter repos"
              className="mb-2 w-full rounded-ui bg-ui-bg px-2 py-1 text-body text-ui-ink ring-1 ring-ui-line placeholder:text-ui-faint focus:outline-none focus:ring-2 focus:ring-ui-accent"
            />
          )}

          <div className="max-h-72 overflow-y-auto">
            {total === 0 ? (
              // An EMPTY WORKSPACE — an ordinary state, not a broken one, and no longer the
              // account-wide "you have added nothing yet". This panel has no add affordance, so
              // it names the surface that does rather than inviting a search that isn't here.
              <div className="px-1 py-2 text-meta text-ui-mute">
                No repos in this workspace — move some in from Manage repos &amp; workspaces.
              </div>
            ) : rows.length === 0 ? (
              <div className="px-1 py-2 text-meta text-ui-mute">No repos match.</div>
            ) : (
              rows.map((r) => {
                // Don't let the user hide the only visible repo (would leave an
                // empty timeline with everything unchecked). The checkbox for the
                // last shown repo is disabled.
                const lastShown = isVisible(r.id) && shownCount <= 1;
                return (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded-ui px-1 py-1 text-meta hover:bg-ui-hover"
                  >
                    <label
                      className={`flex min-w-0 flex-1 items-center gap-2 ${
                        lastShown ? 'cursor-default' : 'cursor-pointer'
                      }`}
                    >
                      <CheckboxBox
                        checked={isVisible(r.id)}
                        disabled={lastShown}
                        onChange={() => onToggle(r.id)}
                        title={lastShown ? 'At least one repo must stay shown' : undefined}
                      />
                      <span className="min-w-0 truncate" title={r.fullName}>
                        <span className="text-ui-faint">{r.owner}/</span>
                        <span className="font-medium text-ui-ink">
                          {r.name}
                        </span>
                      </span>
                      {r.lastSyncStatus === 'error' && (
                        <span
                          role="img"
                          className="flex shrink-0 items-center text-ui-danger"
                          title={r.lastSyncError ?? 'Last sync failed'}
                          aria-label="Last sync failed"
                        >
                          <WarningIcon size={12} />
                        </span>
                      )}
                    </label>
                    {/* Quick-isolate: show only this repo (deselect the rest), so
                        you can hop between repos without unchecking everything.
                        Hidden when this repo is already the sole visible one. */}
                    {!(isVisible(r.id) && shownCount === 1) && (
                      <button
                        type="button"
                        onClick={() => onOnly(r.id)}
                        title={`Show only ${r.fullName}`}
                        aria-label={`Show only ${r.fullName}`}
                        className="hit shrink-0 rounded-ui px-1.5 py-0.5 text-meta font-medium text-ui-faint opacity-0 hover:bg-ui-hover hover:text-ui-ink focus:opacity-100 group-hover:opacity-100 "
                      >
                        only
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {filtered && (
            <div className="mt-2 flex items-center justify-between border-t border-ui-line pt-2">
              <span className="text-meta text-ui-faint">
                {shownCount} of {total} shown
              </span>
              <button
                type="button"
                onClick={() => onShowAll()}
                className="hit text-meta text-ui-faint hover:text-ui-ink"
              >
                Show all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

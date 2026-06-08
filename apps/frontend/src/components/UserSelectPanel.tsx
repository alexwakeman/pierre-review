import { useEffect, useRef, useState } from 'react';
import type { User } from '@pierre-review/shared';
import { Avatar } from './CommentCard.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { userLabel } from '../lib/ui.js';

// A labelled group of members in the picker (e.g. "Maintainers", a repo name,
// or "Other"). The same user may appear in several sections; selection is keyed
// by user id, so checking them in one section checks them everywhere.
export interface MemberSection {
  key: string; // stable react key
  label: string;
  members: User[]; // already sorted by the caller
}

// Maintainer shield — mirrors the timeline row-label badge (same purple
// shield-check). Marks a member with merge rights in the relevant repo(s).
function MaintainerShield(): JSX.Element {
  return (
    <span className="flex-none" title="Maintainer — has merged a PR in the selected repo(s)">
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <path fill="#8957e5" d="M8 .8 2.2 2.9v4.2c0 3.3 2.5 6.4 5.8 7.3 3.3-.9 5.8-4 5.8-7.3V2.9L8 .8Z" />
        <path
          d="M5.2 8 7.1 9.9 10.9 6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function UserSelectPanel({
  sections,
  userIds,
  maintainerIds,
  onApply,
  excludeBots,
  onExcludeBotsChange,
}: {
  sections: MemberSection[]; // grouped picker options (maintainers, per-repo, other)
  userIds: number[] | null; // committed selection (null = all)
  maintainerIds: Set<number>; // members with merge rights in the relevant repo(s)
  onApply: (ids: number[] | null) => void; // empty => null (show all)
  excludeBots: boolean; // hide bot actors from the timeline (committed, immediate)
  onExcludeBotsChange: (v: boolean) => void; // immediate — NOT staged behind Apply
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Staged selection lives here, NOT in the store — nothing filters/refetches
  // until Apply. Initialised from the committed userIds each time the panel opens.
  const [staged, setStaged] = useState<Set<number>>(new Set());
  // In-panel type-to-filter over the (potentially large) roster. View-only: it
  // narrows which options are shown, never the staged selection.
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const activeCount = userIds?.length ?? 0;

  const openPanel = (): void => {
    setStaged(new Set(userIds ?? [])); // seed from committed selection
    setFilter('');
    setOpen(true);
  };

  const q = filter.trim().toLowerCase();
  const matches = (u: User): boolean =>
    !q ||
    u.githubLogin.toLowerCase().includes(q) ||
    (u.displayName ?? '').toLowerCase().includes(q);

  // Narrow each section by the search box, then drop sections left empty. A
  // member repeated across repos stays in every section it belongs to.
  const visibleSections = sections
    .map((s) => ({ ...s, members: s.members.filter(matches) }))
    .filter((s) => s.members.length > 0);
  const totalMembers = sections.reduce((n, s) => n + s.members.length, 0);

  // Outside-click dismiss via the shared hook; both it and Escape discard staged
  // edits (no commit) — closing without Apply just drops `staged`, which is
  // re-seeded from the committed userIds the next time the panel opens. Escape
  // stays INLINE below: it must stopPropagation() so it doesn't bubble to the
  // global useKeyboard handler (which would clearSelection() and wipe the selected
  // PR/thread), so it can't be folded into the mousedown hook.
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

  const toggle = (id: number): void =>
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Bulk-toggle a whole section's (currently-shown) members on or off at once.
  const toggleMany = (ids: number[], on: boolean): void =>
    setStaged((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const apply = (): void => {
    const ids = [...staged];
    onApply(ids.length ? ids : null); // empty staged => show all rows
    setOpen(false);
  };

  // Clear all unchecks every staged member. It does NOT commit on its own — the
  // user clicks Apply (empty => setUserIds(null) => all rows shown).
  const clearAll = (): void => setStaged(new Set());

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger + (when a selection is active) a clear-✕. Sibling buttons inside
          one pill — never a button nested in a button (that can swallow clicks). */}
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-300 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${
            activeCount > 0 ? 'pr-1' : 'pr-2.5'
          }`}
        >
          Members{activeCount > 0 ? ` (${activeCount})` : ''}
          <span aria-hidden className="text-[9px]">▾</span>
        </button>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => {
              onApply(null); // null => clear the member filter (show all rows)
              setOpen(false);
            }}
            title="Clear members filter"
            aria-label="Clear members filter"
            className="py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Select members"
          className="absolute left-0 top-full z-[60] mt-1 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <input
            autoFocus
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter members…"
            aria-label="Filter members"
            className="mb-2 w-full rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
          />
          {maintainerIds.size > 0 &&
            (() => {
              // Quick-select: stage every maintainer in the current filter context
              // (toggles off again once they're all staged).
              const ids = [...maintainerIds];
              const allChecked = ids.every((id) => staged.has(id));
              return (
                <button
                  type="button"
                  onClick={() => toggleMany(ids, !allChecked)}
                  title="Select every maintainer in the current filter"
                  className={`mb-2 flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition ${
                    allChecked
                      ? 'bg-[#8957e5]/15 text-[#8957e5]'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                  }`}
                >
                  <MaintainerShield />
                  <span className="font-medium">Maintainers</span>
                  <span className="text-gray-400">({ids.length})</span>
                  <span className="ml-auto text-[10px] text-gray-400">
                    {allChecked ? 'clear' : 'select all'}
                  </span>
                </button>
              );
            })()}
          <div className="max-h-72 overflow-y-auto">
            {totalMembers === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No members in range.</div>
            ) : visibleSections.length === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No members match.</div>
            ) : (
              visibleSections.map((sec) => {
                const ids = sec.members.map((u) => u.id);
                const allChecked = ids.every((id) => staged.has(id));
                return (
                  <div key={sec.key} className="mb-1 last:mb-0">
                    <div className="sticky top-0 flex items-center justify-between bg-white px-1 pb-0.5 pt-1 dark:bg-gray-900">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        {sec.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleMany(ids, !allChecked)}
                        className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      >
                        {allChecked ? 'none' : 'all'}
                      </button>
                    </div>
                    {sec.members.map((u) => (
                      <label
                        key={`${sec.key}:${u.id}`}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <input
                          type="checkbox"
                          checked={staged.has(u.id)}
                          onChange={() => toggle(u.id)}
                        />
                        <Avatar user={u} size={16} />
                        <span className="min-w-0 truncate" title={u.githubLogin}>
                          {userLabel(u, u.id)}
                        </span>
                        {maintainerIds.has(u.id) && <MaintainerShield />}
                      </label>
                    ))}
                  </div>
                );
              })
            )}
          </div>
          {/* Exclude-bots toggle. IMMEDIATE — wired straight to the store (not
              staged behind Apply): it's a visibility switch over bot actors, not a
              member selection, so it takes effect on click like the repo/event
              show/hide controls. */}
          <label className="mt-2 flex cursor-pointer items-center gap-2 border-t border-gray-200 pt-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={excludeBots}
              onChange={(e) => onExcludeBotsChange(e.target.checked)}
            />
            Exclude bots
          </label>
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={clearAll}
              className="text-[11px] text-gray-400 hover:text-gray-600"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded bg-blue-600 px-2.5 py-0.5 text-xs text-white"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

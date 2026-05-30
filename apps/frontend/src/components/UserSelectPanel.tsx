import { useEffect, useRef, useState } from 'react';
import type { User } from '@gh-team-monitor/shared';
import { Avatar } from './CommentCard.js';
import { userLabel } from '../lib/ui.js';

export function UserSelectPanel({
  members,
  userIds,
  onApply,
}: {
  members: User[];
  userIds: number[] | null; // committed selection (null = all)
  onApply: (ids: number[] | null) => void; // empty => null (show all)
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
  const shown = q
    ? members.filter(
        (u) =>
          u.githubLogin.toLowerCase().includes(q) ||
          (u.displayName ?? '').toLowerCase().includes(q),
      )
    : members;

  // Outside-click + Escape dismiss. Dismiss discards staged edits (no commit).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Don't let this bubble to the global useKeyboard handler (window), which
        // would clearSelection() and wipe the selected PR/thread out from under us.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (id: number): void =>
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="true"
        aria-expanded={open}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
      >
        Members{activeCount > 0 ? ` (${activeCount})` : ''}
        <span aria-hidden className="text-[9px]">▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select members"
          className="absolute left-0 top-full z-[60] mt-1 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
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
          <div className="max-h-64 overflow-y-auto">
            {members.length === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No members in range.</div>
            ) : shown.length === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No members match.</div>
            ) : (
              shown.map((u) => (
                <label
                  key={u.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={staged.has(u.id)}
                    onChange={() => toggle(u.id)}
                  />
                  <Avatar user={u} size={16} />
                  <span className="truncate" title={u.githubLogin}>
                    {userLabel(u, u.id)}
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
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

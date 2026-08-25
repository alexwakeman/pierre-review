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

// In-panel type-to-filter rule — ONE spelling for every surface that renders member rows
// (this dropdown's member + bot halves, and the Reports People picker's inline panel).
export function matchesMemberFilter(u: User, q: string): boolean {
  return (
    !q ||
    u.githubLogin.toLowerCase().includes(q) ||
    (u.displayName ?? '').toLowerCase().includes(q)
  );
}

// Maintainer shield — mirrors the timeline row-label badge (same purple
// shield-check). Marks a member with merge rights in the relevant repo(s).
export function MaintainerShield(): JSX.Element {
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

// The section-list BODY of the Members dropdown, extracted so the Reports People picker can
// render the same content inline (beneath its own text field) without the dropdown shell.
// Everything behavioural moved verbatim: the sticky section headers, maintainer-first rows +
// shield, the per-section all/none, the show-10-more collapse, and the searching-shows-all-
// matches-flat rule. Staging semantics stay with the CALLER — the dropdown stages behind Apply,
// the picker commits straight to chips — which is why `staged`/`onToggle` are props, not state.
export function MemberSectionList({
  sections,
  filter,
  staged,
  onToggle,
  onToggleMany,
  maintainerIds,
  shownOthers,
  setShownOthers,
}: {
  sections: MemberSection[]; // grouped options (per-repo, other) — UNfiltered; the list narrows
  filter: string; // the caller's search-box value (raw; trimmed/lowered here)
  staged: Set<number>; // checked ids (the dropdown's staged set / the picker's chip ids)
  onToggle: (id: number) => void;
  onToggleMany: (ids: number[], on: boolean) => void; // per-section all/none
  maintainerIds: Set<number>;
  // Per-section (repo) count of NON-maintainer members revealed — 0 = collapsed. Owned by the
  // caller so reopening its surface can reset the collapse (the dropdown does; chips persist).
  shownOthers: Record<string, number>;
  setShownOthers: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}): JSX.Element {
  const q = filter.trim().toLowerCase();

  // Narrow each section by the search box, then drop sections left empty. A
  // member repeated across repos stays in every section it belongs to.
  const visibleSections = sections
    .map((s) => ({ ...s, members: s.members.filter((u) => matchesMemberFilter(u, q)) }))
    .filter((s) => s.members.length > 0);
  const totalMembers = sections.reduce((n, s) => n + s.members.length, 0);

  // One member row (checkbox + avatar + name + maintainer shield). Shared by a section's
  // always-shown maintainers and its expandable non-maintainer list.
  const memberRow = (sec: MemberSection, u: User): JSX.Element => (
    <label
      key={`${sec.key}:${u.id}`}
      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
    >
      <input type="checkbox" checked={staged.has(u.id)} onChange={() => onToggle(u.id)} />
      <Avatar user={u} size={16} />
      <span className="min-w-0 truncate" title={u.githubLogin}>
        {userLabel(u, u.id)}
      </span>
      {maintainerIds.has(u.id) && <MaintainerShield />}
    </label>
  );

  return (
    <>
      {totalMembers === 0 ? (
        <div className="px-1 py-2 text-xs text-gray-500">No members in range.</div>
      ) : visibleSections.length === 0 ? (
        <div className="px-1 py-2 text-xs text-gray-500">No members match.</div>
      ) : (
        visibleSections.map((sec) => {
          const ids = sec.members.map((u) => u.id);
          const allChecked = ids.every((id) => staged.has(id));
          const searching = q.length > 0;
          // Default (no search): show every maintainer, collapse the rest behind a per-repo
          // "show more" that reveals 10 at a time. While searching, show all matches flat so
          // a filtered member is never hidden by the collapse.
          const maints = searching ? [] : sec.members.filter((u) => maintainerIds.has(u.id));
          const rest = searching
            ? sec.members
            : sec.members.filter((u) => !maintainerIds.has(u.id));
          const shown = shownOthers[sec.key] ?? 0;
          const visibleRest = searching ? rest : rest.slice(0, shown);
          const remaining = rest.length - visibleRest.length;
          return (
            <div key={sec.key} className="mb-1 last:mb-0">
              {/* Opaque + z-10 + a hairline so a scrolling member row passes cleanly BEHIND
                  the pinned repo name instead of bleeding through it. */}
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-1 pb-0.5 pt-1 dark:border-gray-800 dark:bg-gray-900">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  {sec.label}
                </span>
                <button
                  type="button"
                  onClick={() => onToggleMany(ids, !allChecked)}
                  title="Select / clear every member in this repo (including any collapsed below)"
                  className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {allChecked ? 'none' : 'all'}
                </button>
              </div>
              {maints.map((u) => memberRow(sec, u))}
              {visibleRest.map((u) => memberRow(sec, u))}
              {!searching && rest.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 py-0.5 text-[10px]">
                  {remaining > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setShownOthers((s) => ({ ...s, [sec.key]: (s[sec.key] ?? 0) + 10 }))
                      }
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {/* Lead number == what THIS click reveals (always ≤10, since the
                          onClick bumps by 10); "· N hidden" is the total still collapsed. */}
                      {remaining <= 10
                        ? `Show ${remaining} more`
                        : `Show 10 more · ${remaining} hidden`}
                    </button>
                  )}
                  {shown > 0 && (
                    <button
                      type="button"
                      onClick={() => setShownOthers((s) => ({ ...s, [sec.key]: 0 }))}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

export function UserSelectPanel({
  sections,
  botSections,
  userIds,
  maintainerIds,
  onApply,
  excludeBots,
  onExcludeBotsChange,
  allowedBotIds,
  onToggleAllowedBot,
}: {
  sections: MemberSection[]; // grouped picker options (maintainers, per-repo, other)
  botSections: MemberSection[]; // per-repo bot contributors (item 3)
  userIds: number[] | null; // committed selection (null = all)
  maintainerIds: Set<number>; // members with merge rights in the relevant repo(s)
  onApply: (ids: number[] | null) => void; // empty => null (show all)
  excludeBots: boolean; // hide bot actors from the timeline (committed, immediate)
  onExcludeBotsChange: (v: boolean) => void; // immediate — NOT staged behind Apply
  allowedBotIds: number[]; // bots kept visible under excludeBots (committed, immediate)
  onToggleAllowedBot: (id: number) => void; // immediate — like excludeBots, not staged
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Staged selection lives here, NOT in the store — nothing filters/refetches
  // until Apply. Initialised from the committed userIds each time the panel opens.
  const [staged, setStaged] = useState<Set<number>>(new Set());
  // In-panel type-to-filter over the (potentially large) roster. View-only: it
  // narrows which options are shown, never the staged selection.
  const [filter, setFilter] = useState('');
  // Per-section (repo) count of NON-maintainer members revealed — 0 = collapsed, so a section
  // shows only its maintainers by default. "Show more" bumps it by 10; reset when the panel
  // reopens. Ignored while searching (a query always shows every match).
  const [shownOthers, setShownOthers] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  const activeCount = userIds?.length ?? 0;

  const openPanel = (): void => {
    setStaged(new Set(userIds ?? [])); // seed from committed selection
    setFilter('');
    setShownOthers({}); // every section back to maintainers-only
    setOpen(true);
  };

  const q = filter.trim().toLowerCase();

  // Per-repo Bots (item 3): allow-list is IMMEDIATE (like excludeBots) — a ticked bot stays
  // visible even when bots are excluded. Narrowed by the same search box (the member half's
  // narrowing lives inside MemberSectionList now, off the same matchesMemberFilter rule).
  const allowedSet = new Set(allowedBotIds);
  const visibleBotSections = botSections
    .map((s) => ({ ...s, members: s.members.filter((u) => matchesMemberFilter(u, q)) }))
    .filter((s) => s.members.length > 0);

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
            <MemberSectionList
              sections={sections}
              filter={filter}
              staged={staged}
              onToggle={toggle}
              onToggleMany={toggleMany}
              maintainerIds={maintainerIds}
              shownOthers={shownOthers}
              setShownOthers={setShownOthers}
            />
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

          {/* Per-repo Bots (item 3): allow-list the important bots so they stay visible even
              while "Exclude bots" hides the rest. IMMEDIATE like the exclude toggle. */}
          {visibleBotSections.length > 0 && (
            <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
              <div className="mb-1 flex items-center gap-1.5 px-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  Bots
                </span>
                <span className="text-[10px] text-gray-400">
                  {excludeBots ? '· ticked stay visible' : '· all shown (bots not excluded)'}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto">
                {visibleBotSections.map((sec) => (
                  <div key={sec.key} className="mb-1 last:mb-0">
                    <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-1 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800 dark:bg-gray-900">
                      {sec.label}
                    </div>
                    {sec.members.map((u) => (
                      <label
                        key={`${sec.key}:${u.id}`}
                        className={`flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 ${
                          excludeBots ? 'cursor-pointer' : 'cursor-pointer opacity-60'
                        }`}
                        title={
                          excludeBots
                            ? 'Keep this bot visible even though bots are excluded'
                            : 'Bots are currently shown; enable "Exclude bots" for this to take effect'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={allowedSet.has(u.id)}
                          onChange={() => onToggleAllowedBot(u.id)}
                        />
                        <Avatar user={u} size={16} />
                        <span className="min-w-0 truncate" title={u.githubLogin}>
                          {userLabel(u, u.id)}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
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

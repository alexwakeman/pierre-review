import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useSearchTimeline, useRepos, useUsers } from '../hooks/useTimeline.js';
import { useSearchOpenPrs } from '../hooks/useTriage.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { indexUsers, userLabel } from '../lib/ui.js';
import { Avatar } from './CommentCard.js';

// Sticky PR-title search. The query lives in the store (searchQuery /
// setSearchQuery), so it survives this component's re-renders, input blur, and
// PR selection — re-focusing the input re-shows the same results. The panel's
// open/closed state is local: results show only while the input is focused AND
// the query is non-empty; Escape / outside-click hides the panel but keeps the
// query. The filter is purely client-side over already-loaded data, and picking
// a result (click or Enter) ENTERS the sticky PR-isolation focus overlay
// (focusPrOnTimeline) — it isolates that one PR, shown even when the active
// filters would hide it (its bar is force-shown), and suppresses the marker-level
// thread/verdict filters for it; browser-back / Esc leaves focus and returns to
// the exact filtered view the search ran from. The index is GLOBAL: it reads the
// member-agnostic useSearchTimeline / useSearchOpenPrs sets, so a PR is findable
// even when the active filters would hide it.
export function TimelineSearch(): JSX.Element {
  const query = useFilters((s) => s.searchQuery);
  const setQuery = useFilters((s) => s.setSearchQuery);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);

  const { data: timeline } = useSearchTimeline();
  const { data: openPrs } = useSearchOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();

  const [open, setOpen] = useState(false);
  // Keyboard-highlighted result (-1 = none); driven by Arrow keys, committed by
  // Enter, and mirrored to aria-activedescendant so the listbox is really usable.
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  // No useReposById hook — build a Map (id → fullName) over useRepos().
  const reposById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos ?? []) m.set(r.id, r.fullName);
    return m;
  }, [repos]);
  // Resolve each result's authorId → user so the row can show who opened the PR.
  const usersById = useMemo(() => indexUsers(users), [users]);

  // De-dupe timeline + open PRs by id (open PRs may be hidden by the collapsed
  // strip or outside the window, so include them so they're still findable).
  const allPrs = useMemo(() => {
    const m = new Map<number, TimelinePr>();
    for (const p of timeline?.prs ?? []) m.set(p.id, p);
    for (const p of openPrs?.prs ?? []) if (!m.has(p.id)) m.set(p.id, p);
    return [...m.values()];
  }, [timeline, openPrs]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Match by title OR by PR number — typing a number (with or without a leading
    // '#') finds that PR. A purely-numeric query ranks the closest number matches
    // first (exact, then prefix, then substring) so #24528 leads when you type 24528.
    const numQ = q.replace(/^#/, '');
    const numeric = numQ.length > 0 && /^\d+$/.test(numQ);
    const matched = allPrs.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (numeric && String(p.number).includes(numQ)),
    );
    if (numeric) {
      const rank = (p: TimelinePr): number => {
        const n = String(p.number);
        return n === numQ ? 0 : n.startsWith(numQ) ? 1 : n.includes(numQ) ? 2 : 3;
      };
      matched.sort((a, b) => rank(a) - rank(b));
    }
    return matched.slice(0, 30);
  }, [allPrs, query]);

  const showPanel = open && query.trim().length > 0;
  // Clamp the highlight to the current result set (it shrinks as you type).
  const activeId = active >= 0 && active < results.length ? results[active]!.id : null;

  // Outside-click hides the panel but never clears the query (sticky). Escape
  // close stays inline in onKeyDown (it also blurs the input).
  useClickOutside(rootRef, () => setOpen(false), showPanel);

  // Keep the keyboard-highlighted row scrolled into view within the panel.
  useEffect(() => {
    if (activeId == null) return;
    rootRef.current
      ?.querySelector(`#pr-result-${activeId}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const pick = (pr: TimelinePr | undefined): void => {
    if (!pr) return;
    // Open the picked PR as its own PR-focus TAB (a fresh isolated Timeline that boots
    // into isolation). The tab fetches a ~90-day member-agnostic window, so the PR is
    // present even when the active board filters would hide it.
    const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    openPrFocusTab({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: reposById.get(pr.repoId) ?? `repo ${pr.repoId}`,
      authorLogin: author?.githubLogin ?? null,
      authorDisplayName: author?.displayName ?? null,
      authorAvatarUrl: author?.avatarUrl ?? null,
    });
    setOpen(false); // hide panel; query stays sticky for re-focus
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setOpen(false); // hide panel, KEEP the query (sticky)
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (!showPanel || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[active >= 0 ? active : 0]); // Enter with no highlight → top match
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        type="search"
        value={query}
        placeholder="Search PRs (title or number)…"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1); // the result set changed; drop the highlight
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="pr-search-results"
        aria-autocomplete="list"
        aria-activedescendant={activeId != null ? `pr-result-${activeId}` : undefined}
        aria-label="Search PRs by title or number"
        className="w-56 rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
      />
      {showPanel && (
        <div
          id="pr-search-results"
          role="listbox"
          aria-label="PR search results"
          className="absolute right-0 top-full z-[60] mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500">No matching PRs.</div>
          ) : (
            results.map((p, idx) => {
              const author = p.authorId != null ? usersById.get(p.authorId) : undefined;
              return (
                <button
                  key={p.id}
                  id={`pr-result-${p.id}`}
                  type="button"
                  role="option"
                  aria-selected={idx === active}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(p)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                    idx === active ? 'bg-gray-100 dark:bg-gray-800' : ''
                  } hover:bg-gray-100 dark:hover:bg-gray-800`}
                >
                  <span className="flex items-center gap-1 text-[10px] text-gray-400">
                    <Avatar user={author} size={12} />
                    <span className="truncate" title={userLabel(author, p.authorId)}>
                      {userLabel(author, p.authorId)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">
                      {reposById.get(p.repoId) ?? `repo ${p.repoId}`} · #{p.number}
                    </span>
                  </span>
                  <span className="truncate text-xs" title={p.title}>
                    {p.title}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

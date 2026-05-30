import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelinePr } from '@gh-team-monitor/shared';
import { useTimeline, useRepos } from '../hooks/useTimeline.js';
import { useOpenPrs } from '../hooks/useTriage.js';
import { useFilters } from '../store/filters.js';

// Sticky PR-title search. The query lives in the store (searchQuery /
// setSearchQuery), so it survives this component's re-renders, input blur, and
// PR selection — re-focusing the input re-shows the same results. The panel's
// open/closed state is local: results show only while the input is focused AND
// the query is non-empty; Escape / outside-click hides the panel but keeps the
// query. The filter is purely client-side over already-loaded data (it never
// feeds buildTimelineSearch), and picking a result (click or Enter) reuses
// openPrFocused — the same focus+glow path the timeline delivers.
export function TimelineSearch(): JSX.Element {
  const query = useFilters((s) => s.searchQuery);
  const setQuery = useFilters((s) => s.setSearchQuery);
  const openPrFocused = useFilters((s) => s.openPrFocused);

  const { data: timeline } = useTimeline();
  const { data: openPrs } = useOpenPrs();
  const { data: repos } = useRepos();

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
    return allPrs.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 30);
  }, [allPrs, query]);

  const showPanel = open && query.trim().length > 0;
  // Clamp the highlight to the current result set (it shrinks as you type).
  const activeId = active >= 0 && active < results.length ? results[active]!.id : null;

  // Outside-click hides the panel but never clears the query (sticky).
  useEffect(() => {
    if (!showPanel) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showPanel]);

  // Keep the keyboard-highlighted row scrolled into view within the panel.
  useEffect(() => {
    if (activeId == null) return;
    rootRef.current
      ?.querySelector(`#pr-result-${activeId}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const pick = (pr: TimelinePr | undefined): void => {
    if (!pr) return;
    openPrFocused(pr.id); // focus + glow (delivered by the timeline)
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
        placeholder="Search PR titles…"
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
        aria-label="Search PR titles"
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
            results.map((p, idx) => (
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
                <span className="text-[10px] text-gray-400">
                  {reposById.get(p.repoId) ?? `repo ${p.repoId}`} · #{p.number}
                </span>
                <span className="truncate text-xs" title={p.title}>
                  {p.title}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

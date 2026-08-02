import { useEffect } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Global shortcuts: `/` focus search, `j`/`k` cycle PRs (board only), `i` open the Activity
// console (per-repo insights now live there), `esc` leave the current tab/overlay → the
// board (or clear the selection when already on the board).
export function useKeyboard(): void {
  const { data } = useTimeline();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { selectedPrId, selectPr, clearSelection } = useFilters.getState();
      const tabsApi = usePinnedTabs.getState();
      const onBoard = tabsApi.activeTab === 'timeline';

      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        } else if (!onBoard) {
          // Any tab/overlay (Activity, pr-detail, pr-focus) → the plain board. The tab
          // stays open; this just re-shows the shared timeline.
          tabsApi.showTimeline();
        } else {
          clearSelection();
        }
        return;
      }
      if (isTypingTarget(e.target)) return;

      // `/` focuses the global search box, which is mounted on EVERY view (FilterBar). The
      // add-repo field is the fallback and only exists while the "Manage repos & workspaces"
      // modal (or first-run onboarding) is open — it used to be the sole target, which made the
      // shortcut a silent no-op everywhere else once repo management moved into that modal.
      if (e.key === '/') {
        e.preventDefault();
        const target =
          document.getElementById('add-repo-input') ??
          document.getElementById('global-search-input');
        target?.focus();
        return;
      }

      // Open the Activity console (per-repo insights + charts now live in its rail).
      if (e.key === 'i') {
        tabsApi.showActivity();
        return;
      }

      // j/k cycle the board's PRs only when the shared board is showing (they mutate
      // its selection; an isolated focus tab owns its own board).
      if (!onBoard) return;
      if (e.key === 'j' || e.key === 'k') {
        const prs = [...(data?.prs ?? [])].sort((a, b) =>
          b.openedAt.localeCompare(a.openedAt),
        );
        if (prs.length === 0) return;
        const idx = prs.findIndex((p) => p.id === selectedPrId);
        let next: number;
        if (idx === -1) next = 0;
        else next = e.key === 'j' ? idx + 1 : idx - 1;
        next = Math.max(0, Math.min(prs.length - 1, next));
        const target = prs[next];
        if (target) selectPr(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data]);
}

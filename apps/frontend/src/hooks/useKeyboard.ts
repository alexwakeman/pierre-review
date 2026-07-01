import { useEffect } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Global shortcuts: `/` focus filter, `j`/`k` cycle PRs (board only), `m` open the
// My Turn tab, `i` open Insights, `esc` leave the current tab/overlay → the board (or
// clear the selection when already on the board).
export function useKeyboard(): void {
  const { data } = useTimeline();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { selectedPrId, selectPr, clearSelection, setInsightsOpen } =
        useFilters.getState();
      const tabsApi = usePinnedTabs.getState();
      const onBoard = tabsApi.activeTab === 'timeline';

      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        } else if (!onBoard) {
          // Any tab/overlay (Inbox, pr-detail, pr-focus, my-turn) → the plain board.
          // The tab stays open; this just re-shows the shared timeline.
          tabsApi.showTimeline();
        } else {
          clearSelection();
        }
        return;
      }
      if (isTypingTarget(e.target)) return;

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('add-repo-input')?.focus();
        return;
      }

      // Open (or switch to) the My Turn tab — its own isolated triage timeline.
      if (e.key === 'm') {
        tabsApi.openMyTurnTab();
        return;
      }

      // Open the Insights panel.
      if (e.key === 'i') {
        setInsightsOpen(true);
        return;
      }

      // j/k cycle the board's PRs only when the shared board is showing (they mutate
      // its selection; an isolated focus/my-turn tab owns its own board).
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

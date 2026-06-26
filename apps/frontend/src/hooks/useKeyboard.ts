import { useEffect } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Global shortcuts: `/` focus filter, `j`/`k` cycle PRs, `m` enter My Turn focus,
// `i` open Insights, `esc` exit focus (PR-isolation or My Turn) / clear selection.
export function useKeyboard(): void {
  const { data } = useTimeline();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const {
        selectedPrId,
        selectPr,
        clearSelection,
        focusActive,
        exitFocus,
        myTurnOnly,
        enterMyTurnFocus,
        exitMyTurnFocus,
        setInsightsOpen,
      } = useFilters.getState();

      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        } else if (usePinnedTabs.getState().activeTab !== 'timeline') {
          // A pinned PR is showing full-screen — Escape returns to the board (the
          // tab stays pinned), taking precedence over focus/selection handling
          // (those concern the timeline, which is hidden behind the overlay).
          usePinnedTabs.getState().showTimeline();
        } else if (focusActive) {
          // In the PR-isolation focus overlay, Escape exits it exactly like the
          // on-canvas "Exit focus" button: the Timeline reacts to the bumped
          // exitFocusSignal to restore the rows, re-centre, and fade-glow the marker.
          // Selection is left intact (the detail pane stays put).
          exitFocus();
        } else if (myTurnOnly) {
          // In My Turn Focus Mode, Escape leaves it entirely → the Feed home: un-isolate
          // the board and clear any selection. (The browser Back button, by contrast,
          // steps one level: a To Do's PR detail → the To Do list → the Feed.)
          exitMyTurnFocus();
        } else {
          clearSelection();
        }
        return;
      }
      if (isTypingTarget(e.target)) return;

      // While a pinned PR tab is full-screen the board is hidden behind the overlay —
      // suppress the board-navigation shortcuts (j/k cycle, m My Turn focus) so they
      // don't silently mutate it out of sight. `/` (filter) + `i` (Insights) stay, as
      // their UI is still visible above the overlay.
      if (
        usePinnedTabs.getState().activeTab !== 'timeline' &&
        (e.key === 'j' || e.key === 'k' || e.key === 'm')
      ) {
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('add-repo-input')?.focus();
        return;
      }

      // Enter My Turn Focus Mode (mirrors the header "My Turn" pill): isolate the board
      // to your inbox + show the To Do list. From a drilled-in To Do it steps back to the
      // list; on the list it's a no-op. Suppressed during the PR-isolation overlay (that
      // lens owns the board). `clearSelection` is unused now but kept destructured above
      // for the Escape branch.
      if (e.key === 'm') {
        if (focusActive) return;
        enterMyTurnFocus();
        return;
      }

      // Open the Insights panel.
      if (e.key === 'i') {
        setInsightsOpen(true);
        return;
      }

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

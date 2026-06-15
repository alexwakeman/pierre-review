import { useEffect } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Global shortcuts: `/` focus filter, `j`/`k` cycle PRs, `m` toggle My Turn,
// `i` open Insights, `esc` clear selection / exit focus.
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
        exitMyTurnFocus,
        setInsightsOpen,
      } = useFilters.getState();

      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        } else if (focusActive) {
          // In the PR-isolation focus overlay, Escape exits it exactly like the
          // on-canvas "Exit focus" button: the Timeline reacts to the bumped
          // exitFocusSignal to restore the rows, re-centre, and fade-glow the marker.
          // Selection is left intact (the detail pane stays put).
          exitFocus();
        } else if (myTurnOnly) {
          // In My Turn Focus Mode, Escape leaves it: un-isolate the board back to the
          // full timeline, keeping any selection (it stays selected on the full board).
          exitMyTurnFocus();
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

      // Show the My Turn panel (clear the selection), mirroring the header pill — a
      // no-op in home, and in My Turn Focus Mode it re-shows the panel without leaving
      // focus. Suppressed during the PR-isolation overlay (the lens owns the board).
      if (e.key === 'm') {
        if (focusActive) return;
        clearSelection();
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

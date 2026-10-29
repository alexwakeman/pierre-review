import { useEffect, useRef } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useShell } from '../store/shell.js';
import { goTo, resolveGoChord } from '../components/shell/nav.js';
import { openCommandPalette } from '../components/ui/commands.js';
import { isTypingTarget, modalOpen, shortcutBlocked } from '../components/ui/keys.js';

// THE GLOBAL KEYS (docs/redesign/DESIGN.md § 8). ⌘K lives in CommandPalette (it works while
// typing); a list's j/k/↵/a/m/e/z live in `useListKeyboard`, owned by the page that has the list.
// Here:
//
//   /        the command palette (or the add-repo field while "Manage repos" is open)
//   ?        the key sheet
//   g + key  go to a page: p Pending · o Open pull requests · s This Sprint · t Timeline ·
//            r Reports · b Bots Monitoring · d Docs · f Feed (components/shell/nav.ts GO_KEYS)
//   i        Activity (kept from before the shell)
//   j / k    cycle the Timeline board's PRs by openedAt (the board only)
//   Esc      blur a field; off the board → the Timeline (the tab stays open); on it → clear the
//            selection. Every layer above (palette, drawer, menus, popovers, modals, the resolver)
//            takes Escape first in the capture phase and stops it (lib/activePopover.ts).
export function useKeyboard(): void {
  const { data } = useTimeline();
  // When `g` was pressed, for the chord (null = not armed).
  const goArmedAt = useRef<number | null>(null);

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

      // `/`: the add-repo field when "Manage repos & workspaces" (or first-run onboarding) is open
      // — that is what the reader is doing — else the command palette, which searches PRs, threads,
      // people and tickets as well as jumping anywhere (it replaced the FilterBar's search box).
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const addRepo = document.getElementById('add-repo-input');
        if (addRepo != null) {
          e.preventDefault();
          addRepo.focus();
          return;
        }
        if (modalOpen()) return;
        e.preventDefault();
        openCommandPalette();
        return;
      }

      if (shortcutBlocked(e)) return;

      if (e.key === '?') {
        e.preventDefault();
        useShell.getState().setShortcutsOpen(true);
        return;
      }

      // Activity (where it was last: its destination is remembered in the store).
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

  // g, then a letter — in the CAPTURE phase, so the letter never also reaches a list's own keys
  // (`o` opens a row on GitHub in a list; `g o` must only go to Open pull requests). Only the
  // chord's second key is stopped; every other key passes through untouched, and Escape is never
  // handled here (the layers above own it in their own capture listeners).
  useEffect(() => {
    const onChord = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || shortcutBlocked(e)) {
        goArmedAt.current = null;
        return;
      }
      const chord = resolveGoChord(goArmedAt.current, e.key, Date.now());
      goArmedAt.current = chord.armedAt;
      if (chord.go == null) return;
      e.preventDefault();
      e.stopPropagation();
      goTo(chord.go);
    };
    window.addEventListener('keydown', onChord, true);
    return () => window.removeEventListener('keydown', onChord, true);
  }, []);
}

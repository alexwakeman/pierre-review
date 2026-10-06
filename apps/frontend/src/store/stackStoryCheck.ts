import { create } from 'zustand';
import { resolveStoryTarget, storyTargetExpired, storyTargetFor, type StoryTarget } from '../lib/ticketShare.js';
import { useOpenPrsView } from './openPrsView.js';
import { useFilters } from './filters.js';

// The Open PRs ticket stacks' "Story check" panel: which stacks have it OPEN, and a pending jump to
// one from the PR pane ("See the whole story in Open PRs"). Collapsed by default; remembered for
// the session only (in memory, never storage or the URL), like the "Merged (n)" panel. The jump is
// a TRANSIENT request the Open PRs list answers once its stack is on the page (`takeTarget`).

interface StackStoryCheckState {
  open: ReadonlySet<string>;
  target: StoryTarget | null;
  toggle: (stackId: string) => void;
  /** Answer the pending jump if it names one of these stacks: opens that panel, clears the target. */
  takeTarget: (stackIds: readonly string[]) => string | null;
}

export const useStackStoryCheck = create<StackStoryCheckState>((set, get) => ({
  open: new Set<string>(),
  target: null,
  toggle: (id) => {
    const next = new Set(get().open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ open: next });
  },
  takeTarget: (stackIds) => {
    const { target, open } = get();
    if (target == null) return null;
    const now = Date.now();
    const hit = resolveStoryTarget(target, stackIds, now);
    if (hit == null) {
      // Expired: drop it so a later visit does not jump.
      if (storyTargetExpired(target, now)) set({ target: null });
      return null;
    }
    const next = new Set(open);
    next.add(hit);
    set({ open: next, target: null });
    return hit;
  },
}));

/**
 * From the PR pane: show the Open PRs tab with this ticket's stack in view and its Story check
 * open. Grouped view on, the stack expanded, and the tab's repo filter cleared (a ticket's PRs can
 * span repos, so a narrowed list could hide the stack).
 */
export function showStoryInOpenPrs(ticketKey: string): void {
  const target = storyTargetFor(ticketKey, Date.now());
  useStackStoryCheck.setState({ target });
  const view = useOpenPrsView.getState();
  if (view.view !== 'grouped') view.setView('grouped');
  for (const id of view.collapsed) {
    if (id.toUpperCase() === target.stackId.toUpperCase()) view.expand(id);
  }
  useFilters.getState().openOpenPrsDetail(null);
}

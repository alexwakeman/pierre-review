// THE ONE THREAD-STATE EDGE — the coloured left border (and the dot beside it) every thread card and
// inline thread pill wears, whatever its state. Resolved threads used to drop it (a transparent edge,
// a check mark, faded text), which made them the hardest cards to pick out while scrolling; now every
// state is drawn the same way and only the colour changes.
//
// Resolved is always green. An open thread a Claude (or Codex) run judged takes the AI signal colour,
// as its pills do; every other state keeps its DERIVED_STATE_META colour (`likely_addressed` stays the
// heuristic's blue, and its pill still says so).

import type { DerivedState } from '@pierre-review/shared';
import { DERIVED_STATE_META } from './ui.js';

/** The AI signal's non-text fill — edges and dots only, never text. */
export const AI_EDGE_COLOR = 'rgb(var(--ai-signal-fill))';

export function threadEdgeColor(state: DerivedState, aiJudged: boolean): string {
  if (state === 'resolved') return DERIVED_STATE_META.resolved.color;
  return aiJudged ? AI_EDGE_COLOR : DERIVED_STATE_META[state].color;
}

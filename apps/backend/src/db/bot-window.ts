// The ONE BotWindowKind → duration mapping. This ternary used to be copy-pasted at seven
// sites across queries.ts and ml-labels.ts; a divergence between any two of them would make
// two "same-window" surfaces silently measure different windows (the merged Bots table's ROI
// and severity columns share one window BY CONTRACT). Lives in its own tiny module — not in
// queries.ts — so ml-labels.ts can import it without deepening the deliberate queries ⇄
// ml-labels module cycle.
//
// rolling_14 and 'sprint' both use the 14-day trailing window: core can't read the account's
// configured sprint bounds — they live in Pro settings (pre-existing quirk, kept).
import type { BotWindowKind } from '@pierre-review/shared';

export function botWindowDays(window: BotWindowKind): number {
  return window === 'rolling_7' ? 7 : window === 'rolling_30' ? 30 : 14;
}

export function botWindowMs(window: BotWindowKind): number {
  return botWindowDays(window) * 86_400_000;
}

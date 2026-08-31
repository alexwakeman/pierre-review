// The ONE BotWindowKind → duration mapping. This ternary used to be copy-pasted at seven
// sites across queries.ts and ml-labels.ts; a divergence between any two of them would make
// two "same-window" surfaces silently measure different windows (the merged Bots table's ROI
// and severity columns share one window BY CONTRACT). Lives in its own tiny module — not in
// queries.ts — so ml-labels.ts can import it without deepening the deliberate queries ⇄
// ml-labels module cycle.
//
// rolling_14 and 'sprint' both use the 14-day trailing window: core can't read the account's
// configured sprint bounds — they live in Pro settings (pre-existing quirk, kept). A caller that
// DOES know them (the Pro Insights chat) passes explicit bounds to `getBotAnalytics` instead of
// relying on this mapping, so 'sprint' only means 14 days when nobody could do better.
import type { BotWindowKind } from '@pierre-review/shared';

// An explicit record rather than a ternary chain: a new BotWindowKind member is then a COMPILE
// ERROR here instead of silently falling through to 14 days. `rolling_90` was added for the
// Insights chat's 90d range and did exactly that under the old ternary.
const WINDOW_DAYS: Record<BotWindowKind, number> = {
  rolling_7: 7,
  rolling_14: 14,
  rolling_30: 30,
  rolling_90: 90,
  sprint: 14,
};

export function botWindowDays(window: BotWindowKind): number {
  return WINDOW_DAYS[window];
}

export function botWindowMs(window: BotWindowKind): number {
  return botWindowDays(window) * 86_400_000;
}

/**
 * 365.25 ÷ 12. The ONE factor that turns a rate measured over a window into a rate per month.
 *
 * ⚠ IT MUST EQUAL `DAYS_PER_MONTH` IN `packages/pro/src/bots/benchmark/cost.ts`, which the plugin
 * declares separately because production plugin code may only `import type` from `shared` and may
 * not import from core at all. Two numbers, one fact: if these ever diverge, the Bots → ROI table
 * and the Bots → Benchmark rollup will quote different money for the same bot at the same price,
 * one tab apart. `benchmark-cost.test.ts` pins the plugin's to six places; `bot-analytics` tests
 * pin this one.
 *
 * ⚠ AND IT IS LOAD-BEARING, NOT COSMETIC. `costPerActedOnUsd` shipped as `monthlyPrice ÷ actedOn`,
 * where `actedOn` is counted over the SELECTED WINDOW — a month's numerator over a fortnight's
 * denominator. On a real reviewer that read $2.23 beside the benchmark's $21.24 for the same bot
 * and the same $49, with no way for a reader to reconcile them, and it erred in the direction that
 * flatters the bot. Both figures are now monthly rates; they differ only by the window each was
 * measured over, which each surface states.
 */
export const DAYS_PER_MONTH = 30.44;

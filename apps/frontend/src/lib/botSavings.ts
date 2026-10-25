import type { BotVendorAnalytics, BotWindowKind } from '@pierre-review/shared';

// Bots → ROI: "what you could stop paying". ONE templated sentence per review bot that carries a
// price in this Workspace and whose threads the team rarely uses — no model, nothing generated.
//
// ⚠ IT READS THE ROI ROW'S OWN FIGURES AND NOTHING ELSE: `costMonthlyUsd` (the Workspace's
// effective monthly price, seat-adjusted on read) and `actedOnPct` (the panel's "used" share,
// over the window the picker chose). No new measure of "acted on" is invented here.
//
// ⚠ MONEY LIVES AT WORKSPACE GRAIN. The caller passes `showCost` — the ROI panel's own
// `repoId == null` — and on a repo-narrowed mount there is no line at all, exactly like the
// `$ per used thread` column. Every row of one response belongs to ONE Workspace, so nothing here
// can add prices across Workspaces; it does not total them at all.
//
// ⚠ WHERE THE PANEL HAS NO COST FIGURE, THIS SAYS NOTHING: no price, a $0 price, a dormant bot,
// no rate, or too few threads to judge.

/**
 * "Rarely used": fewer than this share of the bot's threads used (resolved, replied to, or a later
 * commit touched the file). The same cut as the ROI panel's "Rarely used" verdict, so the sentence
 * never contradicts the chip beside it.
 */
export const RARELY_USED_MAX_PCT = 30;

/** Fewer threads than this in the window and the share is too thin to suggest switching off —
 *  the same volume floor as the "Rarely used" verdict. */
export const RARELY_USED_MIN_THREADS = 10;

const WINDOW_PHRASE: Record<BotWindowKind, string> = {
  rolling_7: 'in the last 7 days',
  rolling_14: 'in the last 14 days',
  rolling_30: 'in the last 30 days',
  rolling_90: 'in the last 90 days',
  sprint: 'this sprint',
};

/** US$, whole dollars when whole, else cents; thousands separated. */
export function savingsUsd(v: number): string {
  const whole = Math.round(v * 100) % 100 === 0;
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/**
 * The sentence for one ROI row, or null when there is nothing honest to say.
 *
 * Annual = monthly × 12 (the stored price is a calendar-month price).
 */
export function stopPayingLine(
  v: Pick<BotVendorAnalytics, 'label' | 'threads' | 'actedOnPct' | 'costMonthlyUsd' | 'dormant' | 'verdict'>,
  window: BotWindowKind,
  showCost: boolean,
): string | null {
  if (!showCost) return null;
  const monthly = v.costMonthlyUsd;
  if (monthly == null || !Number.isFinite(monthly) || monthly <= 0) return null;
  // ⚠ Only beside a "Rarely used" chip (`verdict === 'noisy'`): the verdict also needs at least half
  // the threads unanswered, so the share and volume cuts alone would speak beside a "Tune" chip.
  if (v.verdict !== 'noisy') return null;
  if (v.dormant || v.threads < RARELY_USED_MIN_THREADS) return null;
  if (v.actedOnPct == null || v.actedOnPct >= RARELY_USED_MAX_PCT) return null;
  const pct = Math.round(v.actedOnPct);
  return (
    `${v.label} costs ${savingsUsd(monthly)} a month and your team used ${pct}% of its threads ` +
    `${WINDOW_PHRASE[window]}. Turning it off would save ${savingsUsd(monthly * 12)} a year.`
  );
}

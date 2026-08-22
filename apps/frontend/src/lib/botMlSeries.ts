// Pure series builders for the Bots → Behaviour tab's ML severity/category charts.
//
// Extracted from the panel because they are the part with real arithmetic in them — the mean
// severity ordinal, the union-of-weeks x-axis, and the per-category weekly fold over whatever
// subset of bots is selected — and none of it needs React to be checked. The panel keeps the
// rendering; these keep the maths (apps/frontend/test/botMlSeries.test.ts).
import type {
  BotBehaviourMlBot,
  MlCategory,
  MlSeverity,
  MlSeverityCounts,
} from '@pierre-review/shared';

/** nit=1 … critical=4 — the ordinal the "severity over time" line is plotted on. */
export const SEVERITY_ORDINAL: Record<MlSeverity, number> = {
  nit: 1,
  minor: 2,
  major: 3,
  critical: 4,
};

/** Stack order, LOW first: a stacked bar then reads nit at the bottom → critical on top. */
export const SEVERITY_STACK_ORDER: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];

export function severityTotal(c: MlSeverityCounts): number {
  return c.nit + c.minor + c.major + c.critical;
}

/**
 * A week's mean severity on the 1–4 ordinal, or null when the bot found nothing that week.
 *
 * Null rather than 0 for the same reason the density trend uses null: 0 is off the scale (there
 * is no severity below `nit`), so a zero would draw a line plunging to the floor on every quiet
 * week and turn "no findings" into "only trivia".
 */
export function meanSeverityOrdinal(c: MlSeverityCounts): number | null {
  const n = severityTotal(c);
  if (n === 0) return null;
  const sum =
    c.nit * SEVERITY_ORDINAL.nit +
    c.minor * SEVERITY_ORDINAL.minor +
    c.major * SEVERITY_ORDINAL.major +
    c.critical * SEVERITY_ORDINAL.critical;
  return sum / n;
}

/**
 * The shared x-axis: the union of every week any of these bots has a point for, ascending, last
 * 12. Union-of-weeks (not one bot's own array) is what lets the lines be compared — the density
 * chart does the same, and both read their `weekStart` strings from the same server-side array.
 */
export function mlWeekLabels(bots: BotBehaviourMlBot[]): string[] {
  const weeks = new Set<string>();
  for (const b of bots) for (const p of b.weekly) weeks.add(p.weekStart);
  return [...weeks].sort().slice(-12);
}

/**
 * Per-bot mean-severity values aligned to `labels` (null where that bot has no findings that
 * week, which breaks its line rather than dropping it to the floor).
 */
export function meanSeverityValues(bot: BotBehaviourMlBot, labels: string[]): (number | null)[] {
  const byWeek = new Map(bot.weekly.map((p) => [p.weekStart, p.bySeverity]));
  return labels.map((w) => {
    const counts = byWeek.get(w);
    return counts ? meanSeverityOrdinal(counts) : null;
  });
}

/** "12 findings · 7 nit / 3 minor / 2 major" — the hover detail behind one mean. */
export function severityBreakdownNote(c: MlSeverityCounts): string | null {
  const n = severityTotal(c);
  if (n === 0) return null;
  const parts = SEVERITY_STACK_ORDER.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return `${n} finding${n === 1 ? '' : 's'} · ${parts.join(' / ')}`;
}

/**
 * Weekly per-category counts summed over the SELECTED bots, aligned to `labels`.
 *
 * Returns only categories that actually occur (a chart of nine flat zero-lines is noise), each
 * with a real 0 where the week has none — unlike the severity mean, 0 is a true value here
 * ("nobody raised a security finding that week" is the point of the chart).
 */
export function categoryWeeklySeries(
  bots: BotBehaviourMlBot[],
  labels: string[],
): Array<{ category: MlCategory; values: number[]; total: number }> {
  const byCategory = new Map<MlCategory, number[]>();
  const index = new Map(labels.map((w, i) => [w, i]));
  for (const b of bots)
    for (const p of b.weekly) {
      const i = index.get(p.weekStart);
      if (i == null) continue; // a week outside the 12 the axis shows
      for (const { category, count } of p.byCategory) {
        let arr = byCategory.get(category);
        if (!arr) {
          arr = new Array<number>(labels.length).fill(0);
          byCategory.set(category, arr);
        }
        arr[i]! += count;
      }
    }
  return [...byCategory.entries()]
    .map(([category, values]) => ({
      category,
      values,
      total: values.reduce((a, c) => a + c, 0),
    }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

// ── The severity INFLATION INDEX ───────────────────────────────────────────────────────────────
// Per bot, how often its OWN badge disagrees with ours and which way. `vendorOverCall` is the bot
// grading a finding worse than we did (inflation); `vendorUnderCall` is us grading it worse than
// the bot did. Both are the SERVER's counts — folded from the same windowed scan the rest of the
// `ml` block is, through the one shared `vendorAgreementOf` rule — and nothing here re-derives
// them from anything else. The vendor badge is the thing being MEASURED here, never an input to
// our severity (0.474 vs 0.700 exact on the adjudicated gold-300).

/** Which side called it worse. Names the two directions the drill-down's `disagree` refinement
 *  takes, so a bar and the list it opens cannot mean different things. */
export type InflationDirection = 'over' | 'under';

/** One bar: the bot, the direction's count, and the denominator that count is out of. */
export interface InflationBar {
  /** `u<userId>` — the bot-subset legend's identity (the same key `MlBotView` joins on). */
  key: string;
  /** `users.id` — a member of the drill-down's `authorUserIds` refinement (one bar sends its own;
   *  the card-level "view all" sends every badged bar's, which is what keeps that button's total
   *  and the list it opens in step). Carried rather than parsed back out of `key`, because a
   *  second spelling of that format is how a bar and the list behind it come to describe
   *  different bots. */
  userId: number;
  label: string;
  /** vendorOverCall | vendorUnderCall — verbatim. */
  count: number;
  /** vendorDeclared: the badged findings this bot's count is out of. */
  declared: number;
}

export interface InflationSummary {
  /** Badged bots only, most-inflated first. */
  bars: InflationBar[];
  /** Σ count over `bars` — the population the card's "view all" opens (every badged bot). */
  total: number;
  /** Σ declared — the honest denominator of that total. */
  declared: number;
  /**
   * Bots with findings in the window but NOT ONE badge: excluded from `bars` on purpose, and
   * named so the exclusion is stated rather than silent.
   *
   * ⚠ A ZERO BAR WOULD BE A LIE. Badge coverage is vendor-shaped and wildly uneven — some bots
   * badge nearly every finding, several badge nothing at all — so a bot that never declares a
   * severity has no over-calls for the arithmetic reason that it has no calls. Drawn as a 0 it
   * reads "never inflates", which is the opposite of "we cannot tell". Same rule as the ROI
   * table's blanked ML columns: "not scored" and "zero" are different claims.
   */
  unbadged: string[];
}

/**
 * The bars for one direction, over the bots that declared at least one badge.
 *
 * Sorted by count desc (the reader's question is "who inflates most"), ties by label so the two
 * cards' bar order is stable across a refetch. A badged bot with a count of 0 STAYS — that zero
 * is a real measurement ("it badged 1,278 findings and agreed with us on every one"), unlike the
 * absent one above.
 */
export function inflationSummary(
  bots: Array<{ key: string; userId: number; label: string; ml: BotBehaviourMlBot }>,
  direction: InflationDirection,
): InflationSummary {
  const bars: InflationBar[] = [];
  const unbadged: string[] = [];
  for (const b of bots) {
    if (b.ml.vendorDeclared <= 0) {
      // Only bots that found SOMETHING are worth naming as an exclusion — a bot with no findings
      // at all in the window is absent from this whole block's story, not silent within it.
      if (b.ml.findings > 0) unbadged.push(b.label);
      continue;
    }
    bars.push({
      key: b.key,
      userId: b.userId,
      label: b.label,
      count: direction === 'over' ? b.ml.vendorOverCall : b.ml.vendorUnderCall,
      declared: b.ml.vendorDeclared,
    });
  }
  bars.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    bars,
    total: bars.reduce((n, b) => n + b.count, 0),
    declared: bars.reduce((n, b) => n + b.declared, 0),
    unbadged,
  };
}

/** Every category any of these bots used in-window, most-used first — the stacked bar's series. */
export function categoriesPresent(bots: BotBehaviourMlBot[]): MlCategory[] {
  const totals = new Map<MlCategory, number>();
  for (const b of bots)
    for (const { category, count } of b.byCategory)
      totals.set(category, (totals.get(category) ?? 0) + count);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
}

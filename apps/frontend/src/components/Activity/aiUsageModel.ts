import {
  AI_USAGE_FEATURE_GROUPS,
  AI_USAGE_GROUP_LABEL,
  formatTokens,
  type AiUsageCostUnit,
  type AiUsageDayBucket,
  type AiUsageFeatureGroup,
  type AiUsageFigures,
  type AiUsageWeek,
} from '@pierre-review/shared';
import { usageCostText } from '../../lib/aiBudget.js';
import { PALETTE, type Series } from '../charts/common.js';

// Reports → AI usage, the pure half (test/aiUsageModel.test.ts). The server folds and ranks; this
// file only re-buckets the day chart by week, picks colours and words the figures. Every cost goes
// through `usageCostText` (lib/aiBudget.ts), the ONE wording of a summed cost.

/** One colour per feature group, fixed so a group keeps its hue across both charts. */
export const GROUP_COLOR: Readonly<Record<AiUsageFeatureGroup, string>> = {
  code: PALETTE.blue,
  story: PALETTE.orange,
  ci: PALETTE.teal,
  fix: PALETTE.amber,
  chat: PALETTE.pink,
  diagrams: PALETTE.green,
  sprint: PALETTE.purple,
  docs: PALETTE.indigo,
  resolve: PALETTE.red,
  other: PALETTE.slate,
};

export const PROVIDER_COLOR = { claude: PALETTE.orange, codex: PALETTE.slate } as const;

export type UsageGrain = 'day' | 'week';

/** The Monday on or before a local date, as local midnight ms. */
function mondayOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * The usage chart's bars: one per day, or one per week (days folded onto their Monday), stacked by
 * feature group. Only groups with tokens get a series, in the fixed group order.
 */
export function usageChart(days: readonly AiUsageDayBucket[], grain: UsageGrain): { labels: string[]; series: Series[] } {
  const buckets: { start: string; tokens: Partial<Record<AiUsageFeatureGroup, number>> }[] = [];
  if (grain === 'day') buckets.push(...days);
  else {
    const byWeek = new Map<number, Partial<Record<AiUsageFeatureGroup, number>>>();
    for (const d of days) {
      const w = mondayOf(Date.parse(d.start));
      let acc = byWeek.get(w);
      if (acc == null) byWeek.set(w, (acc = {}));
      for (const [g, n] of Object.entries(d.tokens) as [AiUsageFeatureGroup, number][]) acc[g] = (acc[g] ?? 0) + n;
    }
    for (const [w, tokens] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
      buckets.push({ start: new Date(w).toISOString(), tokens });
    }
  }
  const present = AI_USAGE_FEATURE_GROUPS.filter((g) => buckets.some((b) => (b.tokens[g] ?? 0) > 0));
  return {
    labels: buckets.map((b) => b.start),
    series: present.map((g) => ({
      key: g,
      label: AI_USAGE_GROUP_LABEL[g],
      color: GROUP_COLOR[g],
      values: buckets.map((b) => b.tokens[g] ?? 0),
    })),
  };
}

/** "1.2M tokens · 3% of a week", "840 tokens". The cost is Claude's; absent when there is none. */
export function figuresText(f: Pick<AiUsageFigures, 'tokens' | 'claudeCost'>, unit: AiUsageCostUnit | null): string {
  const cost = usageCostText(f.claudeCost, unit);
  const tokens = `${formatTokens(f.tokens)} tokens`;
  return cost == null ? tokens : `${tokens} · ${cost}`;
}

/** "About 33k tokens · 2.1% of a week". */
export function savingText(f: Pick<AiUsageFigures, 'tokens' | 'claudeCost'>, unit: AiUsageCostUnit | null): string {
  return `About ${figuresText(f, unit)}`;
}

/** The 12 weeks' trend in words, from the server's least-squares slope (tokens a week). */
export function trendText(weeks: readonly AiUsageWeek[], slope: number | null): string | null {
  if (slope == null) return null;
  const complete = weeks.filter((w) => !w.partial);
  const mean = complete.reduce((n, w) => n + w.figures.tokens, 0) / Math.max(complete.length, 1);
  if (mean <= 0) return null;
  // Under 5% of a typical week, either way, reads as flat.
  if (Math.abs(slope) < mean * 0.05) return 'Steady over the 12 weeks';
  return `${slope > 0 ? 'Rising' : 'Falling'} by about ${formatTokens(Math.abs(slope))} tokens a week`;
}

/** The stated share of each provider, for a figures row: "Claude 80% · Codex 20%"; null for one. */
export function providerSplitText(f: AiUsageFigures): string | null {
  if (f.tokens <= 0 || f.claudeTokens === 0 || f.codexTokens === 0) return null;
  const c = Math.round((f.claudeTokens / f.tokens) * 100);
  return `Claude ${c}% · Codex ${100 - c}%`;
}

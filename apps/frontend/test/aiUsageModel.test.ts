import { describe, expect, it } from 'vitest';
import { aiUsageFeatureGroup, formatTokens, type AiUsageWeek } from '@pierre-review/shared';
import { figuresText, providerSplitText, savingText, trendText, usageChart } from '../src/components/Activity/aiUsageModel.js';
import { effectiveInsightsTab } from '../src/components/Activity/bottlenecksModel.js';
import { usageCostText } from '../src/lib/aiBudget.js';

// Reports → AI usage, the pure half: the week fold of the day chart, the one cost wording (never
// US$ on a subscription), the trend words, the feature groups and the tab literal.

const local = (y: number, m: number, d: number): string => new Date(y, m - 1, d).toISOString();

describe('the AI usage tab literal', () => {
  it('is a member the derive keeps', () => {
    expect(effectiveInsightsTab('ai-usage')).toBe('ai-usage');
  });
});

describe('usageChart', () => {
  const days = [
    { start: local(2026, 10, 19), tokens: { code: 100 } }, // Monday
    { start: local(2026, 10, 20), tokens: { code: 50, fix: 10 } },
    { start: local(2026, 10, 26), tokens: { story: 7 } }, // next Monday
  ];

  it('draws one bar a day, a series per group with tokens, in the fixed order', () => {
    const c = usageChart(days, 'day');
    expect(c.labels).toHaveLength(3);
    expect(c.series.map((s) => s.key)).toEqual(['code', 'story', 'fix']);
    expect(c.series[0]!.values).toEqual([100, 50, 0]);
  });

  it('folds days onto their Monday by week', () => {
    const c = usageChart(days, 'week');
    expect(c.labels).toEqual([local(2026, 10, 19), local(2026, 10, 26)]);
    expect(c.series.find((s) => s.key === 'code')!.values).toEqual([150, 0]);
    expect(c.series.find((s) => s.key === 'story')!.values).toEqual([0, 7]);
  });
});

describe('the cost wording', () => {
  it('is US$ on an API key and a share of a week on a subscription, never US$ there', () => {
    expect(usageCostText(4.1, 'usd')).toBe('US$4.10');
    expect(usageCostText(3.24, 'week_pct')).toBe('3.2% of a week');
    expect(usageCostText(3.24, 'week_pct')).not.toContain('$');
    expect(usageCostText(0, 'usd')).toBeNull();
    expect(usageCostText(2, null)).toBeNull();
  });

  it('puts tokens first and the cost after', () => {
    expect(figuresText({ tokens: 1_234_567, claudeCost: 2.5 }, 'week_pct')).toBe('1.2M tokens · 2.5% of a week');
    expect(figuresText({ tokens: 840, claudeCost: null }, null)).toBe('840 tokens');
    expect(savingText({ tokens: 33_000, claudeCost: 1.2 }, 'usd')).toBe('About 33k tokens · US$1.20');
  });

  it('spells token counts one way', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(42_400)).toBe('42k');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
});

describe('trendText', () => {
  const weeks = (ns: number[]): AiUsageWeek[] =>
    ns.map((n, i) => ({
      start: local(2026, 8, 3 + i * 7),
      partial: i === ns.length - 1,
      figures: { runs: 1, tokens: n, claudeTokens: n, codexTokens: 0, claudeCost: null },
    }));
  it('says rising, falling or steady from the slope', () => {
    expect(trendText(weeks([100, 200, 300, 0]), 100)).toBe('Rising by about 100 tokens a week');
    expect(trendText(weeks([300, 200, 100, 0]), -100)).toBe('Falling by about 100 tokens a week');
    expect(trendText(weeks([1000, 1000, 1010, 0]), 5)).toBe('Steady over the 12 weeks');
    expect(trendText(weeks([1, 2]), null)).toBeNull();
  });
});

describe('providerSplitText', () => {
  it('names both providers only when both ran', () => {
    expect(providerSplitText({ runs: 2, tokens: 100, claudeTokens: 80, codexTokens: 20, claudeCost: null })).toBe('Claude 80% · Codex 20%');
    expect(providerSplitText({ runs: 1, tokens: 100, claudeTokens: 100, codexTokens: 0, claudeCost: null })).toBeNull();
  });
});

describe('aiUsageFeatureGroup', () => {
  it('maps every recorded feature to its group', () => {
    const cases: Record<string, string> = {
      claude_review: 'code',
      'claude_review:security': 'code',
      claude_review_merge: 'code',
      replies_check: 'code',
      thread_check: 'code',
      ticket_review: 'story',
      story_labels: 'story',
      ci_review: 'ci',
      ai_fix: 'fix',
      ai_fix_plan: 'fix',
      claude_review_chat: 'chat',
      sequence_diagram: 'diagrams',
      sprint_briefs: 'sprint',
      sprint_paths: 'sprint',
      sprint_ask: 'sprint',
      sprint_report: 'other',
      reference_docs_build: 'docs',
      docs_figure_describe: 'docs',
      story_docs_alignment: 'docs',
      ai_resolve: 'resolve',
      digest: 'other',
      annotation_impact: 'other',
    };
    for (const [f, g] of Object.entries(cases)) expect(aiUsageFeatureGroup(f), f).toBe(g);
  });
});

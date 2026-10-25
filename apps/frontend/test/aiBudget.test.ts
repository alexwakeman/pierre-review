import { describe, expect, it } from 'vitest';
import type { AiBudgetResponse, AiBudgetStatus, AiBudgetSubscriptionStatus, AiUsageView } from '@pierre-review/shared';
import {
  fiveHourUsedSentence,
  headerUsageOf,
  runCostText,
  usageDetailOf,
  formatResume,
  formatSharePct,
  formatUsd,
  meterText,
  pausedSentence,
  reviewsPerDayText,
  runButtonsIn,
  usedSentence,
} from '../src/lib/aiBudget.js';

const sub = (over: Partial<AiBudgetSubscriptionStatus> = {}): AiBudgetSubscriptionStatus => ({
  subscription: 'max20x',
  subscriptionSource: 'picked',
  reportedSubscription: 'max',
  pickFrom: ['max5x', 'max20x'],
  sharePct: 5,
  usedSharePct: 2,
  reviewsPerDay: 25,
  window: 'reset',
  weekResetsAt: null,
  fiveHourSharePct: 5,
  fiveHourFollowsWeek: true,
  fiveHourUsedSharePct: 1,
  fiveHourWindow: 'rolling',
  fiveHourResetsAt: null,
  ...over,
});

const status = (over: Partial<AiBudgetStatus>): AiBudgetStatus => ({
  enabled: true,
  mode: 'subscription',
  route: 'login',
  subscription: sub(),
  apiKey: null,
  overBudget: false,
  limitedBy: null,
  reason: null,
  resumesAt: null,
  ...over,
});

describe('the Claude spend meter', () => {
  it('says nothing while the budget is off', () => {
    expect(meterText(status({ enabled: false, mode: 'off', subscription: null }))).toBeNull();
  });

  it('subscription: Limn’s share in percentages, never US$', () => {
    const t = meterText(status({}));
    expect(t).toBe('Limn: 2% of your week · limit 5%');
    expect(t).not.toMatch(/\$/);
    expect(meterText(status({ subscription: sub({ usedSharePct: 0.3 }) }))).toBe('Limn: under 1% of your week · limit 5%');
  });

  it('subscription not known yet: asks for it, never reads as zero', () => {
    expect(meterText(status({ subscription: sub({ subscription: null, usedSharePct: null, reviewsPerDay: null }) }))).toBe(
      'Limn: pick your subscription',
    );
    expect(usedSentence(status({ subscription: sub({ subscription: null, usedSharePct: null }) }))).toBeNull();
  });

  it('API key: this week in US$', () => {
    const s = status({ mode: 'api_key', route: 'api_key', subscription: null, apiKey: { weeklyUsd: 25, usedUsd: 4.1 } });
    expect(meterText(s)).toBe('This week $4.10 of $25');
  });

  it('says over budget when the server does', () => {
    expect(meterText(status({ overBudget: true }))).toBe('Over budget');
  });

  it('words the share, the reviews a day and the money', () => {
    expect(usedSentence(status({}))).toBe('Limn has used 2% of your week');
    expect(formatSharePct(0)).toBe('0%');
    expect(formatSharePct(4.6)).toBe('5%');
    expect(reviewsPerDayText(25)).toBe('about 25 automatic reviews a working day');
    expect(reviewsPerDayText(1)).toBe('about 1 automatic review a working day');
    expect(reviewsPerDayText(0)).toBe('under one automatic review a working day');
    expect(reviewsPerDayText(null)).toBeNull();
    expect(reviewsPerDayText(Number.NaN)).toBeNull();
    expect(formatUsd(4.1)).toBe('$4.10');
    expect(formatUsd(1650)).toBe('$1,650');
  });

  it('the toast: "Limn has used its share of your week. Automatic runs resume …"', () => {
    const now = Date.parse('2026-10-24T09:00:00');
    expect(formatResume(new Date('2026-10-24T14:30:00').toISOString(), now)).toBe('14:30');
    expect(formatResume(null, now)).toBe('');
    expect(pausedSentence(status({ overBudget: true, resumesAt: new Date('2026-10-24T14:30:00').toISOString() }), now)).toBe(
      'Limn has used its share of your week. Automatic runs resume 14:30.',
    );
    expect(pausedSentence(status({ overBudget: true, resumesAt: null }), now)).toBe(
      'Limn has used its share of your week. Automatic runs are paused.',
    );
    expect(pausedSentence(status({ mode: 'api_key', overBudget: true }), now)).toMatch(/^Limn has used its weekly budget\./);
  });
});

describe('runButtonsIn: only the Run control takes the over-budget second press', () => {
  const fake = (buttons: Array<{ name: string; run?: boolean }>) => ({
    querySelectorAll: (sel: string) =>
      buttons.filter((b) => (sel === 'button[data-ai-run]' ? b.run === true : true)) as never,
  });
  it('marked buttons win; an unmarked gate counts its ONLY button; several unmarked hold nothing', () => {
    const marked = fake([{ name: 'info' }, { name: 'run', run: true }, { name: 'discard' }]);
    expect(runButtonsIn(marked).map((b) => (b as unknown as { name: string }).name)).toEqual(['run']);
    expect(runButtonsIn(fake([{ name: 'run' }])).length).toBe(1);
    expect(runButtonsIn(fake([{ name: 'a' }, { name: 'b' }]))).toEqual([]);
  });
});

const usage = (over: Partial<AiUsageView> = {}): AiUsageView => ({
  route: 'login',
  account: {
    reportedSubscription: 'max',
    subscription: 'max20x',
    fiveHour: { key: 'five_hour', label: null, usedPct: 12, resetsAt: '2026-10-24T12:00:00.000Z', observedAt: '2026-10-24T08:56:00.000Z' },
    week: { key: 'seven_day', label: null, usedPct: 31, resetsAt: '2026-10-28T00:00:00.000Z', observedAt: '2026-10-24T08:56:00.000Z' },
    models: [
      { key: 'seven_day_opus', label: 'Opus', usedPct: 9, resetsAt: '2026-10-28T00:00:00.000Z', observedAt: '2026-10-24T08:56:00.000Z' },
    ],
    observedAt: '2026-10-24T08:56:00.000Z',
  },
  limn: {
    weekFrom: '2026-10-21T00:00:00.000Z',
    window: 'reset',
    runs: 24,
    inputTokens: 1_008_000,
    outputTokens: 74_400,
    weekSharePct: 2,
    fiveHourSharePct: 0.4,
  },
  apiKey: null,
  weekPctPerUsd: 100 / 1650,
  ...over,
});

const resp = (s: Partial<AiBudgetStatus>, u: Partial<AiUsageView> = {}): AiBudgetResponse => ({
  settings: { enabled: true, weekSharePct: 5, fiveHourSharePct: null, subscription: 'max20x', weeklyUsd: null },
  isDefault: false,
  status: status(s),
  usage: usage(u),
});

describe('a run’s cost (US$ on an API key, the share of the week on a subscription)', () => {
  it('subscription: a share of the week, never US$', () => {
    expect(runCostText(4.95, usage())).toBe('0.3% of your week');
    expect(runCostText(0.01, usage())).toBe('<0.1% of your week');
    expect(runCostText(4.95, usage())).not.toMatch(/\$/);
  });
  it('subscription not known: nothing', () => {
    expect(runCostText(0.42, usage({ weekPctPerUsd: null }))).toBeNull();
  });
  it('API key: US$', () => {
    expect(runCostText(0.42, usage({ route: 'api_key', account: null, weekPctPerUsd: null }))).toBe('US$0.42');
  });
  it('no answer yet, no credential, or no cost: nothing', () => {
    expect(runCostText(0.42, undefined)).toBeNull();
    expect(runCostText(0.42, usage({ route: 'none', account: null }))).toBeNull();
    expect(runCostText(null, usage())).toBeNull();
  });
});

describe('the 5-hour share', () => {
  it('words the session line and the paused toast by the limit that paused runs', () => {
    expect(fiveHourUsedSentence(status({}))).toBe('This 5-hour session: Limn has used 1% (limit 5%)');
    expect(fiveHourUsedSentence(status({ subscription: sub({ fiveHourUsedSharePct: null }) }))).toBeNull();
    const now = Date.parse('2026-10-24T09:00:00');
    expect(
      pausedSentence(
        status({ overBudget: true, limitedBy: 'five_hour', resumesAt: new Date('2026-10-24T11:15:00').toISOString() }),
        now,
      ),
    ).toBe('Limn has used its share of this 5-hour session. Automatic runs resume 11:15.');
  });
});

describe('the header usage item', () => {
  it('budget on: the share of Limn’s week used, or the 5-hour session when that is closer', () => {
    expect(headerUsageOf(resp({}))).toMatchObject({ label: 'AI quota for Limn:', figure: '40%', tone: 'normal' });
    expect(headerUsageOf(resp({}))?.title).toMatch(/your week/);
    const five = headerUsageOf(resp({ subscription: sub({ fiveHourUsedSharePct: 4.5 }) }));
    expect(five).toMatchObject({ figure: '90%', tone: 'near' });
    expect(five?.title).toMatch(/5-hour session/);
  });
  it('over: names the limit the server said', () => {
    const h = headerUsageOf(resp({ overBudget: true, limitedBy: 'five_hour', subscription: sub({ fiveHourUsedSharePct: 5.2 }) }));
    expect(h?.tone).toBe('over');
    expect(h?.title).toMatch(/5-hour/);
  });
  it('budget off: Claude’s own weekly figure; nothing read: no figure', () => {
    expect(headerUsageOf(resp({ enabled: false, mode: 'off', subscription: null }))).toMatchObject({ label: 'Claude this week:', figure: '31%' });
    const none = usage();
    none.account = { ...none.account!, week: null };
    expect(headerUsageOf({ ...resp({ enabled: false, mode: 'off', subscription: null }), usage: none })?.figure).toBeNull();
  });
  it('API key: % of the weekly budget, or this week’s US$ with no budget; no credential: nothing', () => {
    const k = { route: 'api_key' as const, account: null, weekPctPerUsd: null, apiKey: { weekUsd: 4.1, fiveHourUsd: 1, todayUsd: 2 } };
    expect(
      headerUsageOf(resp({ mode: 'api_key', route: 'api_key', subscription: null, apiKey: { weeklyUsd: 25, usedUsd: 4.1 } }, k))?.figure,
    ).toBe('16%');
    expect(headerUsageOf(resp({ enabled: false, mode: 'off', route: 'api_key', subscription: null }, k))?.figure).toBe('US$4.10');
    expect(headerUsageOf(resp({ route: 'none' }, { route: 'none', account: null }))).toBeNull();
  });
});

describe('the usage popover', () => {
  const now = Date.parse('2026-10-24T09:00:00.000Z');
  it('subscription: Limn’s share with limits, Claude’s windows, runs and tokens; no US$', () => {
    const d = usageDetailOf(resp({}), now);
    expect(d.heading).toBe('Claude Max 20x');
    const flat = d.sections.flatMap((s) => s.rows.map((r) => `${r.label}: ${r.value}`));
    expect(flat).toContain('This week: 2% of your week · limit 5%');
    expect(flat).toContain('This 5-hour session: 0.4% of the session · limit 5%');
    expect(flat).toContain('Runs this week: 24');
    expect(flat).toContain('Tokens this week: 1.0M in · 74.4k out');
    expect(flat.some((r) => r.startsWith('5-hour session: 12% used · 88% left · resets'))).toBe(true);
    expect(flat.some((r) => r.startsWith('Opus, week: 9% used'))).toBe(true);
    expect(d.updated).toBe('Updated 4 min ago');
    expect(JSON.stringify(d)).not.toMatch(/\$/);
  });
  it('bars: Limn rows fill against their limit, account rows show Claude’s own use; counts have none', () => {
    const rows = usageDetailOf(resp({}), now).sections.flatMap((s) => s.rows);
    const bar = (label: string) => rows.find((r) => r.label === label)?.barPct;
    expect(bar('This week')).toBe(40);
    expect(bar('5-hour session')).toBe(12);
    expect(bar('Runs this week')).toBeUndefined();
    expect(rows.every((r) => r.barPct == null || (r.barPct >= 0 && r.barPct <= 100))).toBe(true);
  });
  it('unknown pieces are left out, never 0', () => {
    const u = usage({ weekPctPerUsd: null });
    u.account = { reportedSubscription: null, subscription: null, fiveHour: null, week: null, models: [], observedAt: null };
    u.limn = { ...u.limn, inputTokens: null, outputTokens: null, weekSharePct: null, fiveHourSharePct: null };
    const d = usageDetailOf({ ...resp({ enabled: false, mode: 'off', subscription: null }), usage: u }, now);
    expect(d.heading).toBe('Claude');
    expect(d.sections.map((s) => s.title)).toEqual(['Limn’s runs']);
    expect(d.sections[0]!.rows.map((r) => r.label)).toEqual(['Runs this week']);
    expect(d.updated).toBeNull();
  });
  it('API key: US$ this week against the budget, last 5 hours, today', () => {
    const d = usageDetailOf(
      resp(
        { mode: 'api_key', route: 'api_key', subscription: null, apiKey: { weeklyUsd: 25, usedUsd: 4.1 } },
        { route: 'api_key', account: null, weekPctPerUsd: null, apiKey: { weekUsd: 4.1, fiveHourUsd: 1, todayUsd: 2 } },
      ),
      now,
    );
    expect(d.heading).toBe('Anthropic API key');
    const flat = d.sections.flatMap((s) => s.rows.map((r) => `${r.label}: ${r.value}`));
    expect(flat).toContain('Last 7 days: US$4.10 of US$25.00 · 16%');
    expect(flat).toContain('Last 5 hours: US$1.00');
    expect(flat).toContain('Today: US$2.00');
  });
});

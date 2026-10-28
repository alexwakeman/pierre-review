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
  otherAiProvider,
  otherReadingWanted,
  usageForRun,
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
    weekResetsAt: '2026-10-28T00:00:00.000Z',
    fiveHourFrom: '2026-10-24T07:00:00.000Z',
    fiveHourWindow: 'reset',
    fiveHourResetsAt: '2026-10-24T12:00:00.000Z',
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
  it('a run is judged by its OWN provider: the other provider’s reading says nothing about it', () => {
    // A Claude run on the Claude reading (absent provider = Claude) reads as before.
    expect(runCostText(4.95, usage(), 'claude')).toBe('0.3% of your week');
    // A Codex run is never judged by Claude's week, and a Claude run never by Codex's.
    expect(runCostText(0, usage(), 'codex')).toBeNull();
    expect(runCostText(4.95, usage({ provider: 'codex', weekPctPerUsd: null }), 'claude')).toBeNull();
  });
  it('a Codex run on a ChatGPT sign-in: never US$, nothing at all (no price, no per-run share)', () => {
    expect(runCostText(0, usage({ provider: 'codex', weekPctPerUsd: null }), 'codex')).toBeNull();
    expect(runCostText(0, usage({ provider: 'codex', weekPctPerUsd: 0.5 }), 'codex')).toBeNull();
  });
});

describe('a run of the OTHER provider is priced by its own reading', () => {
  // The bug: default Codex, Claude on an API key; a run the reader picked on Claude Opus showed no
  // US$, because only the default's reading was ever read.
  it('picks the run provider’s own reading, the default’s when absent', () => {
    const claudeKey = usage({ route: 'api_key', account: null, weekPctPerUsd: null });
    const codex = usage({ provider: 'codex', weekPctPerUsd: null });
    const readings = { default: codex, other: claudeKey };
    expect(otherAiProvider('codex')).toBe('claude');
    expect(otherAiProvider('claude')).toBe('codex');
    expect(runCostText(0.42, usageForRun('claude', 'codex', readings), 'claude')).toBe('US$0.42');
    expect(usageForRun('codex', 'codex', readings)).toBe(codex);
    expect(usageForRun(null, 'codex', readings)).toBe(codex);
    // The other reading not read yet: nothing, never the default's figure.
    expect(runCostText(0.42, usageForRun('claude', 'codex', { default: codex, other: undefined }), 'claude')).toBeNull();
  });
  it('reads the other provider only while it holds a credential', () => {
    const me = (claudeRoute: 'login' | 'api_key' | 'none', codexRoute: 'login' | 'api_key' | 'none', enabled = true) =>
      ({ ai: { enabled, providers: { claude: { route: claudeRoute }, codex: { route: codexRoute } } } }) as never;
    expect(otherReadingWanted(me('api_key', 'login'), 'claude')).toBe(true);
    expect(otherReadingWanted(me('none', 'login'), 'claude')).toBe(false);
    expect(otherReadingWanted(me('login', 'login'), 'codex')).toBe(true);
    expect(otherReadingWanted(me('login', 'none'), 'codex')).toBe(false);
    expect(otherReadingWanted(me('login', 'login', false), 'codex')).toBe(false);
    expect(otherReadingWanted(undefined, 'codex')).toBe(false);
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
    expect(flat).toContain('This week: 2% · limit 5%');
    expect(flat).toContain('This 5-hour session: 0.4% · limit 5%');
    // The provider's own resets, plainly.
    const rows = d.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.label === 'This week')?.note).toMatch(/^Resets \w{3} \d{2}:\d{2}$/);
    expect(rows.find((r) => r.label === 'This 5-hour session')?.note).toMatch(/^Resets \d{2}:\d{2}$/);
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
    expect(bar('This 5-hour session')).toBe(8);
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
    expect(d.sections.map((s) => s.title)).toEqual(['Limn’s share']);
    expect(d.sections[0]!.rows.map((r) => r.label)).toEqual(['Runs this week']);
    expect(d.updated).toBeNull();
  });
  it('no limit set: a bar anyway, against the 50% most Limn can be given', () => {
    const d = usageDetailOf(resp({ enabled: false, mode: 'off', subscription: null }), now);
    const rows = d.sections.flatMap((s) => s.rows);
    const week = rows.find((r) => r.label === 'This week')!;
    expect(week.value).toBe('2% · max 50%');
    expect(week.barPct).toBe(4);
    const five = rows.find((r) => r.label === 'This 5-hour session')!;
    expect(five.value).toBe('0.4% · max 50%');
    expect(five.barPct).toBeCloseTo(0.8, 5);
    expect(JSON.stringify(d)).not.toMatch(/\$/);
  });
  it('no reset known (or an older server): the rolling window, named', () => {
    const u = usage();
    u.limn = { ...u.limn, window: 'rolling', weekResetsAt: null, fiveHourWindow: 'rolling', fiveHourResetsAt: null };
    const rows = usageDetailOf({ ...resp({}), usage: u }, now).sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.label === 'This week')?.note).toBe('Last 7 days');
    expect(rows.find((r) => r.label === 'This 5-hour session')?.note).toBe('Last 5 hours');
  });
  it('every provider in use gets its own block, the default first', async () => {
    const { usageDetailsOf } = await import('../src/lib/aiBudget.js');
    const codexUsage = usage({ provider: 'codex', weekPctPerUsd: null });
    codexUsage.account = { ...codexUsage.account!, reportedSubscription: 'plus', subscription: null, models: [] };
    const codexStatus = status({ provider: 'codex', enabled: false, mode: 'off', subscription: null });
    const all = usageDetailsOf({ ...resp({}), others: [{ provider: 'codex', status: codexStatus, usage: codexUsage }] }, now);
    expect(all.map((d) => [d.provider, d.heading])).toEqual([
      ['claude', 'Claude Max 20x'],
      ['codex', 'Codex · ChatGPT Plus'],
    ]);
    // Both draw Limn's bars: Claude's against its limit, Codex's (no limit) against 50%.
    const bars = all.map((d) => d.sections[0]!.rows.filter((r) => r.barPct != null).map((r) => r.label));
    expect(bars).toEqual([
      ['This 5-hour session', 'This week'],
      ['This 5-hour session', 'This week'],
    ]);
    expect(JSON.stringify(all)).not.toMatch(/\$/);
    // An older server sends no `others`: just the default.
    expect(usageDetailsOf(resp({}), now)).toHaveLength(1);
  });
  it('a signed-out default hands the header and the popover to a signed-in other provider', async () => {
    const { usageDetailsOf } = await import('../src/lib/aiBudget.js');
    const codexUsage = usage({ provider: 'codex', weekPctPerUsd: null });
    codexUsage.account = { ...codexUsage.account!, reportedSubscription: 'plus', subscription: null, models: [] };
    const codexStatus = status({ provider: 'codex', enabled: false, mode: 'off', subscription: null });
    const claudeNone = usage({ route: 'none', account: null });
    claudeNone.limn = { ...claudeNone.limn, runs: 0, weekSharePct: null, fiveHourSharePct: null };
    const data = {
      ...resp({ route: 'none', enabled: false, mode: 'off', subscription: null }, claudeNone),
      others: [{ provider: 'codex' as const, status: codexStatus, usage: codexUsage }],
    };
    expect(headerUsageOf(data)).not.toBeNull();
    const all = usageDetailsOf(data, now);
    expect(all.map((d) => d.heading)).toEqual(['Codex · ChatGPT Plus']);
    expect(all[0]!.hasLimnShare).toBe(true);
    // Nobody signed in, nothing run: nothing shows.
    expect(headerUsageOf({ ...data, others: [] })).toBeNull();
  });
  it('the ⓘ sits on the first block with Limn’s share, not on an API key block', async () => {
    const { usageDetailsOf } = await import('../src/lib/aiBudget.js');
    const codexUsage = usage({ provider: 'codex', weekPctPerUsd: null });
    const codexStatus = status({ provider: 'codex', enabled: false, mode: 'off', subscription: null });
    const all = usageDetailsOf(
      {
        ...resp(
          { mode: 'off', enabled: false, route: 'api_key', subscription: null },
          { route: 'api_key', account: null, weekPctPerUsd: null, apiKey: { weekUsd: 4.1, fiveHourUsd: 1, todayUsd: 2 } },
        ),
        others: [{ provider: 'codex', status: codexStatus, usage: codexUsage }],
      },
      now,
    );
    expect(all.map((d) => d.hasLimnShare)).toEqual([false, true]);
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

describe('the ChatGPT plan and the setup button name the right thing', () => {
  it('capitalises the plan the same way everywhere', async () => {
    const { chatGptPlanLabel } = await import('../src/lib/aiBudget.js');
    expect(chatGptPlanLabel('plus')).toBe('ChatGPT Plus');
  });
  it('the Codex setup button states Codex’s size; Claude’s stays as it was', async () => {
    const { aiSetupLabel, AI_SETUP_LABEL } = await import('../src/lib/aiCapabilities.js');
    expect(aiSetupLabel('claude')).toBe(AI_SETUP_LABEL);
    expect(aiSetupLabel(null)).toBe(AI_SETUP_LABEL);
    expect(aiSetupLabel('codex')).toContain('360 MB');
  });
});

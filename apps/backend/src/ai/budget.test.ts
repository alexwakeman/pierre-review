// THE CLAUDE SPEND BUDGET (ai/budget.ts): the ONE decision (Limn's share of the week and of the
// 5-hour session; the API key's weekly US$), the header's usage view, the subscription rule, the reading fold and probe parser (each with its own scale),
// reviews a day, the gate's log-once rule, and — on a throwaway SQLite file — the settings round-trip, the ledger read
// and the persisted reading.
//
//   pnpm --filter @pierre-review/backend test ai/budget
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_CYCLE_COST_FALLBACKS,
  SUBSCRIPTION_ESTIMATES,
  aiBudgetSettingsView,
  aiUsageView,
  formatSharePct,
  runWeekShareText,
  cycleCostUsd,
  resolveAiBudgetSettings,
  resolveAiSubscription,
  reviewsPerDayFor,
  validateAiBudgetBody,
  type AiBudgetSettings,
  type AiBudgetStatus,
  type AiUsageReading,
} from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-ai-budget'}.ai-budget.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let B: typeof import('./budget.js');
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const H = 60 * 60 * 1000;
const D = 24 * H;
const eqId = (id: number) => eq(schema.accounts.id, id);
const on = (over: Partial<AiBudgetSettings> = {}): AiBudgetSettings =>
  resolveAiBudgetSettings({ enabled: true, ...over });
const NO_COSTS = { reviewMeanUsd: null, diagramMeanUsd: null, autoDiagrams: false };
const decide = (over: Partial<Parameters<typeof import('./budget.js').decideAiBudget>[0]> = {}) =>
  B.decideAiBudget({ settings: on(), route: 'login', reading: null, ledger: [], costs: NO_COSTS, nowMs: NOW, ...over });
const reading = (sub: string | null, resetsAtMs: number | null, utilization: number | null = 30): AiUsageReading => ({
  subscriptionType: sub,
  week: { utilization, resetsAtMs, observedAtMs: NOW - 60_000 },
});
/** Every key anywhere in a value, for the "no US$ on a subscription" check. */
const keysDeep = (v: unknown): string[] =>
  v && typeof v === 'object'
    ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysDeep(x)])
    : [];

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  B = await import('./budget.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => B._resetAiBudgetForTest());

describe('decideAiBudget — off', () => {
  it('⚠ switched off never blocks, whatever the spend', () => {
    const s = decide({ settings: resolveAiBudgetSettings(null), route: 'api_key', ledger: [{ atMs: NOW - H, usd: 10_000 }] });
    expect(s).toMatchObject({ enabled: false, mode: 'off', overBudget: false, subscription: null, apiKey: null });
  });

  it('no credential is off too', () => {
    const s = decide({ route: 'none' });
    expect(s.mode).toBe('off');
    expect(s.overBudget).toBe(false);
  });
});

describe('decideAiBudget — Limn’s share of the week (subscription)', () => {
  const pro = SUBSCRIPTION_ESTIMATES.pro.week; // 170

  it('share = Limn’s own spend in the week ÷ the weekly allowance; over at the setting', () => {
    // Claude says Pro; the week resets in 2 days; 5% of $170 = $8.50. The spend is 6 hours old, so
    // the 5-hour share (rolling here: no 5-hour reading) is not involved.
    const r = reading('pro', NOW + 2 * D);
    const under = decide({ reading: r, ledger: [{ atMs: NOW - 6 * H, usd: 8.4 }] });
    expect(under.mode).toBe('subscription');
    expect(under.subscription).toMatchObject({ subscription: 'pro', subscriptionSource: 'reading', sharePct: 5, window: 'reset' });
    expect(under.subscription!.usedSharePct).toBeCloseTo((8.4 / pro) * 100, 2);
    expect(under.overBudget).toBe(false);
    const over = decide({ reading: r, ledger: [{ atMs: NOW - 6 * H, usd: 8.5 }] });
    expect(over.overBudget).toBe(true);
    expect(over.limitedBy).toBe('week');
    expect(over.reason).toBe('Limn has used its share of your week.');
    // Reset-anchored: automatic runs resume at the reset.
    expect(over.resumesAt).toBe(new Date(NOW + 2 * D).toISOString());
    // The reader's share is the line.
    expect(decide({ settings: on({ weekSharePct: 10 }), reading: r, ledger: [{ atMs: NOW - 6 * H, usd: 8.5 }] }).overBudget).toBe(false);
  });

  it('⚠ Claude’s own weekly figure never blocks — only Limn’s own spend counts', () => {
    const s = decide({ reading: reading('pro', NOW + D, 99), ledger: [] });
    expect(s.overBudget).toBe(false);
    expect(s.subscription!.usedSharePct).toBe(0);
  });

  it('reset-anchored week: [reset − 7 days, reset) — spend before the week began does not count', () => {
    const resetMs = NOW + 2 * D; // the week began 5 days ago
    const ledger = [
      { atMs: NOW - 6 * D, usd: 100 }, // last week
      { atMs: NOW - 4 * D, usd: 1.7 },
    ];
    const s = decide({ reading: reading('pro', resetMs), ledger });
    expect(s.subscription!.window).toBe('reset');
    expect(s.subscription!.weekResetsAt).toBe(new Date(resetMs).toISOString());
    expect(s.subscription!.usedSharePct).toBe(1);
  });

  it('no reset read (or one in the past): the last 7 days, and runs resume when enough spend rolls out', () => {
    const ledger = [
      { atMs: NOW - 8 * D, usd: 100 }, // outside
      { atMs: NOW - 6 * D, usd: 5 },
      { atMs: NOW - 2 * H, usd: 4 },
    ];
    for (const r of [reading('pro', null), reading('pro', NOW - 1)]) {
      const s = decide({ reading: r, ledger });
      expect(s.subscription!.window).toBe('rolling');
      expect(s.subscription!.weekResetsAt).toBeNull();
      expect(s.overBudget).toBe(true); // $9 ≥ $8.50
      // Dropping the oldest row ($5) brings it under: it rolls out 7 days after it was spent.
      expect(s.resumesAt).toBe(new Date(NOW - 6 * D + B.WEEK_MS).toISOString());
    }
  });

  it('⚠ Claude says "max": the reader must pick Max 5x or Max 20x; until then nothing blocks', () => {
    const ledger = [{ atMs: NOW - H, usd: 10_000 }];
    const s = decide({ reading: reading('max', NOW + D), ledger });
    expect(s.overBudget).toBe(false);
    expect(s.subscription).toMatchObject({ subscription: null, reportedSubscription: 'max', pickFrom: ['max5x', 'max20x'] });
    expect(s.subscription!.usedSharePct).toBeNull();
    expect(s.subscription!.reviewsPerDay).toBeNull();
    expect(s.reason).toMatch(/Max 5x or Max 20x/);
    // A pick of the pair is used; a pick outside it is not.
    const picked = decide({ settings: on({ subscription: 'max20x' }), reading: reading('max', NOW + D), ledger });
    expect(picked.subscription).toMatchObject({ subscription: 'max20x', subscriptionSource: 'picked' });
    expect(picked.overBudget).toBe(true);
    expect(decide({ settings: on({ subscription: 'pro' }), reading: reading('max', NOW + D), ledger }).subscription!.subscription).toBeNull();
  });

  it('unknown subscription (no reading, enterprise): never blocks and asks for a pick', () => {
    for (const r of [null, reading('enterprise', NOW + D)]) {
      const s = decide({ reading: r, ledger: [{ atMs: NOW - H, usd: 10_000 }] });
      expect(s.overBudget).toBe(false);
      expect(s.subscription!.subscription).toBeNull();
      expect(s.subscription!.pickFrom).toEqual(['pro', 'max5x', 'max20x', 'team']);
      expect(s.reason).toMatch(/Pick your Claude subscription/);
    }
    // Picked: judged against the pick, over the last 7 days.
    const s = decide({ settings: on({ subscription: 'team' }), reading: null, ledger: [{ atMs: NOW - H, usd: 10 }] });
    expect(s.subscription).toMatchObject({ subscription: 'team', subscriptionSource: 'picked', window: 'rolling' });
    expect(s.overBudget).toBe(true);
  });

  it('a reading of "pro" or "team" wins over the reader’s pick', () => {
    const s = decide({ settings: on({ subscription: 'max20x' }), reading: reading('team', NOW + D) });
    expect(s.subscription).toMatchObject({ subscription: 'team', subscriptionSource: 'reading', pickFrom: null });
  });

  it('⚠ NO US$ ON A SUBSCRIPTION: the status carries percentages only', () => {
    const s = decide({ settings: on({ subscription: 'max20x' }), reading: reading('max', NOW + D), ledger: [{ atMs: NOW - H, usd: 3 }] });
    expect(s.apiKey).toBeNull();
    const keys = keysDeep(s);
    expect(keys.filter((k) => /usd|cost|dollar|price/i.test(k))).toEqual([]);
    expect(Object.keys(s.subscription!).sort()).toEqual(
      [
        'pickFrom', 'reportedSubscription', 'reviewsPerDay', 'sharePct', 'subscription', 'subscriptionSource', 'usedSharePct', 'weekResetsAt', 'window',
        'fiveHourSharePct', 'fiveHourFollowsWeek', 'fiveHourUsedSharePct', 'fiveHourWindow', 'fiveHourResetsAt',
      ].sort(),
    );
  });

  it('reviews a working day: share × allowance ÷ 5 ÷ cycle cost, diagrams counted only when drawn automatically', () => {
    const r = reading('max', NOW + D);
    const s = on({ subscription: 'max20x' });
    // Fallbacks: 5% × 1650 / 5 = 16.5 → ÷ 0.42 = 39.
    expect(decide({ settings: s, reading: r }).subscription!.reviewsPerDay).toBe(39);
    // With diagrams: ÷ 0.64 = 25.
    expect(decide({ settings: s, reading: r, costs: { ...NO_COSTS, autoDiagrams: true } }).subscription!.reviewsPerDay).toBe(25);
    // Recorded means win: ÷ (1.5 + 0.15) = 10.
    expect(
      decide({ settings: s, reading: r, costs: { reviewMeanUsd: 1.5, diagramMeanUsd: 0.15, autoDiagrams: true } }).subscription!.reviewsPerDay,
    ).toBe(10);
  });
});

describe('decideAiBudget — Limn’s share of a 5-hour session (subscription)', () => {
  // Pro: week ≈ $170, 5-hour ≈ $15. At 5%: $8.50 a week, $0.75 a session.
  const five = (resetsAtMs: number | null, sub = 'pro'): AiUsageReading => ({
    subscriptionType: sub,
    week: { utilization: 30, resetsAtMs: NOW + 2 * D, observedAtMs: NOW - 60_000 },
    fiveHour: { utilization: 3, resetsAtMs, observedAtMs: NOW - 60_000 },
  });

  it('follows the weekly share by default (5% a week → 5% a session), and pauses on it alone', () => {
    const s = decide({ reading: five(NOW + 2 * H), ledger: [{ atMs: NOW - H, usd: 0.8 }] });
    expect(s.subscription).toMatchObject({ fiveHourSharePct: 5, fiveHourFollowsWeek: true, fiveHourWindow: 'reset' });
    expect(s.subscription!.fiveHourUsedSharePct).toBeCloseTo((0.8 / 15) * 100, 2);
    expect(s.subscription!.usedSharePct).toBeLessThan(5); // the week is fine
    expect(s.overBudget).toBe(true);
    expect(s.limitedBy).toBe('five_hour');
    expect(s.reason).toBe('Limn has used its share of this 5-hour session.');
    expect(s.resumesAt).toBe(new Date(NOW + 2 * H).toISOString());
    // The weekly share moves it too, while it follows.
    expect(decide({ settings: on({ weekSharePct: 20 }), reading: five(NOW + 2 * H), ledger: [{ atMs: NOW - H, usd: 0.8 }] }).overBudget).toBe(false);
  });

  it('a separate 5-hour share is used instead, whatever the weekly one', () => {
    const ledger = [{ atMs: NOW - H, usd: 0.8 }];
    const s = decide({ settings: on({ fiveHourSharePct: 10 }), reading: five(NOW + 2 * H), ledger });
    expect(s.subscription).toMatchObject({ fiveHourSharePct: 10, fiveHourFollowsWeek: false, sharePct: 5 });
    expect(s.overBudget).toBe(false);
    expect(decide({ settings: on({ weekSharePct: 30, fiveHourSharePct: 1 }), reading: five(NOW + 2 * H), ledger }).limitedBy).toBe('five_hour');
  });

  it('reset-anchored: [reset − 5 hours, now]; no live reset (none, past, too far ahead): the last 5 hours', () => {
    const ledger = [
      { atMs: NOW - 4 * H, usd: 5 }, // before this session (it began 3 hours ago)
      { atMs: NOW - H, usd: 0.3 },
    ];
    const anchored = decide({ reading: five(NOW + 2 * H), ledger });
    expect(anchored.subscription!.fiveHourWindow).toBe('reset');
    expect(anchored.subscription!.fiveHourResetsAt).toBe(new Date(NOW + 2 * H).toISOString());
    expect(anchored.subscription!.fiveHourUsedSharePct).toBe(2);
    expect(anchored.overBudget).toBe(false);
    for (const r of [five(null), five(NOW - 1), five(NOW + 6 * H)]) {
      const s = decide({ reading: r, ledger });
      expect(s.subscription!.fiveHourWindow).toBe('rolling');
      expect(s.subscription!.fiveHourResetsAt).toBeNull();
      expect(s.subscription!.fiveHourUsedSharePct).toBeCloseTo((5.3 / 15) * 100, 2);
      expect(s.limitedBy).toBe('five_hour');
      // Dropping the $5 row brings it under: it rolls out 5 hours after it was spent.
      expect(s.resumesAt).toBe(new Date(NOW - 4 * H + 5 * H).toISOString());
    }
  });

  it('both over: the week is named, and runs resume when BOTH have cleared (the later time)', () => {
    const s = decide({ reading: five(NOW + 2 * H), ledger: [{ atMs: NOW - H, usd: 9 }] });
    expect(s.limitedBy).toBe('week');
    expect(s.reason).toBe('Limn has used its share of your week.');
    expect(s.resumesAt).toBe(new Date(NOW + 2 * D).toISOString());
  });

  it('⚠ over the 5-hour share pauses AUTOMATIC runs only: the gate says no; the status still lets the reader run', async () => {
    const st = decide({ reading: five(NOW + 2 * H), ledger: [{ atMs: NOW - H, usd: 0.8 }] });
    expect(await B.allowAutomaticRun(9, 'auto review', undefined, async () => st)).toBe(false);
    // Nothing in the status refuses a reader's run: the SPA asks for a second press on overBudget.
    expect(Object.keys(st)).not.toContain('refuse');
    expect(st.mode).toBe('subscription');
  });

  it('unknown subscription: no 5-hour judgement either', () => {
    const s = decide({ reading: five(NOW + 2 * H, 'max'), ledger: [{ atMs: NOW - H, usd: 100 }] });
    expect(s.overBudget).toBe(false);
    expect(s.subscription!.fiveHourUsedSharePct).toBeNull();
  });

  it('⚠ API key: no 5-hour limit — a busy 5 hours under the weekly US$ never pauses', () => {
    const s = decide({
      settings: on({ weeklyUsd: 25, fiveHourSharePct: 1 }),
      route: 'api_key',
      reading: five(NOW + 2 * H),
      ledger: [{ atMs: NOW - H, usd: 20 }],
    });
    expect(s.mode).toBe('api_key');
    expect(s.subscription).toBeNull();
    expect(s.overBudget).toBe(false);
    expect(s.limitedBy).toBeNull();
  });
});

describe('aiUsageView — the header item and its popover', () => {
  const TODAY = NOW - 12 * H;
  const full: AiUsageReading = {
    subscriptionType: 'max',
    week: { utilization: 31, resetsAtMs: NOW + 3 * D, observedAtMs: NOW - 4 * 60_000 },
    fiveHour: { utilization: 3, resetsAtMs: NOW + 2 * H, observedAtMs: NOW - 4 * 60_000 },
    models: {
      seven_day_sonnet: { utilization: 12, resetsAtMs: NOW + 3 * D, observedAtMs: NOW - 4 * 60_000 },
      seven_day_opus: { utilization: 4, resetsAtMs: NOW + 3 * D, observedAtMs: NOW - 4 * 60_000 },
      seven_day_old: { utilization: 90, resetsAtMs: NOW - H, observedAtMs: NOW - 2 * D }, // reset passed
    },
  };
  const ledger = [
    { atMs: NOW - 5 * D, usd: 100, inputTokens: 10, outputTokens: 1 }, // before this week (began 4 days ago)
    { atMs: NOW - 2 * D, usd: 16.5, inputTokens: 1000, outputTokens: 200 },
    { atMs: NOW - H, usd: 2, inputTokens: null, outputTokens: 50 },
  ];
  const view = (over: Partial<Parameters<typeof aiUsageView>[0]> = {}) =>
    aiUsageView({ settings: on({ subscription: 'max20x' }), route: 'login', reading: full, ledger, nowMs: NOW, todayFromMs: TODAY, ...over });

  it('login: Claude’s own windows, Limn’s week (runs, tokens, shares) and the run-share rate', () => {
    const u = view();
    expect(u.route).toBe('login');
    expect(u.apiKey).toBeNull();
    expect(u.account).toMatchObject({ reportedSubscription: 'max', subscription: 'max20x' });
    expect(u.account!.week).toMatchObject({ key: 'seven_day', usedPct: 31, resetsAt: new Date(NOW + 3 * D).toISOString() });
    expect(u.account!.fiveHour).toMatchObject({ key: 'five_hour', usedPct: 3 });
    // Opus first; a window whose reset has passed is dropped, never shown as a figure.
    expect(u.account!.models.map((m) => [m.key, m.label])).toEqual([['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]);
    expect(u.account!.observedAt).toBe(new Date(NOW - 4 * 60_000).toISOString());
    expect(u.limn).toMatchObject({ window: 'reset', runs: 2, inputTokens: 1000, outputTokens: 250, weekFrom: new Date(NOW - 4 * D).toISOString() });
    expect(u.limn.weekSharePct).toBeCloseTo((18.5 / SUBSCRIPTION_ESTIMATES.max20x.week) * 100, 2);
    expect(u.limn.fiveHourSharePct).toBeCloseTo((2 / SUBSCRIPTION_ESTIMATES.max20x.fiveHour) * 100, 2);
    expect(u.weekPctPerUsd).toBeCloseTo(100 / SUBSCRIPTION_ESTIMATES.max20x.week, 10);
  });

  it('filled whether or not the budget is on', () => {
    const u = view({ settings: resolveAiBudgetSettings({ enabled: false, subscription: 'max20x' }) });
    expect(u.account!.week?.usedPct).toBe(31);
    expect(u.limn.runs).toBe(2);
    expect(u.weekPctPerUsd).not.toBeNull();
  });

  it('unknown is absent, never 0: no reading, no subscription, no tokens', () => {
    const u = view({ settings: on(), reading: { subscriptionType: 'max' }, ledger: [{ atMs: NOW - H, usd: 1 }] });
    expect(u.account).toMatchObject({ fiveHour: null, week: null, models: [], observedAt: null, subscription: null });
    expect(u.limn).toMatchObject({ window: 'rolling', runs: 1, inputTokens: null, outputTokens: null, weekSharePct: null, fiveHourSharePct: null });
    expect(u.weekPctPerUsd).toBeNull();
  });

  it('API key: US$ this week, the last 5 hours and today; no account reading, no rate', () => {
    const u = view({ route: 'api_key', reading: null });
    expect(u.account).toBeNull();
    expect(u.weekPctPerUsd).toBeNull();
    // The API key's week is the rolling last 7 days (the reset belongs to a subscription).
    expect(u.limn).toMatchObject({ window: 'rolling', runs: 3, weekSharePct: null });
    expect(u.apiKey).toEqual({ weekUsd: 118.5, fiveHourUsd: 2, todayUsd: 2 });
  });

  it('⚠ NO US$ AMOUNT ON THE SUBSCRIPTION WIRE: status, settings and usage together', () => {
    const settings = on({ subscription: 'max20x' });
    const status = decide({ settings, reading: full, ledger });
    const body = { settings: aiBudgetSettingsView(settings, 'login'), status, usage: view() };
    const moneyKeysWithValues = (v: unknown): string[] =>
      v && typeof v === 'object'
        ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
            ...(/usd|cost|dollar|price/i.test(k) && x != null ? [k] : []),
            ...moneyKeysWithValues(x),
          ])
        : [];
    // The one exception is the documented RATE (% of the week per recorded US$), not an amount.
    expect(moneyKeysWithValues(body)).toEqual(['weekPctPerUsd']);
  });
});

describe('a run’s cost as a share of the week', () => {
  const rate = 100 / SUBSCRIPTION_ESTIMATES.max20x.week;
  it('rounded for reading; nothing to say without a rate or a cost', () => {
    expect(runWeekShareText(5, rate)).toBe('0.3% of your week');
    expect(runWeekShareText(0.42, rate)).toBe('<0.1% of your week');
    expect(runWeekShareText(330, rate)).toBe('20% of your week');
    expect(runWeekShareText(0, rate)).toBe('0% of your week');
    expect(runWeekShareText(5, null)).toBeNull();
    expect(runWeekShareText(null, rate)).toBeNull();
    expect(runWeekShareText(Number.NaN, rate)).toBeNull();
    expect(formatSharePct(4.25)).toBe('4.3%');
    expect(formatSharePct(0.05)).toBe('<0.1%');
  });
});

describe('reviewsPerDayFor / cycleCostUsd — never NaN, Infinity or negative', () => {
  it('edge cases', () => {
    expect(reviewsPerDayFor(5, 170, 0)).toBeNull();
    expect(reviewsPerDayFor(5, 170, -1)).toBeNull();
    expect(reviewsPerDayFor(5, 170, Number.NaN)).toBeNull();
    expect(reviewsPerDayFor(5, Number.POSITIVE_INFINITY, 0.42)).toBeNull();
    expect(reviewsPerDayFor(0, 170, 0.42)).toBeNull();
    expect(reviewsPerDayFor(1, 170, 100)).toBe(0); // under one a day is 0, not a fraction
    expect(reviewsPerDayFor(5, 170, 0.42)).toBe(4); // 8.5 / 5 / 0.42 = 4.05
    // A zero, negative or non-finite mean falls back to the typical figure.
    expect(cycleCostUsd({ reviewMeanUsd: 0, diagramMeanUsd: Number.NaN, autoDiagrams: true })).toBeCloseTo(
      AI_CYCLE_COST_FALLBACKS.review + AI_CYCLE_COST_FALLBACKS.diagram,
    );
    expect(cycleCostUsd({ reviewMeanUsd: 0.5, diagramMeanUsd: 0.3, autoDiagrams: false })).toBe(0.5);
  });
});

describe('resolveAiSubscription — the one subscription rule', () => {
  it('pro/team from the reading; max needs the pair; anything else picks from all', () => {
    expect(resolveAiSubscription('pro', 'max20x')).toEqual({ kind: 'pro', source: 'reading', pickFrom: null });
    expect(resolveAiSubscription('TEAM', null).kind).toBe('team');
    expect(resolveAiSubscription('max', null)).toEqual({ kind: null, source: null, pickFrom: ['max5x', 'max20x'] });
    expect(resolveAiSubscription('max', 'max5x').kind).toBe('max5x');
    expect(resolveAiSubscription('enterprise', null).kind).toBeNull();
    expect(resolveAiSubscription(null, 'pro')).toMatchObject({ kind: 'pro', source: 'picked' });
  });
});

describe('decideAiBudget — API key', () => {
  it('a rolling 7-day US$ budget; a subscription reading is ignored', () => {
    const ledger = [
      { atMs: NOW - 8 * D, usd: 100 }, // outside the week
      { atMs: NOW - 6 * D, usd: 15 },
      { atMs: NOW - 2 * H, usd: 10 },
    ];
    const s = decide({ settings: on({ weeklyUsd: 25 }), route: 'api_key', reading: reading('pro', NOW + D), ledger });
    expect(s.mode).toBe('api_key');
    expect(s.subscription).toBeNull();
    expect(s.apiKey).toEqual({ weeklyUsd: 25, usedUsd: 25 });
    expect(s.overBudget).toBe(true);
    expect(s.reason).toBe('Limn has used its weekly budget.');
    // Dropping the oldest row ($15) brings it under: it rolls out 7 days after it was spent.
    expect(s.resumesAt).toBe(new Date(NOW - 6 * D + B.WEEK_MS).toISOString());
    expect(decide({ settings: on({ weeklyUsd: 30 }), route: 'api_key', ledger }).overBudget).toBe(false);
  });
});

describe('rollingSpend', () => {
  it('counts only the window and finds when enough rolls out', () => {
    const r = B.rollingSpend(
      [
        { atMs: NOW - 4 * D, usd: 3 },
        { atMs: NOW - 3 * D, usd: 3 },
        { atMs: NOW - 1 * D, usd: 3 },
        { atMs: NOW - 8 * D, usd: 50 },
      ],
      NOW,
      B.WEEK_MS,
      5,
    );
    expect(r.usedUsd).toBe(9);
    // 9 → 6 (still ≥ 5) → 3: the second row's exit is the moment.
    expect(r.resumesAtMs).toBe(NOW - 3 * D + B.WEEK_MS);
  });
});

describe('the readings — each path converts its own scale', () => {
  it('rate_limit_event: a 0–1 FRACTION, converted to 0–100; seconds → ms; the 5-hour and per-model windows kept', () => {
    const r = B.foldRateLimitEvent(
      { subscriptionType: 'max' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.31, resetsAt: 1_800_000_000 } },
      NOW,
    );
    expect(r?.week).toEqual({ utilization: 31, resetsAtMs: 1_800_000_000_000, observedAtMs: NOW });
    expect(r?.subscriptionType).toBe('max');
    // ⚠ No "≤ 1 means a fraction" guess: a figure above the fraction range is refused, not taken as %.
    const big = B.foldRateLimitEvent(null, { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 31 } }, NOW);
    expect(big).toBeNull();
    expect(
      B.foldRateLimitEvent(null, { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1_800_000_000 } }, NOW)
        ?.fiveHour,
    ).toEqual({ utilization: 90, resetsAtMs: 1_800_000_000_000, observedAtMs: NOW });
    expect(
      B.foldRateLimitEvent(null, { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day_opus', utilization: 0.2 } }, NOW)?.models,
    ).toEqual({ seven_day_opus: { utilization: 20, resetsAtMs: null, observedAtMs: NOW } });
    // An unknown window type (overage, …) says nothing.
    expect(B.foldRateLimitEvent(null, { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'overage', utilization: 0.2 } }, NOW)).toBeNull();
  });

  it('rate_limit_event: the week from unifiedWindows; a rejection with no figure is 100%', () => {
    const r = B.foldRateLimitEvent(
      null,
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.5, resetsAt: 1_800_100_000 } },
        },
      },
      NOW,
    );
    expect(r?.week).toEqual({ utilization: 50, resetsAtMs: 1_800_100_000_000, observedAtMs: NOW });
    expect(r?.fiveHour).toEqual({ utilization: 10, resetsAtMs: 1_800_000_000_000, observedAtMs: NOW });
    expect(
      B.foldRateLimitEvent(null, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } }, NOW)?.week
        ?.utilization,
    ).toBe(100);
    expect(B.foldRateLimitEvent(null, { type: 'assistant' }, NOW)).toBeNull();
  });

  it('the probe: utilisation is ALREADY 0–100 and kept as-is (the real login’s answer)', () => {
    const ok = B.parseUsageProbe(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 3, resets_at: '2026-10-24T15:00:00Z' },
          seven_day: { utilization: 31, resets_at: '2026-10-28T00:00:00Z' },
          seven_day_opus: { utilization: 4, resets_at: '2026-10-28T00:00:00Z' },
          seven_day_sonnet: null,
          extra_usage: { utilization: 1 },
        },
      },
      NOW,
    );
    expect(ok).toEqual({
      week: { utilization: 31, resetsAtMs: Date.parse('2026-10-28T00:00:00Z'), observedAtMs: NOW },
      fiveHour: { utilization: 3, resetsAtMs: Date.parse('2026-10-24T15:00:00Z'), observedAtMs: NOW },
      models: { seven_day_opus: { utilization: 4, resetsAtMs: Date.parse('2026-10-28T00:00:00Z'), observedAtMs: NOW } },
      subscriptionType: 'max',
    });
    // A small probe figure stays small: 0.5 means 0.5%, never 50%.
    const small = B.parseUsageProbe(
      { rate_limits_available: true, rate_limits: { seven_day: { utilization: 0.5, resets_at: '2026-10-28T00:00:00Z' } } },
      NOW,
    );
    expect(small?.week?.utilization).toBe(0.5);
  });

  it('the probe parser refuses any shape it does not know, but keeps a bare subscription type', () => {
    expect(B.parseUsageProbe(null, NOW)).toBeNull();
    expect(B.parseUsageProbe({ rate_limits_available: false, rate_limits: null }, NOW)).toBeNull();
    expect(B.parseUsageProbe({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 'x' } } }, NOW)).toBeNull();
    expect(B.parseUsageProbe({ subscription_type: 'pro', rate_limits_available: false }, NOW)).toEqual({ subscriptionType: 'pro' });
  });

  it('a stored reading is normalised: windows kept, junk and unknown model keys dropped', () => {
    expect(
      B.normaliseStoredReading({
        fiveHour: { utilization: 99, resetsAtMs: NOW + H, observedAtMs: NOW },
        week: { utilization: 40, resetsAtMs: NOW + D, observedAtMs: NOW },
        models: { seven_day_sonnet: { utilization: 7, resetsAtMs: null, observedAtMs: NOW }, 'bad key': { observedAtMs: NOW } },
        subscriptionType: 'pro',
      }),
    ).toEqual({
      week: { utilization: 40, resetsAtMs: NOW + D, observedAtMs: NOW },
      fiveHour: { utilization: 99, resetsAtMs: NOW + H, observedAtMs: NOW },
      models: { seven_day_sonnet: { utilization: 7, resetsAtMs: null, observedAtMs: NOW } },
      subscriptionType: 'pro',
    });
    // The pre-models shape (week only) still reads.
    expect(B.normaliseStoredReading({ week: { utilization: 1, resetsAtMs: null, observedAtMs: NOW } })?.week?.utilization).toBe(1);
    expect(B.normaliseStoredReading('junk')).toBeNull();
  });

  it('merging: each window independently; an event keeps the subscription and the other windows', () => {
    const prev: AiUsageReading = {
      subscriptionType: 'max',
      week: { utilization: 30, resetsAtMs: NOW + D, observedAtMs: NOW - H },
      fiveHour: { utilization: 2, resetsAtMs: NOW + H, observedAtMs: NOW - H },
      models: { seven_day_opus: { utilization: 5, resetsAtMs: NOW + D, observedAtMs: NOW - H } },
    };
    const next = B.mergeReadings(prev, { fiveHour: { utilization: 6, resetsAtMs: null, observedAtMs: NOW } });
    expect(next.subscriptionType).toBe('max');
    expect(next.week).toEqual(prev.week);
    expect(next.models).toEqual(prev.models);
    // The new figure, the known reset.
    expect(next.fiveHour).toEqual({ utilization: 6, resetsAtMs: NOW + H, observedAtMs: NOW });
  });
});

describe('the gate', () => {
  const status = (overBudget: boolean): AiBudgetStatus => ({
    enabled: true,
    mode: 'api_key',
    route: 'api_key',
    subscription: null,
    apiKey: { weeklyUsd: 25, usedUsd: 0 },
    overBudget,
    limitedBy: overBudget ? 'week' : null,
    reason: null,
    resumesAt: null,
  });

  it('skips while over and logs ONCE per pause, then once on resuming', async () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m) };
    let over = true;
    const statusOf = async () => status(over);
    expect(await B.allowAutomaticRun(1, 'auto review', log, statusOf)).toBe(false);
    expect(await B.allowAutomaticRun(1, 'CI review', log, statusOf)).toBe(false);
    expect(lines).toHaveLength(1);
    over = false;
    expect(await B.allowAutomaticRun(1, 'auto review', log, statusOf)).toBe(true);
    expect(await B.allowAutomaticRun(1, 'auto review', log, statusOf)).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/resume/);
  });
});

describe('validateAiBudgetBody', () => {
  it('accepts a subset and refuses bad values and retired keys', () => {
    expect(validateAiBudgetBody({ enabled: true })).toBeNull();
    expect(validateAiBudgetBody({ subscription: null, weekSharePct: 50 })).toBeNull();
    expect(validateAiBudgetBody({ weekSharePct: 0 })).toMatch(/1 to 50/);
    expect(validateAiBudgetBody({ weekSharePct: 51 })).toMatch(/1 to 50/);
    expect(validateAiBudgetBody({ weekSharePct: 5.5 })).toMatch(/whole/);
    expect(validateAiBudgetBody({ subscription: 'gold' })).toMatch(/subscription/);
    expect(validateAiBudgetBody({ weeklyUsd: -1 })).toMatch(/weeklyUsd/);
    expect(validateAiBudgetBody({ weeklyUsd: 0 })).toMatch(/weeklyUsd/);
    for (const k of ['fiveHourPct', 'weekPct', 'dailyUsd', 'nope']) expect(validateAiBudgetBody({ [k]: 1 })).toMatch(/Unknown/);
    // The 5-hour share: a whole 1–50, or null (= follow the weekly share).
    expect(validateAiBudgetBody({ fiveHourSharePct: 10 })).toBeNull();
    expect(validateAiBudgetBody({ fiveHourSharePct: null })).toBeNull();
    for (const v of [0, 51, 2.5, '5']) expect(validateAiBudgetBody({ fiveHourSharePct: v })).toMatch(/fiveHourSharePct/);
    expect(validateAiBudgetBody([])).not.toBeNull();
  });

  it('old stored JSON (fiveHourPct / weekPct / dailyUsd) is tolerated and ignored on read', () => {
    const s = resolveAiBudgetSettings({ enabled: true, fiveHourPct: 70, weekPct: 80, dailyUsd: 3, weeklyUsd: 12 } as never);
    expect(s).toEqual({ enabled: true, weekSharePct: 5, fiveHourSharePct: null, subscription: null, weeklyUsd: 12 });
  });

  it('the wire view carries the US$ budget on the API-key route only', () => {
    const s = on({ weeklyUsd: 12 });
    expect(aiBudgetSettingsView(s, 'api_key').weeklyUsd).toBe(12);
    expect(aiBudgetSettingsView(s, 'login').weeklyUsd).toBeNull();
    expect(aiBudgetSettingsView(s, 'none').weeklyUsd).toBeNull();
    expect(aiBudgetSettingsView(s, 'login').weekSharePct).toBe(s.weekSharePct);
  });
});

describe('on the database', () => {
  const env = { ...process.env };
  afterAll(() => {
    process.env = env;
  });

  it('settings round-trip: NULL reads as off with the defaults, a write merges over what is stored, old keys go', async () => {
    const first = await B.readAiBudgetSettings(2);
    expect(first.isDefault).toBe(true);
    expect(first.settings).toEqual(resolveAiBudgetSettings(null));
    await db.update(schema.accounts).set({ aiBudgetSettings: { enabled: true, weekPct: 80, dailyUsd: 3 } }).where(eqId(2)).execute();
    await B.writeAiBudgetSettings(2, { weeklyUsd: 12 });
    await B.writeAiBudgetSettings(2, { weekSharePct: 7 });
    const after = await B.readAiBudgetSettings(2);
    expect(after.isDefault).toBe(false);
    expect(after.settings).toEqual({ enabled: true, weeklyUsd: 12, weekSharePct: 7, fiveHourSharePct: null, subscription: null });
    const raw = await db.select({ s: schema.accounts.aiBudgetSettings }).from(schema.accounts).where(eqId(2)).execute();
    expect(Object.keys(raw[0].s).sort()).toEqual(['enabled', 'fiveHourSharePct', 'subscription', 'weekSharePct', 'weeklyUsd']);
    // A separate 5-hour share, then cleared back to "same as weekly".
    await B.writeAiBudgetSettings(2, { fiveHourSharePct: 12 });
    expect((await B.readAiBudgetSettings(2)).settings.fiveHourSharePct).toBe(12);
    await B.writeAiBudgetSettings(2, { fiveHourSharePct: null });
    expect((await B.readAiBudgetSettings(2)).settings.fiveHourSharePct).toBeNull();
  });

  it('API key route: the status reads the account’s own ai_usage rows only', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.LIMN_AI_USE_API_KEY = 'true';
    await db.insert(schema.aiUsage).values([
      { accountId: 2, seam: 'agent', feature: 'claude_review', model: 'm', costUsd: 7, occurredAt: new Date(NOW - H) },
      { accountId: 2, seam: 'summary', feature: 'digest', model: 'm', costUsd: 6, occurredAt: new Date(NOW - 2 * H) },
      { accountId: 1, seam: 'agent', feature: 'claude_review', model: 'm', costUsd: 500, occurredAt: new Date(NOW - H) },
    ]).execute();
    const s = await B.aiBudgetStatus(2, { nowMs: NOW, probe: false });
    expect(s.mode).toBe('api_key');
    expect(s.apiKey).toEqual({ weeklyUsd: 12, usedUsd: 13 });
    expect(s.overBudget).toBe(true);
  });

  it('cycle costs: the account’s own 28-day means, and whether any workspace draws diagrams', async () => {
    await db.insert(schema.aiUsage).values([
      { accountId: 2, seam: 'agent', feature: 'claude_review', model: 'm', costUsd: 1, occurredAt: new Date(NOW - 3 * D) },
      { accountId: 2, seam: 'agent', feature: 'claude_review', model: 'm', costUsd: 99, occurredAt: new Date(NOW - 40 * D) },
      { accountId: 2, seam: 'agent', feature: 'sequence_diagram', model: 'm', costUsd: 0.3, occurredAt: new Date(NOW - D) },
    ]).execute();
    const c = await B.readCycleCosts(2, NOW);
    expect(c.reviewMeanUsd).toBeCloseTo(4); // (7 + 1) / 2 — the 40-day-old row is outside
    expect(c.diagramMeanUsd).toBeCloseTo(0.3);
    expect(typeof c.autoDiagrams).toBe('boolean');
  });

  it('login route: a weekly rate-limit event is persisted and survives a restart; it anchors the week, never blocks', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LIMN_AI_USE_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    await B.writeAiBudgetSettings(1, { enabled: true, subscription: 'pro' });
    const resetSec = Math.floor((NOW + 2 * D) / 1000);
    B.noteAgentMessage(
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.95, resetsAt: resetSec } },
      NOW,
    );
    // Let the fire-and-forget write land.
    await new Promise((r) => setTimeout(r, 50));
    B._resetAiBudgetForTest();
    const s = await B.aiBudgetStatus(1, { nowMs: NOW + 60_000, probe: false });
    expect(s.route).toBe('login');
    expect(s.subscription).toMatchObject({ subscription: 'pro', window: 'reset', weekResetsAt: new Date(resetSec * 1000).toISOString() });
    // Account 1 spent $500 an hour ago in the setup above: over its 5% of Pro — Limn's own spend.
    expect(s.overBudget).toBe(true);
    expect(s.resumesAt).toBe(new Date(resetSec * 1000).toISOString());
  });

  it('⚠ an event arriving before the stored reading loaded merges over it, never replaces it', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    B._setUsageProbeForTest(async () => ({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { seven_day_opus: { utilization: 9, resets_at: new Date(NOW + 2 * D).toISOString() } },
    }));
    await B.kickUsageProbe(NOW);
    await new Promise((r) => setTimeout(r, 50));
    // A restart: nothing in memory. The first thing that happens is a run's 5-hour event.
    B._resetAiBudgetForTest();
    B.noteAgentMessage(
      { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: Math.floor((NOW + 3600_000) / 1000) } },
      NOW,
    );
    await new Promise((r) => setTimeout(r, 50));
    B._resetAiBudgetForTest();
    const snap = await B.aiBudgetSnapshot(1, { nowMs: NOW + 60_000, probe: false });
    expect(snap.usage.account?.reportedSubscription).toBe('max');
    expect(snap.usage.account?.models.map((m) => m.key)).toContain('seven_day_opus');
    expect(snap.usage.account?.fiveHour?.usedPct).toBe(10);
    B._setUsageProbeForTest(null);
    // Leave no reading behind for the tests below.
    await db.update(schema.accounts).set({ aiBudgetReading: null }).where(eqId(1)).execute();
    B._resetAiBudgetForTest();
  });

  it('the gate probes only while the budget is on; a throwing probe keeps the last reading, never a crash', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    let calls = 0;
    B._setUsageProbeForTest(async () => {
      calls += 1;
      throw new Error('boom');
    });
    await B.writeAiBudgetSettings(2, { enabled: false });
    await B.aiBudgetStatus(2, { nowMs: NOW });
    expect(calls).toBe(0);
    // 'always' (GET /api/ai/budget) probes on the login route whatever the budget.
    await B.aiBudgetSnapshot(2, { nowMs: NOW, probe: 'always' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    B._setUsageProbeForTest(null);
  });

  it('⚠ the probe never blocks the request, runs at most every 5 minutes, and a later call serves its reading', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    let calls = 0;
    let answer: (v: unknown) => void = () => {};
    B._setUsageProbeForTest(() => {
      calls += 1;
      return new Promise((r) => {
        answer = r;
      });
    });
    // The probe hangs: the snapshot still answers, from the cached (empty) reading.
    const first = await B.aiBudgetSnapshot(1, { nowMs: NOW, probe: 'always' });
    expect(calls).toBe(1);
    expect(first.usage.account?.fiveHour ?? null).toBeNull();
    // Single-flight and the 5-minute floor.
    await B.aiBudgetSnapshot(1, { nowMs: NOW + 60_000, probe: 'always' });
    expect(calls).toBe(1);
    answer({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12, resets_at: new Date(NOW + 2 * H).toISOString() } },
    });
    await new Promise((r) => setTimeout(r, 10));
    const next = await B.aiBudgetSnapshot(1, { nowMs: NOW + 2 * 60_000, probe: 'always' });
    expect(calls).toBe(1); // still inside 5 minutes
    expect(next.usage.account?.fiveHour?.usedPct).toBe(12);
    await B.aiBudgetSnapshot(1, { nowMs: NOW + B.PROBE_MIN_INTERVAL_MS + 1, probe: 'always' });
    expect(calls).toBe(2);
    B._setUsageProbeForTest(null);
  });

  it('GET /api/ai/budget: settings, status and usage in one answer; the subscription wire carries no US$ amount', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    delete process.env.ANTHROPIC_API_KEY;
    B._setUsageProbeForTest(async () => {
      throw new Error('no probe in this test');
    });
    const Fastify = (await import('fastify')).default;
    const { aiBudgetRoutes } = await import('../api/routes/ai-budget.js');
    const app = Fastify();
    await app.register(aiBudgetRoutes);
    await app.ready();
    try {
      const put = await app.inject({ method: 'PUT', url: '/api/ai/budget', payload: { enabled: true, subscription: 'pro', fiveHourSharePct: 9 } });
      expect(put.statusCode).toBe(200);
      const body = put.json();
      expect(Object.keys(body).sort()).toEqual(['isDefault', 'settings', 'status', 'usage']);
      expect(body.settings).toMatchObject({ fiveHourSharePct: 9, weeklyUsd: null });
      expect(body.status.subscription).toMatchObject({ fiveHourSharePct: 9, fiveHourFollowsWeek: false });
      expect(body.usage.route).toBe('login');
      expect(body.usage.apiKey).toBeNull();
      expect(typeof body.usage.limn.runs).toBe('number');
      const money = keysDeep(body).filter((k) => /usd|cost|dollar|price/i.test(k));
      expect(money.sort()).toEqual(['weekPctPerUsd', 'weeklyUsd']);
      expect(body.settings.weeklyUsd).toBeNull();
      const bad = await app.inject({ method: 'PUT', url: '/api/ai/budget', payload: { fiveHourSharePct: 0 } });
      expect(bad.statusCode).toBe(400);
      const cleared = await app.inject({ method: 'PUT', url: '/api/ai/budget', payload: { fiveHourSharePct: null } });
      expect(cleared.json().status.subscription.fiveHourFollowsWeek).toBe(true);
      const get = await app.inject({ method: 'GET', url: '/api/ai/budget' });
      expect(get.statusCode).toBe(200);
      expect(get.json().settings.fiveHourSharePct).toBeNull();
    } finally {
      await app.close();
      B._setUsageProbeForTest(null);
    }
  });
});

describe('the runtime tap (ai/runtime.ts)', () => {
  it('observes every message without changing the stream or the Query methods', async () => {
    const { tapQuery, setAgentMessageObserver } = await import('./runtime.js');
    const seen: unknown[] = [];
    setAgentMessageObserver((m) => {
      seen.push(m);
      throw new Error('an observer that throws never reaches the run');
    });
    async function* gen() {
      yield { type: 'assistant' };
      yield { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.2 } };
    }
    const q = Object.assign(gen(), { interrupt: async function (this: unknown) { return this; } });
    const t = tapQuery(q);
    const out: unknown[] = [];
    for await (const m of t) out.push(m);
    expect(out).toHaveLength(2);
    expect(seen).toEqual(out);
    expect(await t.interrupt()).toBe(q); // methods stay bound to the real Query
    setAgentMessageObserver(null);
  });
});

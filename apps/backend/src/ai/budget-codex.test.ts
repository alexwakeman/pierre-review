// THE CODEX BUDGET FOLD (packages/shared ai-budget.ts; docs/CODEX-PLAN.md § 6 + § 8.1) — pure:
//   Limn's share of a Codex window = Limn's tokens in it ÷ the account's tokens in it × usedPercent.
//   1. the one-window fold: unknown reading ⇒ null; Limn used nothing ⇒ 0; account unknown or 0 ⇒ the
//      whole usedPercent; the ratio caps at 1;
//   2. WHOLE-PERCENT COARSENESS: a window reading 0% shows 0% whatever Limn did, and a 5% share first
//      trips when the window itself reaches 5% with Limn as all of it;
//   3. a ZERO-TOKEN window (no Codex run) is 0% and never blocks, however full the account is;
//   4. the windows: [reset − length, now] when the reset is read; rows outside never count;
//   5. the decision and the header view on Codex: percentages only, no Claude picker, no US$ rate;
//      an API key is the weekly US$ budget as for Claude.
//
//   pnpm --filter @pierre-review/backend test ai/budget-codex
import { describe, expect, it } from 'vitest';
import {
  aiUsageView,
  budgetWindowStart,
  codexWindowSharePct,
  decideAiBudget,
  ledgerTokensIn,
  resolveAiBudgetSettings,
  type AiAccountTokenSpan,
  type AiLedgerRow,
  type AiUsageReading,
} from '@pierre-review/shared';

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 25, 12);
const NO_COSTS = { reviewMeanUsd: null, diagramMeanUsd: null, autoDiagrams: false };

function reading(weekPct: number | null, fivePct: number | null): AiUsageReading {
  return {
    week: { utilization: weekPct, resetsAtMs: NOW + 3 * D, observedAtMs: NOW },
    fiveHour: { utilization: fivePct, resetsAtMs: NOW + 2 * H, observedAtMs: NOW },
    subscriptionType: 'plus',
  };
}
const row = (atMs: number, inputTokens: number, outputTokens = 0): AiLedgerRow => ({ atMs, usd: 0, inputTokens, outputTokens });
const on = resolveAiBudgetSettings({ enabled: true });
// The account's tokens over the WHOLE window (the span the fold then counts Limn's rows over too).
const span = (r: AiUsageReading | null, which: 'week' | 'five_hour', tokens: number | null): AiAccountTokenSpan | null =>
  tokens == null ? null : { tokens, ...budgetWindowStart(r, NOW, which), toMs: NOW };

function decide(r: AiUsageReading | null, ledger: AiLedgerRow[], week: number | null, five: number | null, settings = on) {
  return decideAiBudget({
    settings,
    route: 'login',
    reading: r,
    ledger,
    costs: NO_COSTS,
    nowMs: NOW,
    provider: 'codex',
    accountTokens: { week: span(r, 'week', week), fiveHour: span(r, 'five_hour', five) },
  });
}

describe('codexWindowSharePct — one window', () => {
  it('no reading ⇒ unknown (null), which never blocks', () => {
    expect(codexWindowSharePct(100, 100, null)).toBeNull();
  });
  it('Limn used nothing ⇒ 0, whatever the account did (a zero-token window)', () => {
    expect(codexWindowSharePct(0, 5000, 90)).toBe(0);
    expect(codexWindowSharePct(0, 0, 90)).toBe(0);
    expect(codexWindowSharePct(0, null, 90)).toBe(0);
  });
  it("the account's tokens UNKNOWN ⇒ the share is unknown (null, never blocks); KNOWN but zero ⇒ all of the window", () => {
    expect(codexWindowSharePct(10, null, 7)).toBeNull();
    expect(codexWindowSharePct(10, 0, 7)).toBe(7);
  });
  it('weights the window by Limn’s fraction of the tokens, capped at all of it', () => {
    expect(codexWindowSharePct(250, 1000, 20)).toBe(5);
    expect(codexWindowSharePct(2000, 1000, 20)).toBe(20); // a lagging account count never inflates past the window
  });
});

describe('whole-percent coarseness', () => {
  it('a window reading 0% shows Limn at 0% even when every token was Limn’s', () => {
    const s = decide(reading(0, 0), [row(NOW - H, 50_000)], 50_000, 50_000);
    expect(s.subscription?.usedSharePct).toBe(0);
    expect(s.subscription?.fiveHourUsedSharePct).toBe(0);
    expect(s.overBudget).toBe(false);
  });
  it('a 5% share first trips when the window reaches 5% with Limn as all of it', () => {
    expect(decide(reading(4, 0), [row(NOW - H, 1000)], 1000, null).overBudget).toBe(false);
    const at5 = decide(reading(5, 0), [row(NOW - H, 1000)], 1000, null);
    expect(at5.subscription?.usedSharePct).toBe(5);
    expect(at5.overBudget).toBe(true);
    expect(at5.limitedBy).toBe('week');
    expect(at5.reason).toBe('Limn has used its share of your week.');
    expect(at5.resumesAt).toBe(new Date(NOW + 3 * D).toISOString());
  });
  it('half the tokens at a 9% window is 4.5% — under a 5% share', () => {
    const s = decide(reading(9, 0), [row(NOW - H, 500)], 1000, 1000);
    expect(s.subscription?.usedSharePct).toBe(4.5);
    expect(s.overBudget).toBe(false);
  });
});

describe('a zero-token window', () => {
  it('no Codex run in the window ⇒ 0% and never blocks, however full the account is', () => {
    const s = decide(reading(95, 99), [], 1_000_000, 1_000_000);
    expect(s.subscription?.usedSharePct).toBe(0);
    expect(s.subscription?.fiveHourUsedSharePct).toBe(0);
    expect(s.overBudget).toBe(false);
    expect(s.reason).toBeNull();
  });
});

describe('the windows', () => {
  it('counts Limn’s tokens from [reset − length] when the reset is read, rolling otherwise', () => {
    const r = reading(10, 10);
    expect(budgetWindowStart(r, NOW, 'week')).toEqual({ fromMs: NOW + 3 * D - 7 * D, inclusive: true });
    expect(budgetWindowStart(r, NOW, 'five_hour')).toEqual({ fromMs: NOW + 2 * H - 5 * H, inclusive: true });
    expect(budgetWindowStart(null, NOW, 'week')).toEqual({ fromMs: NOW - 7 * D, inclusive: false });
    const ledger = [row(NOW - 5 * D, 100), row(NOW - 4 * H, 40, 10), row(NOW - H, 7)];
    expect(ledgerTokensIn(ledger, NOW - 4 * D, true, NOW)).toBe(57);
    expect(ledgerTokensIn(ledger, NOW - 3 * H, true, NOW)).toBe(7);
  });
  it('the 5-hour share follows the weekly setting unless set, and trips on its own', () => {
    // Week: 100/1000 × 30 = 3% (under 5). Five-hour: 100/100 × 6 = 6% (over 5).
    const s = decide(reading(30, 6), [row(NOW - H, 100)], 1000, 100);
    expect(s.subscription?.fiveHourFollowsWeek).toBe(true);
    expect(s.subscription?.usedSharePct).toBe(3);
    expect(s.subscription?.fiveHourUsedSharePct).toBe(6);
    expect(s.limitedBy).toBe('five_hour');
    expect(s.resumesAt).toBe(new Date(NOW + 2 * H).toISOString());
    const own = decide(reading(30, 6), [row(NOW - H, 100)], 1000, 100, resolveAiBudgetSettings({ enabled: true, fiveHourSharePct: 10 }));
    expect(own.overBudget).toBe(false);
  });
  it("Limn's tokens are counted over the SAME span as the account's, never the whole window", () => {
    // After a restart the account is only known over the last hour (300 tokens), while Limn spent
    // 900 tokens earlier in the week and 100 in that hour. Same span: 100/300 of a 30% week = 10%,
    // not 900+100 over 300 (capped to all of it, 30%).
    const r = reading(30, 30);
    const ledger = [row(NOW - 2 * D, 900), row(NOW - 30 * 60_000, 100)];
    const s = decideAiBudget({
      settings: resolveAiBudgetSettings({ enabled: true, weekSharePct: 50, fiveHourSharePct: 50 }),
      route: 'login',
      reading: r,
      ledger,
      costs: NO_COSTS,
      nowMs: NOW,
      provider: 'codex',
      accountTokens: {
        week: { tokens: 300, fromMs: NOW - H, inclusive: false, toMs: NOW },
        fiveHour: { tokens: 300, fromMs: NOW - H, inclusive: false, toMs: NOW },
      },
    });
    expect(s.subscription?.usedSharePct).toBe(10);
    expect(s.subscription?.fiveHourUsedSharePct).toBe(10);
  });
  it("…and over EXACTLY its END too: Limn's rows after the account's newest sample are not in the count", () => {
    // The account's count ends 20 minutes ago (its newest probe sample): 300 tokens, Limn's 100 of
    // them. Limn's 200-token run AFTER that sample is in neither count — counting it would make the
    // share 300/300 of the week, not 100/300.
    const s = decideAiBudget({
      settings: resolveAiBudgetSettings({ enabled: true, weekSharePct: 50, fiveHourSharePct: 50 }),
      route: 'login',
      reading: reading(30, 30),
      ledger: [row(NOW - 30 * 60_000, 100), row(NOW - 10 * 60_000, 200)],
      costs: NO_COSTS,
      nowMs: NOW,
      provider: 'codex',
      accountTokens: {
        week: { tokens: 300, fromMs: NOW - H, inclusive: false, toMs: NOW - 20 * 60_000 },
        fiveHour: { tokens: 300, fromMs: NOW - H, inclusive: false, toMs: NOW - 20 * 60_000 },
      },
    });
    expect(s.subscription?.usedSharePct).toBe(10);
    expect(s.subscription?.fiveHourUsedSharePct).toBe(10);
  });
  it('no account count at all ⇒ the share is unknown and nothing blocks, even with Limn’s tokens in a full window', () => {
    const s = decide(reading(99, 99), [row(NOW - H, 5000)], null, null);
    expect(s.subscription?.usedSharePct).toBeNull();
    expect(s.subscription?.fiveHourUsedSharePct).toBeNull();
    expect(s.overBudget).toBe(false);
  });
  it('a share over the line with NO reset read is never over (there is no moment the pause would end)', () => {
    const noReset: AiUsageReading = {
      week: { utilization: 50, resetsAtMs: null, observedAtMs: NOW },
      fiveHour: { utilization: 50, resetsAtMs: null, observedAtMs: NOW },
      subscriptionType: 'plus',
    };
    const s = decide(noReset, [row(NOW - H, 1000)], 1000, 1000);
    expect(s.subscription?.usedSharePct).toBe(50);
    expect(s.overBudget).toBe(false);
    expect(s.resumesAt).toBeNull();
  });
  it('a window whose reset has passed no longer applies: unknown, never over', () => {
    const stale: AiUsageReading = {
      week: { utilization: 80, resetsAtMs: NOW - H, observedAtMs: NOW - 2 * H },
      fiveHour: null,
      subscriptionType: 'plus',
    };
    const s = decide(stale, [row(NOW - H, 100)], 100, 100);
    expect(s.subscription?.usedSharePct).toBeNull();
    expect(s.overBudget).toBe(false);
  });
});

describe('the decision and the header view on Codex', () => {
  it('no reading yet ⇒ one plain sentence, nothing blocked, no Claude subscription picker', () => {
    const s = decide(null, [row(NOW - H, 100)], null, null);
    expect(s.provider).toBe('codex');
    expect(s.mode).toBe('subscription');
    expect(s.overBudget).toBe(false);
    expect(s.reason).toBe('Limn has not read your Codex usage yet.');
    expect(s.subscription?.pickFrom).toBeNull();
    expect(s.subscription?.subscription).toBeNull();
  });
  it('percentages only — no US$ figure anywhere on a ChatGPT plan', () => {
    const s = decide(reading(10, 4), [row(NOW - H, 200)], 400, 400);
    expect(JSON.stringify(s)).not.toMatch(/usd/i);
    const v = aiUsageView({
      settings: on,
      route: 'login',
      reading: reading(10, 4),
      ledger: [row(NOW - H, 200)],
      nowMs: NOW,
      todayFromMs: NOW - 12 * H,
      provider: 'codex',
      accountTokens: { week: span(reading(10, 4), 'week', 400), fiveHour: span(reading(10, 4), 'five_hour', 400) },
    });
    expect(v.provider).toBe('codex');
    expect(v.account?.week?.usedPct).toBe(10);
    expect(v.account?.models).toEqual([]);
    expect(v.account?.reportedSubscription).toBe('plus');
    expect(v.limn.weekSharePct).toBe(5);
    expect(v.limn.fiveHourSharePct).toBe(2);
    expect(v.apiKey).toBeNull();
    expect(v.weekPctPerUsd).toBeNull();
    expect(v.limn.inputTokens).toBe(200);
  });
  it('an API key is the weekly US$ budget, exactly as for Claude', () => {
    const s = decideAiBudget({
      settings: resolveAiBudgetSettings({ enabled: true, weeklyUsd: 10 }),
      route: 'api_key',
      reading: null,
      ledger: [{ atMs: NOW - D, usd: 11 }],
      costs: NO_COSTS,
      nowMs: NOW,
      provider: 'codex',
    });
    expect(s.mode).toBe('api_key');
    expect(s.overBudget).toBe(true);
    expect(s.apiKey).toEqual({ weeklyUsd: 10, usedUsd: 11 });
  });
  it('a Claude decision without a provider is byte-for-byte what it was (no provider key)', () => {
    const s = decideAiBudget({ settings: on, route: 'none', reading: null, ledger: [], costs: NO_COSTS, nowMs: NOW });
    expect('provider' in s).toBe(false);
  });
});

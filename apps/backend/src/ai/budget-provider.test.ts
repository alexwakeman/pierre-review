// THE SPEND BUDGET IS PER PROVIDER (ai/budget.ts; docs/CODEX-PLAN.md § 8.1), on a throwaway SQLite file:
//   1. every fold summing the ledger for the budget reads the ACTIVE provider's rows only — a Codex
//      row (there are none yet in real use) never counts toward Claude's week or its cycle cost;
//   2. `recordAiUsage` writes 'claude' unless told otherwise, and carries a share when given;
//   3. with LIMN_AI_PROVIDER=codex (agents "not available yet") and no Codex credential the
//      budget answers route 'none', budget off, no probe — and nothing throws;
//   4. with a Codex ChatGPT sign-in (a faked app-server probe) the budget judges CODEX's windows by
//      the token-weighted share, through the same gate; a $0 Codex row with tokens is kept.
//
//   pnpm --filter @pierre-review/backend test ai/budget-provider
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-budget-provider`}.ai-budget-provider.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
// Limn's Codex home sits under the data directory: an empty temp one, never ~/.limn. No key either.
process.env.LIMN_DATA_DIR = mkdtempSync(join(tmpdir(), 'limn-budget-provider-'));
delete process.env.OPENAI_API_KEY;

/* eslint-disable @typescript-eslint/no-explicit-any */
let B: typeof import('./budget.js');
let U: typeof import('../db/usage.js');
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
const savedProvider = process.env.LIMN_AI_PROVIDER;

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db.insert(schema.accounts).values({ id: 7, githubUserId: 'U7', githubLogin: 'me7', isLocal: false }).onConflictDoNothing().execute();
  B = await import('./budget.js');
  U = await import('../db/usage.js');
  await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'claude-opus-5-5', costUsd: 2, inputTokens: 10, outputTokens: 5 });
  await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'x', costUsd: 9, provider: 'codex', sharePct: 1.5 });
});

afterEach(async () => {
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
  B._resetAiBudgetForTest();
  (await import('./codex/app-server.js'))._setCodexProbeForTest(null);
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('the ledger read reaches back to the account-token span', () => {
  it('ledgerSinceMs: the week, today, and an earlier span start (a day bucket opening before the week)', () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const week = now - 7 * 24 * 3600_000;
    expect(B.ledgerSinceMs(now, null)).toBe(week);
    const bucket = week - 12 * 3600_000;
    expect(
      B.ledgerSinceMs(now, {
        week: { tokens: 1, fromMs: bucket, inclusive: true, toMs: now },
        fiveHour: { tokens: 1, fromMs: now - 3600_000, inclusive: false, toMs: now },
      }),
    ).toBe(bucket);
  });
});

describe('the ledger is read per provider', () => {
  it('recordAiUsage writes claude by default and keeps a given provider and share', async () => {
    const rows = await db.select().from(schema.aiUsage).execute();
    expect(rows.map((r: any) => [r.provider, r.sharePct, r.costUsd])).toEqual([
      ['claude', null, 2],
      ['codex', 1.5, 9],
    ]);
  });

  it("Claude's week counts only Claude's rows", async () => {
    delete process.env.LIMN_AI_PROVIDER;
    const snap = await B.aiBudgetSnapshot(7, { probe: false });
    expect(snap.usage.limn.runs).toBe(1);
  });

  it('aiBudgetOthers: every non-default provider in use, each with its own figures', async () => {
    // Claude is the default; Codex has no credential here but Limn ran on it this week ⇒ listed.
    delete process.env.LIMN_AI_PROVIDER;
    const others = await B.aiBudgetOthers(7, { probe: false });
    expect(others.map((o) => o.provider)).toEqual(['codex']);
    expect(others[0]!.usage.provider).toBe('codex');
    expect(others[0]!.status.provider).toBe('codex');
    expect(others[0]!.usage.limn.runs).toBeGreaterThanOrEqual(1);
    // Codex is the default: Claude is the other one, and Limn ran it this week ⇒ listed.
    process.env.LIMN_AI_PROVIDER = 'codex';
    const flipped = await B.aiBudgetOthers(7, { probe: false });
    expect(flipped.map((o) => o.provider)).toEqual(['claude']);
    expect(flipped[0]!.usage.limn.runs).toBe(1);
  });

  it('aiBudgetOthers leaves out a provider with no credential and no runs this week', async () => {
    delete process.env.LIMN_AI_PROVIDER;
    // Account 8 has no ledger rows at all; Codex holds no credential in this test environment.
    await db.insert(schema.accounts).values({ id: 8, githubUserId: 'U8', githubLogin: 'me8', isLocal: false }).onConflictDoNothing().execute();
    expect(await B.aiBudgetOthers(8, { probe: false })).toEqual([]);
  });

  it('the cycle cost averages only the asked provider’s runs', async () => {
    const now = Date.now();
    expect((await B.readCycleCosts(7, now)).reviewMeanUsd).toBe(2);
    expect((await B.readCycleCosts(7, now, 'claude')).reviewMeanUsd).toBe(2);
    expect((await B.readCycleCosts(7, now, 'codex')).reviewMeanUsd).toBe(9);
  });

  it('LIMN_AI_PROVIDER=codex with no Codex credential — route none, budget off, no probe, no throw', async () => {
    process.env.LIMN_AI_PROVIDER = 'codex';
    const snap = await B.aiBudgetSnapshot(7, { probe: 'always' });
    expect(snap.status.route).toBe('none');
    expect(snap.status.overBudget).toBe(false);
    expect(snap.usage.limn.runs).toBe(1); // the codex row
    expect(B.kickUsageProbe(Date.now())).toBeNull();
    expect(await B.allowAutomaticRun(7, 'test')).toBe(true);
  });

  it('LIMN_AI_PROVIDER=codex on a ChatGPT sign-in: Codex windows, TOKEN-WEIGHTED share, the one gate', async () => {
    process.env.LIMN_AI_PROVIDER = 'codex';
    const AS = await import('./codex/app-server.js');
    const now = Date.now();
    const weekReset = now + 3 * 24 * 3600_000;
    const fiveReset = now + 2 * 3600_000;
    const weekFrom = weekReset - 7 * 24 * 3600_000;
    const reading = {
      week: { utilization: 10, resetsAtMs: weekReset, observedAtMs: now },
      fiveHour: { utilization: 4, resetsAtMs: fiveReset, observedAtMs: now },
      subscriptionType: 'plus',
    };
    const account = { signedIn: true, type: 'chatgpt', plan: 'plus' };
    // Two lifetime samples: one before the week opened (1,000) and one now (1,400) ⇒ 400 account
    // tokens in the week, and in the 5-hour window too.
    let lifetime = 1000;
    let at = weekFrom - 60_000;
    AS._setCodexProbeForTest(async () => ({ atMs: at, account, reading, lifetimeTokens: lifetime, daily: null }));
    await AS.kickCodexProbe({ force: true, nowMs: at });
    // A sample just before the 5-hour window opened (no account use since the week opened): the
    // week's start sample is DAYS older than that window, so it cannot count as its start.
    at = fiveReset - 5 * 3600_000 - 60_000;
    await AS.kickCodexProbe({ force: true, nowMs: at });
    // Limn's own Codex runs this week: 150 + 50 = 200 tokens (the earlier codex row reported none).
    await U.recordAiUsage({
      accountId: 7, seam: 'agent', feature: 'claude_review', model: 'gpt-6-luna', costUsd: 0,
      provider: 'codex', inputTokens: 150, outputTokens: 50,
    });
    // The account's newest sample comes AFTER Limn's run (the account's count ends there, and Limn's
    // is counted to exactly that instant).
    lifetime = 1400;
    at = Date.now() + 1;
    await AS.kickCodexProbe({ force: true, nowMs: at });
    // The $0 Codex row is KEPT (its tokens are the share's numerator) — and so is a cancelled Codex
    // run's row with NULL tokens ("tokens unknown", CODEX-SPIKE.md § 9: every run is recorded, and an
    // unknown figure is never written as zero). A $0 Claude row still is not.
    const before = (await db.select().from(schema.aiUsage).execute()).length;
    await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'claude-x', costUsd: 0, inputTokens: 9 });
    await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'gpt-6-luna', costUsd: 0, provider: 'codex' });
    expect((await db.select().from(schema.aiUsage).execute()).length).toBe(before + 1);
    const codexRows = (await db.select().from(schema.aiUsage).execute()).filter((r: any) => r.provider === 'codex' && r.costUsd === 0);
    expect(codexRows).toHaveLength(2);
    expect(codexRows.filter((r: any) => r.inputTokens === null && r.outputTokens === null)).toHaveLength(1);
    await B.writeAiBudgetSettings(7, { enabled: true, weekSharePct: 5 });
    try {
      const snap = await B.aiBudgetSnapshot(7, { probe: false, nowMs: now + 1000 });
      expect(snap.status.provider).toBe('codex');
      expect(snap.status.route).toBe('login');
      expect(snap.status.mode).toBe('subscription');
      // 200 / 400 × 10% = 5% of the week ⇒ at a 5% share: over.
      expect(snap.status.subscription?.usedSharePct).toBe(5);
      // 200 / 400 × 4% = 2% of the 5-hour window.
      expect(snap.status.subscription?.fiveHourUsedSharePct).toBe(2);
      expect(snap.status.subscription?.reportedSubscription).toBe('plus');
      expect(snap.status.subscription?.pickFrom).toBeNull();
      expect(snap.status.overBudget).toBe(true);
      expect(snap.status.limitedBy).toBe('week');
      expect(snap.status.resumesAt).toBe(new Date(weekReset).toISOString());
      // The header's view: Codex's own windows, Limn's token-weighted shares, no US$ anywhere.
      expect(snap.usage.provider).toBe('codex');
      expect(snap.usage.account?.week?.usedPct).toBe(10);
      expect(snap.usage.account?.fiveHour?.usedPct).toBe(4);
      expect(snap.usage.limn.weekSharePct).toBe(5);
      // Limn's week and session are CODEX'S OWN windows: they start at its resets minus their length.
      expect(snap.usage.limn).toMatchObject({
        window: 'reset',
        weekFrom: new Date(weekFrom).toISOString(),
        weekResetsAt: new Date(weekReset).toISOString(),
        fiveHourWindow: 'reset',
        fiveHourFrom: new Date(fiveReset - 5 * 3600_000).toISOString(),
        fiveHourResetsAt: new Date(fiveReset).toISOString(),
      });
      expect(snap.usage.apiKey).toBeNull();
      expect(snap.usage.weekPctPerUsd).toBeNull();
      expect(await B.allowAutomaticRun(7, 'test', undefined, async () => snap.status)).toBe(false);
    } finally {
      await B.writeAiBudgetSettings(7, { enabled: false });
    }
  });
});

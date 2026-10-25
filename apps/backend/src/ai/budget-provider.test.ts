// THE SPEND BUDGET IS PER PROVIDER (ai/budget.ts; docs/CODEX-PLAN.md § 8.1), on a throwaway SQLite file:
//   1. every fold summing the ledger for the budget reads the ACTIVE provider's rows only — a Codex
//      row (there are none yet in real use) never counts toward Claude's week or its cycle cost;
//   2. `recordAiUsage` writes 'claude' unless told otherwise, and carries a share when given;
//   3. with LIMN_AI_PROVIDER=codex (the "not available yet" placeholder) and no Codex credential the
//      budget answers route 'none', budget off, no probe — and nothing throws;
//   4. with a Codex ChatGPT sign-in (a faked app-server probe) the budget judges CODEX's windows by
//      the token-weighted share, through the same gate; a $0 Codex row with tokens is kept.
//
//   pnpm --filter @pierre-review/backend test ai/budget-provider
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-ai-budget-provider'}.ai-budget-provider.sqlite`;
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

  it('the cycle cost averages only the asked provider’s runs', async () => {
    const now = Date.now();
    expect((await B.readCycleCosts(7, now)).reviewMeanUsd).toBe(2);
    expect((await B.readCycleCosts(7, now, 'claude')).reviewMeanUsd).toBe(2);
    expect((await B.readCycleCosts(7, now, 'codex')).reviewMeanUsd).toBe(9);
  });

  it('LIMN_AI_PROVIDER=codex: the placeholder answers — route none, budget off, no probe, no throw', async () => {
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
    lifetime = 1400;
    at = now;
    await AS.kickCodexProbe({ force: true, nowMs: now });
    // Limn's own Codex runs this week: 150 + 50 = 200 tokens (the earlier codex row reported none).
    await U.recordAiUsage({
      accountId: 7, seam: 'agent', feature: 'claude_review', model: 'gpt-6-luna', costUsd: 0,
      provider: 'codex', inputTokens: 150, outputTokens: 50,
    });
    // The $0 Codex row is KEPT (its tokens are the share's numerator); a $0 Claude row still is not.
    const before = (await db.select().from(schema.aiUsage).execute()).length;
    await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'claude-x', costUsd: 0, inputTokens: 9 });
    await U.recordAiUsage({ accountId: 7, seam: 'agent', feature: 'claude_review', model: 'gpt-6-luna', costUsd: 0, provider: 'codex' });
    expect((await db.select().from(schema.aiUsage).execute()).length).toBe(before);
    expect(
      (await db.select().from(schema.aiUsage).execute()).filter((r: any) => r.provider === 'codex' && r.costUsd === 0),
    ).toHaveLength(1);
    await B.writeAiBudgetSettings(7, { enabled: true });
    try {
      const snap = await B.aiBudgetSnapshot(7, { probe: false, nowMs: now + 1000 });
      expect(snap.status.provider).toBe('codex');
      expect(snap.status.route).toBe('login');
      expect(snap.status.mode).toBe('subscription');
      // 200 / 400 × 10% = 5% of the week ⇒ at the 5% default share: over.
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
      expect(snap.usage.apiKey).toBeNull();
      expect(snap.usage.weekPctPerUsd).toBeNull();
      expect(await B.allowAutomaticRun(7, 'test', undefined, async () => snap.status)).toBe(false);
    } finally {
      await B.writeAiBudgetSettings(7, { enabled: false });
    }
  });
});

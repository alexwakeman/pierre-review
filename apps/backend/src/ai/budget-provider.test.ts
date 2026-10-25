// THE SPEND BUDGET IS PER PROVIDER (ai/budget.ts; docs/CODEX-PLAN.md § 8.1), on a throwaway SQLite file:
//   1. every fold summing the ledger for the budget reads the ACTIVE provider's rows only — a Codex
//      row (there are none yet in real use) never counts toward Claude's week or its cycle cost;
//   2. `recordAiUsage` writes 'claude' unless told otherwise, and carries a share when given;
//   3. with LIMN_AI_PROVIDER=codex (the "not available yet" placeholder) the budget asks the
//      placeholder: route 'none', budget off, no probe — and nothing throws.
//
//   pnpm --filter @pierre-review/backend test ai/budget-provider
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-ai-budget-provider'}.ai-budget-provider.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

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

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
  B._resetAiBudgetForTest();
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
});

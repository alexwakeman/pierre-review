// computeTriage — the "approved & ready" tag must respect BRANCH PROTECTION, on a THROWAWAY
// sqlite DB (the bot-analytics-verdict.test.ts pattern).
//
// The bug this pins: the tag fired on `mergeable === 'mergeable'` alone. `mergeable` reports
// ONLY merge-CONFLICT state (MERGEABLE / CONFLICTING / UNKNOWN), so an approved PR whose
// REQUIRED checks were failing — `mergeStateStatus: 'blocked'` — was tagged "approved & ready"
// in the triage queue while every merge surface (correctly) refused to merge it.
//
// The gate is `mergeStateStatus ∈ {clean, has_hooks, unstable}`. 'unstable' is deliberately IN:
// it means only NON-required checks are red, and GitHub will still merge it — so it really is
// ready. 'blocked' / 'behind' / 'dirty' / 'unknown' are not.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MergeStateStatus, ReasonTag, ThreadStateCounts } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-triage-merge-verdict-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let computeTriage: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

const NO_THREADS: ThreadStateCounts = {
  untouched: 0,
  replied_unresolved: 0,
  likely_addressed: 0,
  resolved: 0,
};

// One seeded PR per merge state, so each case is a distinct row with its own approving review.
const CASES: { key: string; mss: MergeStateStatus; expected: ReasonTag }[] = [
  { key: 'clean', mss: 'clean', expected: 'approved_ready' },
  { key: 'has_hooks', mss: 'has_hooks', expected: 'approved_ready' },
  // Non-required checks red — GitHub merges it, so it IS ready.
  { key: 'unstable', mss: 'unstable', expected: 'approved_ready' },
  // The regression: required checks failing / required reviews missing.
  { key: 'blocked', mss: 'blocked', expected: 'in_progress' },
  { key: 'behind', mss: 'behind', expected: 'in_progress' },
  { key: 'unknown', mss: 'unknown', expected: 'in_progress' },
];

const prIdByKey = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ computeTriage } = await import('./triage.js'));
  await runMigrations();

  const { repos, pullRequests, users, reviews } = schema;

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_triage',
      inboxWatch: true,
    })
    .returning()
    .execute();

  const [reviewer] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice', isBot: false })
    .returning()
    .execute();

  let n = 1;
  for (const c of CASES) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_${c.key}`,
        accountId: 1,
        repoId: repo.id,
        number: n++,
        title: `${c.key} fixture`,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 3 * DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    prIdByKey.set(c.key, pr.id);
    // A standing approval — the other half of the `approved_ready` condition.
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_${c.key}`,
        prId: pr.id,
        authorId: reviewer.id,
        state: 'approved',
        body: null,
        submittedAt: new Date(now - DAY),
      })
      .execute();
  }
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('computeTriage approved_ready gate', () => {
  it('only tags an approved PR ready when branch protection would let it land', async () => {
    const inputs = CASES.map((c) => ({
      id: prIdByKey.get(c.key)!,
      state: 'open' as const,
      authorId: null,
      // Success, so the earlier `ci_failing` branch can never be what decides these cases.
      ciStatus: 'success' as const,
      mergeable: 'mergeable' as const,
      mergeStateStatus: c.mss,
      isStalled: false,
      threadCounts: NO_THREADS,
    }));

    const out = await computeTriage(inputs, 1);

    for (const c of CASES) {
      const res = out.get(prIdByKey.get(c.key)!);
      expect(res, `no triage result for ${c.key}`).toBeTruthy();
      // The approval standing itself is unaffected by the gate — it is only the READY tag
      // that keys on mergeability, so every case stays isApproved.
      expect(res.isApproved, `${c.key} should still read as approved`).toBe(true);
      expect(res.reasonTag, `${c.key} (mergeStateStatus=${c.mss})`).toBe(c.expected);
    }
  });
});

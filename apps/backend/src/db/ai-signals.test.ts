// AI VENDOR SIGNALS, READ SIDE (db/ai-signals.ts; docs/AI-ADOPTION-REPORT.md § Detection).
// Throwaway sqlite, no GitHub.
//
// What this pins:
//   1. A PR's signals = its own ∪ its commits' ∪ Ensemble's own work, deduped, canonical order.
//   2. `scanned` follows the stored version; NULL is unknown, never "no AI".
//   3. Ensemble's work counts from ai_fixes rows that PUSHED (not every run), and from Implement
//      pushes resolved within (accountId, repoId) only — never a same-number PR in another repo, and
//      never `limn_pushed_by_user_id` (a plain branch update or a hand-made conflict resolution).
//   4. Cross-account: another account's ids are ABSENT, its rows never leak in.
//   5. `aiSignalsFirstScanMs`: the earliest scan among the given repos, null when none.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_SIGNALS_VERSION } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-signals-read-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let read: typeof import('./ai-signals.js');
const R: Record<string, number> = {};
const P: Record<string, number> = {};
let personId = 0;

async function mkPr(accountId: number, repoId: number, n: number, over: Record<string, unknown> = {}): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_air_${accountId}_${repoId}_${n}`,
      accountId,
      repoId,
      number: n,
      title: `pr ${n}`,
      state: 'merged',
      isDraft: false,
      openedAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
      ...over,
    })
    .returning()
    .execute();
  return pr.id;
}

async function mkCommit(prId: number, sha: string, aiSignals: string | null, over: Record<string, unknown> = {}): Promise<void> {
  await db.insert(schema.commits).values({ prId, sha, committedAt: new Date(), aiSignals, ...over }).execute();
}

async function mkFix(accountId: number, repoId: number, prId: number, pushedAt: Date | null): Promise<void> {
  await db
    .insert(schema.aiFixes)
    .values({ accountId, repoId, prId, baseSha: 'b', status: 'done', model: 'm', seed: 'review', pushedAt })
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  read = await import('./ai-signals.js');
  const { ensureDefaultWorkspace } = await import('./queries.js');
  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_air_b', githubLogin: 'air-b', isLocal: false }).execute();
  const mkRepo = async (accountId: number, name: string): Promise<number> =>
    (await db.insert(schema.repos).values({ accountId, owner: 'acme', name, githubNodeId: `R_air_${accountId}_${name}` }).returning().execute())[0].id;
  R.api = await mkRepo(1, 'api');
  R.web = await mkRepo(1, 'web');
  R.foreign = await mkRepo(2, 'api');
  personId = (await db.insert(schema.users).values({ githubLogin: 'alice', isBot: false }).returning().execute())[0].id;

  const v1 = { aiSignalsVersion: AI_SIGNALS_VERSION, aiSignalsCheckedAt: new Date('2026-10-05T00:00:00Z') };
  // PR + commits, overlapping signals.
  P.mixed = await mkPr(1, R.api, 1, { aiSignals: JSON.stringify([{ vendor: 'claude', source: 'pr_body' }]), ...v1 });
  await mkCommit(P.mixed, 'm1', JSON.stringify([{ vendor: 'claude', source: 'commit_trailer' }]));
  await mkCommit(P.mixed, 'm2', JSON.stringify([{ vendor: 'claude', source: 'commit_trailer' }, { vendor: 'cursor', source: 'commit_trailer' }]));
  await mkCommit(P.mixed, 'm3', null); // not scanned: contributes nothing
  // Scanned clean.
  P.clean = await mkPr(1, R.api, 2, { aiSignals: '[]', ...v1, aiSignalsCheckedAt: new Date('2026-10-03T00:00:00Z') });
  await mkCommit(P.clean, 'c1', '[]');
  // Never scanned.
  P.unscanned = await mkPr(1, R.api, 3);
  // Stale version.
  P.stale = await mkPr(1, R.api, 4, { aiSignals: '[]', aiSignalsVersion: 0, aiSignalsCheckedAt: new Date('2026-10-04T00:00:00Z') });
  // AI Fix: pushed counts, an unpushed run does not.
  P.fixPushed = await mkPr(1, R.api, 5, { aiSignals: '[]', ...v1 });
  await mkFix(1, R.api, P.fixPushed, new Date());
  P.fixUnpushed = await mkPr(1, R.api, 6, { aiSignals: '[]', ...v1 });
  await mkFix(1, R.api, P.fixUnpushed, null);
  // A Limn-attributed commit (a branch update or a conflict resolution) is NOT AI work.
  P.limnPush = await mkPr(1, R.api, 7, { aiSignals: '[]', ...v1 });
  await mkCommit(P.limnPush, 'l1', '[]', { limnPushedByUserId: personId });
  // Implement story: PR #8 in api by number; the loop's sha in PR #9; the same number #8 in web must not count.
  P.implNumber = await mkPr(1, R.api, 8, { aiSignals: '[]', ...v1 });
  P.implLoop = await mkPr(1, R.api, 9, { aiSignals: '[]', ...v1 });
  await mkCommit(P.implLoop, 'loopsha', '[]');
  P.webSameNumber = await mkPr(1, R.web, 8, { aiSignals: '[]', ...v1 });
  await mkCommit(P.webSameNumber, 'loopsha', '[]'); // same sha, another repo: not this build's push
  // Another account: an id the reader passes must be absent.
  P.foreign = await mkPr(2, R.foreign, 8, { aiSignals: JSON.stringify([{ vendor: 'devin', source: 'pr_author' }]), ...v1 });
  await mkFix(2, R.foreign, P.foreign, new Date());

  const ws = await ensureDefaultWorkspace(1);
  const [build] = await db
    .insert(schema.storyBuilds)
    .values({ accountId: 1, workspaceId: ws, ident: 'PROJ-1', ticketKey: 'PROJ-1', status: 'done' })
    .returning()
    .execute();
  const [plan] = await db
    .insert(schema.storyBuildPlans)
    .values({ accountId: 1, buildId: build.id, revision: 1, source: 'opening', planJson: { stack: [], criteria: [], contentions: [] }, rawSha: 'x' })
    .returning()
    .execute();
  const sbp = (k: number, over: Record<string, unknown>) => ({
    accountId: 1,
    buildId: build.id,
    repoId: R.api,
    planId: plan.id,
    prKey: `PR${k}`,
    position: k,
    stackIndex: k,
    title: `Part ${k}`,
    contains: 'x',
    branch: `PROJ-1-${k}`,
    status: 'pushed',
    ...over,
  });
  await db
    .insert(schema.storyBuildPrs)
    .values([sbp(1, { pushedPrNumber: 8, pushedAt: new Date() }), sbp(2, { loopPushedSha: 'LOOPSHA' }), sbp(3, {})])
    .execute();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getPrAiSignals', () => {
  it('unions the PR, its commits and Ensemble, deduped in canonical order', async () => {
    const m = await read.getPrAiSignals(1, [P.mixed!]);
    expect(m.get(P.mixed!)).toEqual({
      scanned: true,
      signals: [
        { vendor: 'claude', source: 'commit_trailer' },
        { vendor: 'claude', source: 'pr_body' },
        { vendor: 'cursor', source: 'commit_trailer' },
      ],
    });
  });

  it('reads the scan state: clean, never scanned, stale', async () => {
    const m = await read.getPrAiSignals(1, [P.clean!, P.unscanned!, P.stale!]);
    expect(m.get(P.clean!)).toEqual({ scanned: true, signals: [] });
    expect(m.get(P.unscanned!)).toEqual({ scanned: false, signals: [] });
    expect(m.get(P.stale!)).toEqual({ scanned: false, signals: [] });
  });

  it("counts Ensemble's pushed work only, resolved within its repo", async () => {
    const ids = [P.fixPushed!, P.fixUnpushed!, P.limnPush!, P.implNumber!, P.implLoop!, P.webSameNumber!];
    const m = await read.getPrAiSignals(1, ids);
    const ens = [{ vendor: 'ensemble', source: 'ensemble' }];
    expect(m.get(P.fixPushed!)!.signals).toEqual(ens);
    expect(m.get(P.fixUnpushed!)!.signals).toEqual([]);
    expect(m.get(P.limnPush!)!.signals).toEqual([]);
    expect(m.get(P.implNumber!)!.signals).toEqual(ens);
    expect(m.get(P.implLoop!)!.signals).toEqual(ens);
    expect(m.get(P.webSameNumber!)!.signals).toEqual([]);
  });

  it("leaves another account's ids out of the map, and its rows out of every verdict", async () => {
    const m = await read.getPrAiSignals(1, [P.foreign!, P.clean!, 999_999]);
    expect([...m.keys()]).toEqual([P.clean!]);
    const theirs = await read.getPrAiSignals(2, [P.foreign!, P.mixed!]);
    expect([...theirs.keys()]).toEqual([P.foreign!]);
    expect(theirs.get(P.foreign!)!.signals).toEqual([
      { vendor: 'devin', source: 'pr_author' },
      { vendor: 'ensemble', source: 'ensemble' },
    ]);
  });

  it('answers an empty map for no ids, and chunks a long list', async () => {
    expect((await read.getPrAiSignals(1, [])).size).toBe(0);
    const many = [...Array.from({ length: 1_500 }, (_v, i) => 1_000_000 + i), P.mixed!, P.clean!];
    const m = await read.getPrAiSignals(1, many);
    expect(new Set(m.keys())).toEqual(new Set([P.mixed!, P.clean!]));
  });
});

describe('aiSignalsFirstScanMs', () => {
  it('is the earliest scan among the given repos, account-scoped', async () => {
    expect(await read.aiSignalsFirstScanMs(1, [R.api!])).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(await read.aiSignalsFirstScanMs(1, [R.web!, R.api!])).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(await read.aiSignalsFirstScanMs(1, [R.foreign!])).toBeNull();
    expect(await read.aiSignalsFirstScanMs(2, [R.foreign!])).toBe(Date.parse('2026-10-05T00:00:00Z'));
    expect(await read.aiSignalsFirstScanMs(1, [])).toBeNull();
  });
});

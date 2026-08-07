// The ML-label candidate query and the "pending" count, on a THROWAWAY sqlite DB.
//
// REGRESSION THIS FILE EXISTS FOR: an approval with no comment is a `reviews` row whose body is
// the EMPTY STRING, not NULL — there are 5.4k of them in this repo's own dev database. The first
// cut filtered candidates with `IS NOT NULL` and then dropped empty bodies in JavaScript, while
// the pending COUNT only did the `IS NOT NULL` half. The two therefore disagreed permanently:
// the worker skipped those rows on every tick while the Bots panel reported them as "still being
// processed", and coverage could never reach 100%. Both sides now share one `trim(x) <> ''`
// predicate. Seeding an empty-body review is what makes this fail against the old code.
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-ml-labels-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let mlLabels: any;
let queries: any;

let scope: { workspaceId: number; repoIds: number[] };
let botId = 0;
let realReviewId = 0;
let emptyReviewId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  mlLabels = await import('./ml-labels.js');
  queries = await import('./queries.js');
  await runMigrations();

  const at = new Date();
  const { repos, pullRequests, users, reviews, reviewThreads } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_ml' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_ml',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'pr',
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubNodeId: 'U_bot', githubLogin: 'somebot', isBot: true })
    .returning()
    .execute();
  botId = bot.id;

  // A thread so the actor has a FOOTPRINT — setWorkspaceReviewer refuses an actor without one,
  // and a review comment alone does not create one.
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_ml',
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      originalCommenterId: botId,
      createdAt: at,
    })
    .execute();

  // THE FIXTURE: one review with real text, one that is an approval with NO comment (empty
  // string, NOT null), and one that is whitespace only.
  const [real] = await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_real',
      prId: pr.id,
      authorId: botId,
      state: 'commented',
      body: 'This looks like a genuine finding worth classifying.',
      submittedAt: at,
    })
    .returning()
    .execute();
  realReviewId = real.id;
  const [empty] = await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_empty',
      prId: pr.id,
      authorId: botId,
      state: 'approved',
      body: '',
      submittedAt: at,
    })
    .returning()
    .execute();
  emptyReviewId = empty.id;
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_blank',
      prId: pr.id,
      authorId: botId,
      state: 'approved',
      body: '   \n  ',
      submittedAt: at,
    })
    .execute();

  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  scope = (await queries.workspaceScopeForRepo(1, repo.id))!;
  await queries.setWorkspaceReviewer(1, botId, {
    workspaceId: scope.workspaceId,
    automated: true,
  });
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ML label candidates vs the pending count', () => {
  it('excludes the empty-string approval, the 5.4k-row case', async () => {
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    expect(candidates.map((c: any) => c.targetId)).toContain(realReviewId);
    expect(candidates.map((c: any) => c.targetId)).not.toContain(emptyReviewId);
    // The whitespace-with-newlines row DOES survive, and that is deliberate: SQL's `trim()`
    // strips spaces only in both dialects, so excluding it would take a JS-side filter — and a
    // JS-side filter is exactly what made the two sides disagree. It is classified once and
    // then stops being pending, which is cheaper than a permanent discrepancy.
    expect(candidates).toHaveLength(2);
  });

  it('counts pending as EXACTLY what the worker will pick up (the empty-body trap)', async () => {
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    // THE INVARIANT. Against the old code this was 2 vs 3 (and against the code before that,
    // 1 vs 3): rows the worker would never offer were counted as work outstanding forever.
    expect(rollup.pending).toBe(candidates.length);
    expect(rollup.pending).toBe(2);
    expect(rollup.labelled).toBe(0);
  });

  // The account-wide backlog is what `GET /api/ml-status` reports so a sync surface can keep
  // showing the scoring phase instead of announcing "complete" when only the GitHub walk is
  // done. It walks every workspace itself, so the thing worth pinning is that it agrees with
  // the per-workspace answer rather than quietly reporting an empty backlog — a zero here would
  // make the indicator go dark with work still outstanding, which is the exact bug it fixes.
  it('reports the same outstanding work account-wide as the workspace rollup', async () => {
    const backlog = await mlLabels.getMlBacklogForAccount(1);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(backlog.pending).toBe(rollup.pending);
    expect(backlog.pending).toBe(2);
    expect(backlog.labelled).toBe(0);
  });

  it('drops to zero pending once every candidate is labelled', async () => {
    const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    await mlLabels.upsertMlLabels(
      candidates.map((c: any) => ({
        accountId: 1,
        repoId: scope.repoIds[0]!,
        prId,
        targetKind: c.targetKind,
        targetId: c.targetId,
        authorUserId: botId,
        severity: c.targetId === realReviewId ? 'major' : 'nit',
        severityOrd: c.targetId === realReviewId ? 2 : 0,
        severityProb: 0.8,
        categories: ['correctness_bug'],
        categoryProbs: { correctness_bug: 0.8 },
        isSummary: false,
        backend: 'test',
        modelVersion: 'test',
        bodyHash: 'h',
        targetCreatedAt: new Date(),
      })),
    );
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(rollup.pending).toBe(0);
    expect(rollup.labelled).toBe(2);
    expect(rollup.totals.bySeverity.major).toBe(1);
    expect(await mlLabels.listMlCandidates(1, scope, 100)).toEqual([]);
    // ...and the account-wide backlog drains with it, so the sync indicator can actually stop.
    expect(await mlLabels.getMlBacklogForAccount(1)).toEqual({
      pending: 0,
      unscorable: 0,
      labelled: 2,
    });
  });

  // ── The VENDOR'S OWN declared severity, stored beside ours ──────────────────────────────
  //
  // Two independent things have to hold, and they fail in opposite directions:
  //   • a claim that IS present survives the round trip to the per-PR badge index, because the
  //     whole point is displaying it next to ours ("CodeRabbit: Major · Pierre: Minor");
  //   • a claim that is ABSENT — the ordinary case, and also what an older severity-api build
  //     produces for every row — stores NULL and throws nothing. A write that threw here would
  //     abandon the workspace's backlog for the tick, and the target would be re-selected
  //     forever after (the candidate query is "has no label row").
  describe('vendor severity', () => {
    const baseRow = () => ({
      accountId: 1,
      repoId: scope.repoIds[0]!,
      authorUserId: botId,
      severity: 'minor' as const,
      severityOrd: 1,
      severityProb: 0.7,
      categories: ['correctness_bug'],
      categoryProbs: { correctness_bug: 0.7 },
      isSummary: false,
      backend: 'test',
      modelVersion: 'test',
      bodyHash: 'hv',
      targetCreatedAt: new Date(),
    });

    it('round-trips a vendor claim through the per-PR index', async () => {
      const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
      // Clear this target's label first so what follows is a genuine INSERT. By the time this
      // file gets here the earlier cases have already labelled every candidate, so without the
      // delete both halves of the upsert would only ever be exercised on the UPDATE path — and
      // "the insert forgot the new columns" is the other half of the same landmine. The row is
      // re-created immediately below, so the counts the later cases assert are unchanged.
      // Scoped to THIS target: a blanket delete would also drop the other candidate's label and
      // leave `labelled` one short for the cases that follow.
      await db
        .delete(schema.mlCommentLabels)
        .where(
          and(
            eq(schema.mlCommentLabels.targetKind, 'review'),
            eq(schema.mlCommentLabels.targetId, realReviewId),
          ),
        )
        .execute();
      await mlLabels.upsertMlLabels([
        {
          ...baseRow(),
          prId,
          targetKind: 'review',
          targetId: realReviewId,
          // The bot says MAJOR where we say MINOR. That disagreement is the feature: our label
          // is the more accurate one (0.700 exact / 0.303 ordinal MAE against the vendor
          // badge's 0.474 / 0.697), so ours must be untouched by theirs.
          vendorSeverity: 'major',
          vendorSeverityConfidence: 'high',
        },
      ]);
      const labels = await mlLabels.getPrMlLabels(prId, 1);
      const label = labels.find(
        (l: any) => l.targetKind === 'review' && l.targetId === realReviewId,
      );
      expect(label).toBeDefined();
      expect(label.vendorSeverity).toBe('major');
      expect(label.vendorSeverityConfidence).toBe('high');
      // OUR severity is not derived from, corrected by, or overwritten with theirs.
      expect(label.severity).toBe('minor');
    });

    it('stores null when the service omitted the fields entirely', async () => {
      const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
      const row: any = { ...baseRow(), prId, targetKind: 'review', targetId: realReviewId };
      // Not `vendorSeverity: null` — the keys are ABSENT, exactly as they are when an older
      // severity-api build answers and the client's defensive read finds nothing.
      expect('vendorSeverity' in row).toBe(false);
      await expect(mlLabels.upsertMlLabels([row])).resolves.toBe(1);
      const labels = await mlLabels.getPrMlLabels(prId, 1);
      const label = labels.find(
        (l: any) => l.targetKind === 'review' && l.targetId === realReviewId,
      );
      expect(label.vendorSeverity).toBeNull();
      expect(label.vendorSeverityConfidence).toBeNull();
    });

    it('CLEARS a stale claim on re-write — the onConflictDoUpdate branch', async () => {
      // The conflict target is `(account_id, target_kind, target_id)` and the new columns have
      // to be in BOTH halves of the upsert. An insert-only test never reaches the SET list, and
      // a missing key there type-checks perfectly while freezing the first value ever stored.
      const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
      const target = { prId, targetKind: 'review' as const, targetId: realReviewId };
      await mlLabels.upsertMlLabels([
        { ...baseRow(), ...target, vendorSeverity: 'critical', vendorSeverityConfidence: 'low' },
      ]);
      let label = (await mlLabels.getPrMlLabels(prId, 1)).find(
        (l: any) => l.targetKind === 'review' && l.targetId === realReviewId,
      );
      expect(label.vendorSeverity).toBe('critical');

      // Same target, re-scored after the vendor dropped its badge (or the service that read it
      // was rolled back). The row must be UPDATED in place and the claim must go.
      await mlLabels.upsertMlLabels([
        { ...baseRow(), ...target, vendorSeverity: null, vendorSeverityConfidence: null },
      ]);
      const all = await mlLabels.getPrMlLabels(prId, 1);
      expect(
        all.filter((l: any) => l.targetKind === 'review' && l.targetId === realReviewId),
      ).toHaveLength(1);
      label = all.find((l: any) => l.targetKind === 'review' && l.targetId === realReviewId);
      expect(label.vendorSeverity).toBeNull();
      expect(label.vendorSeverityConfidence).toBeNull();
    });
  });

  it('upserts idempotently on (account, target_kind, target_id)', async () => {
    // The conflict target is the table's declared unique. A stale one type-checks perfectly and
    // only raises at runtime, only when a row is actually WRITTEN — so writing twice is the
    // only thing that exercises it.
    const row = {
      accountId: 1,
      repoId: scope.repoIds[0]!,
      prId: (await db.select().from(schema.pullRequests).execute())[0]!.id,
      targetKind: 'review' as const,
      targetId: realReviewId,
      authorUserId: botId,
      severity: 'nit' as const,
      severityOrd: 0,
      severityProb: 0.4,
      categories: ['nitpick'],
      categoryProbs: { nitpick: 0.4 },
      isSummary: false,
      backend: 'test2',
      modelVersion: 'test2',
      bodyHash: 'h2',
      targetCreatedAt: new Date(),
    };
    await mlLabels.upsertMlLabels([row]);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(rollup.labelled).toBe(2); // the row was UPDATED, not duplicated
    expect(rollup.totals.bySeverity.major).toBe(0); // major → nit
    expect(rollup.totals.bySeverity.nit).toBe(2);
  });

  // ── The reviewThreads join drift ────────────────────────────────────────────────────────
  //
  // The candidate query joins reviewThreads to carry `path` — a HINT to the model, nothing
  // more — while the pending count does not join threads at all. With an INNER join those two
  // disagree the moment a review comment's thread row is missing: counted as pending forever,
  // never offered to the worker — a phantom backlog `isMlScoring` cannot tell from real work.
  // The join is LEFT so a threadless comment is counted AND selectable, with a null path.
  //
  // This schema's FKs make the orphan unreachable through the app, so the fixture is built
  // with a second raw connection with `foreign_keys` OFF (the pragma is per-connection). The
  // state is still worth pinning: FK enforcement is a runtime pragma, not a property of the
  // file, and the cost of the drift is silent in exactly the way this suite exists to catch.
  describe('a review comment without a thread row', () => {
    let orphanCommentId = 0;

    beforeAll(async () => {
      const at = new Date();
      const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
      const [thread] = await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: 'RT_orphan',
          prId,
          path: 'b.ts',
          isResolved: false,
          derivedState: 'untouched',
          originalCommenterId: botId,
          createdAt: at,
        })
        .returning()
        .execute();
      const [comment] = await db
        .insert(schema.reviewComments)
        .values({
          githubNodeId: 'RC_orphan',
          threadId: thread.id,
          prId,
          authorId: botId,
          body: 'a real finding whose thread row is gone',
          createdAt: at,
        })
        .returning()
        .execute();
      orphanCommentId = comment.id;
      const raw = new Database(DB_PATH);
      raw.pragma('foreign_keys = OFF');
      raw.prepare('DELETE FROM review_threads WHERE id = ?').run(thread.id);
      raw.close();
    });

    it('is counted AND selectable — never phantom pending', async () => {
      const candidates = await mlLabels.listMlCandidates(1, scope, 100);
      const orphan = candidates.find(
        (c: any) => c.targetKind === 'review_comment' && c.targetId === orphanCommentId,
      );
      expect(orphan).toBeDefined();
      expect(orphan.path).toBeNull(); // the hint degrades; the candidacy does not
      // THE INVARIANT, same as the empty-body case above: whatever pending reports, the
      // worker can actually pick up. An inner thread join makes this 1 vs 0.
      const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
      expect(rollup.pending).toBe(candidates.length);
      expect(rollup.pending).toBe(1);
    });
  });
});

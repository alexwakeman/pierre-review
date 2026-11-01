// LIMN FINDINGS IN THE ML AND BOTS FOLDS (docs/ML-SEVERITY.md § Limn findings). Throwaway sqlite;
// the real persistPr, no GitHub, no scoring service.
//
// What this pins:
//   1. Sync writes each Limn finding's severity badge from its OWN lead (blocker→critical,
//      warning→major, nit→nit, question→minor), backend `limn-review`, no vendor claim. A reminder
//      without a severity gets no row. The writer is idempotent.
//   2. A Limn finding is never an ML candidate and never pending — the two queries in lockstep.
//   3. The scorer's upsert never overwrites a Limn row; a deep re-sync's delete keeps them.
//   4. The severity rollup shows each poster's bot as its own row ("Limn · alice-dev"), and
//      `backends` (the fallback banner's input) never lists `limn-review`.
//   5. The inflation index has nothing to compare (no vendor badge): Limn is never counted as
//      badged.
//   6. My Turn: a thread rooted on YOUR Limn finding is still yours — a person's reply in it
//      summons you; your own Limn finding on your own PR is not an "unanswered thread".
//   7. The per-reviewer drill-down lists a Limn bot's PRs by its `u<id>` key.
//   8. A body edited to drop the marker loses its Limn label.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-limn-finding-labels-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('../sync/upsert.js');
let ml: typeof import('./ml-labels.js');
let labels: typeof import('./limn-finding-labels.js');
let q: typeof import('./queries.js');
let repoId = 0;
let scope: any;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' };
const BOB = { login: 'bob-dev', id: 'U_bob', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };
const RABBIT = { login: 'coderabbitai', id: 'U_rabbit', __typename: 'Bot' };

const finding = (word: string, text: string) => `**${word}**\n\n${text}\n\n${MARK}`;

function comment(id: string, author: any, body: string, at: string): any {
  return { id, fullDatabaseId: id.replace(/\D/g, '') || null, body, createdAt: at, diffHunk: null, author };
}

function thread(id: string, comments: any[], path = 'src/x.ts'): any {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    path,
    line: 12,
    resolvedBy: null,
    comments: { nodes: comments },
  };
}

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_lfl_${n}`,
    number: n,
    title: 'Parser fix',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-10-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-10-02T00:00:00Z',
    url: `https://github.com/acme/lfl/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

// Recent timestamps, so every windowed fold (rolling 14 days) sees them.
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');

const PR1 = () =>
  gqlPr(1, {
    reviewThreads: {
      nodes: [
        thread('T_1', [
          comment('C_101', ALICE, finding('Blocker', 'Lock never released.'), iso(72)),
          comment('C_102', CAROL, 'Fixed, please look again.', iso(70)),
        ]),
        thread('T_2', [comment('C_201', ALICE, finding('Warning', 'Throws on empty input.'), iso(71))]),
        thread('T_3', [comment('C_301', BOB, finding('Nit', 'Name this better.'), iso(71))]),
        thread('T_4', [comment('C_401', BOB, finding('Question', 'Is this reachable?'), iso(71))]),
        thread('T_5', [comment('C_501', RABBIT, 'Consider a guard here.', iso(71))]),
      ],
    },
    comments: {
      nodes: [
        comment('IC_1', ALICE, `**Reminder:** first raised earlier.\n\nStill open.\n\n${MARK}`, iso(69)),
        comment('IC_2', ALICE, `**Warning** · \`src/x.ts:3\`\n\n**Reminder:** first raised earlier.\n\n${MARK}`, iso(69)),
      ],
    },
  } as any);

// Alice's own PR with her own (untouched) Limn finding on it.
const PR2 = () =>
  gqlPr(2, {
    author: ALICE,
    reviewThreads: {
      nodes: [
        thread('T_6', [comment('C_601', ALICE, finding('Warning', 'Self check.'), iso(72))], 'src/self.ts'),
        // A teammate's Limn finding on alice's PR: an unanswered thread on her PR (the control).
        thread('T_7', [comment('C_701', BOB, finding('Nit', 'Typo.'), iso(72))], 'src/team.ts'),
      ],
    },
  } as any);

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function userId(login: string): Promise<number> {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.githubLogin, login)).execute())[0].id;
}

async function rcId(nodeId: string): Promise<number> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.reviewComments).where(eq(schema.reviewComments.githubNodeId, nodeId)).execute())[0].id;
}

async function pcId(nodeId: string): Promise<number> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.prComments).where(eq(schema.prComments.githubNodeId, nodeId)).execute())[0].id;
}

async function labelOf(kind: string, id: number): Promise<any> {
  const { and, eq } = await import('drizzle-orm');
  return (
    await db
      .select()
      .from(schema.mlCommentLabels)
      .where(and(eq(schema.mlCommentLabels.targetKind, kind), eq(schema.mlCommentLabels.targetId, id)))
      .execute()
  )[0];
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('../sync/upsert.js');
  ml = await import('./ml-labels.js');
  labels = await import('./limn-finding-labels.js');
  q = await import('./queries.js');
  const { eq } = await import('drizzle-orm');
  await db
    .update(schema.accounts)
    // own_thread is OFF by default; switched on so "unanswered threads on your PRs" is built.
    .set({ githubLogin: 'alice-dev', myTurnSettings: { show: { own_thread: true } } })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'lfl', githubNodeId: 'R_lfl_1', createdAt: new Date(Date.now() - 30 * 86_400_000) })
    .returning()
    .execute();
  repoId = r.id;
  await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  await persist(PR1());
  await persist(PR2());
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the Limn label writer', () => {
  it('maps each lead to its severity, under the poster\'s bot, with no vendor claim', async () => {
    const aliceBot = await userId('limn:alice-dev');
    const bobBot = await userId('limn:bob-dev');
    const want: Array<[string, string, number, string[]]> = [
      ['C_101', 'critical', aliceBot, ['correctness_bug']],
      ['C_201', 'major', aliceBot, ['correctness_bug']],
      ['C_301', 'nit', bobBot, ['nitpick']],
      ['C_401', 'minor', bobBot, ['correctness_bug']],
    ];
    for (const [node, severity, author, cats] of want) {
      const l = await labelOf('review_comment', await rcId(node));
      expect(l, node).toBeDefined();
      expect(l.severity).toBe(severity);
      expect(l.authorUserId).toBe(author);
      expect(l.backend).toBe('limn-review');
      expect(l.modelVersion).toBe('limn-finding-v1');
      expect(l.severityProb).toBe(1);
      expect(l.vendorSeverity).toBeNull();
      expect(l.isSummary).toBe(false);
      expect(l.categories).toEqual(cats);
    }
    // A reminder with no severity has no badge; one with a severity has its badge.
    expect(await labelOf('pr_comment', await pcId('IC_1'))).toBeUndefined();
    expect((await labelOf('pr_comment', await pcId('IC_2'))).severity).toBe('major');
    // Never on a person's own words, nor on another bot's comment.
    expect(await labelOf('review_comment', await rcId('C_102'))).toBeUndefined();
    expect(await labelOf('review_comment', await rcId('C_501'))).toBeUndefined();
  });

  it('is idempotent', async () => {
    const { db: realDb } = await import('./client.js');
    expect(await labels.syncLimnFindingLabels(realDb, 1)).toEqual({ written: 0, deleted: 0 });
    // A re-sync of the same PR writes nothing new either.
    await persist(PR1());
    expect(await labels.syncLimnFindingLabels(realDb, 1)).toEqual({ written: 0, deleted: 0 });
  });
});

describe('the ML scorer never sees a Limn finding', () => {
  it('is neither a candidate nor pending, and the two counts agree', async () => {
    const candidates = await ml.listMlCandidates(1, scope, 500);
    const limnIds = new Set([await userId('limn:alice-dev'), await userId('limn:bob-dev')]);
    expect(candidates.some((c) => limnIds.has(c.authorUserId))).toBe(false);
    // The reminder without a severity has no label and is still not pending.
    expect(candidates.map((c) => c.targetId)).not.toContain(await pcId('IC_1'));
    // CodeRabbit's comment IS a candidate — the exclusion is Limn's alone.
    expect(candidates.map((c) => c.targetId)).toContain(await rcId('C_501'));
    const rollup = await ml.getBotSeverityRollup(1, scope, true);
    expect(rollup.pending).toBe(candidates.length);
  });

  it('the scorer upsert does not overwrite a Limn row', async () => {
    const id = await rcId('C_201');
    const before = await labelOf('review_comment', id);
    const written = await ml.upsertMlLabels([
      {
        accountId: 1,
        repoId,
        prId: before.prId,
        targetKind: 'review_comment',
        targetId: id,
        authorUserId: before.authorUserId,
        severity: 'nit',
        severityOrd: 0,
        severityProb: 0.6,
        vendorSeverity: null,
        vendorSeverityConfidence: null,
        categories: ['nitpick'],
        categoryProbs: { nitpick: 0.6 },
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'sev-test',
        bodyHash: 'x',
        targetCreatedAt: before.targetCreatedAt,
      },
    ]);
    expect(written).toBe(0);
    const after = await labelOf('review_comment', id);
    expect(after.severity).toBe('major');
    expect(after.backend).toBe('limn-review');
  });

  it('a deep re-sync\'s label delete keeps the Limn rows', async () => {
    const { eq } = await import('drizzle-orm');
    // A scorer row to be purged beside them.
    await ml.upsertMlLabels([
      {
        accountId: 1,
        repoId,
        prId: (await labelOf('review_comment', await rcId('C_201'))).prId,
        targetKind: 'review_comment',
        targetId: await rcId('C_501'),
        authorUserId: await userId('coderabbitai'),
        severity: 'minor',
        severityOrd: 1,
        severityProb: 0.7,
        vendorSeverity: 'major',
        vendorSeverityConfidence: 'high',
        categories: ['correctness_bug'],
        categoryProbs: { correctness_bug: 0.7 },
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'sev-test',
        bodyHash: 'y',
        targetCreatedAt: new Date(),
      },
    ]);
    await ml.deleteMlLabelsForRepo(1, repoId);
    const rows = await db.select().from(schema.mlCommentLabels).where(eq(schema.mlCommentLabels.repoId, repoId)).execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.backend === 'limn-review')).toBe(true);
  });
});

describe('Limn bots in the Bots folds', () => {
  it('the severity rollup has one row per poster and never lists limn-review as a scorer', async () => {
    const rollup = await ml.getBotSeverityRollup(1, scope, true);
    const aliceBot = await userId('limn:alice-dev');
    const bobBot = await userId('limn:bob-dev');
    const alice = rollup.rows.find((r) => r.reviewerKey === `u${aliceBot}`);
    const bob = rollup.rows.find((r) => r.reviewerKey === `u${bobBot}`);
    expect(alice?.label).toBe('Limn · alice-dev');
    expect(alice?.kind).toBe('pierre');
    expect(alice?.bySeverity).toEqual({ nit: 0, minor: 0, major: 3, critical: 1 });
    expect(bob?.label).toBe('Limn · bob-dev');
    expect(bob?.bySeverity).toEqual({ nit: 2, minor: 1, major: 0, critical: 0 });
    expect(rollup.backends).not.toContain('limn-review');
    // The person is never a bot row.
    const alice0 = await userId('alice-dev');
    expect(rollup.rows.some((r) => r.userId === alice0)).toBe(false);
  });

  it('the inflation fold has no vendor badge to compare: Limn is never "badged"', async () => {
    const aliceBot = await userId('limn:alice-dev');
    const from = new Date(Date.now() - 14 * 86_400_000);
    const automated = await q.automatedReviewerUserIds(1, scope.workspaceId, 'all');
    expect(automated).toContain(aliceBot);
    const agg = await ml.getMlWindowAggregates(1, scope, automated, from, null);
    const row = agg.byBot.get(aliceBot);
    expect(row?.findings).toBe(4);
    expect(row?.vendorBadged).toBe(0);
    expect(agg.totals.backends).not.toContain('limn-review');
    // The "N of M scored" coverage leaves Limn labels out: every label here is Limn's.
    expect(agg.totals.limnLabelled).toBe(agg.totals.labelled);
    expect(agg.totals.limnLabelled).toBeGreaterThan(0);
  });

  it('the per-reviewer drill-down lists a Limn bot\'s PRs by its u<id> key', async () => {
    const aliceBot = await userId('limn:alice-dev');
    const resp = await q.getBotVendorPrs(1, { userId: aliceBot }, 'rolling_14', scope);
    expect(resp.key).toBe(`u${aliceBot}`);
    expect(resp.label).toBe('Limn · alice-dev');
    expect(resp.prs.map((p) => p.prNumber).sort()).toEqual([1, 2]);
  });

  it('the flagging drill-down lists Limn findings but keeps them out of the agreement matrix', async () => {
    const resp = await ml.getBotFlaggingComments(
      1,
      { kind: 'findings' },
      { cell: null, disagree: null, authorUserIds: null },
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    // Every finding here is Limn's: the list counts them, the matrix places none of them.
    expect(resp.total).toBeGreaterThan(0);
    expect(resp.matrix.total).toBe(0);
    expect(resp.matrix.undeclared).toBe(0);
    // And no matrix cell can select one.
    const cell = await ml.getBotFlaggingComments(
      1,
      { kind: 'findings' },
      { cell: { vendor: 'none', ours: 'major' }, disagree: null, authorUserIds: null },
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    expect(cell.filteredTotal).toBe(0);
  });

  it('the ROI table has a u<id> row per Limn poster, labelled "Limn · <login>"', async () => {
    const roi = await q.getBotAnalytics(1, 'rolling_14', scope);
    const aliceBot = await userId('limn:alice-dev');
    const row = roi.vendors.find((v) => v.key === `u${aliceBot}`);
    expect(row).toBeDefined();
    expect(row!.label).toBe('Limn · alice-dev');
    expect(row!.kind).toBe('pierre');
    // The poster herself is never a ROI row.
    const alice = await userId('alice-dev');
    expect(roi.vendors.some((v) => v.key === `u${alice}`)).toBe(false);
  });

  it('the person behind a Limn bot is still not a bot', async () => {
    const automated = await q.automatedReviewerUserIds(1, scope.workspaceId, 'all');
    expect(automated).not.toContain(await userId('alice-dev'));
    expect(automated).not.toContain(await userId('bob-dev'));
  });
});

describe('My Turn on threads rooted on your Limn finding', () => {
  it('a person\'s reply in a thread rooted on your Limn finding summons you', async () => {
    const mt = await q.getMyTurn(1, scope);
    const item = mt.threadsAwaiting.find((t: any) => t.path === 'src/x.ts' && t.awaitingKind === 'reply');
    expect(item).toBeDefined();
    expect(item!.lastReplyAuthorId).toBe(await userId('carol-dev'));
  });

  it('your own Limn finding on your own PR is not an unanswered thread', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.ownThreads.find((t: any) => t.path === 'src/team.ts')).toBeDefined();
    expect(mt.ownThreads.find((t: any) => t.path === 'src/self.ts')).toBeUndefined();
  });
});

describe('a body edited to drop the marker', () => {
  it('loses its Limn label on the next walk', async () => {
    const id = await rcId('C_201');
    expect((await labelOf('review_comment', id))?.backend).toBe('limn-review');
    const pr = PR1() as any;
    pr.reviewThreads.nodes[1].comments.nodes[0].body = 'Throws on empty input.';
    await persist(pr);
    expect(await labelOf('review_comment', id)).toBeUndefined();
  });
});

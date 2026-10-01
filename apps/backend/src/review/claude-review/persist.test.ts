// CLAUDE REVIEW PERSISTENCE — the ticket, the follow-up and the re-raise link, over the REAL core
// client and migrations (the benchmark-roi-agreement.test.ts precedent).
//
// ⚠ WHY NOT STUB TABLES: drizzle silently DROPS an unknown key in `.values()` / `.set()`. With stub
// tables, a plugin↔core column-name mismatch (`cr.followUp` vs a differently named core property)
// would pass every test here and never write the column. Over the real schema it cannot.
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's config/client, which open the
// connection at module load.
//
//   pnpm --filter @pierre-review/backend test claude-review-persist
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ClaudeReviewFollowUpRecord,
  ClaudeReviewModel,
  ClaudeReviewTicket,
  ClaudeTicketAssessment,
} from '@pierre-review/shared';
import type { ReviewFinding } from '../../pro/contract.js';
import type { AgentContext as ProContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-persist.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: ProContext;
let persist: typeof import('./persist.js');
let prId = 0;
let otherPrId = 0;
let foreignPrId = 0;
let chainPrId = 0;

const finding = (
  over: Partial<ReviewFinding> & { priorFindingId?: number | null } = {},
): ReviewFinding & { priorFindingId?: number | null } => ({
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 't',
  body: 'b',
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  ...over,
});

const success = (
  findings: Array<ReviewFinding & { priorFindingId?: number | null; included?: boolean }>,
  extra: object = {},
) => ({
  scope: 'diff_only' as const,
  summary: 's',
  verdict: 'COMMENT' as const,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: 1,
  excludedFiles: [],
  findings,
  ...extra,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
  } as any as ProContext;
  persist = await import('./persist.js');

  const { accounts, repos, pullRequests } = schema;
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'U_persist_other', githubLogin: 'other', isLocal: false })
    .execute();
  const repo = async (accountId: number, key: string) =>
    (
      await db
        .insert(repos)
        .values({ accountId, owner: 'acme', name: key, githubNodeId: `R_${key}` })
        .returning()
        .execute()
    )[0].id as number;
  const pr = async (accountId: number, repoId: number, key: string) =>
    (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_${key}`,
          accountId,
          repoId,
          number: 1,
          title: key,
          state: 'open',
          isDraft: false,
          openedAt: new Date(),
          updatedAt: new Date(),
          headSha: 'h'.repeat(40),
        })
        .returning()
        .execute()
    )[0].id as number;
  const r1 = await repo(1, 'persist-a');
  prId = await pr(1, r1, 'persist-a');
  const r2 = await repo(1, 'persist-b');
  otherPrId = await pr(1, r2, 'persist-b');
  const r3 = await repo(2, 'persist-foreign');
  foreignPrId = await pr(2, r3, 'persist-foreign');
  const r4 = await repo(1, 'persist-chain');
  chainPrId = await pr(1, r4, 'persist-chain');
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const ticket: ClaudeReviewTicket = {
  title: 'Reset password',
  description: null,
  acceptanceCriteria: '- a\n- b',
  criteria: ['a', 'b'],
};

describe('ticket + follow-up persistence', () => {
  it('insertQueuedReview stores the ticket at queue time', async () => {
    const id = await persist.insertQueuedReview(ctx, otherPrId, 'q'.repeat(40), 'claude-opus-5-5', 1, ticket);
    const latest = await persist.getLatestClaudeReview(ctx, otherPrId, 1);
    expect(latest?.id).toBe(id);
    expect(latest?.ticket).toEqual(ticket);
    expect(latest?.model).toBe('claude-opus-5-5');
    expect(latest?.followUp).toBeNull();
    expect(latest?.ticketAssessment).toBeNull();
  });

  it('saveReviewSuccess writes followUp, ticketAssessment and priorFindingId; reraisedFindingId is derived', async () => {
    const first = await persist.insertQueuedReview(ctx, prId, 'a'.repeat(40), 'claude-sonnet-5', 1);
    await persist.markReviewRouted(ctx, first, 'diff_only', {} as any);
    await persist.saveReviewSuccess(
      ctx,
      first,
      success([
        finding({ title: 'kept' }),
        finding({ title: 'praise', severity: 'praise' }),
        finding({ title: 'to ignore' }),
        finding({ title: 'ignored but posted' }),
      ]),
    );
    const firstReview = (await persist.getClaudeReviewById(ctx, first, 1))!;
    const [kept, , toIgnore, posted] = firstReview.findings;
    await persist.updateFinding(ctx, toIgnore!.id, { included: false, editedBody: 'unused' });
    await persist.updateFinding(ctx, posted!.id, { included: false, editedBody: 'My wording.' });
    await persist.markFindingPosted(ctx, posted!.id, 'c1', 'inline');

    const second = await persist.insertQueuedReview(ctx, prId, 'b'.repeat(40), 'claude-opus-5-5', 1, ticket);
    const assessment: ClaudeTicketAssessment = {
      alignment: 'aligned',
      summary: 'ok',
      criteria: [
        { ref: 'AC1', index: 0, text: 'a', status: 'met', explanation: null, path: null, line: null },
        { ref: 'AC2', index: 1, text: 'b', status: 'not_checked', explanation: null, path: null, line: null },
      ],
      missing: [],
      notRequested: [],
    };
    const followUp: ClaudeReviewFollowUpRecord = {
      priorReviewId: first,
      priorHeadSha: 'a'.repeat(40),
      headMoved: true,
      changesSinceShown: false,
      items: [
        { ref: 'P1', priorFindingId: kept!.id, sent: true, carried: false, status: 'not_addressed', explanation: 'x', path: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'warning', title: 'kept' },
        { ref: 'P2', priorFindingId: posted!.id, sent: true, carried: false, status: 'not_checked', explanation: null, path: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'warning', title: 'ignored but posted' },
      ],
    };
    await persist.saveReviewSuccess(
      ctx,
      second,
      success(
        [finding({ title: 'ordinary' }), finding({ title: 're-raise', priorFindingId: kept!.id })],
        { followUp, ticketAssessment: assessment },
      ),
    );
    const r = (await persist.getClaudeReviewById(ctx, second, 1))!;
    expect(r.ticket).toEqual(ticket);
    expect(r.ticketAssessment).toEqual(assessment);
    expect(r.findings.map((f) => [f.title, f.priorFindingId])).toEqual([
      ['ordinary', null],
      ['re-raise', kept!.id],
    ]);
    const reraise = r.findings[1]!;
    expect(r.followUp?.items.map((i) => [i.ref, i.reraisedFindingId])).toEqual([
      ['P1', reraise.id],
      ['P2', null],
    ]);
    expect(r.followUp?.priorReviewId).toBe(first);

    // ---- loadPriorReviewForFollowUp, as the NEXT run would call it ----
    const third = await persist.insertQueuedReview(ctx, prId, 'c'.repeat(40), 'claude-opus-5-5', 1);
    // A later SKIP run between them never read code and must be passed over.
    const skip = await persist.insertQueuedReview(ctx, prId, 'c'.repeat(40), 'claude-opus-5-5', 1);
    await persist.markReviewRouted(ctx, skip, 'skip', {} as any);
    await persist.saveReviewSuccess(ctx, skip, success([finding({ title: 'never' })]));
    // A later FAILED run is passed over too.
    const failed = await persist.insertQueuedReview(ctx, prId, 'c'.repeat(40), 'claude-opus-5-5', 1);
    await persist.markReviewFailed(ctx, failed, 'boom');
    const current = await persist.insertQueuedReview(ctx, prId, 'c'.repeat(40), 'claude-opus-5-5', 1);

    const prior = await persist.loadPriorReviewForFollowUp(ctx, prId, 1, current);
    expect(prior?.reviewId).toBe(second);
    expect(prior?.headSha).toBe('b'.repeat(40));
    // Its own findings (both eligible), then the CARRIED not_checked one from the first review
    // (ignored but posted, so still eligible — with the user's wording).
    expect(prior?.findings.map((f) => [f.title, f.carried])).toEqual([
      ['ordinary', false],
      ['re-raise', false],
      ['ignored but posted', true],
    ]);
    expect(prior?.findings[2]!.body).toBe('My wording.');
    // Each finding carries the head of the review that RAISED it — the carried one keeps the
    // first review's, older head — and whether it was posted.
    expect(prior?.findings.map((f) => [f.title, f.headSha, f.posted])).toEqual([
      ['ordinary', 'b'.repeat(40), false],
      ['re-raise', 'b'.repeat(40), false],
      ['ignored but posted', 'a'.repeat(40), true],
    ]);

    // The run's own id is excluded: asking "before `second`" lands on `first`, whose eligible set
    // drops praise and the ignored-unposted one.
    const beforeSecond = await persist.loadPriorReviewForFollowUp(ctx, prId, 1, second);
    expect(beforeSecond?.reviewId).toBe(first);
    expect(beforeSecond?.findings.map((f) => f.title)).toEqual(['kept', 'ignored but posted']);
    expect(beforeSecond?.findings[1]!.body).toBe('My wording.');
    expect(third).toBeLessThan(current);
  });

  it('a pre-routing run (review_mode NULL) under a retired model id counts as a previous review', async () => {
    // A stored row may name a model that is no longer offered (the old Opus 4.8). The cast says so:
    // the id is outside ClaudeReviewModel on purpose, because the column is plain text.
    const retired = 'claude-opus-4-8' as ClaudeReviewModel;
    const legacy = await persist.insertQueuedReview(ctx, otherPrId, 'l'.repeat(40), retired, 1);
    await persist.saveReviewSuccess(ctx, legacy, success([finding({ title: 'legacy' })]));
    const next = await persist.insertQueuedReview(ctx, otherPrId, 'm'.repeat(40), 'claude-opus-5-5', 1);
    const prior = await persist.loadPriorReviewForFollowUp(ctx, otherPrId, 1, next);
    expect(prior?.reviewId).toBe(legacy);
    expect(prior?.findings.map((f) => f.title)).toEqual(['legacy']);
  });

  it("another account's PR ⇒ null", async () => {
    const foreign = await persist.insertQueuedReview(ctx, foreignPrId, 'f'.repeat(40), 'claude-sonnet-5', 2);
    await persist.saveReviewSuccess(ctx, foreign, success([finding({ title: 'foreign' })]));
    expect(await persist.loadPriorReviewForFollowUp(ctx, foreignPrId, 1, foreign + 100)).toBeNull();
    expect((await persist.loadPriorReviewForFollowUp(ctx, foreignPrId, 2, foreign + 100))?.reviewId).toBe(foreign);
  });

  it('a carried id from another PR is NOT loaded (re-scoped by the query)', async () => {
    const other = await persist.insertQueuedReview(ctx, otherPrId, 'o'.repeat(40), 'claude-sonnet-5', 1);
    await persist.saveReviewSuccess(ctx, other, success([finding({ title: 'other-pr finding' })]));
    const otherFinding = (await persist.getClaudeReviewById(ctx, other, 1))!.findings[0]!;
    const run = await persist.insertQueuedReview(ctx, prId, 'p'.repeat(40), 'claude-sonnet-5', 1);
    await persist.saveReviewSuccess(
      ctx,
      run,
      success([], {
        followUp: {
          priorReviewId: 1,
          priorHeadSha: 'x',
          headMoved: true,
          changesSinceShown: false,
          items: [
            { ref: null, priorFindingId: otherFinding.id, sent: false, carried: false, status: 'not_checked', explanation: null, path: 'x', line: null, side: 'RIGHT', severity: 'nit', title: 'x' },
          ],
        } satisfies ClaudeReviewFollowUpRecord,
      }),
    );
    const next = await persist.insertQueuedReview(ctx, prId, 'q'.repeat(40), 'claude-sonnet-5', 1);
    const prior = await persist.loadPriorReviewForFollowUp(ctx, prId, 1, next);
    expect(prior?.reviewId).toBe(run);
    expect(prior?.findings).toEqual([]);
  });

  it('a re-raise left out because its comment is already on this commit keeps the original in the chain', async () => {
    const HEAD_A = 'a'.repeat(40);
    // R1 at A: F is posted; G is never posted.
    const r1 = await persist.insertQueuedReview(ctx, chainPrId, HEAD_A, 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, r1, success([finding({ title: 'F' }), finding({ title: 'G' })]));
    const [F, G] = (await persist.getClaudeReviewById(ctx, r1, 1))!.findings;
    await persist.markFindingPosted(ctx, F!.id, 'c-f', 'inline');

    // R2, a same-head re-run: both still open. F's re-raise arrives left out (already on this
    // commit); G's is included, and the reader then ignores it.
    const r2 = await persist.insertQueuedReview(ctx, chainPrId, HEAD_A, 'claude-opus-5-5', 1);
    const item = (id: number, title: string, priorPosted: boolean) => ({
      ref: 'P1', priorFindingId: id, sent: true, carried: false, status: 'not_addressed' as const,
      explanation: 'x', path: 'src/a.ts', line: 3, side: 'RIGHT' as const, severity: 'warning' as const,
      title, headMoved: false, priorPosted,
    });
    await persist.saveReviewSuccess(
      ctx,
      r2,
      success(
        [
          { ...finding({ title: "F'" }), priorFindingId: F!.id, included: false },
          { ...finding({ title: "G'" }), priorFindingId: G!.id },
        ],
        {
          followUp: {
            priorReviewId: r1,
            priorHeadSha: HEAD_A,
            headMoved: false,
            changesSinceShown: false,
            items: [item(F!.id, 'F', true), { ...item(G!.id, 'G', false), ref: 'P2' }],
          } satisfies ClaudeReviewFollowUpRecord,
        },
      ),
    );
    const second = (await persist.getClaudeReviewById(ctx, r2, 1))!;
    const [Fre, Gre] = second.findings;
    // Round trip: the left-out re-raise is stored ignored; the ordinary one is included.
    expect([Fre!.title, Fre!.included]).toEqual(["F'", false]);
    expect([Gre!.title, Gre!.included]).toEqual(["G'", true]);
    expect(second.followUp?.items.map((i) => [i.title, i.headMoved, i.priorPosted])).toEqual([
      ['F', false, true],
      ['G', false, false],
    ]);
    await persist.updateFinding(ctx, Gre!.id, { included: false });

    // R3 after a push: F' is not eligible, but F is ON the pull request, so F is carried (with
    // its own head). G was never posted and the reader ignored its reminder: it drops out.
    const r3 = await persist.insertQueuedReview(ctx, chainPrId, 'b'.repeat(40), 'claude-opus-5-5', 1);
    const prior = await persist.loadPriorReviewForFollowUp(ctx, chainPrId, 1, r3);
    expect(prior?.reviewId).toBe(r2);
    expect(prior?.findings.map((f) => [f.id, f.carried, f.headSha, f.posted])).toEqual([
      [F!.id, true, HEAD_A, true],
    ]);

    // Once the reader includes F' after all, R3 follows up THROUGH it — never F twice.
    await persist.updateFinding(ctx, Fre!.id, { included: true });
    const again = await persist.loadPriorReviewForFollowUp(ctx, chainPrId, 1, r3);
    expect(again?.findings.map((f) => [f.id, f.carried])).toEqual([[Fre!.id, false]]);
  });
});

// EVERY LIMN FINDING COUNTS IN AN AI FIX (manager.ts `withCoverFollowUp`). A Claude + Codex pair whose
// Codex half failed is followed by Claude's COVER PASS over Codex's earlier open findings (a
// `kind = 'replies'` row with `followUp.cover`). What it found still open must reach the fix seed as
// "Earlier findings not fixed yet" (P items), like the pair's own follow-up. Pinned, over the REAL
// client and migrations:
//   1. a pair with a failed half + a succeeded cover at its head ⇒ the cover's still-open items join;
//   2. an item the pair itself judged keeps the pair's word (never doubled);
//   3. a cover at another head, a failed cover, or one after the PR's next full review ⇒ not read;
//   4. a pair whose two halves succeeded is returned as it is.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_FIX_DEFAULT_INCLUDE, type ClaudeFollowUpItemRecord, type ClaudeReviewFollowUpRecord } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-fix-cover-seed.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let persist: typeof import('../../review/claude-review/persist.js');
let fixManager: typeof import('./manager.js');
let seed: typeof import('./review-seed.js');
let repoId = 0;
let prSeq = 0;

async function makePr(): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRCS_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state: 'open', isDraft: false,
      headSha: 'HEAD', openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

const success = (title: string | null, followUp: ClaudeReviewFollowUpRecord | null = null) => ({
  scope: 'diff_only' as const,
  summary: 's',
  verdict: 'COMMENT' as const,
  costUsd: 0,
  inputTokens: 1,
  outputTokens: 1,
  numTurns: 1,
  excludedFiles: [],
  findings: title
    ? [{ path: 'src/a.ts', line: 3, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title} — body`, suggestion: null, diffHunk: null, anchored: true, fileInDiff: true }]
    : [],
  followUp,
});

const item = (priorFindingId: number, title: string, status: ClaudeFollowUpItemRecord['status']): ClaudeFollowUpItemRecord => ({
  ref: 'P1',
  priorFindingId,
  sent: true,
  carried: true,
  status,
  explanation: `${title} is still there.`,
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title,
});

/** An earlier Codex review with one finding, then a pair at HEAD whose Codex half failed. */
async function pairWithFailedCodex(o: { codexFails?: boolean; pairJudges?: ClaudeFollowUpItemRecord['status'] } = {}) {
  const prId = await makePr();
  const earlier = await persist.insertQueuedReview(ctx, prId, 'OLD', 'claude-opus-5-5' as any, 1, [], 'manual', 'codex');
  await persist.markReviewRanOn(ctx, earlier, { provider: 'codex', model: 'gpt-6.1-sol' });
  await persist.saveReviewSuccess(ctx, earlier, success('Codex: lock leak'));
  const old = (await persist.getClaudeReviewById(ctx, earlier, 1))!.findings[0]!;
  const first = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto', 'claude', false, { role: 'first' });
  const pairFollowUp: ClaudeReviewFollowUpRecord | null = o.pairJudges
    ? { priorReviewId: earlier, priorHeadSha: 'OLD', headMoved: true, changesSinceShown: false, items: [item(old.id, 'Codex: lock leak', o.pairJudges)] }
    : null;
  await persist.saveReviewSuccess(ctx, first, success('Claude: null deref', pairFollowUp));
  const second = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto', 'codex', false, { role: 'second', pairId: first });
  if (o.codexFails === false) {
    await persist.markReviewRanOn(ctx, second, { provider: 'codex', model: 'gpt-6.1-sol' });
    await persist.saveReviewSuccess(ctx, second, success(null));
  } else {
    await persist.markReviewFailed(ctx, second, 'Codex usage limit reached');
  }
  return { prId, oldId: old.id, earlier, first, second };
}

async function cover(prId: number, oldId: number, earlier: number, o: { head?: string; fail?: boolean; status?: ClaudeFollowUpItemRecord['status'] } = {}) {
  const id = await persist.insertQueuedReview(ctx, prId, o.head ?? 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto', 'claude', false, null, 'replies');
  if (o.fail) {
    await persist.markReviewFailed(ctx, id, 'stopped');
    return id;
  }
  await persist.saveReviewSuccess(
    ctx,
    id,
    success(null, {
      priorReviewId: earlier,
      priorHeadSha: 'OLD',
      headMoved: true,
      changesSinceShown: false,
      items: [item(oldId, 'Codex: lock leak', o.status ?? 'not_addressed')],
      cover: { provider: 'codex' },
    }),
  );
  return id;
}

const pItems = (review: any) =>
  seed
    .buildReviewSeed(review, { nonce: () => 'n'.repeat(16), selection: { kind: 'sections', include: AUTO_FIX_DEFAULT_INCLUDE } })
    .items.filter((i) => i.kind === 'earlier_finding')
    .map((i) => i.title);

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'cs', githubNodeId: 'R_cs' }).returning().execute();
  repoId = r.id;
  persist = await import('../../review/claude-review/persist.js');
  fixManager = await import('./manager.js');
  seed = await import('./review-seed.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    accountIdOf: () => 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('a pair with a failed half: the cover pass counts in the fix', () => {
  it('the cover’s still-open item joins the earlier findings', async () => {
    const p = await pairWithFailedCodex();
    await cover(p.prId, p.oldId, p.earlier);
    const view = (await persist.getReviewView(ctx, p.second, 1))!;
    expect(pItems(view)).toEqual([]);
    const folded = await fixManager.withCoverFollowUp(ctx, 1, p.prId, view);
    expect(pItems(folded)).toEqual(['Codex: lock leak']);
  });

  it('an item the pair judged keeps the pair’s word', async () => {
    const p = await pairWithFailedCodex({ pairJudges: 'addressed' });
    await cover(p.prId, p.oldId, p.earlier, { status: 'not_addressed' });
    const view = (await persist.getReviewView(ctx, p.second, 1))!;
    const folded = await fixManager.withCoverFollowUp(ctx, 1, p.prId, view);
    expect(folded.followUp?.items.filter((i) => i.priorFindingId === p.oldId).map((i) => i.status)).toEqual(['addressed']);
    expect(pItems(folded)).toEqual([]);
  });

  it('never a cover at another head, a failed cover, or one after the next full review', async () => {
    const a = await pairWithFailedCodex();
    await cover(a.prId, a.oldId, a.earlier, { head: 'OTHER' });
    await cover(a.prId, a.oldId, a.earlier, { fail: true });
    const va = (await persist.getReviewView(ctx, a.second, 1))!;
    expect(pItems(await fixManager.withCoverFollowUp(ctx, 1, a.prId, va))).toEqual([]);

    const b = await pairWithFailedCodex();
    const next = await persist.insertQueuedReview(ctx, b.prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'manual', 'claude');
    await persist.saveReviewSuccess(ctx, next, success(null));
    await cover(b.prId, b.oldId, b.earlier);
    const vb = (await persist.getReviewView(ctx, b.second, 1))!;
    expect(pItems(await fixManager.withCoverFollowUp(ctx, 1, b.prId, vb))).toEqual([]);
  });

  it('a pair whose two halves succeeded is returned as it is', async () => {
    const p = await pairWithFailedCodex({ codexFails: false });
    await cover(p.prId, p.oldId, p.earlier);
    const view = (await persist.getReviewView(ctx, p.second, 1))!;
    expect(await fixManager.withCoverFollowUp(ctx, 1, p.prId, view)).toBe(view);
  });
});

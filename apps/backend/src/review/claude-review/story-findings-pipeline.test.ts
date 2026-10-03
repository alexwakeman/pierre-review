// USER-STORY RESULTS BECOME FINDINGS — end to end through the review manager's pipeline, over the
// REAL core client and migrations (persist.test.ts's precedent), with a fake prepare + a fake model.
//
//   1. a run with a story makes one finding per unmet / partly met criterion and per "Not done"
//      item, tagged with its story origin, anchored like any finding (inline / PR-level);
//   2. a SAME-HEAD re-run carries the assessment and re-creates those findings — and a story
//      finding that was POSTED is linked, saved left out, never a second row for one criterion;
//   3. "Not asked for" never becomes a finding.
//
//   pnpm --filter @pierre-review/backend test story-findings-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ClaudeReview, ClaudeReviewTicket } from '@pierre-review/shared';
import type { RunReviewResult } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-story-findings.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const DIFF = [
  'diff --git a/src/mail.ts b/src/mail.ts',
  '--- a/src/mail.ts',
  '+++ b/src/mail.ts',
  '@@ -0,0 +1,4 @@',
  '+a',
  '+b',
  '+c',
  '+d',
].join('\n');

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let runs = 0;

// What the fake model answers: a story report ONLY the first time it is asked (the same-head
// re-run must not ask — the assessment is carried).
const reply = (): RunReviewResult =>
  ({
    submitted: true,
    scope: 'diff_only',
    summary: 'ok',
    verdict: 'COMMENT',
    findings: [],
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    tickets: [
      {
        ref: 'T1',
        alignment: 'partly_aligned',
        summary: 'Half of it.',
        criteria: [
          { text: 'A link is sent', status: 'met', explanation: 'Yes.', path: 'src/mail.ts', line: 1 },
          { text: 'The link expires', status: 'not_met', explanation: 'No expiry.', path: 'src/mail.ts', line: 3 },
          { text: 'The page says so', status: 'partly_met', explanation: 'Only on desktop.' },
        ],
        missing: [{ title: 'Rate limiting', explanation: 'Nothing limits resets.' }],
        notRequested: [{ title: 'A banner', explanation: 'Not asked.', path: 'src/mail.ts', line: 2 }],
      },
    ],
  }) as unknown as RunReviewResult;

const story: ClaudeReviewTicket = {
  title: 'Reset password',
  description: 'From sign-in.',
  acceptanceCriteria: '* link sent\n* link expires\n* page says so',
  source: 'jira',
  key: 'BMD-1040',
  url: null,
  fetchedAt: null,
};

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
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF,
        promptDiff: DIFF,
        changedFiles: ['src/mail.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [{ path: 'src/mail.ts', additions: 4, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      runReview: async () => {
        runs += 1;
        return reply();
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');

  const { repos, pullRequests } = schema;
  const repoId = (
    await db.insert(repos).values({ accountId: 1, owner: 'acme', name: 'story', githubNodeId: 'R_story' }).returning().execute()
  )[0].id as number;
  prId = (
    await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_story', accountId: 1, repoId, number: 7, title: 'Reset', state: 'open',
        isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha: HEAD,
      })
      .returning()
      .execute()
  )[0].id as number;
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function runToEnd(): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', [story]);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  for (let i = 0; i < 200; i++) {
    const r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
    if (r && r.status !== 'queued' && r.status !== 'running') {
      // Let the pipeline's `finally` release the PR's claim before the next run.
      await new Promise((res) => setTimeout(res, 20));
      return r;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('review did not finish');
}

describe('story results become findings', () => {
  let first: ClaudeReview;

  it('a run makes one finding per unmet / partly met criterion and per not-done item', async () => {
    first = await runToEnd();
    expect(first.status).toBe('succeeded');
    expect(first.findings.map((f) => [f.story, f.severity, f.title, f.path, f.line, f.anchored, f.fileInDiff, f.included])).toEqual([
      [{ index: 0, ref: 'AC2' }, 'warning', 'The link expires', 'src/mail.ts', 3, true, true, true],
      [{ index: 0, ref: 'AC3' }, 'nit', 'The page says so', '', null, false, false, true],
      [{ index: 0, ref: 'M1' }, 'warning', 'Rate limiting', '', null, false, false, true],
    ]);
    // Claude's explanation alone: the story line is added when the comment is built (storyCommentLead).
    expect(first.findings[0]!.body).toBe('No expiry.');
    // The stories section still carries the whole read-only assessment, notRequested included.
    expect(first.tickets?.[0]?.assessment?.notRequested.map((g) => g.title)).toEqual(['A banner']);
    expect(runs).toBe(1);
  });

  it('a SAME-HEAD re-run carries the assessment and re-creates the findings — a posted one linked, left out, never twice', async () => {
    // The reader posted the not-met criterion's finding on this commit.
    const postedId = first.findings[0]!.id;
    await db
      .update(schema.claudeReviewFindings)
      .set({ postedAt: new Date(), githubCommentId: '555', postedCommentKind: 'inline' })
      .where(eq(schema.claudeReviewFindings.id, postedId))
      .execute();

    const second = await runToEnd();
    expect(second.status).toBe('succeeded');
    // The model was asked again (for the review), but not about the story: carried.
    expect(second.tickets?.[0]?.assessment).toEqual(first.tickets?.[0]?.assessment);
    // ONE row per story item — the posted criterion re-raised by its own story finding, saved left
    // out (it is already on this commit); no synthesized follow-up twin.
    const byRef = second.findings.map((f) => [f.story?.ref, f.priorFindingId ?? null, f.included]);
    expect(byRef).toEqual([
      ['AC2', postedId, false],
      ['AC3', null, true],
      ['M1', null, true],
    ]);
    expect(second.followUp?.items.map((it) => [it.priorFindingId, it.status, it.reraisedFindingId])).toEqual([
      [postedId, 'not_addressed', second.findings[0]!.id],
    ]);
  });
});

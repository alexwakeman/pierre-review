// THE PR REVIEW WITHOUT STORIES — end to end through the review manager's pipeline, over the REAL
// core client and migrations (persist.test.ts's precedent), with a fake prepare + a fake model.
//
//   1. a run makes NO story finding and stores NO ticket / assessment, even when the model sends a
//      stray `tickets` report (stories are the ticket review's, review/ticket-review/);
//   2. a POSTED legacy story finding is never followed up by the next run (no re-raise, no item);
//   3. a DEEP run is handed the PR's ticket peers (open first, then merged; closed, head-less and
//      other accounts' PRs never), capped, and a diff-only run none.
//
//   pnpm --filter @pierre-review/backend test no-stories-pipeline
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW, type ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';
import { _resetTicketSourceForTest, _overrideTicketSourceForTest } from '../../tracker/ticket-source.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-no-stories.sqlite';
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
let peerIds: Record<'openWeb' | 'mergedApi' | 'closed' | 'noHead' | 'foreign', number>;
let runs = 0;
let deep = false;
let lastArgs: RunReviewArgs | null = null;

// The fake model: one ordinary finding, plus a stray story report an older prompt would have asked for.
const reply = (): RunReviewResult =>
  ({
    submitted: true,
    scope: 'diff_only',
    summary: 'ok',
    verdict: 'COMMENT',
    findings: [
      {
        path: 'src/mail.ts', line: 2, side: 'RIGHT', severity: 'warning', title: 'Unchecked input', body: 'b',
        suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
      },
    ],
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    tickets: [
      {
        ref: 'T1',
        alignment: 'partly_aligned',
        summary: 'Half of it.',
        criteria: [{ text: 'The link expires', status: 'not_met', explanation: 'No expiry.' }],
        missing: [{ title: 'Rate limiting', explanation: 'Nothing limits resets.' }],
      },
    ],
  }) as unknown as RunReviewResult;

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
        // `deep` routes the run to a worktree review (an API touch is a contract change).
        fileMetrics: [{ path: 'src/mail.ts', additions: 4, deletions: 0, isNew: !deep, apiTouch: deep }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs) => {
        runs += 1;
        lastArgs = args;
        return reply();
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');

  const { repos, pullRequests } = schema;
  const repo = async (accountId: number, name: string): Promise<number> =>
    (await db.insert(repos).values({ accountId, owner: 'acme', name, githubNodeId: `R_${accountId}_${name}` }).returning().execute())[0]
      .id as number;
  const pr = async (accountId: number, repoId: number, number: number, state: string, headSha: string | null): Promise<number> =>
    (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_${accountId}_${repoId}_${number}`, accountId, repoId, number, title: `PR ${number}`, state,
          isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha,
          files: [{ path: `src/f${number}.ts`, additions: 1, deletions: 0 }],
        })
        .returning()
        .execute()
    )[0].id as number;
  const api = await repo(1, 'api');
  const web = await repo(1, 'web');
  const foreign = await repo(2, 'web');
  prId = await pr(1, api, 7, 'open', HEAD);
  peerIds = {
    openWeb: await pr(1, web, 11, 'open', 'b'.repeat(40)),
    mergedApi: await pr(1, api, 12, 'merged', 'c'.repeat(40)),
    closed: await pr(1, web, 13, 'closed', 'd'.repeat(40)),
    noHead: await pr(1, web, 14, 'open', null),
    foreign: await pr(2, foreign, 15, 'open', 'e'.repeat(40)),
  };
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

afterEach(() => {
  _resetTicketSourceForTest();
  deep = false;
});

async function runToEnd(): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5');
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

describe('the PR review checks no story', () => {
  it('a run makes no story finding and stores no ticket or assessment, whatever the model sends', async () => {
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    expect(r.findings.map((f) => [f.title, f.story])).toEqual([['Unchecked input', null]]);
    expect(r.tickets).toEqual([]);
    expect(r.ticket).toBeNull();
    expect(r.ticketAssessment).toBeNull();
    expect(lastArgs?.prompt).not.toContain('User stories');
    expect(lastArgs?.systemPrompt).not.toContain('`tickets`');
  });

  it('a POSTED legacy story finding is not followed up by the next run', async () => {
    // A legacy run: one ordinary finding and one story finding, both posted.
    const legacy = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1, [{ title: 'Reset', description: null, acceptanceCriteria: null }]);
    const base = {
      path: 'src/mail.ts', line: 3, side: 'RIGHT' as const, body: 'b', suggestion: null, diffHunk: null,
      anchored: true, fileInDiff: true, severity: 'warning' as const,
    };
    await persist.saveReviewSuccess(ctx, legacy, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
      numTurns: 1, excludedFiles: [],
      findings: [{ ...base, title: 'Ordinary' }, { ...base, title: 'The link expires' }],
    });
    await db
      .update(schema.claudeReviewFindings)
      .set({ postedAt: new Date(), githubCommentId: '9', postedCommentKind: 'inline' })
      .where(eq(schema.claudeReviewFindings.reviewId, legacy))
      .execute();
    await db
      .update(schema.claudeReviewFindings)
      .set({ storyIndex: 0, storyRef: 'AC1' })
      .where(eq(schema.claudeReviewFindings.title, 'The link expires'))
      .execute();

    const next = await runToEnd();
    expect(next.status).toBe('succeeded');
    expect(next.followUp?.items.map((it) => it.title)).toEqual(['Ordinary']);
    expect(next.findings.map((f) => f.title)).not.toContain('The link expires');
    expect(next.findings.every((f) => f.story == null)).toBe(true);
  });
});

describe('ticket peers on a deep review', () => {
  const providers = (members: number[]) =>
    _overrideTicketSourceForTest({
      ticketsForPr: async () => [
        { ident: 'jira:https://x#ENG-1', ticket: { title: 'Reset', description: null, acceptanceCriteria: null, key: 'ENG-1' }, ticketHash: 'h' },
      ],
      ticketMembers: async () => members.map((id) => ({ prId: id, workspaceId: 1 })),
    });

  it('no tickets ⇒ no peers', async () => {
    expect(await manager.reviewPeersFor({ ctx, accountId: 1, prId })).toEqual([]);
  });

  it('open first, then merged; never itself, closed, head-less or another account\'s', async () => {
    providers([prId, peerIds.mergedApi, peerIds.openWeb, peerIds.closed, peerIds.noHead, peerIds.foreign]);
    const peers = await manager.reviewPeersFor({ ctx, accountId: 1, prId });
    expect(peers.map((p) => [p.ref, p.repoFullName, p.number, p.state, p.ticketKeys, p.files])).toEqual([
      ['X1', 'acme/web', 11, 'open', ['ENG-1'], ['src/f11.ts']],
      ['X2', 'acme/api', 12, 'merged', ['ENG-1'], ['src/f12.ts']],
    ]);
  });

  it('caps the peers, and a failing seam costs the block only', async () => {
    expect(TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW).toBeLessThan(6);
    _overrideTicketSourceForTest({
      ticketsForPr: async () => {
        throw new Error('jira down');
      },
      ticketMembers: async () => [],
    });
    expect(await manager.reviewPeersFor({ ctx, accountId: 1, prId })).toEqual([]);
  });

  it('a deep run hands the peers to the agent and fences them in the prompt; a diff-only run does not', async () => {
    providers([peerIds.openWeb, peerIds.mergedApi]);
    deep = true;
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    expect(lastArgs?.mode).toBe('worktree');
    expect(lastArgs?.peers).toEqual([
      { ref: 'X1', owner: 'acme', name: 'web', prNumber: 11, headSha: 'b'.repeat(40) },
      { ref: 'X2', owner: 'acme', name: 'api', prNumber: 12, headSha: 'c'.repeat(40) },
    ]);
    expect(lastArgs?.prompt).toContain('## Related PRs on the same ticket');
    expect(lastArgs?.prompt).toContain('### X1: acme/web#11 (open)');

    deep = false;
    await runToEnd();
    expect(lastArgs?.mode).toBe('diff_only');
    expect(lastArgs?.peers).toEqual([]);
    expect(lastArgs?.prompt).not.toContain('Related PRs');
  });
});

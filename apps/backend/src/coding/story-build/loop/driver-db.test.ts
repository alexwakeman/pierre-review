// THE REVIEW LOOP'S STATE MACHINE (loop/driver.ts) over the REAL core client (a scratch SQLite, migrations
// applied) with FAKE seams (`setStoryLoopSeamsForTests`): the reviews, the story check, the git and GitHub
// writes and the live session. Pinned:
//   • the happy path: the start claim → round 0 pushes each branch (no PR) → review 1 (findings, a criterion
//     not met) → the fix turn (REVIEW.md, the answers stored) → ONE fast-forward push for the changed target
//     → review 2 clean → the PRs open, READY, the body summarising the rounds → done; the closing review is
//     written as ONE claude_reviews row at the PR head (auto review then skips that head);
//   • N reached: the closing review still finds something ⇒ the PR opens, its body names what is still open;
//   • the spend gate: a refusal before the round PAUSES (budget); Continue is the reader's run (the gate is not
//     asked for that step), the next automatic step asks again;
//   • a push failure pauses and is NEVER retried by itself; BRANCH_EXISTS + Continue with a new name;
//   • restart: a claimed push with no answer ⇒ paused (interrupted); Continue ADOPTS the push that landed;
//   • Stop during a review aborts it ⇒ stopped;
//   • the reader's Push on a paused loop's branch opens the PR (loop_ended 'manual_push');
//   • a stacked plan: PR2's fix commit carries PR1's new commit as a second parent when PR1 moved;
//   • the settings switch refuses once the loop started; the routes answer and scope the account.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketAssessment } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild-loop-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('../../../tracker/manual-links.js', () => ({ resolveTicketRefs: async () => ({ ok: true, body: { results: [] } }) }));
vi.mock('../../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('../persist.js');
let D: typeof import('./driver.js');
let LP: typeof import('./persist.js');
const repo: { api: number; web: number } = { api: 0, web: 0 };
let ws = 0;
const IDENT = 'jira:https://acme.atlassian.net#PAY-142';

interface Script {
  /** Findings per (round, repo name). */
  findings: (round: number, name: string, provider: string) => Array<{ severity: string; path: string; title: string; body: string; priorFindingId?: number | null }>;
  criteria: (round: number) => TicketAssessment['criteria'];
  /** The agent's answers per fix turn. */
  answers: (shown: readonly string[], round: number) => Array<{ ref: string; action: string; reply: string }>;
  /** What a fix turn changes: repo name → new patch. */
  changes: (round: number) => Record<string, string>;
}

const G = {
  allowed: true,
  providers: ['claude'] as string[],
  branchPushes: [] as any[],
  ffPushes: [] as any[],
  opened: [] as any[],
  fixTurns: [] as string[],
  files: [] as any[],
  gateAsks: [] as string[],
  halves: [] as any[],
  checks: [] as any[],
  branchFail: null as null | { code: string; message: string },
  liveSha: null as string | null,
  facts: null as null | { tree: string; parents: string[] },
  hangReview: false,
  seq: 0,
  script: null as unknown as Script,
};

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const treeOfPatch = (patch: string): string => createHash('sha1').update(patch).digest('hex');

const criterion = (ref: string, status: string, text: string): TicketAssessment['criteria'][number] =>
  ({ ref, index: Number(ref.slice(2)) - 1, text, status, explanation: status === 'met' ? 'Done.' : 'Not done.', deliveredBy: [], evidence: [], expectedIn: null }) as any;

function defaultScript(): Script {
  return {
    findings: (round, name) => (round === 1 && name === 'api' ? [{ severity: 'warning', path: 'src/refund.ts', title: 'No amount check', body: 'Refund accepts a negative amount.' }] : []),
    criteria: (round) => [criterion('AC1', 'met', 'Refund a card'), criterion('AC2', round === 1 ? 'not_met' : 'met', 'Email the buyer')],
    answers: (shown) => shown.map((ref) => ({ ref, action: 'fixed', reply: `Done ${ref}.` })),
    changes: () => ({ api: 'diff --git a/a.ts b/a.ts\n+fixed\n' }),
  };
}

function seams(): Partial<import('./seams.js').LoopSeams> {
  return {
    now: () => new Date(),
    waitMs: 200,
    pollMs: 5,
    providers: async () => G.providers as any,
    storyProvider: () => 'claude',
    automaticAllowed: async (_c, _a, what) => {
      G.gateAsks.push(what);
      return G.allowed;
    },
    runHalf: async (_c, i) => {
      G.halves.push({ round: i.round, name: i.name, provider: i.provider, head: i.headSha, prior: i.prior });
      if (G.hangReview) {
        await new Promise<void>((resolve) => i.abort.signal.addEventListener('abort', () => resolve()));
        return { status: 'cancelled', failureReason: null, reviewMode: null, summary: null, verdict: null, findings: [], followUp: null, ranOn: { provider: i.provider, model: null, effort: null }, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null };
      }
      const fs = G.script.findings(i.round, i.name, i.provider);
      return {
        status: 'succeeded',
        failureReason: null,
        reviewMode: 'diff_only',
        summary: `Round ${i.round}.`,
        verdict: fs.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE',
        findings: fs.map((f) => ({ path: f.path, line: 3, side: 'RIGHT', severity: f.severity as any, title: f.title, body: f.body, suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, priorFindingId: f.priorFindingId ?? null })),
        followUp: null,
        ranOn: { provider: i.provider, model: 'm', effort: null },
        costUsd: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        numTurns: 1,
      };
    },
    runStoryCheck: async (_c, i) => {
      G.checks.push({ claims: i.claims, targets: i.targets.map((t) => t.member.branch) });
      const criteria = G.script.criteria(G.checks.length);
      return {
        status: 'succeeded',
        failureReason: null,
        assessment: { alignment: 'partly_aligned', summary: 's', criteria, missing: [], notRequested: [] },
        claimVerdicts: i.claims.filter((c) => c.kind === 'not_applicable').map((c) => ({ ref: c.ref, verdict: 'accepted' as const, why: 'Out of scope.' })),
        model: 'm',
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        numTurns: 1,
      };
    },
    consolidate: async (_c, _a, a) => ({ summary: a.summary, verdict: a.verdict, how: 'code', sourceOf: {}, mergedFrom: {} }),
    canPush: async () => true,
    pushNewBranch: async (a) => {
      G.branchPushes.push(a);
      if (G.branchFail) throw Object.assign(new Error(G.branchFail.message), { code: G.branchFail.code });
      return { commitSha: sha(++G.seq), treeSha: treeOfPatch(a.patch) };
    },
    pushFastForward: async (a) => {
      G.ffPushes.push(a);
      return { commitSha: sha(1000 + ++G.seq), pushed: true };
    },
    openPr: async (a) => {
      const n = 500 + ++prSeq;
      G.opened.push(a);
      await a.afterSync?.(n);
      return { prNumber: n, prUrl: `https://github.com/${a.owner}/${a.name}/pull/${n}` };
    },
    treeOfPatch: async (_a, _o, _n, _r, _s, patch) => treeOfPatch(patch),
    liveBranchSha: async () => G.liveSha,
    openPrOfBranch: async () => null,
    commitFacts: async () => G.facts ?? { tree: '', parents: [] },
    afterPrSync: async (_c, a) => {
      await db
        .insert(schema.pullRequests)
        .values({ githubNodeId: `PR_${a.repoId}_${a.prNumber}`, accountId: a.accountId, repoId: a.repoId, number: a.prNumber, title: 't', state: 'open', isDraft: false, headSha: 'h', openedAt: new Date(), updatedAt: new Date() })
        .execute();
    },
    session: {
      hold: () => {},
      release: () => {},
      ready: () => true,
      live: () => true,
      provider: () => 'claude',
      root: () => '/workspace',
      copyIn: async (_id, files) => {
        G.files.push(...files);
        return true;
      },
      removeResponse: async () => {},
      readResponse: async (_id, shown) => ({ kind: 'ok' as const, check: { payload: { items: G.script.answers(shown, 0) as any }, problems: [], notReported: [] } }),
      resume: async () => null,
      interrupt: async () => {},
      emit: () => {},
      notice: () => {},
      startFixTurn: (id, text) => {
        G.fixTurns.push(text);
        // The turn: the agent changes the code, the store step keeps the patch, then the turn ends.
        void (async () => {
          const round = G.fixTurns.length;
          const rows = await P.listStoryBuildRepoRows(ctx, 1, id);
          for (const [name, patch] of Object.entries(G.script.changes(round))) {
            const r = rows.find((x) => x.repoId === (repo as any)[name]);
            if (r) await P.updateStoryBuildRepo(ctx, 1, r.id, { patch });
          }
          await D.afterLoopFixTurn(ctx, { accountId: 1, buildId: id }, { outcome: 'completed', stored: true, saved: true });
        })();
        return 'started' as const;
      },
    } satisfies import('./seams.js').LoopSeams['session'],
  };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../../db/run-migrations.js');
  const client = await import('../../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../../db/queries.js');
  for (const acct of [1, 2]) await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
  ws = await ensureDefaultWorkspace(1);
  for (const name of ['api', 'web'] as const) {
    const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: `R${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' }).returning().execute();
    repo[name] = r.id;
  }
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    accountIdOf: (req: any) => Number(req.headers['x-account'] ?? 1),
    github: { fetchPrHeadInfo: async () => ({ isFork: false }) },
  };
  P = await import('../persist.js');
  D = await import('./driver.js');
  LP = await import('./persist.js');
});

afterAll(async () => {
  D.setStoryLoopSeamsForTests(null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  Object.assign(G, { seq: 0, allowed: true, providers: ['claude'], branchPushes: [], ffPushes: [], opened: [], fixTurns: [], files: [], gateAsks: [], halves: [], checks: [], branchFail: null, liveSha: null, facts: null, hangReview: false, script: defaultScript() });
  D.setStoryLoopSeamsForTests(seams());
});

let identSeq = 0;
let prSeq = 0;
/** A built session with both repositories ready and the option on. */
async function readyBuild(o: { rounds?: number; autoPush?: boolean; only?: 'api' } = {}): Promise<number> {
  const started = await P.insertStoryBuild(ctx, { accountId: 1, workspaceId: ws, ident: `${IDENT}-${++identSeq}`, ticketKey: 'PAY-142', ticketTitle: 'Refunds', wantDiagram: false, wantDocs: false, provider: 'claude', model: 'claude-opus-5-5' });
  const id = started.id;
  await P.updateStoryBuild(ctx, 1, id, {
    status: 'ready',
    sessionPhase: 'built',
    autoPush: o.autoPush ?? true,
    loopRounds: o.rounds ?? 3,
    seedJson: { version: 1, story: { key: 'PAY-142', title: 'Refunds', text: 'Refund card payments.', url: null }, criteria: [{ n: 1, text: 'Refund a card' }, { n: 2, text: 'Email the buyer' }], comments: null, cards: [] },
  });
  const common = { accountId: 1, buildId: id, baseRef: 'main', baseSha: 'b'.repeat(40), stackedOnPrId: null, status: 'ready' as const };
  const a = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: repo.api, ref: 'R1', buildOrder: 0, include: true, branch: 'PAY-142' });
  await P.updateStoryBuildRepo(ctx, 1, a, { patch: 'diff --git a/a.ts b/a.ts\n+one\n', summary: 'Refund endpoint.', commitMessage: 'feat: refunds' });
  if (o.only !== 'api') {
    const w = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: repo.web, ref: 'R2', buildOrder: 1, include: true, branch: 'PAY-142' });
    await P.updateStoryBuildRepo(ctx, 1, w, { patch: 'diff --git a/b.ts b/b.ts\n+button\n', summary: 'Refund button.', commitMessage: 'feat: refund button' });
  }
  return id;
}

async function until(id: number, pred: (b: any) => boolean, what: string, settle = true): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const b = await P.getStoryBuildRow(ctx, 1, id);
    if (b && pred(b)) {
      if (!settle) return b;
      for (let j = 0; j < 400 && D.isStoryLoopBusy(id); j++) await new Promise((r) => setTimeout(r, 5));
      return P.getStoryBuildRow(ctx, 1, id);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the review loop', () => {
  it('pushes, reviews, fixes, pushes a fast-forward fix, reviews clean, then opens ready PRs', async () => {
    const id = await readyBuild();
    expect(await D.maybeStartLoop(ctx, { accountId: 1, buildId: id })).toBe('started');
    // A second start never runs twice (the claim).
    expect(await D.maybeStartLoop(ctx, { accountId: 1, buildId: id })).toBe('skipped');
    const b = await until(id, (x) => x.loopState === 'done', 'done');
    expect(b.loopRound).toBe(2);
    // Round 0: each branch, no PR; then one fix push (api changed), then the PRs.
    expect(G.branchPushes.map((p) => `${p.name}:${p.branch}`)).toEqual(['api:PAY-142', 'web:PAY-142']);
    expect(G.ffPushes.map((p) => p.name)).toEqual(['api']);
    expect(G.ffPushes[0].extraParents).toEqual([]);
    expect(G.ffPushes[0].message).toContain('Address review round 1');
    expect(G.opened.map((p) => p.name)).toEqual(['api', 'web']);
    expect(G.opened.every((p) => p.draft === false)).toBe(true);
    expect(G.opened[0].body).toContain('## Review in Limn');
    expect(G.opened[0].body).toContain('Fixed: 1');
    // The fix turn: REVIEW.md listed the finding and the criterion; the checker was copied in.
    expect(G.fixTurns).toHaveLength(1);
    expect(G.files.map((f) => f.path)).toEqual(['/workspace/REVIEW.md', '/workspace/.limn/review-refs.json', '/home/agent/.limn/review-response-check.cjs']);
    expect(G.files[0].content).toContain('## F1');
    expect(G.files[0].content).toContain('## AC2');
    // Round 2 re-reviewed only the target that changed or had something open (api), and fed it the answer.
    expect(G.halves.map((h) => `${h.round}:${h.name}`)).toEqual(['1:api', '1:web', '2:api']);
    expect(G.halves[2].prior.findings[0].thread.replies[0].body).toBe('Fixed: Done F1.');
    // Stored: the answers, the PRs on the targets, every write claimed once.
    const findings = await LP.listLoopFindings(ctx, 1, id);
    expect(findings[0]).toMatchObject({ ref: 'F1', response: 'fixed', responseText: 'Done F1.', responseRound: 1 });
    expect((await LP.listLoopAcResponses(ctx, 1, id)).map((r) => `${r.ref}:${r.response}`)).toEqual(['AC2:fixed']);
    const repos = await P.listStoryBuildRepoRows(ctx, 1, id);
    expect(repos.map((r) => [r.status, r.loopEnded, r.pushedPrNumber != null])).toEqual([
      ['pushed', 'pr_opened', true],
      ['pushed', 'pr_opened', true],
    ]);
    const pushes = await LP.listLoopPushes(ctx, 1, id);
    expect(pushes.map((p) => `${p.round}:${p.step}`).sort()).toEqual(['0:branch', '0:branch', '0:open', '0:open', '1:fix']);
    expect(pushes.every((p) => p.doneAt != null && p.error == null)).toBe(true);
    // The closing review sits on the api PR at its head (auto review skips that head).
    const cr = await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.headSha, repos[0]!.loopPushedSha)).execute();
    expect(cr).toHaveLength(1);
    expect(cr[0]).toMatchObject({ status: 'succeeded', trigger: 'manual', postedAt: null });
    // The wire.
    const loop = await D.storyLoopWire(ctx, 1, b);
    expect(loop).toMatchObject({ on: true, state: 'done', rounds: 3, editable: false, canContinue: false, next: null });
    expect(loop!.history.map((h) => [h.round, h.open.findings, h.open.criteria])).toEqual([
      [1, 1, 1],
      [2, 0, 0],
    ]);
    expect(loop!.history[0]!.reviews[0]!.findings[0]!.response).toMatchObject({ action: 'fixed', text: 'Done F1.' });
  });

  it('after N rounds the closing review opens the PR anyway, naming what is still open', async () => {
    G.script.findings = (_round, name) => (name === 'api' ? [{ severity: 'blocker', path: 'src/x.ts', title: 'Still broken', body: 'b' }] : []);
    G.script.answers = (shown) => shown.map((ref) => ({ ref, action: 'pushed_back', reply: 'It is fine.' }));
    const id = await readyBuild({ rounds: 1, only: 'api' });
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    const b = await until(id, (x) => x.loopState === 'done', 'done');
    expect(b.loopRound).toBe(2);
    expect(G.fixTurns).toHaveLength(1);
    expect(G.opened).toHaveLength(1);
    expect(G.opened[0].body).toContain('Still open: 1');
    expect(G.opened[0].body).toContain('blocker · src/x.ts: Still broken');
  });

  it('pauses on the spend gate; Continue is the reader\'s run, the next automatic step asks again', async () => {
    const id = await readyBuild({ only: 'api' });
    G.allowed = false;
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    let b = await until(id, (x) => x.loopState === 'paused', 'paused');
    expect(b).toMatchObject({ loopPause: 'budget', loopResume: 'reviewing', loopRound: 1 });
    expect(G.halves).toEqual([]);
    expect(G.branchPushes).toHaveLength(1);
    // The reader's Continue: the review runs without asking the gate; the fix (automatic) asks and pauses.
    G.gateAsks.length = 0;
    expect(await D.continueLoop(ctx, 1, id)).toEqual({ status: 'continued' });
    b = await until(id, (x) => x.loopState === 'paused', 'paused again');
    expect(G.halves).toHaveLength(1);
    expect(G.gateAsks).toEqual(['story_loop_fix']);
    expect(b).toMatchObject({ loopPause: 'budget', loopResume: 'fixing' });
    G.allowed = true;
    await D.continueLoop(ctx, 1, id);
    b = await until(id, (x) => x.loopState === 'done', 'done');
    expect(G.fixTurns).toHaveLength(1);
  });

  it('a failed push pauses and is never retried by itself; BRANCH_EXISTS + Continue with a new name', async () => {
    const id = await readyBuild({ only: 'api' });
    G.branchFail = { code: 'BRANCH_EXISTS', message: 'branch PAY-142 already exists on acme/api' };
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    const b = await until(id, (x) => x.loopState === 'paused', 'paused');
    expect(b).toMatchObject({ loopPause: 'branch_exists', loopResume: 'pushing' });
    await new Promise((r) => setTimeout(r, 50));
    expect(G.branchPushes).toHaveLength(1);
    const repoRow = (await P.listStoryBuildRepoRows(ctx, 1, id))[0]!;
    expect(repoRow).toMatchObject({ pushErrorCode: 'BRANCH_EXISTS' });
    G.branchFail = null;
    G.script.findings = () => [];
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card')];
    expect(await D.continueLoop(ctx, 1, id, { branch: { kind: 'repo', id: repoRow.id, name: 'PAY-142-v2' } })).toEqual({ status: 'continued' });
    await until(id, (x) => x.loopState === 'done', 'done');
    expect(G.branchPushes.map((p) => p.branch)).toEqual(['PAY-142', 'PAY-142-v2']);
    expect(G.opened[0].branch).toBe('PAY-142-v2');
    const pushes = await LP.listLoopPushes(ctx, 1, id);
    expect(pushes.filter((p) => p.step === 'branch').map((p) => [p.attempt, p.errorCode])).toEqual([
      [1, 'BRANCH_EXISTS'],
      [2, null],
    ]);
  });

  it('a restart pauses (interrupted); Continue adopts the push that landed', async () => {
    const id = await readyBuild({ only: 'api' });
    const row = (await P.listStoryBuildRepoRows(ctx, 1, id))[0]!;
    // A claim the restart cut off: claimed, no answer.
    await LP.claimLoopStart(ctx, 1, id, new Date());
    const tree = treeOfPatch(row.patch!);
    await LP.claimLoopPush(ctx, 1, { buildId: id, round: 0, step: 'branch', targetKind: 'repo', targetId: row.id, attempt: 1, branch: 'PAY-142', parentSha: 'b'.repeat(40), expectTree: tree, now: new Date() });
    expect(await D.reconcileStoryLoopsOnStartup(ctx)).toBe(1);
    let b = await P.getStoryBuildRow(ctx, 1, id);
    expect(b).toMatchObject({ loopState: 'paused', loopPause: 'interrupted', loopResume: 'pushing' });
    expect((await LP.listLoopPushes(ctx, 1, id))[0]).toMatchObject({ errorCode: 'INTERRUPTED' });
    // It landed: the live branch is a commit on the base with the expected tree.
    G.liveSha = sha(77);
    G.facts = { tree, parents: ['b'.repeat(40)] };
    G.script.findings = () => [];
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card')];
    await D.continueLoop(ctx, 1, id);
    b = await until(id, (x) => x.loopState === 'done', 'done');
    expect(G.branchPushes).toEqual([]);
    expect((await P.listStoryBuildRepoRows(ctx, 1, id))[0]).toMatchObject({ loopBranch: 'PAY-142', loopPushedSha: sha(77) });
  });

  it('Stop during a review aborts it and stops the loop (the branch stays)', async () => {
    const id = await readyBuild({ only: 'api' });
    G.hangReview = true;
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    await until(id, (x) => x.loopState === 'reviewing', 'reviewing', false);
    for (let i = 0; i < 100 && G.halves.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await D.stopLoop(ctx, 1, id)).toBe('stopped');
    for (let i = 0; i < 400 && D.isStoryLoopBusy(id); i++) await new Promise((r) => setTimeout(r, 5));
    expect(D.isStoryLoopBusy(id)).toBe(false);
    const b = await P.getStoryBuildRow(ctx, 1, id);
    expect(b).toMatchObject({ loopState: 'stopped' });
    expect(G.opened).toEqual([]);
    expect((await P.listStoryBuildRepoRows(ctx, 1, id))[0]).toMatchObject({ loopBranch: 'PAY-142' });
  });

  it("the reader's Push on a paused loop's branch opens the PR and ends the loop", async () => {
    const id = await readyBuild({ only: 'api' });
    G.allowed = false;
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    await until(id, (x) => x.loopState === 'paused', 'paused');
    const { pushRepo } = await import('../push.js');
    const r = await pushRepo(ctx, { accountId: 1, buildId: id, repoId: repo.api, draft: true });
    expect(r, JSON.stringify(r)).toMatchObject({ outcome: 'pushed', code: null });
    expect(G.opened).toHaveLength(1);
    expect(G.opened[0]).toMatchObject({ branch: 'PAY-142', draft: true });
    expect((await P.listStoryBuildRepoRows(ctx, 1, id))[0]).toMatchObject({ status: 'pushed', loopEnded: 'manual_push' });
    expect(await P.getStoryBuildRow(ctx, 1, id)).toMatchObject({ loopState: 'done' });
  });

  it('the switch and the rounds change until the loop starts; the routes scope the account', async () => {
    const id = await readyBuild({ only: 'api', autoPush: false });
    const app = Fastify();
    const { registerStoryBuildLoopRoutes } = await import('./routes.js');
    registerStoryBuildLoopRoutes(app, ctx);
    await app.ready();
    const post = (url: string, body: unknown, acct = 1) => app.inject({ method: 'POST', url, payload: body as any, headers: { 'x-account': String(acct) } });
    expect((await app.inject({ method: 'GET', url: `/api/story-builds/${id}/loop` })).statusCode).toBe(404);
    expect((await post(`/api/story-builds/${id}/loop/settings`, { rounds: 9 })).statusCode).toBe(400);
    expect((await post(`/api/story-builds/${id}/loop/settings`, { on: true }, 2)).statusCode).toBe(404);
    const set = await post(`/api/story-builds/${id}/loop/settings`, { on: true, rounds: 5 });
    expect(set.statusCode).toBe(200);
    expect(set.json().loop).toMatchObject({ on: true, rounds: 5, editable: true, state: null });
    expect((await app.inject({ method: 'GET', url: `/api/story-builds/${id}/loop`, headers: { 'x-account': '2' } })).statusCode).toBe(404);
    // Started: the switch is refused; Continue on a running/finished loop is refused too.
    G.script.findings = () => [];
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card')];
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    await until(id, (x) => x.loopState === 'done', 'done');
    expect((await post(`/api/story-builds/${id}/loop/settings`, { rounds: 2 })).json().error).toBe('LoopStarted');
    expect((await post(`/api/story-builds/${id}/loop/continue`, {})).statusCode).toBe(409);
    expect((await post(`/api/story-builds/${id}/loop/continue`, { branch: { kind: 'repo', id: 1 } })).statusCode).toBe(400);
    expect((await post(`/api/story-builds/${id}/loop/stop`, {})).statusCode).toBe(409);
    await app.close();
  });
});

describe('a Claude + Codex pair', () => {
  it('runs both halves at once, asks the gate for the second, and stores ONE consolidated review', async () => {
    G.providers = ['claude', 'codex'];
    const base = seams();
    let merged = 0;
    D.setStoryLoopSeamsForTests({
      ...base,
      consolidate: async (_c, _a, a, b) => {
        merged += 1;
        if (b.findings.length === 0) return { summary: a.summary, verdict: a.verdict, how: 'code', sourceOf: {}, mergedFrom: {} };
        const drop = b.findings[0]!.id;
        return { summary: 'One review.', verdict: 'REQUEST_CHANGES', how: 'pass', sourceOf: { [String(a.findings[0]!.id)]: 'both' }, mergedFrom: { [String(drop)]: a.findings[0]!.id } };
      },
    });
    G.script.findings = (round, name) => (round === 1 && name === 'api' ? [{ severity: 'warning', path: 'a.ts', title: 'Same point', body: 'b' }] : []);
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card')];
    const id = await readyBuild({ only: 'api' });
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    await until(id, (x) => x.loopState === 'done', 'done');
    expect(G.halves.filter((h) => h.round === 1).map((h) => h.provider)).toEqual(['claude', 'codex']);
    // Each automatic run asks once: round 1's two halves, then round 2's two.
    expect(G.gateAsks.filter((w) => w === 'story_loop_review')).toHaveLength(4);
    // One consolidation per round the two halves succeeded in.
    expect(merged).toBe(2);
    const reviews = (await LP.listLoopReviews(ctx, 1, id)).filter((r) => r.round === 1);
    expect(reviews.map((r) => r.pairRole)).toEqual(['first', 'second']);
    expect(reviews[0]!.pairConsolidation).toMatchObject({ how: 'pass', summary: 'One review.' });
    // The duplicate is merged away: ONE open finding, so ONE item in REVIEW.md.
    const wire = await D.storyLoopWire(ctx, 1, (await P.getStoryBuildRow(ctx, 1, id))!);
    expect(wire!.history[0]!.open.findings).toBe(1);
    expect(wire!.history[0]!.reviews[0]!.findings[0]!.raisedBy).toBe('both');
    expect(G.files[0].content).toContain('## F1');
    expect(G.files[0].content).not.toContain('## F2');
  });
});

describe('a stacked plan', () => {
  it("PR2's fix commit carries PR1's new commit as a second parent when PR1 moved", async () => {
    const id = await readyBuild({ only: 'api' });
    const [plan] = await db
      .insert(schema.storyBuildPlans)
      .values({ accountId: 1, buildId: id, revision: 1, source: 'opening', planJson: { stack: [], criteria: [], contentions: [] } as any, rawSha: 'x' })
      .returning()
      .execute();
    const pr = (k: number, patch: string) => ({
      accountId: 1,
      buildId: id,
      repoId: repo.api,
      planId: plan.id,
      prKey: `PR${k}`,
      position: k,
      stackIndex: k,
      title: `Part ${k}`,
      contains: `Part ${k}.`,
      branch: k === 1 ? 'PAY-142' : `PAY-142-${k}`,
      status: 'ready',
      patch,
      treeSha: treeOfPatch(patch),
    });
    await db.insert(schema.storyBuildPrs).values([pr(1, 'p1'), pr(2, 'p2')]).execute();
    G.script.findings = (round, _name) => (round === 1 ? [{ severity: 'nit', path: 'a.ts', title: 'Rename', body: 'b' }] : []);
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card')];
    G.script.changes = () => ({});
    // The fix turn moves BOTH planned PRs (the agent rebased PR2 on PR1's fix).
    const base = seams();
    D.setStoryLoopSeamsForTests({
      ...base,
      session: {
        ...(base.session as any),
        startFixTurn: (bid: number) => {
          G.fixTurns.push('fix');
          void (async () => {
            const rows = await db.select().from(schema.storyBuildPrs).where((await import('drizzle-orm')).eq(schema.storyBuildPrs.buildId, bid)).execute();
            for (const r of rows) await db.update(schema.storyBuildPrs).set({ treeSha: treeOfPatch(`${r.patch}-fixed`) }).where((await import('drizzle-orm')).eq(schema.storyBuildPrs.id, r.id)).execute();
            await D.afterLoopFixTurn(ctx, { accountId: 1, buildId: bid }, { outcome: 'completed', stored: true, saved: true });
          })();
          return 'started';
        },
      },
    });
    await D.maybeStartLoop(ctx, { accountId: 1, buildId: id });
    await until(id, (x) => x.loopState === 'done', 'done');
    // Round 0: PR2 is pushed on PR1's branch at PR1's pushed commit.
    expect(G.branchPushes.map((p) => [p.branch, p.baseRef])).toEqual([
      ['PAY-142', 'main'],
      ['PAY-142-2', 'PAY-142'],
    ]);
    expect(G.branchPushes[1].baseSha).toBe(sha(1));
    // The fix: PR1 first, then PR2 with PR1's new commit as its second parent.
    expect(G.ffPushes.map((p) => p.branch)).toEqual(['PAY-142', 'PAY-142-2']);
    expect(G.ffPushes[0].extraParents).toEqual([]);
    expect(G.ffPushes[1].extraParents).toEqual([sha(1003)]);
    // PR2 opens on PR1's branch, both titled as a stack.
    expect(G.opened.map((o) => [o.branch, o.prBase])).toEqual([
      ['PAY-142', 'main'],
      ['PAY-142-2', 'PAY-142'],
    ]);
    expect(G.opened[1].title).toBe('PAY-142 (2/2): Part 2');
  });
});

// AI FIX'S OWN REVIEW LOOP — THE DRIVER (coding/ai-fix/loop.ts) over the REAL core client (a scratch SQLite,
// migrations applied) with FAKE seams (`setFixLoopSeamsForTests`): the reviews, the story check, the local
// commits and the live session. The whole fix session around it is pinned end to end in
// sandbox/session/fix-session-flow-db.test.ts. Pinned here:
//   • clean after round 1 ⇒ the loop ends ('clean') with no fix turn, and the session's end runs once;
//   • findings ⇒ a host fix turn (REVIEW.md in AI Fix's words, the answers stored) ⇒ round 2 follows up on
//     them; N reached ⇒ the closing review (step N + 1) ends it ('rounds');
//   • only criteria the agent says it CANNOT MEET (a reason) are open ⇒ the loop stops ('cannot_meet'); the
//     criterion stays NOT MET on the wire, with the reason;
//   • the ONE spend gate: an unattended fix asks it for every automatic step (its features); a refusal
//     mid-loop STOPS it ('budget'), the fix kept; a manual fix's rounds are the reader's click (never asked);
//   • Stop aborts a running review ('stopped');
//   • a Claude + Codex pair is ONE pass (both halves at once, consolidated, one round);
//   • the merge item: the round reviews the checked merge result (its key), against the merge's base;
//   • after the push the closing review becomes the PR's AI review at the PUSHED head — only when it reviewed
//     exactly what was pushed;
//   • a restart stops a working loop ('interrupted'); the local refs' keeper keeps only resumable fixes.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiFixLoopStop, TicketAssessment } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-fix-loop-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let L: typeof import('./loop.js');
let LP: typeof import('./loop-persist.js');
let repoId = 0;
let prId = 0;
let wsId = 0;

const PATCH = 'diff --git a/a.ts b/a.ts\n+one\n';
const PATCH2 = 'diff --git a/a.ts b/a.ts\n+two\n';

interface Script {
  findings: (round: number, provider: string) => Array<{ severity: string; path: string; title: string; priorFindingId?: number | null }>;
  criteria: (round: number) => TicketAssessment['criteria'] | null;
  answers: (shown: readonly string[], round: number) => Array<{ ref: string; action: string; reply: string }>;
  /** The patch a fix turn leaves. */
  patchAfter: (round: number) => string;
}

const G = {
  allowed: (_feature: string) => true,
  providers: ['claude'] as string[],
  gateAsks: [] as string[],
  halves: [] as any[],
  checks: [] as any[],
  files: [] as any[],
  fixTurns: [] as string[],
  ended: [] as AiFixLoopStop[],
  commits: [] as any[],
  bases: [] as any[],
  consolidated: 0,
  hangReview: false,
  ticket: null as null | { ident: string; ticket: any },
  script: null as unknown as Script,
};

const criterion = (ref: string, status: string, text: string): TicketAssessment['criteria'][number] =>
  ({ ref, index: Number(ref.slice(2)) - 1, text, status, explanation: status === 'met' ? 'Done.' : 'Not done.', deliveredBy: [], evidence: [], expectedIn: null }) as any;

function defaultScript(): Script {
  return {
    findings: () => [],
    criteria: () => null,
    answers: (shown) => shown.map((ref) => ({ ref, action: 'fixed', reply: `Done ${ref}.` })),
    patchAfter: () => PATCH2,
  };
}

function seams(): Partial<import('./loop.js').FixLoopSeams> {
  return {
    now: () => new Date(),
    waitMs: 500,
    pollMs: 5,
    rounds: () => 3,
    providers: async () => G.providers as any,
    storyProvider: async () => 'claude',
    automaticAllowed: async (_c, _a, feature) => {
      G.gateAsks.push(feature);
      return G.allowed(feature);
    },
    ticket: async () => G.ticket,
    holdRefs: () => () => {},
    commitRound: async (a) => {
      G.commits.push({ round: a.round, patch: a.patch, merge: a.merge });
      const sha = a.merge?.resultSha ?? String(a.round).repeat(40);
      return { head: { localRef: `refs/pierre/local/ai-fix-loop/${a.fixId}/r${a.round}`, sha }, workKey: L.fixWorkKey({ patch: a.patch, merge: a.merge }) };
    },
    baseSha: async (a) => {
      G.bases.push(a.merge);
      return a.merge?.baseSha ?? 'b'.repeat(40);
    },
    runHalf: async (_c, i) => {
      const round = G.halves.filter((h) => h.provider === i.provider).length + 1;
      G.halves.push({ round, provider: i.provider, head: i.head, prior: i.prior, byReader: i.byReader, feature: i.feature, baseSha: i.baseSha });
      if (G.hangReview) {
        await new Promise<void>((resolve) => i.abort.signal.addEventListener('abort', () => resolve()));
        return { status: 'cancelled', failureReason: null, reviewMode: null, summary: null, verdict: null, findings: [], followUp: null, ranOn: { provider: i.provider, model: null, effort: null }, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null };
      }
      const fs = G.script.findings(round, i.provider);
      return {
        status: 'succeeded',
        failureReason: null,
        reviewMode: 'diff_only',
        summary: `Round ${round}.`,
        verdict: fs.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE',
        findings: fs.map((f) => ({ path: f.path, line: 3, side: 'RIGHT', severity: f.severity as any, title: f.title, body: 'b', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, priorFindingId: f.priorFindingId ?? null, lens: null })),
        followUp: null,
        ranOn: { provider: i.provider, model: 'm', effort: null },
        costUsd: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        numTurns: 1,
      } as any;
    },
    runStoryCheck: async (_c, i) => {
      G.checks.push({ claims: i.claims, feature: i.feature, targets: i.targets.map((t) => t.head.sha) });
      const criteria = G.script.criteria(G.checks.length) ?? [];
      return { status: 'succeeded', failureReason: null, assessment: { alignment: 'partly_aligned', summary: 's', criteria, missing: [], notRequested: [] }, claimVerdicts: [], model: 'm', costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1 } as any;
    },
    // The pair: the second half's duplicate merges into the first's.
    consolidate: async (_c, _a, a, b) => {
      G.consolidated += 1;
      const mergedFrom: Record<string, number> = {};
      for (const f of b.findings) {
        const same = a.findings.find((x) => x.title === f.title);
        if (same) mergedFrom[String(f.id)] = same.id;
      }
      return { summary: 'Both agree.', verdict: a.verdict, how: 'code', sourceOf: {}, mergedFrom };
    },
    session: {
      hold: () => {},
      release: () => {},
      ready: () => true,
      live: () => true,
      provider: () => 'claude',
      paths: () => ({ root: '/workspace', repoPath: '/workspace/acme/api' }),
      copyIn: async (_id, files) => {
        G.files.push(...files);
        return true;
      },
      removeResponse: async () => {},
      readResponse: async (_id, shown) => ({ kind: 'ok' as const, check: { payload: { items: G.script.answers(shown, G.fixTurns.length) as any }, problems: [], notReported: [] } }),
      interrupt: async () => {},
      notice: () => {},
      changed: () => {},
      ended: async (_c, _a, _id, stop) => void G.ended.push(stop),
      startFixTurn: (id, text) => {
        G.fixTurns.push(text);
        // The turn: the agent changes the code, the store step keeps the patch, then the turn ends.
        void (async () => {
          const round = G.fixTurns.length;
          await db.update(schema.aiFixes).set({ patch: G.script.patchAfter(round) }).where((await import('drizzle-orm')).eq(schema.aiFixes.id, id)).execute();
          await L.afterFixLoopTurn(ctx, { accountId: 1, fixId: id }, { outcome: 'completed', stored: true });
        })();
        return 'started' as const;
      },
    },
  };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  for (const acct of [1, 2]) await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
  wsId = await ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-api', owner: 'acme', name: 'api', defaultBranch: 'main', viewerPermission: 'WRITE' }).returning().execute();
  repoId = r.id;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({ accountId: 1, repoId, githubNodeId: 'PR-7', number: 7, title: 'Refunds', state: 'open', isDraft: false, headSha: 'h'.repeat(40), baseRefName: 'main', openedAt: new Date(), updatedAt: new Date() })
    .returning()
    .execute();
  prId = p.id;
  ctx = { db, schema, runTransaction: client.runTransaction, log: { warn: () => {}, info: () => {}, error: () => {} } };
  L = await import('./loop.js');
  LP = await import('./loop-persist.js');
});

afterAll(async () => {
  L?.setFixLoopSeamsForTests(null);
  L?._resetFixLoopsForTest();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  Object.assign(G, { allowed: () => true, providers: ['claude'], gateAsks: [], halves: [], checks: [], files: [], fixTurns: [], ended: [], commits: [], bases: [], consolidated: 0, hangReview: false, ticket: null, script: defaultScript() });
  L.setFixLoopSeamsForTests(seams());
});

/** A built fix with work to push (the session's facts in session_json, as fix.ts writes them). */
async function builtFix(o: { merge?: Record<string, unknown> | null; reviewItems?: unknown[] } = {}): Promise<number> {
  const [row] = await db
    .insert(schema.aiFixes)
    .values({
      accountId: 1,
      repoId,
      prId,
      baseSha: 'h'.repeat(40),
      status: 'succeeded',
      model: 'claude-opus-5-5',
      provider: 'claude',
      seed: 'review',
      patch: PATCH,
      filesChanged: JSON.stringify(['a.ts']),
      trigger: 'auto',
      sessionPhase: 'built',
      workspaceId: wsId,
      reviewItems: o.reviewItems ? JSON.stringify(o.reviewItems) : null,
      ...(o.merge ? { mergeJson: o.merge, mergeBundle: 'YnVuZGxl' } : {}),
      sessionJson: { fix: { prId, prRepoId: repoId, number: 7, fullName: 'acme/api', title: 'Refunds', body: null, headRef: 'feature/refunds', baseRef: 'main', headSha: 'h'.repeat(40) } },
    })
    .returning()
    .execute();
  return row.id;
}

async function row(id: number): Promise<any> {
  return (await db.select().from(schema.aiFixes).where((await import('drizzle-orm')).eq(schema.aiFixes.id, id)).execute())[0];
}

async function until(id: number, pred: (r: any) => boolean, what: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await row(id);
    if (r && pred(r)) {
      await L._fixLoopsIdleForTest();
      return row(id);
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ended = (r: any) => r.loopState === 'done' || r.loopState === 'stopped';

describe("AI Fix's own review loop", () => {
  it('clean after round 1: ends with no fix turn, the session’s end runs once; an unattended fix asked the gate', async () => {
    const id = await builtFix();
    expect(await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: false })).toBe('started');
    // A second start never runs twice (the claim / the in-process marker).
    expect(await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: false })).toBe('skipped');
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopState: 'done', loopStop: 'clean', loopRound: 1, loopFirstRound: 1, loopRounds: 3, loopBaseSha: 'b'.repeat(40) });
    expect(G.fixTurns).toEqual([]);
    expect(G.ended).toEqual(['clean']);
    expect(G.gateAsks).toEqual(['ai_fix_loop_review']);
    expect(G.halves[0]).toMatchObject({ byReader: false, feature: 'ai_fix_loop_review', baseSha: 'b'.repeat(40) });
    expect(G.halves[0].head).toEqual({ localRef: `refs/pierre/local/ai-fix-loop/${id}/r1`, sha: '1'.repeat(40) });
    expect(L.fixLoopActive(id)).toBe(false);
    const wire = await L.fixLoopWire(ctx, 1, r);
    expect(wire).toMatchObject({ state: 'done', stop: 'clean', stopLine: 'Reviewed: nothing is open.', running: false });
    // Another account reads nothing.
    expect(await LP.listFixLoopReviews(ctx, 2, id)).toEqual([]);
  });

  it('findings ⇒ a host fix turn (REVIEW.md in AI Fix’s words, answers stored) ⇒ round 2 follows up; N reached ⇒ the closing review ends it; a reader’s rounds never ask the gate', async () => {
    G.script.findings = (round) => [{ severity: 'warning', path: 'src/refund.ts', title: `Point ${round}` }];
    G.script.patchAfter = (round) => `diff --git a/a.ts b/a.ts\n+fix ${round}\n`;
    const id = await builtFix();
    expect(await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true })).toBe('started');
    const r = await until(id, ended, 'ended');
    // rounds = 3: three fix turns, four reviews, the fourth is the closing one.
    expect(r).toMatchObject({ loopState: 'done', loopStop: 'rounds', loopRound: 4 });
    expect(G.fixTurns).toHaveLength(3);
    expect(G.halves.map((h) => h.round)).toEqual([1, 2, 3, 4]);
    expect(G.gateAsks).toEqual([]);
    expect(G.halves.every((h) => h.byReader === true)).toBe(true);
    expect(G.fixTurns[0]).toContain('Ensemble reviewed your fix (round 1 of 3).');
    expect(G.fixTurns[0]).toContain('/workspace/acme/api');
    expect(G.fixTurns[0]).toContain('cannot_meet');
    expect(G.files.map((f) => f.path).slice(0, 3)).toEqual(['/workspace/REVIEW.md', '/workspace/.limn/review-refs.json', '/home/agent/.limn/review-response-check.cjs']);
    expect(G.files[0].content).toContain('Ensemble reviewed your fix');
    expect(G.files[0].content).toContain('## F1');
    // Round 2 got round 1's finding back with the agent's answer.
    expect(G.halves[1].prior.findings[0].thread.replies[0].body).toBe('Fixed: Done F1.');
    // Each round reviewed the work as it was then.
    expect(G.commits.map((c) => c.patch)).toEqual([PATCH, 'diff --git a/a.ts b/a.ts\n+fix 1\n', 'diff --git a/a.ts b/a.ts\n+fix 2\n', 'diff --git a/a.ts b/a.ts\n+fix 3\n']);
    const findings = await LP.listFixLoopFindings(ctx, 1, id);
    expect(findings[0]).toMatchObject({ ref: 'F1', response: 'fixed', responseText: 'Done F1.', responseRound: 1 });
    const wire = (await L.fixLoopWire(ctx, 1, r))!;
    expect(wire.history.map((h) => [h.step, h.closing, h.counts.found, h.counts.fixed, h.fix])).toEqual([
      [1, false, 1, 1, 'done'],
      [2, false, 1, 1, 'done'],
      [3, false, 1, 1, 'done'],
      [4, true, 1, 0, 'none'],
    ]);
    expect(wire.stopLine).toBe('Reviewed: the review rounds are used up. What is still open is listed below.');
  });

  it('a "fixed" whose code did not change reads as an answer', async () => {
    G.script.findings = (round) => (round === 1 ? [{ severity: 'nit', path: 'a.ts', title: 'Rename' }] : []);
    G.script.patchAfter = () => PATCH;
    const id = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true });
    await until(id, ended, 'ended');
    expect((await LP.listFixLoopFindings(ctx, 1, id))[0]).toMatchObject({ response: 'answered', responseText: '(no code change) Done F1.' });
  });

  it('⚠ only criteria the agent CANNOT MEET are open ⇒ the loop stops; the criterion stays NOT MET, with the reason', async () => {
    G.ticket = { ident: 'jira:x#PAY-1', ticket: { title: 'Refunds', description: null, acceptanceCriteria: '1. Refund a card\n2. Email the buyer', key: 'PAY-1', url: null } };
    G.script.criteria = () => [criterion('AC1', 'met', 'Refund a card'), criterion('AC2', 'not_met', 'Email the buyer')];
    G.script.answers = (shown) => shown.map((ref) => ({ ref, action: 'cannot_meet', reply: 'Email is sent by another service.' }));
    const id = await builtFix({ reviewItems: [{ ref: 'S1-AC2', kind: 'story', title: 'Email the buyer', path: null, line: null, findingId: null, threadId: null, ticketIndex: 0, included: true }] });
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: false });
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopState: 'done', loopStop: 'cannot_meet', loopRound: 2 });
    // One fix turn (round 1's), then round 2 found only AC2 open — the agent said it cannot be done.
    expect(G.fixTurns).toHaveLength(1);
    expect(G.checks).toHaveLength(2);
    expect(G.checks[0].feature).toBe('ai_fix_loop_check');
    // Round 2's story check got the agent's note as context (an answer, never a "not applicable" claim).
    expect(G.checks[1].claims).toEqual([{ ref: 'AC2', kind: 'answer', text: 'Email is sent by another service.' }]);
    expect(G.gateAsks).toEqual(['ai_fix_loop_review', 'ai_fix_loop_check', 'ai_fix_loop_fix', 'ai_fix_loop_review', 'ai_fix_loop_check']);
    const wire = (await L.fixLoopWire(ctx, 1, r))!;
    expect(wire.cannotMeet).toEqual([{ ref: 'AC2', text: 'Email the buyer', reason: 'Email is sent by another service.' }]);
    expect(wire.history.at(-1)!.criteria.map((c) => [c.ref, c.status])).toEqual([['AC2', 'not_met']]);
    expect(wire.history[0]!.criteria[0]!.response).toEqual({ action: 'cannot_meet', text: 'Email is sent by another service.' });
    expect(wire.stopLine).toBe('Stopped: only criteria the agent says cannot be done are open.');
  });

  it('⚠ a story check that did not finish never reads as "no criteria open": the loop stops (review_failed), never clean', async () => {
    G.ticket = { ident: 'jira:x#PAY-1', ticket: { title: 'Refunds', description: null, acceptanceCriteria: '1. Refund a card', key: 'PAY-1', url: null } };
    const base = seams();
    L.setFixLoopSeamsForTests({
      ...base,
      runStoryCheck: async (_c, i) => {
        G.checks.push({ claims: i.claims, feature: i.feature, targets: [] });
        return { status: 'failed', failureReason: 'boom', assessment: null, claimVerdicts: null, model: null, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null } as any;
      },
    });
    const id = await builtFix({ reviewItems: [{ ref: 'S1-AC1', kind: 'story', title: 'Refund a card', path: null, line: null, findingId: null, threadId: null, ticketIndex: 0, included: true }] });
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true });
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopState: 'stopped', loopStop: 'review_failed', loopRound: 1 });
    expect(G.fixTurns).toEqual([]);
    expect(G.ended).toEqual(['review_failed']);
  });

  it('⚠ the spend gate refuses mid-loop: the loop STOPS (budget), never queued; the fix is kept as built', async () => {
    G.script.findings = () => [{ severity: 'blocker', path: 'a.ts', title: 'Broken' }];
    G.allowed = (feature) => feature !== 'ai_fix_loop_fix';
    const id = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: false });
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopState: 'stopped', loopStop: 'budget', patch: PATCH });
    expect(G.fixTurns).toEqual([]);
    expect(G.ended).toEqual(['budget']);
    expect(L.fixLoopActive(id)).toBe(false);
    // Refused before round 1 too: nothing runs at all.
    G.allowed = () => false;
    G.halves = [];
    const id2 = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id2, byReader: false });
    expect(await until(id2, ended, 'ended')).toMatchObject({ loopStop: 'budget' });
    expect(G.halves).toEqual([]);
  });

  it('Stop aborts a running review: stopped, the session’s end told so', async () => {
    G.hangReview = true;
    const id = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true });
    for (let i = 0; i < 200 && G.halves.length === 0; i++) await new Promise((res) => setTimeout(res, 5));
    expect(L.fixLoopBusyReason(id)).toBe('Wait for the review round to finish, or press Stop.');
    expect(await L.stopFixLoop(ctx, 1, id)).toBe(true);
    const r = await until(id, ended, 'stopped');
    expect(r).toMatchObject({ loopState: 'stopped', loopStop: 'stopped' });
    expect(G.ended).toEqual(['stopped']);
    expect(L.fixLoopActive(id)).toBe(false);
    expect(await L.stopFixLoop(ctx, 1, id)).toBe(false);
  });

  it('⚠ a Claude + Codex pair is ONE pass: both halves of a round at once, consolidated, one round counted', async () => {
    G.providers = ['claude', 'codex'];
    G.script.findings = (round) => (round === 1 ? [{ severity: 'warning', path: 'a.ts', title: 'Same point' }] : []);
    const id = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: false });
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopStop: 'clean', loopRound: 2 });
    expect(G.halves.map((h) => `${h.round}:${h.provider}`)).toEqual(['1:claude', '1:codex', '2:claude', '2:codex']);
    // ONE consolidation per round (the pair → one review).
    expect(G.consolidated).toBe(2);
    // Each automatic half asked the gate (the first for the round), plus the one fix turn.
    expect(G.gateAsks).toEqual(['ai_fix_loop_review', 'ai_fix_loop_review', 'ai_fix_loop_fix', 'ai_fix_loop_review', 'ai_fix_loop_review']);
    const wire = (await L.fixLoopWire(ctx, 1, r))!;
    expect(wire.history.map((h) => [h.step, h.providers, h.counts.found])).toEqual([
      [1, ['claude', 'codex'], 1],
      [2, ['claude', 'codex'], 0],
    ]);
    // The duplicate went into REVIEW.md once.
    expect((G.files[0].content.match(/^## F\d+$/gm) ?? []).length).toBe(1);
  });

  it('the merge item: the round reviews the CHECKED merge result, against the merge’s base commit', async () => {
    const merge = { baseRef: 'main', baseSha: 'a'.repeat(40), mergeBaseSha: 'c'.repeat(40), headSha: 'h'.repeat(40), conflictedFiles: ['x.ts'], status: 'valid', reason: null, mergeSha: 'd'.repeat(40), resultSha: 'e'.repeat(40), resolutionDiff: null, resolutionFiles: [] };
    const id = await builtFix({ merge });
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true });
    const r = await until(id, ended, 'ended');
    expect(r).toMatchObject({ loopStop: 'clean', loopBaseSha: 'a'.repeat(40) });
    expect(G.commits[0].merge).toMatchObject({ status: 'valid', resultSha: 'e'.repeat(40) });
    expect(G.halves[0].head.sha).toBe('e'.repeat(40));
    expect((await LP.listFixLoopReviews(ctx, 1, id))[0]!.workKey).toBe(`merge:${'e'.repeat(40)}`);
  });

  it('after the push: the CLOSING review becomes the PR’s AI review at the PUSHED head — only when it reviewed what was pushed', async () => {
    G.script.findings = (round) => (round === 1 ? [{ severity: 'warning', path: 'a.ts', title: 'Still open' }] : []);
    const id = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id, byReader: true });
    await until(id, ended, 'ended');
    const pushed = 'f'.repeat(40);
    const imported = await L.importLoopReviewAfterPush(ctx, { accountId: 1, fixId: id, repoId, prNumber: 7, pushedSha: pushed });
    expect(imported).not.toBeNull();
    const { and, eq } = await import('drizzle-orm');
    const cr = await db.select().from(schema.claudeReviews).where(and(eq(schema.claudeReviews.prId, prId), eq(schema.claudeReviews.headSha, pushed))).execute();
    expect(cr).toHaveLength(1);
    expect(cr[0]).toMatchObject({ id: imported, status: 'succeeded', trigger: 'manual', postedAt: null, kind: null });
    expect(cr[0].summary).toContain("Reviewed in Ensemble's AI fix before it was pushed (round 2).");
    expect((await row(id)).loopReviewId).toBe(imported);
    await db.update(schema.aiFixes).set({ pushedAt: new Date(), pushedCommitSha: pushed }).where(eq(schema.aiFixes.id, id)).execute();
    expect(await L.headReviewedByFixLoop(ctx, 1, prId, pushed)).toBe(true);
    expect(await L.headReviewedByFixLoop(ctx, 1, prId, 'x'.repeat(40))).toBe(false);
    // The work changed after the last review (a stopped loop, a later turn): nothing is imported.
    const id2 = await builtFix();
    await L.startFixLoop(ctx, { accountId: 1, fixId: id2, byReader: true });
    await until(id2, ended, 'ended');
    await db.update(schema.aiFixes).set({ patch: 'diff --git a/z b/z\n+late\n' }).where(eq(schema.aiFixes.id, id2)).execute();
    expect(await L.importLoopReviewAfterPush(ctx, { accountId: 1, fixId: id2, repoId, prNumber: 7, pushedSha: 'g'.repeat(40) })).toBeNull();
  });

  it('restart: a working loop is stopped (interrupted), its running runs cancelled; the refs keeper keeps only resumable fixes', async () => {
    const id = await builtFix();
    await LP.setFixLoop(ctx, 1, id, { loopState: 'reviewing', loopRound: 1, loopFirstRound: 1, loopRounds: 3 });
    await LP.insertFixLoopReview(ctx, 1, { fixId: id, round: 1, repoId, baseSha: 'b'.repeat(40), headSha: '1'.repeat(40), localRef: null, workKey: null, provider: 'claude', pairRole: null, step: 1, rounds: 3, status: 'running' });
    expect(await L.reconcileFixLoopsOnStartup(ctx)).toBe(1);
    expect(await row(id)).toMatchObject({ loopState: 'stopped', loopStop: 'interrupted' });
    expect((await LP.listFixLoopReviews(ctx, 1, id))[0]).toMatchObject({ status: 'cancelled' });
    // The keeper (registered before the boot sweep): built and unpushed ⇒ kept; pushed / discarded ⇒ swept.
    let keeper: ((ids: readonly number[]) => Promise<ReadonlySet<number>>) | null = null;
    L.registerFixLoopRefKeeper(ctx, (_kind, k) => void (keeper = k));
    const pushedId = await builtFix();
    const { eq } = await import('drizzle-orm');
    await db.update(schema.aiFixes).set({ pushedAt: new Date() }).where(eq(schema.aiFixes.id, pushedId)).execute();
    const discarded = await builtFix();
    await db.update(schema.aiFixes).set({ sessionPhase: 'discarded' }).where(eq(schema.aiFixes.id, discarded)).execute();
    const kept = await keeper!([id, pushedId, discarded, 99_999]);
    expect([...kept]).toEqual([id]);
  });
});

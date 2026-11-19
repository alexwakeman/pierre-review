// REVIEW A LOCAL BRANCH — THE SERVER (local-review/run.ts + routes.ts) over the REAL core client (a scratch SQLite,
// migrations applied) with FAKE seams: the intake, the review halves, the story check, the ticket. Pinned here:
//   • the start body is checked (shape, size cap) and the repository mapped: an untracked or unsynced one refused;
//   • one provider ⇒ one review, its findings stored; a reader's click: `byReader`, the local review's features,
//     the reader's effort, the head a LOCAL ref; the refs held while running, dropped after;
//   • a Claude + Codex pair ⇒ both halves AT ONCE, consolidated into ONE review (a duplicate merged, raised by both);
//   • the story check beside it (a ticket from the subjects with the allowlist); `check_story` runs it alone;
//     without a ticket a plain note;
//   • follow-up answers: F<id> on the findings (the next prior carries the reply), AC<n> cannot_meet stays NOT MET
//     with its reason; an unknown ref is ignored, said so;
//   • ONE run in flight per branch (the second start reads the running id); cancel; a refused bundle;
//   • NOTHING ELSE: no claude_reviews / ticket_reviews / team-claim row, auto fix and auto-post never reached;
//   • the restart rule and the refs' keeper.
import { rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalReview, TicketAssessment } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-local-review-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const autoFix = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../coding/ai-fix/auto-fix.js', () => ({ maybeStartAutoFix: () => void (autoFix.calls += 1) }));
vi.mock('../review/claude-review/auto-post.js', () => ({ maybeAutoPostReview: () => void (autoFix.calls += 1) }));
vi.mock('../review/ticket-review/auto-post.js', () => ({ maybeAutoPostTicketReview: () => void (autoFix.calls += 1) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let R: typeof import('./run.js');
let app: FastifyInstance;
let wsId = 0;
let repoId = 0;

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const HEAD2 = 'd'.repeat(40);
const bundle = Buffer.from('# v2 git bundle\n\nPACK').toString('base64');

const G = {
  providers: ['claude'] as string[],
  halves: [] as any[],
  checks: [] as any[],
  consolidated: 0,
  intakes: [] as any[],
  holds: [] as number[],
  released: [] as number[],
  dropped: [] as number[],
  hang: false,
  intakeError: null as Error | null,
  intakeGate: null as Promise<void> | null,
  findings: (_n: number, _p: string): Array<{ title: string; severity: string; priorFindingId?: number | null }> => [],
  criteria: [] as TicketAssessment['criteria'],
  ticket: true,
};

const criterion = (ref: string, status: string, text: string): TicketAssessment['criteria'][number] =>
  ({ ref, index: Number(ref.slice(2)) - 1, text, status, explanation: status === 'met' ? 'Done.' : 'Not done.', deliveredBy: [], evidence: [], expectedIn: null }) as any;

function seams(): Partial<import('./run.js').LocalReviewSeams> {
  return {
    now: () => new Date(),
    token: async () => null,
    intake: async (a) => {
      G.intakes.push(a);
      if (G.intakeGate) await G.intakeGate;
      if (G.intakeError) throw G.intakeError;
    },
    intakeWaitMs: 200,
    whyNoProvider: async (_c, choice, kind) => `No ${choice ?? 'default'} for ${kind}.`,
    holdRefs: (id) => {
      G.holds.push(id);
      return () => void G.released.push(id);
    },
    dropRefs: async (_o, _n, id) => void G.dropped.push(id),
    providers: async (_c, choice) => (choice ? [choice] : (G.providers as any)),
    storyProvider: async () => 'claude',
    allowKeys: async () => ['PAY'],
    ticket: async (_c, _a, _w, key) =>
      G.ticket ? { ident: `jira:https://x.atlassian.net:${key}`, key, title: 'Refunds', url: null, ticket: { title: 'Refunds', description: 'd', acceptanceCriteria: '1. a\n2. b' } } : { note: `Ensemble could not read ${key} from the tracker.` },
    runHalf: async (_c, i) => {
      const n = G.halves.length + 1;
      G.halves.push(i);
      if (G.hang) {
        await new Promise<void>((resolve) => i.abort.signal.addEventListener('abort', () => resolve()));
        return { status: 'cancelled', failureReason: null, reviewMode: null, summary: null, verdict: null, findings: [], followUp: null, ranOn: { provider: i.provider, model: null, effort: null }, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null };
      }
      const fs = G.findings(n, i.provider);
      return {
        status: 'succeeded',
        failureReason: null,
        reviewMode: 'diff_only',
        summary: `Review by ${i.provider}.`,
        verdict: fs.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE',
        findings: fs.map((f) => ({ path: 'src/a.ts', line: 3, side: 'RIGHT', severity: f.severity as any, title: f.title, body: 'Why.', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, priorFindingId: f.priorFindingId ?? null, lens: null })),
        followUp: i.prior ? { priorReviewId: i.prior.reviewId, priorHeadSha: i.prior.headSha, headMoved: true, changesSinceShown: false, items: i.prior.findings.map((f: any) => ({ ref: 'P1', priorFindingId: f.id, sent: true, carried: false, status: 'addressed', explanation: 'Fixed.', path: f.path, line: f.line, side: 'RIGHT', severity: f.severity, title: f.title })) } : null,
        ranOn: { provider: i.provider, model: 'm', effort: i.effort ?? 'medium' },
        costUsd: 0.25,
        inputTokens: 10,
        outputTokens: 5,
        numTurns: 1,
      } as any;
    },
    runStoryCheck: async (_c, i) => {
      G.checks.push(i);
      return { status: 'succeeded', failureReason: null, assessment: { alignment: 'partly_aligned', summary: 'Partly.', criteria: G.criteria, missing: [], notRequested: [] }, claimVerdicts: [], model: 'm', costUsd: 0.1, inputTokens: 1, outputTokens: 1, numTurns: 1 } as any;
    },
    consolidate: async (_c, _a, a, b) => {
      G.consolidated += 1;
      const mergedFrom: Record<string, number> = {};
      const sourceOf: Record<string, 'both'> = {};
      for (const f of b.findings) {
        const same = a.findings.find((x) => x.title === f.title);
        if (same) {
          mergedFrom[String(f.id)] = same.id;
          sourceOf[String(same.id)] = 'both';
        }
      }
      return { summary: 'Both agree.', verdict: a.verdict, how: 'code', sourceOf, mergedFrom };
    },
  };
}

const startBody = (over: Record<string, unknown> = {}) => ({
  owner: 'Acme',
  name: 'API',
  branch: 'feature/refunds',
  baseRef: 'origin/main',
  baseSha: BASE,
  headSha: HEAD,
  bundle,
  subjects: ['PAY-142 add refunds'],
  includeUncommitted: true,
  uncommittedChanges: false,
  kind: 'review',
  ...over,
});

async function start(over: Record<string, unknown> = {}): Promise<any> {
  const res = await app.inject({ method: 'POST', url: '/api/local-reviews', payload: startBody(over) });
  return { status: res.statusCode, body: res.json() };
}

async function finished(id: number): Promise<LocalReview> {
  await R._localReviewsIdleForTest();
  const res = await app.inject({ method: 'GET', url: `/api/local-reviews/${id}` });
  return res.json();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../db/queries.js');
  for (const acct of [1, 2]) await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
  wsId = await ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-api', owner: 'acme', name: 'api', defaultBranch: 'main' }).returning().execute();
  repoId = r.id;
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: wsId, repoId }).onConflictDoNothing().execute();
  await db.insert(schema.syncState).values({ repoId, lastFullSyncAt: new Date() }).execute();
  const [u] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-new', owner: 'acme', name: 'new' }).returning().execute();
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: wsId, repoId: u.id }).onConflictDoNothing().execute();
  ctx = { db, schema, runTransaction: client.runTransaction, log: { warn: () => {}, info: () => {}, error: () => {} }, accountIdOf: () => 1 };
  R = await import('./run.js');
  R.setLocalReviewSeamsForTests(seams());
  const { registerLocalReviewRoutes } = await import('./routes.js');
  app = Fastify();
  registerLocalReviewRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  R?.setLocalReviewSeamsForTests(null);
  R?._resetLocalReviewsForTest();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  await R._localReviewsIdleForTest();
  R._resetLocalReviewsForTest();
  Object.assign(G, { providers: ['claude'], halves: [], checks: [], consolidated: 0, intakes: [], holds: [], released: [], dropped: [], hang: false, intakeError: null, intakeGate: null, findings: () => [], criteria: [], ticket: true });
  await db.delete(schema.localReviewFindings).execute();
  await db.delete(schema.localReviews).execute();
});

describe('the start', () => {
  it('checks the body: shape, the size cap, a branch name', async () => {
    const { parseStartBody } = await import('./routes.js');
    expect(parseStartBody({ ...startBody(), owner: '../x' })).toBe('Send the repository as owner and name.');
    expect(parseStartBody({ ...startBody(), branch: 'a..b' })).toBe('Send the branch name.');
    expect(parseStartBody({ ...startBody(), headSha: 'nope' })).toBe('Send the base and head as commit ids.');
    expect(parseStartBody({ ...startBody(), bundle: '' })).toBe('Send the branch as a git bundle (base64).');
    expect(parseStartBody({ ...startBody(), effort: 'ultra' })).toMatch(/^The effort must be one of/);
    const { LOCAL_REVIEW_BUNDLE_MAX_BYTES } = await import('@pierre-review/shared');
    expect(parseStartBody({ ...startBody(), bundle: Buffer.alloc(LOCAL_REVIEW_BUNDLE_MAX_BYTES + 1).toString('base64') })).toBe('The bundle is larger than 25 MB.');
    // No path is ever taken: an unknown field is ignored, never read.
    const ok = parseStartBody({ ...startBody(), path: '/etc' });
    expect(typeof ok).toBe('object');
    expect(Object.keys(ok as object)).not.toContain('path');
  });

  it('maps origin owner/name to a SYNCED repository (any case), and refuses the rest in one line', async () => {
    const a = await start({ owner: 'nobody', name: 'x' });
    expect(a).toEqual({ status: 422, body: { error: 'not_tracked', message: 'Ensemble does not track nobody/x. Add it to a workspace in Ensemble first.' } });
    const b = await start({ owner: 'acme', name: 'new' });
    expect(b.body.error).toBe('not_synced');
    G.providers = [];
    const c = await start();
    // The pre-flight's own reason (switched off, not signed in, over the limit …), never a fixed "not signed in".
    expect(c.body).toEqual({ error: 'no_reviewer', message: 'No default for review.' });
    expect(await db.select().from(schema.localReviews).execute()).toEqual([]);
  });

  it('a refused bundle fails the run with the plain line and frees the branch', async () => {
    G.intakeError = Object.assign(new Error('The upload is not a git bundle.'), { name: 'BundleRefusedError' });
    const r = await start();
    expect(r).toEqual({ status: 422, body: { error: 'bad_bundle', message: 'The upload is not a git bundle.' } });
    const [row] = await db.select().from(schema.localReviews).execute();
    expect(row).toMatchObject({ status: 'failed', failureReason: 'The upload is not a git bundle.' });
    expect(G.released).toEqual([row.id]);
    expect(G.dropped).toEqual([row.id]);
    G.intakeError = null;
    expect((await start()).status).toBe(200);
  });
});

describe('a slow intake, a cancel, a failure after the claim', () => {
  it('a start answers with the id after intakeWaitMs; a refusal then FAILS the run (read with get) and frees the branch', async () => {
    let open!: () => void;
    G.intakeGate = new Promise<void>((r) => (open = r));
    G.intakeError = Object.assign(new Error('The upload is not a git bundle.'), { name: 'BundleRefusedError' });
    const r = await start();
    expect(r.body).toMatchObject({ status: 'running', alreadyRunning: false });
    open();
    const out = await finished(r.body.id);
    expect(out).toMatchObject({ status: 'failed', failureReason: 'The upload is not a git bundle.' });
    expect(G.halves).toEqual([]);
    expect(G.released).toEqual([r.body.id]);
    expect(G.dropped).toEqual([r.body.id]);
    G.intakeError = null;
    G.intakeGate = null;
    expect((await start()).body.alreadyRunning).toBe(false);
  });

  it('a cancel during the intake stops the start: no answers written, no ticket read, no review', async () => {
    G.criteria = [criterion('AC1', 'met', 'a')];
    G.findings = (n) => (n === 1 ? [{ title: 'Null check', severity: 'warning' }] : []);
    const first = await finished((await start()).body.id);
    const fid = first.review!.findings[0]!.id;
    const halvesBefore = G.halves.length;
    const checksBefore = G.checks.length;
    let open!: () => void;
    G.intakeGate = new Promise<void>((r) => (open = r));
    const r = await start({ headSha: HEAD2, answers: [{ ref: `F${fid}`, action: 'fixed', reply: 'Done.' }] });
    expect(r.body.status).toBe('running');
    const c = await app.inject({ method: 'POST', url: `/api/local-reviews/${r.body.id}/cancel` });
    expect(c.json()).toMatchObject({ cancelled: true });
    open();
    const out = await finished(r.body.id);
    expect(out.status).toBe('cancelled');
    expect(G.halves.length).toBe(halvesBefore);
    expect(G.checks.length).toBe(checksBefore);
    const [f] = await db.select().from(schema.localReviewFindings).execute();
    expect(f.response ?? null).toBeNull();
    expect(G.released).toContain(r.body.id);
    expect(G.dropped).toContain(r.body.id);
  });

  it('a throw after the claim (the row write) fails the run and frees the branch — never a stuck "running"', async () => {
    const { sql } = await import('drizzle-orm');
    db.run(sql.raw(`CREATE TEMP TRIGGER boom BEFORE UPDATE OF local_ref ON local_reviews WHEN NEW.local_ref IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`));
    try {
      const r = await start();
      const out = await finished(r.body.id);
      expect(out.status).toBe('failed');
      expect(out.failureReason).toMatch(/^Ensemble could not start the review: /);
      expect(G.released).toEqual([r.body.id]);
      expect(G.dropped).toEqual([r.body.id]);
      const t0 = Date.now();
      await app.inject({ method: 'GET', url: `/api/local-reviews/${r.body.id}?waitMs=5000` });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      db.run(sql.raw('DROP TRIGGER IF EXISTS boom'));
    }
    expect((await start()).body.alreadyRunning).toBe(false);
  });

  it("the answers' problems name answers[n] and the open refs, never REVIEW.md or items", () => {
    expect(R.localAnswerProblems(['"items"[0].ref "F9" is not an item in REVIEW.md.', '"items"[1].reply must say what you did, or why.', 'F3 has no answer.'], ['F3'])).toEqual([
      'answers[0]: "F9" is not an open finding or criterion of the last review of this branch. The open ones are F3.',
      'answers[1].reply must say what you did, or why.',
    ]);
    expect(R.localAnswerProblems(['"items" must be a list of at most 500 entries.'], [])).toEqual(['"answers" must be a list of at most 500 entries.']);
  });
});

describe('the run', () => {
  it('one provider: one review, a reader’s click, the reader’s effort, a LOCAL head; refs held then dropped', async () => {
    G.findings = () => [{ title: 'Null check', severity: 'warning' }, { title: 'Nice', severity: 'praise' }];
    const r = await start({ effort: 'high' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'running', alreadyRunning: false, ignoredAnswers: [] });
    const out = await finished(r.body.id);
    expect(out.status).toBe('succeeded');
    expect(out.repo).toBe('acme/api');
    expect(out.review?.findings.map((f) => [f.title, f.severity, f.file, f.raisedBy])).toEqual([['Null check', 'warning', 'src/a.ts', ['claude']]]);
    expect(out.review?.reviewers).toEqual([{ provider: 'claude', model: 'm', effort: 'high', status: 'succeeded', failureReason: null }]);
    const h = G.halves[0];
    expect(h).toMatchObject({ byReader: true, feature: 'local_review', ledgerFeature: 'local_review', effort: 'high', baseSha: BASE, branch: 'feature/refunds' });
    expect(h.head).toEqual({ localRef: `refs/pierre/local/local-review/${r.body.id}/head`, sha: HEAD });
    expect(G.intakes[0]).toMatchObject({ owner: 'acme', name: 'api', destRef: h.head.localRef });
    expect(G.holds).toEqual([r.body.id]);
    expect(G.released).toEqual([r.body.id]);
    expect(G.dropped).toEqual([r.body.id]);
    const [row] = await db.select().from(schema.localReviews).execute();
    expect(row.costUsd).toBeCloseTo(0.35);
  });

  it('a Claude + Codex pair runs AT ONCE and is ONE consolidated review', async () => {
    G.providers = ['claude', 'codex'];
    G.findings = (_n, p) => (p === 'claude' ? [{ title: 'Null check', severity: 'warning' }] : [{ title: 'Null check', severity: 'warning' }, { title: 'Leak', severity: 'nit' }]);
    const r = await start();
    const out = await finished(r.body.id);
    expect(G.halves.map((h) => h.provider)).toEqual(['claude', 'codex']);
    expect(G.consolidated).toBe(1);
    expect(out.review?.summary).toBe('Both agree.');
    expect(out.review?.findings.map((f) => [f.title, f.raisedBy])).toEqual([
      ['Null check', ['claude', 'codex']],
      ['Leak', ['codex']],
    ]);
    expect(out.review?.reviewers.map((x) => x.provider)).toEqual(['claude', 'codex']);
  });

  it('runs the story check beside the review (ticket from the subjects), and check_story alone', async () => {
    G.criteria = [criterion('AC1', 'met', 'a'), criterion('AC2', 'not_met', 'b')];
    const r = await start();
    const out = await finished(r.body.id);
    expect(out.ticket).toEqual({ key: 'PAY-142', title: 'Refunds', url: null });
    expect(G.checks[0]).toMatchObject({ feature: 'local_review_check', ident: 'jira:https://x.atlassian.net:PAY-142' });
    expect(G.checks[0].targets[0].head.localRef).toBe(`refs/pierre/local/local-review/${r.body.id}/head`);
    expect(out.storyCheck?.open).toBe(1);
    expect(out.storyCheck?.criteria.map((c) => [c.ref, c.status, c.open])).toEqual([
      ['AC1', 'met', false],
      ['AC2', 'not_met', true],
    ]);
    const before = G.halves.length;
    const s = await start({ kind: 'story', headSha: HEAD2 });
    const story = await finished(s.body.id);
    expect(story.kind).toBe('story');
    expect(story.review).toBeNull();
    expect(G.halves.length).toBe(before);
    expect(story.storyCheck?.status).toBe('succeeded');
  });

  it('says why there is no story check, and a story-only run without a ticket fails with it', async () => {
    const r = await start({ subjects: ['wip'] });
    const out = await finished(r.body.id);
    expect(out.status).toBe('succeeded');
    expect(out.storyCheck).toBeNull();
    expect(out.ticketNote).toBe('No ticket found in the branch name or the commit subjects. Pass the ticket (for example PAY-142) to check the story.');
    const s = await start({ subjects: ['wip'], kind: 'story', headSha: HEAD2 });
    const story = await finished(s.body.id);
    expect(story).toMatchObject({ status: 'failed', failureReason: out.ticketNote });
    expect(R.detectTicketKey('pay-142-x', ['wip'], null)).toBeNull();
    expect(R.detectTicketKey('pay-142-x', ['wip'], ['PAY'])).toBe('PAY-142');
    expect(R.detectTicketKey('x', ['Fix PAY-9 now'], null)).toBe('PAY-9');
  });

  it('follow-up: answers land on the findings and the criteria; cannot_meet stays NOT MET; an unknown ref is ignored', async () => {
    G.criteria = [criterion('AC1', 'met', 'a'), criterion('AC2', 'not_met', 'b')];
    G.findings = (n) => (n === 1 ? [{ title: 'Null check', severity: 'warning' }] : []);
    const first = await finished((await start()).body.id);
    const fid = first.review!.findings[0]!.id;
    const r = await start({
      headSha: HEAD2,
      answers: [
        { ref: `F${fid}`, action: 'fixed', reply: 'Added the check.' },
        { ref: 'ac2', action: 'cannot_meet', reply: 'Needs the payments team.' },
        { ref: 'F999999', action: 'fixed', reply: 'x' },
      ],
    });
    expect(r.body.ignoredAnswers).toEqual([`answers[2]: "F999999" is not an open finding or criterion of the last review of this branch. The open ones are F${fid}, AC2.`]);
    const out = await finished(r.body.id);
    const prior = G.halves[1].prior;
    expect(prior.findings.map((f: any) => [f.id, f.thread?.replies[0]?.body])).toEqual([[fid, 'Fixed: Added the check.']]);
    expect(out.review?.followUp).toEqual([{ findingId: fid, status: 'addressed', explanation: 'Fixed.' }]);
    expect(G.checks[1].claims).toEqual([{ ref: 'AC2', kind: 'answer', text: 'Needs the payments team.' }]);
    expect(G.checks[1].prior.assessment.criteria.length).toBe(2);
    const ac2 = out.storyCheck!.criteria.find((c) => c.ref === 'AC2')!;
    expect(ac2).toMatchObject({ status: 'not_met', open: true, cannotMeet: 'Needs the payments team.' });
    expect(out.answers.map((a) => a.ref)).toEqual([`F${fid}`, 'AC2']);
  });

  it('ONE run in flight per branch: a second start gets the running id; cancel stops it; then a new one starts', async () => {
    G.hang = true;
    const a = await start();
    const b = await start({ headSha: HEAD2 });
    expect(b.body).toEqual({ id: a.body.id, status: 'running', alreadyRunning: true, ignoredAnswers: [] });
    // Answers sent to a branch that is already being reviewed are not used, and the start says so.
    const b2 = await start({ headSha: HEAD2, answers: [{ ref: 'F1', action: 'fixed', reply: 'x' }] });
    expect(b2.body.ignoredAnswers).toEqual([`A review of this branch is already running (id ${a.body.id}), so the answer was not used. Send it with the next review.`]);
    // Another branch is free.
    const other = await start({ branch: 'other' });
    expect(other.body.alreadyRunning).toBe(false);
    const wait = app.inject({ method: 'GET', url: `/api/local-reviews/${a.body.id}?waitMs=5000` });
    const c = await app.inject({ method: 'POST', url: `/api/local-reviews/${a.body.id}/cancel` });
    expect(c.json()).toMatchObject({ cancelled: true, review: { status: 'cancelled' } });
    expect((await wait).json().status).toBe('cancelled');
    await app.inject({ method: 'POST', url: `/api/local-reviews/${other.body.id}/cancel` });
    G.hang = false;
    await R._localReviewsIdleForTest();
    const again = await start({ headSha: HEAD2 });
    expect(again.body.alreadyRunning).toBe(false);
    expect((await finished(again.body.id)).status).toBe('succeeded');
  });

  it('lists the branch’s runs, and reads nothing of another account', async () => {
    const r = await start();
    await finished(r.body.id);
    const l = await app.inject({ method: 'GET', url: '/api/local-reviews?owner=acme&name=api&branch=feature/refunds' });
    expect(l.json()).toMatchObject({ repo: 'acme/api', branch: 'feature/refunds', reviews: [{ id: r.body.id, kind: 'review', status: 'succeeded' }] });
    const { getLocalReview } = await import('./persist.js');
    expect(await getLocalReview(ctx, 2, r.body.id)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/local-reviews/999999' })).statusCode).toBe(404);
  });
});

describe('nothing else happens', () => {
  it('no claude_reviews, ticket_reviews or team-claim row; auto fix and auto-post never reached', async () => {
    G.providers = ['claude', 'codex'];
    G.criteria = [criterion('AC1', 'not_met', 'a')];
    G.findings = () => [{ title: 'Bug', severity: 'blocker' }];
    await finished((await start()).body.id);
    expect(await db.select().from(schema.claudeReviews).execute()).toEqual([]);
    expect(await db.select().from(schema.ticketReviews).execute()).toEqual([]);
    expect(await db.select().from(schema.teamClaimLines).execute()).toEqual([]);
    expect(await db.select().from(schema.aiFixes).execute()).toEqual([]);
    expect(autoFix.calls).toBe(0);
  });
});

describe('restarts and the refs', () => {
  it('a running row a restart cut off is failed; the keeper keeps only running rows', async () => {
    G.hang = true;
    const r = await start();
    const { runningLocalReviewIds } = await import('./persist.js');
    expect([...(await runningLocalReviewIds(ctx, [r.body.id, 424242]))]).toEqual([r.body.id]);
    R._resetLocalReviewsForTest();
    await R.reconcileLocalReviewsOnStartup(ctx);
    const [row] = await db.select().from(schema.localReviews).execute();
    expect(row).toMatchObject({ status: 'failed', failureReason: 'Ensemble restarted before the review finished. Start it again.' });
    expect([...(await runningLocalReviewIds(ctx, [r.body.id]))]).toEqual([]);
    G.hang = false;
  });
});

// TEAM CLAIMS (team-claim.ts; docs/CLAUDE-REVIEW.md § Team claims) — the pure fold, the line
// wording, and the lifecycle over a THROWAWAY sqlite DB with GitHub faked (no live writes).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import {
  TEAM_CLAIM_DESCRIPTION_MAX,
  TEAM_CLAIM_LEASE_MS,
  clearedLine,
  decideTeamClaim,
  postedReviewUrl,
  releasedLine,
  reviewedLine,
  staleTeammateLine,
  reviewingLine,
  teamClaimContext,
  unfinishedLine,
  type TeamClaimGithub,
  type TeamClaimLine,
  type TeamClaimPost,
} from './team-claim.js';

const DIR = mkdtempSync(join(tmpdir(), 'limn-team-claim-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
let nextId = 1;
const line = (login: string | null, state: string, atMs: number, description = `${login} is reviewing with Claude`): TeamClaimLine => ({
  id: nextId++,
  state,
  description,
  createdAtMs: atMs,
  login,
});

describe('wording', () => {
  it('names the login, says the fact, stays within 140 characters', () => {
    expect(teamClaimContext('claude')).toBe('limn/review-claude');
    expect(teamClaimContext('codex')).toBe('limn/review-codex');
    expect(reviewingLine('alex', 'claude')).toBe('alex is reviewing with Claude');
    expect(reviewingLine('alex', 'codex')).toBe('alex is reviewing with Codex');
    expect(reviewedLine('alex', 4)).toBe('alex reviewed · 4 comments');
    expect(reviewedLine('alex', 1)).toBe('alex reviewed · 1 comment');
    expect(reviewedLine('alex', 0)).toBe('alex reviewed · no comments');
    expect(reviewedLine('alex', null)).toBe('alex reviewed · kept in Limn');
    expect(unfinishedLine('alex')).toBe("alex's review didn't finish · free to claim");
    expect(clearedLine('alex')).toBe('Cleared by alex');
    expect(releasedLine('bob')).toBe("Released: bob's claim expired");
    expect(reviewingLine('x'.repeat(300), 'claude').length).toBe(TEAM_CLAIM_DESCRIPTION_MAX);
  });
  it('builds the posted review link only from well-formed values', () => {
    expect(postedReviewUrl('acme', 'api', 7, '123')).toBe('https://github.com/acme/api/pull/7#pullrequestreview-123');
    expect(postedReviewUrl('acme', 'api', 7, null)).toBeNull();
    expect(postedReviewUrl('acme', 'api', 7, '12x')).toBeNull();
    expect(postedReviewUrl('ac/me', 'api', 7, '1')).toBeNull();
  });
});

describe('decideTeamClaim (the one fold)', () => {
  it('no history is free', () => {
    expect(decideTeamClaim([], 'me', NOW)).toEqual({ kind: 'free' });
  });
  it("someone else's success is 'already reviewed'; mine, or a Clear, is free", () => {
    expect(decideTeamClaim([line('bob', 'pending', NOW - 20 * MIN), line('bob', 'success', NOW - 5 * MIN, 'bob reviewed · 2 comments')], 'me', NOW)).toEqual({
      kind: 'reviewed',
      login: 'bob',
      atMs: NOW - 5 * MIN,
    });
    expect(decideTeamClaim([line('me', 'success', NOW - 5 * MIN, 'me reviewed · kept in Limn')], 'me', NOW).kind).toBe('free');
    expect(decideTeamClaim([line('bob', 'success', NOW - 9 * MIN, 'bob reviewed'), line('carol', 'success', NOW - MIN, 'Cleared by carol')], 'me', NOW).kind).toBe(
      'free',
    );
  });
  it("a teammate's pending line inside the lease holds the head; past it, or marked free, it does not", () => {
    expect(decideTeamClaim([line('bob', 'pending', NOW - 10 * MIN)], 'me', NOW)).toMatchObject({ kind: 'reviewing', login: 'bob' });
    expect(decideTeamClaim([line('bob', 'pending', NOW - TEAM_CLAIM_LEASE_MS - MIN)], 'me', NOW).kind).toBe('free');
    expect(decideTeamClaim([line('bob', 'pending', NOW - MIN, "bob's review didn't finish · free to claim")], 'me', NOW).kind).toBe('free');
  });
  it('the lease runs from the claimant’s NEWEST line (renewals keep it)', () => {
    const d = decideTeamClaim([line('bob', 'pending', NOW - 40 * MIN), line('bob', 'pending', NOW - 8 * MIN)], 'me', NOW);
    expect(d).toMatchObject({ kind: 'reviewing', login: 'bob', leaseEndsAtMs: NOW - 8 * MIN + TEAM_CLAIM_LEASE_MS });
  });
  it('a race: the EARLIEST live claimant wins, whoever posted last', () => {
    const lines = [line('bob', 'pending', NOW - 2 * MIN), line('me', 'pending', NOW - MIN, 'me is reviewing with Claude')];
    expect(decideTeamClaim(lines, 'me', NOW)).toMatchObject({ kind: 'reviewing', login: 'bob' });
    expect(decideTeamClaim(lines, 'bob', NOW).kind).toBe('mine');
    // Same second: the lower id wins.
    const tie = [line('carol', 'pending', NOW - MIN), line('me', 'pending', NOW - MIN)];
    expect(decideTeamClaim(tie, 'me', NOW)).toMatchObject({ kind: 'reviewing', login: 'carol' });
  });
  it('only the race since the last settling line counts', () => {
    const lines = [
      line('bob', 'pending', NOW - 20 * MIN),
      line('bob', 'pending', NOW - 15 * MIN, "bob's review didn't finish · free to claim"),
      line('me', 'pending', NOW - MIN),
    ];
    expect(decideTeamClaim(lines, 'me', NOW).kind).toBe('mine');
  });
  it('a SUCCESS "free to claim" line (the release, since 2026-10-28) is free, not "already reviewed"', () => {
    expect(decideTeamClaim([line('bob', 'pending', NOW - 9 * MIN), line('bob', 'success', NOW - MIN, unfinishedLine('bob'))], 'me', NOW).kind).toBe('free');
    expect(decideTeamClaim([line('bob', 'pending', NOW - 40 * MIN), line('me', 'success', NOW - MIN, releasedLine('bob'))], 'carol', NOW).kind).toBe(
      'free',
    );
    // A plain success by someone else still reads "already reviewed".
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, 'bob reviewed · no comments')], 'me', NOW).kind).toBe('reviewed');
  });
  it("staleTeammateLine: a teammate's expired or pending-free newest line; never a live one, a settled one or mine", () => {
    expect(staleTeammateLine([line('bob', 'pending', NOW - TEAM_CLAIM_LEASE_MS - MIN)], 'me', NOW)).toEqual({ login: 'bob' });
    expect(staleTeammateLine([line('bob', 'pending', NOW - MIN, "bob's review didn't finish · free to claim")], 'me', NOW)).toEqual({ login: 'bob' });
    expect(staleTeammateLine([line('bob', 'pending', NOW - MIN)], 'me', NOW)).toBeNull();
    expect(staleTeammateLine([line('me', 'pending', NOW - TEAM_CLAIM_LEASE_MS - MIN)], 'me', NOW)).toBeNull();
    expect(staleTeammateLine([line('bob', 'pending', NOW - 40 * MIN), line('bob', 'success', NOW - 30 * MIN, 'bob reviewed')], 'me', NOW)).toBeNull();
    expect(staleTeammateLine([], 'me', NOW)).toBeNull();
  });
  it('a failure or error line (never Limn’s own) is free', () => {
    expect(decideTeamClaim([line('bob', 'error', NOW - MIN)], 'me', NOW).kind).toBe('free');
  });
});

// ---- the lifecycle, over a real DB ----

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let tc: typeof import('./team-claim.js');
let settings: typeof import('./auto-settings.js');
let ctx: AgentContext;
let workspaceId = 0;
let prId = 0;
let reviewId = 0;

/** A fake GitHub: one in-memory status list per context; optional failures. */
function fakeGh(opts: { readFails?: unknown; postFails?: unknown; login?: string } = {}) {
  const lines: Record<string, TeamClaimLine[]> = {};
  const posts: Array<{ context: string } & TeamClaimPost> = [];
  let clock = NOW;
  let id = 1000;
  const gh: TeamClaimGithub = {
    async listLines(_a, _o, _n, _sha, context) {
      if (opts.readFails) throw opts.readFails;
      return [...(lines[context] ?? [])].reverse();
    },
    async postLine(_a, _o, _n, _sha, context, post) {
      if (opts.postFails) throw opts.postFails;
      posts.push({ context, ...post });
      (lines[context] ??= []).push({ id: id++, state: post.state, description: post.description, createdAtMs: clock, login: opts.login ?? 'me' });
    },
    async login() {
      return opts.login ?? 'me';
    },
  };
  return {
    gh,
    posts,
    seed: (context: string, l: TeamClaimLine) => (lines[context] ??= []).push(l),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** One ledger row (`team_claim_lines`). */
async function ledgerRow(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(schema.teamClaimLines).where(eq(schema.teamClaimLines.id, id)).execute();
  return row ?? null;
}

const target = () => ({ accountId: 1, prId, owner: 'acme', name: 'api', number: 7, headSha: 'head1', provider: 'claude' as const });

beforeAll(async () => {
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  tc = await import('./team-claim.js');
  settings = await import('./auto-settings.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'me' } })
    .execute();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_tc', createdAt: new Date(NOW - 86_400_000) })
    .returning()
    .execute();
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_tc',
      accountId: 1,
      repoId: repo.id,
      number: 7,
      title: 't',
      state: 'open',
      isDraft: false,
      headSha: 'head1',
      openedAt: new Date(NOW - 3_600_000),
      updatedAt: new Date(NOW - 3_600_000),
    })
    .returning()
    .execute();
  prId = p.id;
  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  const [r] = await db
    .insert(schema.claudeReviews)
    .values({ accountId: 1, prId, headSha: 'head1', status: 'running', model: 'm', provider: 'claude', trigger: 'auto' })
    .returning()
    .execute();
  reviewId = r.id;
  ctx = {
    db,
    schema,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  tc._resetTeamClaimsForTest();
  await db.delete(schema.teamClaimLines).execute();
});

describe('the workspace switch', () => {
  it('is OFF by default, and the one writer turns it on and off', async () => {
    expect((await settings.readWorkspaceAutoReview(ctx, 1, workspaceId))?.teamClaimsEnabled).toBe(false);
    const f = fakeGh();
    expect((await tc.claimBeforeAutoRun(ctx, target(), {}, f.gh)).kind).toBe('off');
    expect(f.posts).toEqual([]);
    const on = await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
    expect(on?.teamClaimsEnabled).toBe(true);
    expect((await settings.readWorkspaceAutoReview(ctx, 1, workspaceId))?.teamClaimsEnabled).toBe(true);
  });
});

describe('claimBeforeAutoRun', () => {
  beforeAll(async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
  });

  it('free ⇒ posts "<login> is reviewing with Claude" and runs, marked', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r.kind).toBe('run');
    if (r.kind !== 'run') return;
    expect(r.handle.marked).toBe(true);
    expect(r.handle.record).toMatchObject({ context: 'limn/review-claude', state: 'marked', lastLine: 'reviewing' });
    expect(f.posts).toEqual([{ context: 'limn/review-claude', state: 'pending', description: 'me is reviewing with Claude' }]);
  });

  it("a teammate's live claim ⇒ skip with NO line, remembered; the next try reads nothing until the lease ends", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', line('bob', 'pending', NOW - 5 * MIN));
    let reads = 0;
    const counting: TeamClaimGithub = { ...f.gh, listLines: async (...a) => (reads++, f.gh.listLines(...a)) };
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, counting);
    expect(r).toMatchObject({ kind: 'skip', skip: { kind: 'reviewing', login: 'bob', headSha: 'head1', provider: 'claude' } });
    expect(f.posts).toEqual([]);
    expect(tc.teamClaimSkipFor(1, prId, 'head1')).toMatchObject({ login: 'bob' });
    expect(tc.teamClaimSkipFor(1, prId, 'other-head')).toBeNull();
    expect(tc.teamClaimHeldHead(1, prId, NOW)).toBe('head1');
    await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW + MIN }, counting);
    expect(reads).toBe(1);
    // A reader's press reads GitHub afresh.
    await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW + MIN, pressed: true }, counting);
    expect(reads).toBe(2);
    // A different provider is not held by Claude's line.
    const codex = await tc.claimBeforeAutoRun(ctx, { ...target(), provider: 'codex' }, { nowMs: () => NOW }, f.gh);
    expect(codex.kind).toBe('run');
  });

  it("a teammate's finished review ⇒ skip 'already reviewed'", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', line('bob', 'success', NOW - 5 * MIN, 'bob reviewed · 3 comments'));
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r).toMatchObject({ kind: 'skip', skip: { kind: 'reviewed', login: 'bob' } });
  });

  it('lost race ⇒ stand down and re-post the winner’s line', async () => {
    const f = fakeGh();
    // bob claims in the same instant, earlier id — after our step-1 read saw nothing.
    let first = true;
    const racing: TeamClaimGithub = {
      ...f.gh,
      listLines: async (...a) => {
        if (!first) return f.gh.listLines(...a);
        first = false;
        const out = await f.gh.listLines(...a);
        f.seed('limn/review-claude', { id: 1, state: 'pending', description: 'bob is reviewing with Claude', createdAtMs: NOW, login: 'bob' });
        return out;
      },
    };
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, racing);
    expect(r).toMatchObject({ kind: 'skip', skip: { kind: 'reviewing', login: 'bob' } });
    expect(f.posts.map((p) => p.description)).toEqual(['me is reviewing with Claude', 'bob is reviewing with Claude']);
  });

  it('no write access ⇒ runs WITHOUT a line, never retries the write', async () => {
    const f = fakeGh({ postFails: Object.assign(new Error('403'), { status: 403 }) });
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r.kind).toBe('run');
    if (r.kind !== 'run') return;
    expect(r.handle.marked).toBe(false);
    expect(r.handle.record).toMatchObject({ state: 'unmarked', reason: 'no_access', lastLine: null });
    await tc.finishTeamClaim(ctx, r.handle, null, { kind: 'unfinished' }, f.gh);
    expect(f.posts).toEqual([]);
  });

  it('statuses unreadable ⇒ runs without a line (never blocks a run)', async () => {
    const f = fakeGh({ readFails: new Error('ECONNRESET') });
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r).toMatchObject({ kind: 'run', handle: { marked: false, record: { state: 'unmarked', reason: 'error' } } });
    expect(f.posts).toEqual([]);
  });
});

describe('finish and clear', () => {
  beforeAll(async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
  });

  it('success ⇒ "me reviewed · N comments" with the review link, recorded on the run row', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    await tc.finishTeamClaim(
      ctx,
      r.handle,
      reviewId,
      { kind: 'succeeded', comments: 2, reviewUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-9' },
      f.gh,
    );
    expect(f.posts.at(-1)).toEqual({
      context: 'limn/review-claude',
      state: 'success',
      description: 'me reviewed · 2 comments',
      targetUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-9',
    });
    const [row] = await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, reviewId)).execute();
    expect(row.teamClaim).toMatchObject({ state: 'marked', lastLine: 'reviewed' });
  });

  it('failure ⇒ a SUCCESS release line "didn\'t finish · free to claim" (never pending, never red); nothing left to Clear', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'unfinished' }, f.gh);
    expect(f.posts.at(-1)).toEqual({ context: 'limn/review-claude', state: 'success', description: "me's review didn't finish · free to claim" });
    // Another Limn reads that success line as FREE (not "already reviewed").
    expect(decideTeamClaim(await f.gh.listLines(1, 'acme', 'api', 'head1', 'limn/review-claude'), 'bob', NOW + MIN).kind).toBe('free');
    const row = await ledgerRow(r.handle.ledgerId!);
    expect(row).toMatchObject({ state: 'released', reviewId, login: 'me', provider: 'claude', headSha: 'head1' });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toBeNull();
  });

  it('a run that never finished (a restart) ⇒ Clear offers itself, posts "Cleared by me" and closes the ledger row', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    expect((await ledgerRow(r.handle.ledgerId!))?.state).toBe('pending');
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toEqual({ provider: 'claude', login: 'me', mine: true });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', true)).toBeNull();
    const res = await tc.clearTeamClaim(ctx, target(), f.gh);
    expect(res).toEqual({ ok: true });
    expect(f.posts.at(-1)).toMatchObject({ state: 'success', description: 'Cleared by me' });
    expect(await ledgerRow(r.handle.ledgerId!)).toMatchObject({ state: 'released', lastError: 'cleared' });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toBeNull();
  });

  it("Clear over a teammate's claim forgets the skip; a refused write says why", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', line('bob', 'pending', NOW - MIN));
    await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toEqual({ provider: 'claude', login: 'bob', mine: false });
    expect(await tc.clearTeamClaim(ctx, target(), f.gh)).toEqual({ ok: true });
    expect(tc.teamClaimSkipFor(1, prId, 'head1')).toBeNull();
    const refused = fakeGh({ postFails: Object.assign(new Error('404'), { status: 404 }) });
    expect(await tc.clearTeamClaim(ctx, target(), refused.gh)).toMatchObject({ ok: false, error: 'no_access' });
  });
});

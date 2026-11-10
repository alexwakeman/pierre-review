// TEAM CLAIMS (team-claim.ts; docs/CLAUDE-REVIEW.md § Team claims) — the pure fold, the line
// wording, and the lifecycle over a THROWAWAY sqlite DB with GitHub faked (no live writes).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
    expect(unfinishedLine('alex')).toBe("Cleared by alex: review didn't finish · free to claim");
    expect(clearedLine('alex')).toBe('Cleared by alex');
    expect(releasedLine('bob', 'alex')).toBe("Cleared by alex: bob's claim expired");
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
      description: 'bob reviewed · 2 comments',
    });
    expect(decideTeamClaim([line('me', 'success', NOW - 5 * MIN, 'me reviewed · kept in Limn')], 'me', NOW).kind).toBe('free');
    // A teammate's review kept in Limn put nothing on GitHub: it holds nothing.
    expect(decideTeamClaim([line('bob', 'success', NOW - 5 * MIN, 'bob reviewed · kept in Limn')], 'me', NOW).kind).toBe('free');
    expect(decideTeamClaim([line('bob', 'success', NOW - 5 * MIN, 'bob reviewed · no comments')], 'me', NOW).kind).toBe('reviewed');
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
    expect(decideTeamClaim([line('bob', 'pending', NOW - 40 * MIN), line('me', 'success', NOW - MIN, releasedLine('bob', 'me'))], 'carol', NOW).kind).toBe(
      'free',
    );
    // The 2026-10-28 build's wording still reads free.
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, "bob's review didn't finish · free to claim")], 'me', NOW).kind).toBe('free');
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, "Released: carol's claim expired")], 'me', NOW).kind).toBe('free');
    // A plain success by someone else still reads "already reviewed".
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, 'bob reviewed · no comments')], 'me', NOW).kind).toBe('reviewed');
  });
  it('a teammate on an OLDER Limn reads every free success line as free too (it reads only "Cleared by ")', () => {
    // The fold every Limn up to 0.1.140 runs: a success is free only when it starts "Cleared by ".
    const oldFoldFree = (description: string): boolean => description.startsWith('Cleared by ');
    expect(oldFoldFree(unfinishedLine('alex'))).toBe(true);
    expect(oldFoldFree(releasedLine('bob', 'alex'))).toBe(true);
    expect(oldFoldFree(clearedLine('alex'))).toBe(true);
    expect(oldFoldFree(unfinishedLine('x'.repeat(300)))).toBe(true);
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
  it("the PR AUTHOR's own lines never hold the head (reviewed or reviewing); a non-author teammate's still do", () => {
    const authorDone = [line('carol', 'success', NOW - 5 * MIN, 'carol reviewed · 2 comments')];
    const authorLive = [line('carol', 'pending', NOW - 5 * MIN)];
    expect(decideTeamClaim(authorDone, 'me', NOW).kind).toBe('reviewed'); // the contrast: no author known
    expect(decideTeamClaim(authorDone, 'me', NOW, 'carol')).toEqual({ kind: 'free' });
    expect(decideTeamClaim(authorLive, 'me', NOW, 'Carol')).toEqual({ kind: 'free' });
    // A non-author teammate's review behind the author's newer line still holds.
    expect(decideTeamClaim([line('bob', 'success', NOW - 9 * MIN, 'bob reviewed · 1 comment'), ...authorDone], 'me', NOW, 'carol')).toMatchObject({
      kind: 'reviewed',
      login: 'bob',
    });
    expect(decideTeamClaim([line('bob', 'pending', NOW - 2 * MIN), ...authorLive], 'me', NOW, 'carol')).toMatchObject({ kind: 'reviewing', login: 'bob' });
    // The reader IS the author: nothing is left out (their own lines are the race they are in).
    expect(decideTeamClaim([line('me', 'pending', NOW - 3 * MIN), line('bob', 'pending', NOW - 2 * MIN)], 'me', NOW, 'me').kind).toBe('mine');
    // staleTeammateLine never releases the author's LIVE line.
    expect(staleTeammateLine(authorLive, 'me', NOW)).toBeNull();
  });
});

describe("a holder whose review is already on GitHub has FINISHED (PR #592, 2026-11-05)", () => {
  // robin-dunn's Limn posted its review at 12:02 but never wrote "reviewed": the reader waited for the
  // lease. Their posted review at this head now counts as their success line.
  const robinLive = [line('robin', 'pending', NOW - 12 * MIN), line('robin', 'pending', NOW - 4 * MIN)];
  const postedAt = NOW - 3 * MIN;

  it('a live pending line whose claimant posted since the claim began ⇒ "already reviewed", not a wait', () => {
    expect(decideTeamClaim(robinLive, 'me', NOW)).toMatchObject({ kind: 'reviewing', login: 'robin' }); // the contrast
    expect(decideTeamClaim(robinLive, 'me', NOW, null, [{ login: 'Robin', postedAtMs: postedAt }])).toEqual({
      kind: 'reviewed',
      login: 'robin',
      atMs: postedAt,
      description: 'robin reviewed · posted on GitHub',
    });
  });

  it('a renew line after the post still settles at the newest line (one claim)', () => {
    const d = decideTeamClaim(robinLive, 'me', NOW, null, [{ login: 'robin', postedAtMs: NOW - 8 * MIN }]);
    expect(d).toMatchObject({ kind: 'reviewed', login: 'robin', atMs: NOW - 4 * MIN });
  });

  it('past the lease too: still "already reviewed", never free (the recheck must not run it after all)', () => {
    const lapsed = [line('robin', 'pending', NOW - 40 * MIN)];
    expect(decideTeamClaim(lapsed, 'me', NOW).kind).toBe('free'); // the contrast
    expect(decideTeamClaim(lapsed, 'me', NOW, null, [{ login: 'robin', postedAtMs: NOW - 35 * MIN }])).toMatchObject({
      kind: 'reviewed',
      login: 'robin',
    });
    // …and so it is not stale: no "claim expired" line over it.
    expect(staleTeammateLine(lapsed, 'me', NOW)).toEqual({ login: 'robin' });
    expect(staleTeammateLine(lapsed, 'me', NOW, [{ login: 'robin', postedAtMs: NOW - 35 * MIN }])).toBeNull();
  });

  it('a review posted BEFORE the claim began (an earlier review) settles nothing', () => {
    expect(decideTeamClaim(robinLive, 'me', NOW, null, [{ login: 'robin', postedAtMs: NOW - 20 * MIN }])).toMatchObject({
      kind: 'reviewing',
      login: 'robin',
    });
  });

  it("someone else's review, or a review with no claim of theirs, changes nothing", () => {
    expect(decideTeamClaim(robinLive, 'me', NOW, null, [{ login: 'bob', postedAtMs: postedAt }])).toMatchObject({ kind: 'reviewing', login: 'robin' });
    expect(decideTeamClaim([], 'me', NOW, null, [{ login: 'robin', postedAtMs: postedAt }])).toEqual({ kind: 'free' });
    // Their line already settled (a release): stays free.
    const released = [line('robin', 'pending', NOW - 12 * MIN), line('robin', 'success', NOW - 2 * MIN, unfinishedLine('robin'))];
    expect(decideTeamClaim(released, 'me', NOW, null, [{ login: 'robin', postedAtMs: postedAt }]).kind).toBe('free');
  });

  it('a later line still wins: a Clear frees it; a newer live claim holds it', () => {
    const cleared = [...robinLive, line('carol', 'success', NOW - MIN, clearedLine('carol'))];
    expect(decideTeamClaim(cleared, 'me', NOW, null, [{ login: 'robin', postedAtMs: postedAt }]).kind).toBe('free');
    const reclaimed = [...robinLive, line('bob', 'pending', NOW - MIN)];
    expect(decideTeamClaim(reclaimed, 'me', NOW, null, [{ login: 'robin', postedAtMs: postedAt }])).toMatchObject({ kind: 'reviewing', login: 'bob' });
  });

  it("in a race, the finished winner's review settles it: the head reads reviewed", () => {
    const race = [line('robin', 'pending', NOW - 10 * MIN), line('me', 'pending', NOW - 9 * MIN, 'me is reviewing with Claude')];
    expect(decideTeamClaim(race, 'me', NOW, null, [{ login: 'robin', postedAtMs: postedAt }])).toMatchObject({ kind: 'reviewed', login: 'robin' });
  });

  it("the PR AUTHOR's lines still never hold, posted or not; the reader's own post is not read", () => {
    expect(decideTeamClaim(robinLive, 'me', NOW, 'robin', [{ login: 'robin', postedAtMs: postedAt }])).toEqual({ kind: 'free' });
    const mine = [line('me', 'pending', NOW - 5 * MIN, 'me is reviewing with Claude')];
    expect(decideTeamClaim(mine, 'me', NOW, null, [{ login: 'me', postedAtMs: postedAt }]).kind).toBe('mine');
  });
});

// ---- the lifecycle, over a real DB ----

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let tc: typeof import('./team-claim.js');
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

describe('always on (2026-11-10)', () => {
  it('a stored false in the dormant column is ignored: the claim still goes up', async () => {
    await db.update(schema.workspaces).set({ teamClaimsEnabled: false }).where(eq(schema.workspaces.id, workspaceId)).execute();
    const f = fakeGh();
    expect((await tc.claimBeforeAutoRun(ctx, target(), {}, f.gh)).kind).toBe('run');
    expect(f.posts.length).toBeGreaterThan(0);
    await db.update(schema.workspaces).set({ teamClaimsEnabled: null }).where(eq(schema.workspaces.id, workspaceId)).execute();
  });
});

describe('claimBeforeAutoRun', () => {

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

  it("a teammate's live claim whose review is already imported ⇒ 'already reviewed' at once, even over a remembered wait", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', line('robin', 'pending', NOW - 12 * MIN));
    // First: no review yet ⇒ "being reviewed", held until the lease ends.
    const first = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(first).toMatchObject({ kind: 'skip', skip: { kind: 'reviewing', login: 'robin' } });
    expect(await tc.teamClaimHeldHeadNow(ctx, 1, prId, NOW)).toBe('head1');
    // Then robin's Limn posts its review; the sync import stores it (kind 'teammate', the marker's head).
    const [robin] = await db
      .insert(schema.users)
      .values({ githubNodeId: 'U_robin_poster', githubLogin: 'robin' })
      .onConflictDoUpdate({ target: schema.users.githubNodeId, set: { githubLogin: 'robin' } })
      .returning()
      .execute();
    const teammate = (provider: string, headInferred = false) => ({
      githubReviewId: '1',
      run: 'auto',
      pair: false,
      runs: [{ provider, model: null, effort: null }],
      limnVersion: null,
      headInferred,
    });
    const [codexRow] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: 'head1', status: 'succeeded', model: 'm', provider: 'codex', kind: 'teammate', sourceUserId: robin.id, postedAt: new Date(NOW - 2 * MIN), teammate: teammate('codex') })
      .returning()
      .execute();
    // A Codex review does not settle the Claude line.
    expect(await tc.postedTeammateReviewsAtHead(ctx, 1, prId, 'head1', 'claude')).toEqual([]);
    expect(await tc.teamClaimHeldHeadNow(ctx, 1, prId, NOW)).toBe('head1');
    const [claudeRow] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: 'head1', status: 'succeeded', model: 'm', provider: 'claude', kind: 'teammate', sourceUserId: robin.id, postedAt: new Date(NOW - 2 * MIN), teammate: teammate('claude') })
      .returning()
      .execute();
    try {
      expect(await tc.postedTeammateReviewsAtHead(ctx, 1, prId, 'head1', 'claude')).toEqual([{ login: 'robin', postedAtMs: NOW - 2 * MIN }]);
      // The sweeper no longer holds the PR, and the claim reads it again: "already reviewed".
      expect(await tc.teamClaimHeldHeadNow(ctx, 1, prId, NOW + MIN)).toBeNull();
      const again = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW + MIN }, f.gh);
      expect(again).toMatchObject({ kind: 'skip', skip: { kind: 'reviewed', login: 'robin', description: 'robin reviewed · posted on GitHub' } });
      expect(f.posts).toEqual([]);
    } finally {
      const { inArray } = await import('drizzle-orm');
      await db.delete(schema.claudeReviews).where(inArray(schema.claudeReviews.id, [codexRow.id, claudeRow.id])).execute();
    }
  });

  it("the PR author's own line ⇒ runs and claims (their own review never holds a head)", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', line('carol', 'success', NOW - 5 * MIN, 'carol reviewed · 3 comments'));
    const r = await tc.claimBeforeAutoRun(ctx, { ...target(), authorLogin: 'carol' }, { nowMs: () => NOW }, f.gh);
    expect(r.kind).toBe('run');
    expect(f.posts.map((p) => p.description)).toEqual(['me is reviewing with Claude']);
    expect(tc.teamClaimSkipFor(1, prId, 'head1')).toBeNull();
    // A non-author teammate's finished review still holds.
    const g = fakeGh();
    g.seed('limn/review-claude', line('bob', 'success', NOW - 5 * MIN, 'bob reviewed · 3 comments'));
    expect((await tc.claimBeforeAutoRun(ctx, { ...target(), authorLogin: 'carol' }, { nowMs: () => NOW }, g.gh)).kind).toBe('skip');
  });

  it('reads the PR author from the synced PR when the target does not name one', async () => {
    const { eq } = await import('drizzle-orm');
    const [u] = await db.insert(schema.users).values({ githubLogin: 'carol-tc', githubNodeId: 'U_carol_tc' }).returning().execute();
    await db.update(schema.pullRequests).set({ authorId: u.id }).where(eq(schema.pullRequests.id, prId)).execute();
    try {
      expect(await tc.prAuthorLogin(ctx, 1, prId)).toBe('carol-tc');
      expect(await tc.prAuthorLogin(ctx, 2, prId)).toBeNull(); // another account's PR
      const f = fakeGh();
      f.seed('limn/review-claude', line('carol-tc', 'pending', NOW - 2 * MIN));
      expect((await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh)).kind).toBe('run');
    } finally {
      await db.update(schema.pullRequests).set({ authorId: null }).where(eq(schema.pullRequests.id, prId)).execute();
    }
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
    expect(f.posts.at(-1)).toEqual({ context: 'limn/review-claude', state: 'success', description: "Cleared by me: review didn't finish · free to claim" });
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
    refused.seed('limn/review-claude', line('bob', 'pending', NOW - MIN));
    expect(await tc.clearTeamClaim(ctx, target(), refused.gh)).toMatchObject({ ok: false, error: 'no_access' });
  });
});

describe("a teammate's line on the tab (team_claim_seen, migration 0159)", () => {
  beforeAll(async () => {
  });

  it('a skip is recorded durably with their line and name; a Codex claim at the same head keeps the Claude skip', async () => {
    const seen = await import('./team-claim-seen.js');
    await db.delete(schema.teamClaimSeen).execute();
    await db
      .insert(schema.users)
      .values({ githubLogin: 'robin-dunn', displayName: 'Robin Dunn', githubNodeId: 'U_robin' })
      .onConflictDoNothing()
      .execute();
    const f = fakeGh();
    f.seed('limn/review-claude', { id: 1, state: 'pending', description: 'robin-dunn is reviewing with Claude', createdAtMs: NOW - 20 * MIN, login: 'robin-dunn' });
    f.seed('limn/review-claude', { id: 2, state: 'success', description: 'robin-dunn reviewed · no comments', createdAtMs: NOW - 2 * MIN, login: 'robin-dunn' });
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r.kind).toBe('skip');
    // The Codex half claims freely at the same head — and the Claude skip is NOT forgotten (per provider).
    const codex = await tc.claimBeforeAutoRun(ctx, { ...target(), provider: 'codex' }, { nowMs: () => NOW }, f.gh);
    expect(codex.kind).toBe('run');
    expect(tc.teamClaimSkipFor(1, prId, 'head1')).toMatchObject({ provider: 'claude', kind: 'reviewed', login: 'robin-dunn' });
    // Durable: read back from the DB (what the tab shows after a reload or a restart).
    for (let i = 0; i < 50; i++) {
      if ((await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).length > 0) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    tc._resetTeamClaimsForTest();
    const lines = await seen.teammateLinesAtHead(ctx, 1, prId, 'head1');
    expect(lines).toEqual([
      {
        provider: 'claude',
        kind: 'reviewed',
        login: 'robin-dunn',
        headSha: 'head1',
        at: new Date(NOW - 2 * MIN).toISOString(),
        description: 'robin-dunn reviewed · no comments',
        name: 'Robin Dunn',
      },
    ]);
    // Another head shows nothing; a Clear forgets it.
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head2')).toEqual([]);
    await seen.forgetTeammateLine(ctx, 1, prId, 'head1', 'claude');
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).toEqual([]);
  });

  it("⚠ a head that is FREE again forgets the teammate's line — it never sits beside this machine's own review", async () => {
    const seen = await import('./team-claim-seen.js');
    await db.delete(schema.teamClaimSeen).execute();
    tc._resetTeamClaimsForTest();
    await seen.recordTeammateLine(ctx, 1, prId, {
      provider: 'claude',
      kind: 'reviewing',
      login: 'robin-dunn',
      headSha: 'head1',
      at: new Date(NOW - 40 * MIN).toISOString(),
      description: 'robin-dunn is reviewing with Claude',
    });
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).toHaveLength(1);
    // Their line is gone from the head (no lines at all): this machine claims and runs.
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, fakeGh().gh);
    expect(r.kind).toBe('run');
    for (let i = 0; i < 50; i++) {
      if ((await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).length === 0) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).toEqual([]);
  });
});

describe('gap 12: "kept in Limn" only when NOTHING reached GitHub', () => {
  const done = (githubReviewId: string | null, posted: number[], submitted?: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES') =>
    ({
      kind: 'done',
      record: {
        status: githubReviewId != null ? 'posted' : 'skipped',
        at: '',
        reason: null,
        error: null,
        findingIds: [],
        postedFindingIds: posted,
        githubReviewId,
        ...(submitted ? { verdict: { wanted: submitted, submitted, heldReason: null } } : {}),
      },
    }) as any;
  const run = { findings: [{ id: 1, severity: 'nit' }, { id: 2, severity: 'warning' }] };
  it('the verdict leads the line; a COMMENT adds nothing', () => {
    expect(reviewedLine('alex', 0, 'APPROVE')).toBe('alex reviewed · approved');
    expect(reviewedLine('alex', 2, 'APPROVE')).toBe('alex reviewed · approved · 2 comments');
    expect(reviewedLine('alex', 3, 'REQUEST_CHANGES')).toBe('alex reviewed · changes requested · 3 comments');
    expect(reviewedLine('alex', 0, 'COMMENT')).toBe('alex reviewed · no comments');
    expect(reviewedLine('alex', null, 'APPROVE')).toBe('alex reviewed · kept in Limn');
  });
  it('an approval with only nits (nothing of ours posted) holds the commit: "approved", not "kept in Limn"', () => {
    const s = tc.reviewedLineSummary(done('55', [], 'APPROVE'), run);
    expect(s).toEqual({ comments: 0, verdict: 'APPROVE', onGithub: true });
    const d = reviewedLine('bob', s.comments, s.verdict);
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, d)], 'me', NOW).kind).toBe('reviewed');
  });
  it('a reason-only comment, or a pair review holding only the other half’s findings, reads "no comments"', () => {
    expect(tc.reviewedLineSummary(done('56', [], 'COMMENT'), run)).toMatchObject({ comments: 0, onGithub: true });
    expect(tc.reviewedLineSummary(done('57', [99], 'COMMENT'), run)).toMatchObject({ comments: 0, onGithub: true });
    expect(tc.reviewedLineSummary(done('58', [2], 'COMMENT'), run)).toMatchObject({ comments: 1, onGithub: true });
  });
  it('no review on GitHub (auto-post off, skipped, failed) ⇒ "kept in Limn" (free); nothing to say ⇒ "no comments"', () => {
    expect(tc.reviewedLineSummary(done(null, []), run).comments).toBeNull();
    expect(tc.reviewedLineSummary({ kind: 'off' }, run).comments).toBeNull();
    expect(tc.reviewedLineSummary(null, run).comments).toBeNull();
    expect(tc.reviewedLineSummary(null, { findings: [{ id: 3, severity: 'praise' }] }).comments).toBe(0);
    // An old "kept in Limn" line still reads free.
    expect(decideTeamClaim([line('bob', 'success', NOW - MIN, 'bob reviewed · kept in Limn')], 'me', NOW).kind).toBe('free');
  });
});

describe('gap 5: a late final line is never posted blind', () => {
  beforeAll(async () => {
  });

  it("a teammate's newer success ⇒ nothing posted, the row closed 'superseded', the record says so", async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    const before = f.posts.length;
    // The laptop slept: the lease ran out, bob claimed and finished.
    f.seed('limn/review-claude', line('bob', 'pending', NOW + 30 * MIN));
    f.seed('limn/review-claude', line('bob', 'success', NOW + 40 * MIN, 'bob reviewed · 2 comments'));
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'unfinished' }, f.gh, () => NOW + 45 * MIN);
    expect(f.posts.length).toBe(before);
    expect(await ledgerRow(r.handle.ledgerId!)).toMatchObject({ state: 'released', lastError: 'superseded' });
    const [row] = await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, reviewId)).execute();
    expect(row.teamClaim).toMatchObject({ lastLine: 'superseded' });
  });

  it("a teammate's live claim ⇒ a finished review's line is not posted either", async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    const before = f.posts.length;
    f.seed('limn/review-claude', line('bob', 'pending', NOW + 30 * MIN));
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'succeeded', comments: 1, reviewUrl: null }, f.gh, () => NOW + 35 * MIN);
    expect(f.posts.length).toBe(before);
    expect(await ledgerRow(r.handle.ledgerId!)).toMatchObject({ state: 'finished', lastError: 'superseded' });
  });

  it("a loser's stand-down line (naming us) or a teammate's free line does not stop our line", async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    f.seed('limn/review-claude', line('bob', 'pending', NOW + MIN, 'me is reviewing with Claude'));
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'succeeded', comments: 0, reviewUrl: null, verdict: 'APPROVE' }, f.gh, () => NOW + 2 * MIN);
    expect(f.posts.at(-1)).toMatchObject({ state: 'success', description: 'me reviewed · approved' });
    const g = fakeGh();
    const r2 = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, g.gh);
    if (r2.kind !== 'run') throw new Error('expected a run');
    g.seed('limn/review-claude', line('bob', 'success', NOW + MIN, 'Cleared by bob: auto review skipped · AI budget used'));
    await tc.finishTeamClaim(ctx, r2.handle, reviewId, { kind: 'unfinished' }, g.gh, () => NOW + 2 * MIN);
    expect(g.posts.at(-1)?.description).toBe("Cleared by me: review didn't finish · free to claim");
  });

  it('an unreadable history still posts the line (a pending line left behind is worse)', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    const broken: TeamClaimGithub = { ...f.gh, listLines: async () => Promise.reject(new Error('502')) };
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'unfinished' }, broken, () => NOW + MIN);
    expect(f.posts.at(-1)?.description).toBe("Cleared by me: review didn't finish · free to claim");
  });
});

describe("gap 6: Clear for a teammate's claim survives a restart", () => {
  beforeAll(async () => {
  });
  it("the stored 'is reviewing' line offers Clear with no memory; a 'reviewed' one does not", async () => {
    const seen = await import('./team-claim-seen.js');
    await db.delete(schema.teamClaimSeen).execute();
    tc._resetTeamClaimsForTest();
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toBeNull();
    await seen.recordTeammateLine(ctx, 1, prId, {
      provider: 'codex',
      kind: 'reviewing',
      login: 'robin-dunn',
      headSha: 'head1',
      at: new Date(NOW).toISOString(),
      description: 'robin-dunn is reviewing with Codex',
    });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false, NOW + MIN)).toEqual({ provider: 'codex', login: 'robin-dunn', mine: false });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head2', false, NOW + MIN)).toBeNull();
    // GAP 6: a stored line past the lease offers no Clear (nothing re-reads it after a restart).
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false, NOW + tc.TEAM_CLAIM_LEASE_MS)).toBeNull();
    // The Clear forgets it; the teammate has finished since, so the Clear reads that and posts nothing.
    const done = fakeGh();
    done.seed('limn/review-codex', line('robin-dunn', 'pending', NOW - MIN));
    done.seed('limn/review-codex', { ...line('robin-dunn', 'success', NOW), description: 'robin-dunn reviewed · 3 comments' });
    expect(await tc.clearTeamClaim(ctx, { ...target(), provider: 'codex' }, done.gh)).toEqual({ ok: true });
    expect(done.posts).toEqual([]);
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false, NOW + MIN)).toBeNull();
    // An unreadable history posts nothing.
    const blind = fakeGh({ readFails: Object.assign(new Error('boom'), { status: 502 }) });
    expect(await tc.clearTeamClaim(ctx, { ...target(), provider: 'codex' }, blind.gh)).toMatchObject({ ok: false, error: 'error' });
    expect(blind.posts).toEqual([]);
    await seen.recordTeammateLine(ctx, 1, prId, {
      provider: 'claude',
      kind: 'reviewed',
      login: 'robin-dunn',
      headSha: 'head1',
      at: new Date(NOW).toISOString(),
      description: 'robin-dunn reviewed · no comments',
    });
    expect(await tc.teamClaimPendingFor(ctx, 1, prId, 'head1', false)).toBeNull();
    await db.delete(schema.teamClaimSeen).execute();
  });
});

describe('gap 4: manual reviews and team claims', () => {
  const mt = () => ({ accountId: 1, prId, owner: 'acme', name: 'api', number: 7, headSha: 'head1' });
  beforeAll(async () => {
  });
  beforeEach(async () => {
    await db.delete(schema.teamClaimSeen).execute();
  });

  it("a manual run's start stores a teammate's live claim (the tab names it); never posts a line", async () => {
    const m = await import('./team-claim-manual.js');
    const seen = await import('./team-claim-seen.js');
    const f = fakeGh();
    f.seed('limn/review-claude', line('robin-dunn', 'pending', NOW - MIN));
    expect(await m.readTeammateLinesForManualRun(ctx, mt(), ['claude', 'codex'], f.gh, () => NOW)).toBe('read');
    expect(f.posts).toEqual([]);
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).toMatchObject([{ provider: 'claude', kind: 'reviewing', login: 'robin-dunn' }]);
    // The teammate finished: the run's end reads again and the line follows.
    f.seed('limn/review-claude', line('robin-dunn', 'success', NOW + MIN, 'robin-dunn reviewed · 2 comments'));
    await m.refreshTeammateLinesAfterRun(ctx, mt(), f.gh);
    expect(await seen.teammateLinesAtHead(ctx, 1, prId, 'head1')).toMatchObject([{ kind: 'reviewed', description: 'robin-dunn reviewed · 2 comments' }]);
    expect(f.posts).toEqual([]);
  });

  it('a posted manual review writes "<login> reviewed · …" per model; teammates then step aside', async () => {
    const m = await import('./team-claim-manual.js');
    const f = fakeGh();
    const out = await m.markPostedReviewLines(
      ctx,
      mt(),
      { runs: [{ provider: 'claude', comments: 2 }, { provider: 'codex', comments: 0 }], verdict: 'APPROVE', reviewUrl: null },
      f.gh,
      () => NOW,
    );
    expect(out).toEqual({ claude: 'posted', codex: 'posted' });
    expect(f.posts.map((p) => [p.context, p.state, p.description])).toEqual([
      ['limn/review-claude', 'success', 'me reviewed · approved · 2 comments'],
      ['limn/review-codex', 'success', 'me reviewed · approved'],
    ]);
    expect(decideTeamClaim(await f.gh.listLines(1, 'acme', 'api', 'head1', 'limn/review-codex'), 'bob', NOW).kind).toBe('reviewed');
    // Never twice.
    const again = await m.markPostedReviewLines(ctx, mt(), { runs: [{ provider: 'claude', comments: 2 }], verdict: 'APPROVE', reviewUrl: null }, f.gh, () => NOW);
    expect(again).toEqual({ claude: 'already' });
    expect(f.posts).toHaveLength(2);
  });

  it("never over a teammate's success or live claim; never on the reader's own PR; never when claims are off", async () => {
    const m = await import('./team-claim-manual.js');
    const f = fakeGh();
    f.seed('limn/review-claude', line('bob', 'pending', NOW - MIN));
    f.seed('limn/review-codex', line('bob', 'success', NOW - MIN, 'bob reviewed · 1 comment'));
    const out = await m.markPostedReviewLines(
      ctx,
      mt(),
      { runs: [{ provider: 'claude', comments: 1 }, { provider: 'codex', comments: 1 }], verdict: 'COMMENT', reviewUrl: null },
      f.gh,
      () => NOW,
    );
    expect(out).toEqual({ claude: 'teammate', codex: 'teammate' });
    expect(f.posts).toEqual([]);
    // The reader is the author.
    const { eq } = await import('drizzle-orm');
    const [u] = await db.insert(schema.users).values({ githubLogin: 'me', githubNodeId: 'U_me_author' }).onConflictDoNothing().returning().execute();
    const meUser = u ?? (await db.select().from(schema.users).where(eq(schema.users.githubLogin, 'me')).execute())[0];
    await db.update(schema.pullRequests).set({ authorId: meUser.id }).where(eq(schema.pullRequests.id, prId)).execute();
    const g = fakeGh();
    expect(await m.markPostedReviewLines(ctx, mt(), { runs: [{ provider: 'claude', comments: 1 }], verdict: 'COMMENT', reviewUrl: null }, g.gh)).toEqual({
      claude: 'author',
    });
    await db.update(schema.pullRequests).set({ authorId: null }).where(eq(schema.pullRequests.id, prId)).execute();
    expect(g.posts).toEqual([]);
  });
});

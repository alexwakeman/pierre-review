// RELEASING STALE TEAM-CLAIM LINES (team-claim-ledger.ts + team-claim-release.ts; docs/CLAUDE-REVIEW.md
// § Team claims → Releasing stale lines), over a THROWAWAY sqlite DB with GitHub faked (no live writes).
// Pinned:
//   • the ledger row is written BEFORE the pending line is posted;
//   • a refused claim write (403/404, rate limit) closes the row; any other failure leaves it open;
//   • a final line GitHub did not take keeps the row open WITH the success line to retry;
//   • the reconciler releases a row whose run is not in memory (a restart), leaves a running one
//     alone, retries a failure with backoff up to the cap, closes a 403/404, waits out a rate limit,
//     and works with the team-claims switch OFF;
//   • a teammate's expired pending line is released ONCE;
//   • Clear closes the ledger rows (team-claim.test.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import type { TeamClaimGithub, TeamClaimLine, TeamClaimPost } from './team-claim.js';

const DIR = mkdtempSync(join(tmpdir(), 'limn-team-claim-release-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let tc: typeof import('./team-claim.js');
let ledger: typeof import('./team-claim-ledger.js');
let rel: typeof import('./team-claim-release.js');
let settings: typeof import('./auto-settings.js');
let ctx: AgentContext;
let workspaceId = 0;
let prId = 0;
let reviewId = 0;
let eq: typeof import('drizzle-orm').eq;

const rateLimited = () => Object.assign(new Error('API rate limit exceeded'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } });
const forbidden = () => Object.assign(new Error('Resource not accessible'), { status: 403 });
const serverError = () => Object.assign(new Error('Bad gateway'), { status: 502 });

/** A fake GitHub. `postFails` may be a function, answering per call. */
function fakeGh(opts: { postFails?: (n: number) => unknown; login?: string; onPost?: () => Promise<void> } = {}) {
  const lines: Record<string, TeamClaimLine[]> = {};
  const posts: Array<{ context: string; sha: string } & TeamClaimPost> = [];
  let calls = 0;
  let id = 5000;
  const gh: TeamClaimGithub = {
    async listLines(_a, _o, _n, _sha, context) {
      return [...(lines[context] ?? [])].reverse();
    },
    async postLine(_a, _o, _n, sha, context, post) {
      calls += 1;
      await opts.onPost?.();
      const fail = opts.postFails?.(calls);
      if (fail) throw fail;
      posts.push({ context, sha, ...post });
      (lines[context] ??= []).push({ id: id++, state: post.state, description: post.description, createdAtMs: NOW, login: opts.login ?? 'me' });
    },
    async login() {
      return opts.login ?? 'me';
    },
  };
  return { gh, posts, seed: (context: string, l: TeamClaimLine) => (lines[context] ??= []).push(l), calls: () => calls };
}

const target = (over: object = {}) => ({
  accountId: 1,
  prId,
  owner: 'acme',
  name: 'api',
  number: 7,
  headSha: 'head1',
  provider: 'claude' as const,
  ...over,
});

async function rows(): Promise<any[]> {
  return db.select().from(schema.teamClaimLines).orderBy(schema.teamClaimLines.id).execute();
}
async function rowById(id: number): Promise<any> {
  const [r] = await db.select().from(schema.teamClaimLines).where(eq(schema.teamClaimLines.id, id)).execute();
  return r ?? null;
}
const notBusy = { busy: () => false, held: () => false };

beforeAll(async () => {
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  eq = (await import('drizzle-orm')).eq;
  const q = await import('../../db/queries.js');
  tc = await import('./team-claim.js');
  ledger = await import('./team-claim-ledger.js');
  rel = await import('./team-claim-release.js');
  settings = await import('./auto-settings.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'me' } })
    .execute();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_tcr', createdAt: new Date(NOW - 86_400_000) })
    .returning()
    .execute();
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_tcr',
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
    .values({
      accountId: 1,
      prId,
      headSha: 'head1',
      status: 'running',
      model: 'm',
      provider: 'claude',
      trigger: 'auto',
      teamClaim: { context: 'limn/review-claude', state: 'marked', reason: null, lastLine: 'reviewing', at: '' },
    })
    .returning()
    .execute();
  reviewId = r.id;
  ctx = { db, schema, log: { info: () => {}, warn: () => {}, error: () => {} } } as any as AgentContext;
  await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  tc._resetTeamClaimsForTest();
  rel._resetTeamClaimReleaseForTest();
  await db.delete(schema.teamClaimLines).execute();
  await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
});

describe('the ledger around a claim', () => {
  it('is written BEFORE the pending line is posted, and moves on after it', async () => {
    let seenAtPost: any[] | null = null;
    const f = fakeGh({
      onPost: async () => {
        seenAtPost ??= await rows();
      },
    });
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(r.kind).toBe('run');
    expect(seenAtPost).toHaveLength(1);
    expect(seenAtPost![0]).toMatchObject({ state: 'claiming', whose: 'mine', provider: 'claude', headSha: 'head1', login: 'me', prId });
    if (r.kind !== 'run') return;
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({ state: 'pending' });
    // Tied to the run when its row is written.
    await tc.saveTeamClaimRecord(ctx, reviewId, r.handle.record, r.handle);
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({ reviewId });
  });

  it('a newer claim at the same head closes the older open row (its line is replaced)', async () => {
    const f = fakeGh();
    const a = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    const b = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW, pressed: true }, f.gh);
    if (a.kind !== 'run' || b.kind !== 'run') throw new Error('expected runs');
    expect(await rowById(a.handle.ledgerId!)).toMatchObject({ state: 'released', lastError: 'superseded' });
    expect(await rowById(b.handle.ledgerId!)).toMatchObject({ state: 'pending' });
  });

  it('a refused claim write closes the row (nothing was written); any other failure leaves it for the reconciler', async () => {
    const refused = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, fakeGh({ postFails: () => forbidden() }).gh);
    expect(refused).toMatchObject({ kind: 'run', handle: { marked: false, record: { reason: 'no_access' } } });
    expect((await rows()).map((r) => r.state)).toEqual(['released']);
    await db.delete(schema.teamClaimLines).execute();
    const limited = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, fakeGh({ postFails: () => rateLimited() }).gh);
    expect(limited).toMatchObject({ kind: 'run', handle: { marked: false, record: { reason: 'error' } } });
    expect((await rows()).map((r) => r.state)).toEqual(['released']);
    await db.delete(schema.teamClaimLines).execute();
    const maybe = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, fakeGh({ postFails: () => serverError() }).gh);
    if (maybe.kind !== 'run') throw new Error('expected a run');
    expect(maybe.handle.ledgerId).toBeTruthy();
    expect(await rowById(maybe.handle.ledgerId!)).toMatchObject({ state: 'claiming', lastError: 'Bad gateway' });
  });

  it("a final line GitHub did not take keeps the row OPEN with the success line, and the reconciler posts THAT", async () => {
    const ok = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, ok.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    const down = fakeGh({ postFails: () => serverError() });
    await tc.finishTeamClaim(ctx, r.handle, reviewId, { kind: 'succeeded', comments: 3, reviewUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-5' }, down.gh);
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({
      state: 'pending',
      reviewId,
      finalDescription: 'me reviewed · 3 comments',
      finalTargetUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-5',
    });
    const res = await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: ok.gh, nowMs: NOW });
    expect(res).toMatchObject({ finished: 1, released: 0 });
    expect(ok.posts.at(-1)).toMatchObject({
      state: 'success',
      description: 'me reviewed · 3 comments',
      targetUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-5',
    });
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({ state: 'finished' });
  });
});

describe('releaseStaleOwnClaims (the reconciler)', () => {
  it('a restart: an open row whose run is NOT in memory gets the release line at ITS head, then is closed', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    await tc.saveTeamClaimRecord(ctx, reviewId, r.handle.record, r.handle);
    // The process "restarts": the handle and its memory are gone; nothing is busy.
    tc._resetTeamClaimsForTest();
    const res = await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: f.gh, nowMs: NOW });
    expect(res).toMatchObject({ released: 1, failed: 0, limited: false });
    expect(f.posts.at(-1)).toEqual({ context: 'limn/review-claude', sha: 'head1', state: 'success', description: "me's review didn't finish · free to claim" });
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({ state: 'released' });
    // The run row's record says it was released.
    const [run] = await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, reviewId)).execute();
    expect(run.teamClaim).toMatchObject({ lastLine: 'unfinished' });
    // Idempotent: a second pass posts nothing.
    const n = f.posts.length;
    await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: f.gh, nowMs: NOW });
    expect(f.posts).toHaveLength(n);
  });

  it('leaves a row whose run is still going (busy), or whose final line is being written', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    const n = f.posts.length;
    const seen: Array<[number, number, string, string]> = [];
    await rel.releaseStaleOwnClaims(ctx, {
      busy: (a, p, pv, sha) => (seen.push([a, p, pv, sha]), true),
      gh: f.gh,
      nowMs: NOW,
    });
    expect(seen).toEqual([[1, prId, 'claude', 'head1']]);
    expect(f.posts).toHaveLength(n);
    // The run ended; its final line is in flight (stopTeamClaimRenew marks it).
    tc.stopTeamClaimRenew(r.handle);
    await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: f.gh, nowMs: Date.now() });
    expect(f.posts).toHaveLength(n);
    expect(await rowById(r.handle.ledgerId!)).toMatchObject({ state: 'pending' });
  });

  it('retries a failed release with backoff, at most RELEASE_MAX_ATTEMPTS times', async () => {
    const id = await ledger.recordClaimIntent(ctx, { accountId: 1, prId, headSha: 'head1', provider: 'codex', login: 'me' });
    await ledger.setClaimLine(ctx, id, { state: 'pending' });
    const down = fakeGh({ postFails: () => serverError() });
    let t = NOW + 60 * MIN; // well after the row was written
    const first = await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: down.gh, nowMs: t });
    expect(first).toMatchObject({ failed: 1, gaveUp: 0 });
    expect(await rowById(id)).toMatchObject({ state: 'pending', releaseAttempts: 1, lastError: 'Bad gateway' });
    // Inside the backoff: not tried again.
    const before = down.calls();
    await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: down.gh, nowMs: Date.now() });
    expect(down.calls()).toBe(before);
    // Past each backoff: tried until the cap, then left (logged).
    for (let i = 0; i < 10; i += 1) {
      t = Date.now() + 2 * 60 * 60 * 1000;
      await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: down.gh, nowMs: t });
    }
    expect(down.calls()).toBe(rel.RELEASE_MAX_ATTEMPTS);
    expect(await rowById(id)).toMatchObject({ state: 'pending', releaseAttempts: rel.RELEASE_MAX_ATTEMPTS });
    expect(rel.releaseBackoffMs(1)).toBe(MIN);
    expect(rel.releaseBackoffMs(3)).toBe(4 * MIN);
  });

  it('403/404 ⇒ closed with the error (no access); a rate limit ⇒ left for a later tick and the pass stops', async () => {
    const a = await ledger.recordClaimIntent(ctx, { accountId: 1, prId, headSha: 'head1', provider: 'claude', login: 'me' });
    const b = await ledger.recordClaimIntent(ctx, { accountId: 1, prId, headSha: 'head1', provider: 'codex', login: 'me' });
    const limited = fakeGh({ postFails: () => rateLimited() });
    const res = await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: limited.gh, nowMs: NOW });
    expect(res.limited).toBe(true);
    expect(limited.calls()).toBe(1); // stopped after the first
    expect(await rowById(a)).toMatchObject({ state: 'claiming', releaseAttempts: 0 });
    const refused = fakeGh({ postFails: () => Object.assign(new Error('Not Found'), { status: 404 }) });
    await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: refused.gh, nowMs: NOW });
    expect(await rowById(a)).toMatchObject({ state: 'released', lastError: 'no_access' });
    expect(await rowById(b)).toMatchObject({ state: 'released', lastError: 'no_access' });
  });

  it('works with the team-claims switch OFF: what we posted is still released', async () => {
    const f = fakeGh();
    const r = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    if (r.kind !== 'run') throw new Error('expected a run');
    await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: false });
    tc._resetTeamClaimsForTest();
    const res = await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: f.gh, nowMs: NOW });
    expect(res.released).toBe(1);
    expect(f.posts.at(-1)).toMatchObject({ state: 'success', description: "me's review didn't finish · free to claim" });
  });

  it("a row from before the ledger (no login) names the account's login", async () => {
    await db
      .insert(schema.teamClaimLines)
      .values({ accountId: 1, prId, headSha: 'old-head', provider: 'codex', whose: 'mine', state: 'pending', login: null })
      .execute();
    const f = fakeGh({ login: 'alex' });
    await rel.releaseStaleOwnClaims(ctx, { ...notBusy, gh: f.gh, nowMs: NOW });
    expect(f.posts).toEqual([
      { context: 'limn/review-codex', sha: 'old-head', state: 'success', description: "alex's review didn't finish · free to claim" },
    ]);
  });
});

describe("releaseExpiredTeammateLines (a teammate's stale line)", () => {
  it("an expired pending line of bob's is released ONCE, recorded in the ledger", async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', { id: 1, state: 'pending', description: 'bob is reviewing with Claude', createdAtMs: NOW - 5 * MIN, login: 'bob' });
    const skip = await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    expect(skip).toMatchObject({ kind: 'skip', skip: { login: 'bob' } });
    // Inside the lease: nothing to do.
    expect((await rel.releaseExpiredTeammateLines(ctx, { ...notBusy, gh: f.gh, nowMs: NOW + MIN })).released).toBe(0);
    // The sweeper took the PR back: its own claim replaces the line.
    const later = NOW + 40 * MIN;
    expect((await rel.releaseExpiredTeammateLines(ctx, { busy: () => false, held: () => true, gh: f.gh, nowMs: later })).released).toBe(0);
    // Not taken back: released once.
    const res = await rel.releaseExpiredTeammateLines(ctx, { ...notBusy, gh: f.gh, nowMs: later });
    expect(res.released).toBe(1);
    expect(f.posts.at(-1)).toMatchObject({ context: 'limn/review-claude', state: 'success', description: "Released: bob's claim expired" });
    expect((await rows()).find((r) => r.whose === 'teammate')).toMatchObject({ state: 'released', login: 'bob', headSha: 'head1' });
    expect(tc.teamClaimSkipFor(1, prId, 'head1')).toBeNull();
    // Another Limn reads it as free.
    expect(tc.decideTeamClaim(await f.gh.listLines(1, 'acme', 'api', 'head1', 'limn/review-claude'), 'carol', later).kind).toBe('free');
    // Never twice, even if the skip were remembered again.
    const n = f.posts.length;
    await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, { ...f.gh, listLines: async () => [{ id: 2, state: 'pending', description: 'x', createdAtMs: NOW - MIN, login: 'bob' }] });
    await rel.releaseExpiredTeammateLines(ctx, { ...notBusy, gh: f.gh, nowMs: later });
    expect(f.posts).toHaveLength(n);
  });

  it('a workspace with team claims OFF releases nothing of a teammate', async () => {
    const f = fakeGh();
    f.seed('limn/review-claude', { id: 1, state: 'pending', description: 'bob is reviewing with Claude', createdAtMs: NOW - 5 * MIN, login: 'bob' });
    await tc.claimBeforeAutoRun(ctx, target(), { nowMs: () => NOW }, f.gh);
    await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: false });
    const res = await rel.releaseExpiredTeammateLines(ctx, { ...notBusy, gh: f.gh, nowMs: NOW + 40 * MIN });
    expect(res.released).toBe(0);
    expect(f.posts).toEqual([]);
  });
});

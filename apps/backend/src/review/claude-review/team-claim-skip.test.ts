// THE SKIPPED LINE (team-claim-skip.ts; docs/CLAUDE-REVIEW.md § Team claims → The skipped line) — the
// wording, the fold reading it as FREE, and the post over a THROWAWAY sqlite DB with GitHub faked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import {
  TEAM_CLAIM_DESCRIPTION_MAX,
  decideTeamClaim,
  skippedLine,
  type TeamClaimGithub,
  type TeamClaimLine,
  type TeamClaimPost,
} from './team-claim.js';

const DIR = mkdtempSync(join(tmpdir(), 'limn-team-claim-skip-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const MIN = 60_000;
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime(); // local time: the line reads the reader's clock

describe('the skipped line', () => {
  it('names the login and the reason, starts "Cleared by ", stays within 140 characters', () => {
    expect(skippedLine('alex', 'budget', 'claude')).toBe('Cleared by alex: auto review skipped · AI budget used');
    expect(skippedLine('alex', 'daily_cap', 'codex')).toBe('Cleared by alex: auto review skipped · daily auto-review limit reached');
    expect(skippedLine('alex', 'usage_limit', 'codex', { untilMs: new Date(2026, 10, 4, 15, 40).getTime(), nowMs: NOW })).toBe(
      'Cleared by alex: auto review skipped · Codex over its usage limit until 15:40',
    );
    // Another day: the weekday is named.
    expect(skippedLine('alex', 'usage_limit', 'claude', { untilMs: new Date(2026, 10, 5, 9, 5).getTime(), nowMs: NOW })).toBe(
      'Cleared by alex: auto review skipped · Claude over its usage limit until Thu 09:05',
    );
    expect(skippedLine('alex', 'usage_limit', 'claude')).toBe('Cleared by alex: auto review skipped · Claude over its usage limit');
    expect(skippedLine('alex', 'not_ready', 'claude')).toBe('Cleared by alex: auto review skipped · Claude not signed in');
    expect(skippedLine('alex', 'not_ready', 'codex', { notSetUp: true })).toBe('Cleared by alex: auto review skipped · Codex not set up');
    expect(skippedLine('x'.repeat(300), 'budget', 'claude').length).toBe(TEAM_CLAIM_DESCRIPTION_MAX);
  });

  it("a teammate's skipped line is FREE — in this fold, in an older Limn's, and in the bare wording", () => {
    const l = (description: string): TeamClaimLine => ({ id: 1, state: 'success', description, createdAtMs: NOW - MIN, login: 'bob' });
    for (const reason of ['budget', 'daily_cap', 'usage_limit', 'not_ready'] as const) {
      const d = skippedLine('bob', reason, 'claude');
      expect(decideTeamClaim([l(d)], 'me', NOW).kind).toBe('free');
      // Every Limn up to 0.1.140 reads a success as free only when it starts "Cleared by ".
      expect(d.startsWith('Cleared by ')).toBe(true);
    }
    expect(decideTeamClaim([l('bob skipped · weekly AI budget used')], 'me', NOW).kind).toBe('free');
    // Over a teammate's earlier pending claim, it settles the race: free.
    const pending: TeamClaimLine = { id: 0, state: 'pending', description: 'carol is reviewing with Claude', createdAtMs: NOW - 2 * MIN, login: 'carol' };
    expect(decideTeamClaim([pending, l(skippedLine('bob', 'budget', 'claude'))], 'me', NOW).kind).toBe('free');
  });

  it('is never CI: its context carries the limn/ prefix', async () => {
    const { isLimnStatusContext } = await import('@pierre-review/shared');
    const { teamClaimContext } = await import('./team-claim.js');
    expect(isLimnStatusContext(teamClaimContext('claude'))).toBe(true);
    expect(isLimnStatusContext(teamClaimContext('codex'))).toBe(true);
  });
});

// ---- the post, over a real DB ----

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let m: typeof import('./team-claim-skip.js');
let settings: typeof import('./auto-settings.js');
let ctx: AgentContext;
let workspaceId = 0;
let repoId = 0;
let prSeq = 0;

function fakeGh(opts: { readFails?: unknown; postFails?: unknown; login?: string | null } = {}) {
  const lines: Record<string, TeamClaimLine[]> = {};
  const posts: Array<{ context: string; sha: string } & TeamClaimPost> = [];
  let id = 1;
  const gh: TeamClaimGithub = {
    async listLines(_a, _o, _n, sha, context) {
      if (opts.readFails) throw opts.readFails;
      return [...(lines[`${sha}|${context}`] ?? [])];
    },
    async postLine(_a, _o, _n, sha, context, post) {
      if (opts.postFails) throw opts.postFails;
      posts.push({ context, sha, ...post });
      (lines[`${sha}|${context}`] ??= []).push({ id: id++, state: post.state, description: post.description, createdAtMs: NOW, login: 'me' });
    },
    async login() {
      return opts.login === undefined ? 'me' : opts.login;
    },
  };
  return { gh, posts, seed: (sha: string, context: string, l: TeamClaimLine) => (lines[`${sha}|${context}`] ??= []).push(l) };
}

async function makePr(over: Record<string, unknown> = {}): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_skip_${prSeq}`,
      accountId: 1,
      repoId,
      number: prSeq,
      title: 't',
      state: 'open',
      isDraft: false,
      headSha: `head${prSeq}`,
      openedAt: new Date(NOW - 3_600_000),
      updatedAt: new Date(NOW - 3_600_000),
      ...over,
    })
    .returning()
    .execute();
  return p.id;
}

async function rows(prId: number): Promise<any[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.teamClaimSkipLines).where(eq(schema.teamClaimSkipLines.prId, prId)).execute();
}

beforeAll(async () => {
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  m = await import('./team-claim-skip.js');
  settings = await import('./auto-settings.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'me' } })
    .execute();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_skip', createdAt: new Date(NOW - 86_400_000) })
    .returning()
    .execute();
  repoId = repo.id;
  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  ctx = { db, schema, log: { info: () => {}, warn: () => {}, error: () => {} } } as any as AgentContext;
});

afterAll(async () => {
  m?._setSkipLineGithubForTest(null);
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: true });
});

describe('postAutoSkipLines', () => {
  it('each reason posts ONE green line, once per (PR, head, provider, reason)', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    const until = new Date(2026, 10, 4, 15, 40).getTime();
    const out = await m.postAutoSkipLines(
      ctx,
      { accountId: 1, prId: pr },
      [
        { provider: 'claude', reason: 'budget' },
        { provider: 'codex', reason: 'usage_limit', untilMs: until },
      ],
      NOW,
    );
    expect(out).toEqual(['posted', 'posted']);
    expect(f.posts).toEqual([
      { context: 'limn/review-claude', sha: `head${prSeq}`, state: 'success', description: 'Cleared by me: auto review skipped · AI budget used' },
      {
        context: 'limn/review-codex',
        sha: `head${prSeq}`,
        state: 'success',
        description: 'Cleared by me: auto review skipped · Codex over its usage limit until 15:40',
      },
    ]);
    expect((await rows(pr)).map((r) => [r.provider, r.reason, r.state])).toEqual([
      ['claude', 'budget', 'posted'],
      ['codex', 'usage_limit', 'posted'],
    ]);
    // The same head and reason again: nothing more.
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['already']);
    // Another reason at the same head: one more line (over our own skipped line, which is free).
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'daily_cap' }], NOW)).toEqual(['posted']);
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'not_ready' }], NOW)).toEqual(['posted']);
    expect(f.posts.map((p) => p.description)).toEqual([
      'Cleared by me: auto review skipped · AI budget used',
      'Cleared by me: auto review skipped · Codex over its usage limit until 15:40',
      'Cleared by me: auto review skipped · daily auto-review limit reached',
      'Cleared by me: auto review skipped · Claude not signed in',
    ]);
    expect(f.posts.every((p) => p.state === 'success')).toBe(true);
  });

  it('posts nothing while team claims are off for the workspace', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    await settings.setWorkspaceAutoReview(ctx, 1, workspaceId, { teamClaimsEnabled: false });
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['off']);
    expect(f.posts).toEqual([]);
    expect(await rows(pr)).toEqual([]);
  });

  it('never over a line that means something: a pending claim, or a "reviewed" line — recorded, not re-read', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const a = await makePr();
    f.seed(`head${prSeq}`, 'limn/review-claude', { id: 1, state: 'pending', description: 'bob is reviewing with Claude', createdAtMs: NOW - MIN, login: 'bob' });
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: a }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['not_needed']);
    const b = await makePr();
    f.seed(`head${prSeq}`, 'limn/review-claude', { id: 2, state: 'success', description: 'bob reviewed · 2 comments', createdAtMs: NOW - MIN, login: 'bob' });
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: b }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['not_needed']);
    // A free line (a teammate's Clear) is fine to follow.
    const c = await makePr();
    f.seed(`head${prSeq}`, 'limn/review-claude', { id: 3, state: 'success', description: 'Cleared by bob', createdAtMs: NOW - MIN, login: 'bob' });
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: c }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['posted']);
    expect(f.posts).toHaveLength(1);
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: a }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['already']);
  });

  it('a failed write is recorded and never retried', async () => {
    const f = fakeGh({ postFails: Object.assign(new Error('boom'), { status: 500 }) });
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'daily_cap' }], NOW)).toEqual(['failed']);
    expect((await rows(pr)).map((r) => [r.state, r.lastError])).toEqual([['failed', 'boom']]);
    const ok = fakeGh();
    m._setSkipLineGithubForTest(ok.gh);
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'daily_cap' }], NOW)).toEqual(['already']);
    expect(ok.posts).toEqual([]);
  });

  it('never on a draft, a closed PR, a bot-authored PR, a moved head, or a head this account already reviewed', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const one = (prId: number, headSha?: string) =>
      m.postAutoSkipLines(ctx, { accountId: 1, prId, ...(headSha ? { headSha } : {}) }, [{ provider: 'claude', reason: 'budget' }], NOW);
    expect(await one(await makePr({ isDraft: true }))).toEqual(['not_eligible']);
    expect(await one(await makePr({ state: 'closed' }))).toEqual(['not_eligible']);
    const [bot] = await db.insert(schema.users).values({ githubLogin: 'renovate[bot]', githubNodeId: 'U_skip_bot', isBot: true }).returning().execute();
    expect(await one(await makePr({ authorId: bot.id }))).toEqual(['not_eligible']);
    expect(await one(await makePr(), 'an-older-head')).toEqual(['not_eligible']);
    const reviewed = await makePr();
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId: reviewed, headSha: `head${prSeq}`, status: 'failed', model: 'm', provider: 'claude', trigger: 'auto' })
      .execute();
    expect(await one(reviewed)).toEqual(['not_eligible']);
    expect(f.posts).toEqual([]);
  });

  it('no GitHub login known: nothing is written or recorded (a later tick may try)', async () => {
    const f = fakeGh({ login: null });
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    expect(await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'budget' }], NOW)).toEqual(['no_login']);
    expect(await rows(pr)).toEqual([]);
  });

  it('a later run at the head claims over it as usual (the skipped line is ours, so free)', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'budget' }], NOW);
    const tc = await import('./team-claim.js');
    const r = await tc.claimBeforeAutoRun(
      ctx,
      { accountId: 1, prId: pr, owner: 'acme', name: 'api', number: prSeq, headSha: `head${prSeq}`, provider: 'claude', authorLogin: null },
      { nowMs: () => NOW + MIN },
      f.gh,
    );
    expect(r.kind).toBe('run');
    expect(f.posts.map((p) => [p.state, p.description])).toEqual([
      ['success', 'Cleared by me: auto review skipped · AI budget used'],
      ['pending', 'me is reviewing with Claude'],
    ]);
  });

  it('the delete paths and the erasure take its rows', async () => {
    const f = fakeGh();
    m._setSkipLineGithubForTest(f.gh);
    const pr = await makePr();
    await m.postAutoSkipLines(ctx, { accountId: 1, prId: pr }, [{ provider: 'claude', reason: 'budget' }], NOW);
    expect(await rows(pr)).toHaveLength(1);
    const { deleteSettledClaimLinesForPrs } = await import('../../db/team-claim-lines-delete.js');
    await deleteSettledClaimLinesForPrs(db, [pr]);
    expect(await rows(pr)).toEqual([]);
  });
});

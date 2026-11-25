// THE STORY CHECK'S OWN TEAM CLAIM (story-claim.ts; docs/TEAM-REVIEW.md § The story check's own claim) —
// the pure rule, the wording and its free reads, the summary, and the lifecycle over a THROWAWAY sqlite
// DB with GitHub faked (no live writes). Pinned:
//   • ONE context, `ensemble/story-check`, separate from the review contexts and never CI;
//   • a teammate holds the story check only when they hold EVERY open member head;
//   • a reader with story checks whose teammate holds the REVIEW context still claims the story context;
//   • the lifecycle mirrors the review claim: ledger first, re-read, stand down only when every claimed
//     head is lost, never-blind final line, the reconciler releases an orphaned row, a teammate's expired
//     line is released once.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLimnStatusContext, rollupStateWithoutLimn, sameStatusContext } from '@pierre-review/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import {
  STORY_CLAIM_KEY,
  TEAM_CLAIM_LEASE_MS,
  TEAM_CLAIM_REVIEWED_RECHECK_MS,
  claimKeyContext,
  claimKeyOf,
  isFreeTeamClaimLine,
  releasedLine,
  reviewedLine,
  reviewingLine,
  skippedLine,
  storyCheckedLine,
  storyCheckingLine,
  storyClaimContext,
  storyUnfinishedLine,
  teamClaimContext,
  unfinishedLineFor,
  type TeamClaimGithub,
  type TeamClaimLine,
  type TeamClaimPost,
} from '../claude-review/team-claim.js';
import { decideStoryClaim, storyCheckedSummary, storyHeadsKey, storyRecheckAtMs, type StoryClaimHead } from './story-claim.js';
import { ticketAutoCheckPlan, toWireAutoCheck, type TicketAutoPlanInputs } from './auto-plan.js';

const DIR = mkdtempSync(join(tmpdir(), 'ensemble-story-claim-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
let nextId = 1;
const line = (login: string | null, state: string, atMs: number, description = `${login} is checking the story`): TeamClaimLine => ({
  id: nextId++,
  state,
  description,
  createdAtMs: atMs,
  login,
});

describe('the story context', () => {
  it('is ONE ensemble/ context, apart from the review contexts, and never CI', () => {
    expect(storyClaimContext()).toBe('ensemble/story-check');
    expect(claimKeyContext(STORY_CLAIM_KEY)).toBe('ensemble/story-check');
    expect(claimKeyContext('claude')).toBe(teamClaimContext('claude'));
    expect(isLimnStatusContext(storyClaimContext())).toBe(true);
    expect(isLimnStatusContext('limn/story-check')).toBe(true);
    expect(sameStatusContext('limn/story-check', storyClaimContext())).toBe(true);
    expect(sameStatusContext(storyClaimContext(), teamClaimContext('claude'))).toBe(false);
    expect(sameStatusContext(storyClaimContext(), teamClaimContext('codex'))).toBe(false);
    // A head pending ONLY because of a story claim is not CI running.
    expect(
      rollupStateWithoutLimn('PENDING', [
        { name: 'ensemble/story-check', state: 'pending' },
        { name: 'build', state: 'success' },
      ]),
    ).toBe('SUCCESS');
    expect(rollupStateWithoutLimn('PENDING', [{ name: 'ensemble/story-check', state: 'pending' }])).toBeNull();
  });

  it('reads the ledger key back; anything else is a review provider as before', () => {
    expect(claimKeyOf('story')).toBe('story');
    expect(claimKeyOf('codex')).toBe('codex');
    expect(claimKeyOf('claude')).toBe('claude');
    expect(claimKeyOf('weird')).toBe('claude');
  });
});

describe('wording', () => {
  it('says the fact and stops', () => {
    expect(storyCheckingLine('alex')).toBe('alex is checking the story');
    expect(storyCheckedLine('alex', 3)).toBe('alex checked the story · 3 gaps');
    expect(storyCheckedLine('alex', 1)).toBe('alex checked the story · 1 gap');
    expect(storyCheckedLine('alex', 0)).toBe('alex checked the story · no gaps');
    expect(storyCheckedLine('alex', 0, true)).toBe('alex checked the story · no new gaps');
    expect(storyCheckedLine('alex', null)).toBe('alex checked the story · kept in Ensemble');
    expect(storyUnfinishedLine('alex')).toBe("Cleared by alex: story check didn't finish · free to claim");
    expect(unfinishedLineFor('story', 'alex')).toBe(storyUnfinishedLine('alex'));
    expect(unfinishedLineFor('claude', 'alex')).toBe("Cleared by alex: review didn't finish · free to claim");
  });

  it('reads the free lines as free and the checked lines as holding', () => {
    const at = NOW;
    expect(isFreeTeamClaimLine(line('bob', 'success', at, storyCheckedLine('bob', null)))).toBe(true);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, storyUnfinishedLine('bob')))).toBe(true);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, releasedLine('carol', 'bob')))).toBe(true);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, storyCheckedLine('bob', 2)))).toBe(false);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, storyCheckedLine('bob', 0)))).toBe(false);
    expect(isFreeTeamClaimLine(line('bob', 'pending', at, storyCheckingLine('bob')))).toBe(false);
    // The review's own reads are unchanged.
    expect(isFreeTeamClaimLine(line('bob', 'success', at, reviewedLine('bob', null)))).toBe(true);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, reviewedLine('bob', 2)))).toBe(false);
    expect(isFreeTeamClaimLine(line('bob', 'success', at, skippedLine('bob', 'budget', 'claude')))).toBe(true);
  });
});

describe('decideStoryClaim (the one rule)', () => {
  it('no head ⇒ claim nothing (the check runs without a line)', () => {
    expect(decideStoryClaim([], 'me', NOW)).toEqual({ kind: 'claim', heads: [] });
  });

  it('free heads are claimed', () => {
    expect(decideStoryClaim([[], []], 'me', NOW)).toEqual({ kind: 'claim', heads: [0, 1] });
  });

  it('a teammate who checked EVERY head holds the story check', () => {
    const d = decideStoryClaim(
      [[line('bob', 'success', NOW - 5 * MIN, storyCheckedLine('bob', 2))], [line('bob', 'success', NOW - 4 * MIN, storyCheckedLine('bob', 2))]],
      'me',
      NOW,
    );
    expect(d).toMatchObject({ kind: 'held', holder: { kind: 'reviewed', login: 'bob', leaseEndsAtMs: null } });
  });

  it('a live claim names the holder over a finished one, earliest lease first', () => {
    const d = decideStoryClaim(
      [
        [line('bob', 'success', NOW - 5 * MIN, storyCheckedLine('bob', 0))],
        [line('carol', 'pending', NOW - 10 * MIN)],
        [line('dan', 'pending', NOW - 2 * MIN)],
      ],
      'me',
      NOW,
    );
    expect(d).toMatchObject({ kind: 'held', holder: { kind: 'reviewing', login: 'carol', leaseEndsAtMs: NOW - 10 * MIN + TEAM_CLAIM_LEASE_MS } });
  });

  it('⚠ a push to ONE member frees that head: the check is anyone\'s again', () => {
    const d = decideStoryClaim([[line('bob', 'success', NOW - 5 * MIN, storyCheckedLine('bob', 2))], []], 'me', NOW);
    expect(d).toEqual({ kind: 'claim', heads: [1] });
  });

  it("a kept-in-Ensemble or unfinished line holds nothing; a lapsed lease frees the head", () => {
    expect(decideStoryClaim([[line('bob', 'success', NOW - MIN, storyCheckedLine('bob', null))]], 'me', NOW)).toEqual({ kind: 'claim', heads: [0] });
    expect(decideStoryClaim([[line('bob', 'success', NOW - MIN, storyUnfinishedLine('bob'))]], 'me', NOW)).toEqual({ kind: 'claim', heads: [0] });
    expect(decideStoryClaim([[line('bob', 'pending', NOW - TEAM_CLAIM_LEASE_MS - MIN)]], 'me', NOW)).toEqual({ kind: 'claim', heads: [0] });
  });

  it("the reader's own live claim (a restart, another machine) is theirs to take", () => {
    expect(decideStoryClaim([[line('me', 'pending', NOW - MIN)]], 'me', NOW)).toEqual({ kind: 'claim', heads: [0] });
  });

  it("⚠ a review claim on the same head never holds the story check (separate contexts)", () => {
    // The story fold only ever sees ensemble/story-check lines: a teammate's review lines are not in it.
    expect(decideStoryClaim([[]], 'me', NOW)).toEqual({ kind: 'claim', heads: [0] });
  });

  it('the race under one pending line: the earliest live claimant holds the head', () => {
    const lines = [line('me', 'pending', NOW - MIN, storyCheckingLine('me')), line('bob', 'pending', NOW - 2 * MIN)];
    expect(decideStoryClaim([lines], 'me', NOW)).toMatchObject({ kind: 'held', holder: { login: 'bob' } });
  });

  it('rechecks at the lease end, or after the "checked" wait', () => {
    expect(storyRecheckAtMs({ kind: 'reviewing', login: 'b', atMs: 0, leaseEndsAtMs: NOW + MIN, description: null }, NOW)).toBe(NOW + MIN + 30_000);
    expect(storyRecheckAtMs({ kind: 'reviewed', login: 'b', atMs: 0, leaseEndsAtMs: null, description: null }, NOW)).toBe(
      NOW + TEAM_CLAIM_REVIEWED_RECHECK_MS,
    );
    expect(storyHeadsKey([{ prId: 2, headSha: 'b' }, { prId: 1, headSha: 'a' }])).toBe(storyHeadsKey([{ prId: 1, headSha: 'a' }, { prId: 2, headSha: 'b' }]));
  });
});

describe('storyCheckedSummary (what the final line says)', () => {
  const run = (items: number, notRequested = 0, status = 'succeeded') => ({
    status,
    items: Array.from({ length: items }, () => ({})),
    assessment: { notRequested: Array.from({ length: notRequested }, () => ({})) },
  });
  const done = (posted: number, nr: Array<{ carried: boolean; commentId: string | null }> = []) =>
    ({
      kind: 'done',
      record: { status: 'posted', at: '', reason: null, error: null, itemIds: [], postedItemIds: Array.from({ length: posted }, (_, i) => i), notRequested: nr },
    }) as never;

  it('a run that did not succeed is unfinished', () => {
    expect(storyCheckedSummary(null, null)).toEqual({ kind: 'unfinished' });
    expect(storyCheckedSummary(run(2, 0, 'failed'), null)).toEqual({ kind: 'unfinished' });
  });
  it('gaps posted ⇒ counted (a carried "not asked for" entry is not this run\'s)', () => {
    expect(storyCheckedSummary(run(3), done(2, [{ carried: false, commentId: '9' }, { carried: true, commentId: '8' }]))).toEqual({ kind: 'succeeded', gaps: 3 });
  });
  it('⚠ gaps found but nothing reached GitHub ⇒ kept (free for a teammate)', () => {
    expect(storyCheckedSummary(run(2), { kind: 'off' })).toEqual({ kind: 'succeeded', gaps: null });
    expect(storyCheckedSummary(run(2), done(0))).toEqual({ kind: 'succeeded', gaps: null });
    expect(storyCheckedSummary(run(2), { kind: 'skipped', reason: 'no_owner' })).toEqual({ kind: 'succeeded', gaps: null });
  });
  it('nothing new to post ⇒ "no new gaps"; none found ⇒ "no gaps"', () => {
    expect(storyCheckedSummary(run(2), { kind: 'skipped', reason: 'nothing_new' })).toEqual({ kind: 'succeeded', gaps: 0, alreadyPosted: true });
    expect(storyCheckedSummary(run(0), { kind: 'skipped', reason: 'nothing_new' })).toEqual({ kind: 'succeeded', gaps: 0 });
    expect(storyCheckedSummary(run(0), { kind: 'off' })).toEqual({ kind: 'succeeded', gaps: 0 });
  });
});

describe('the automatic plan', () => {
  const base: TicketAutoPlanInputs = {
    running: false,
    needsRun: true,
    autoOn: true,
    tooManyPrs: false,
    alreadyTried: false,
    first: false,
    allMet: false,
    floorOk: true,
    aiReady: true,
    overBudget: false,
    changes: [],
    lastRunAtMs: null,
    laneRoom: 5,
  };
  it('a teammate holding every head HOLDS the check (no time promised) and the wire names them', () => {
    const p = ticketAutoCheckPlan({ ...base, teammate: { kind: 'reviewed', login: 'robin' } }, NOW);
    expect(p).toMatchObject({ status: 'held', reason: 'teammate', due: false, startsAtMs: null });
    expect(toWireAutoCheck(p)).toMatchObject({ status: 'held', reason: 'teammate', teammate: { kind: 'reviewed', login: 'robin' } });
    expect(ticketAutoCheckPlan({ ...base, teammate: null }, NOW)).toMatchObject({ status: 'due' });
    expect(toWireAutoCheck(ticketAutoCheckPlan(base, NOW))).not.toHaveProperty('teammate');
  });
  it('up to date / off reasons still come first', () => {
    expect(ticketAutoCheckPlan({ ...base, needsRun: false, teammate: { kind: 'reviewed', login: 'r' } }, NOW).status).toBe('up_to_date');
    expect(ticketAutoCheckPlan({ ...base, autoOn: false, teammate: { kind: 'reviewed', login: 'r' } }, NOW).reason).toBe('auto_off');
  });
});

// ---- the lifecycle, over a real DB ----

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let sc: typeof import('./story-claim.js');
let ctx: AgentContext;
const prIds: number[] = [];

/** A fake GitHub: one in-memory status list per (sha, context); optional failures. */
function fakeGh(opts: { readFails?: (sha: string) => unknown; postFails?: unknown; login?: string | null } = {}) {
  const lines: Record<string, TeamClaimLine[]> = {};
  const posts: Array<{ sha: string; context: string } & TeamClaimPost> = [];
  let reads = 0;
  let clock = NOW;
  let id = 1000;
  const k = (sha: string, context: string) => `${sha}|${context}`;
  const gh: TeamClaimGithub = {
    async listLines(_a, _o, _n, sha, context) {
      reads += 1;
      const f = opts.readFails?.(sha);
      if (f) throw f;
      return Object.entries(lines)
        .filter(([key]) => {
          const [s, c] = key.split('|');
          return s === sha && sameStatusContext(c, context);
        })
        .flatMap(([key, ls]) => ls.map((l) => ({ ...l, context: key.split('|')[1] })));
    },
    async postLine(_a, _o, _n, sha, context, post) {
      if (opts.postFails) throw opts.postFails;
      posts.push({ sha, context, ...post });
      (lines[k(sha, context)] ??= []).push({ id: id++, state: post.state, description: post.description, createdAtMs: clock, login: opts.login ?? 'me' });
    },
    async login() {
      return opts.login === undefined ? 'me' : opts.login;
    },
  };
  return {
    gh,
    posts,
    reads: () => reads,
    seed: (sha: string, l: TeamClaimLine, context = storyClaimContext()) => (lines[k(sha, context)] ??= []).push(l),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const heads = (): StoryClaimHead[] => [
  { prId: prIds[0]!, owner: 'acme', name: 'api', number: 7, headSha: 'h1' },
  { prId: prIds[1]!, owner: 'acme', name: 'web', number: 8, headSha: 'h2' },
];
const target = (h = heads()) => ({ accountId: 1, ident: 'jira:acme:PAY-1', heads: h });
const now = () => NOW;

async function storyRows(): Promise<any[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.teamClaimLines).where(eq(schema.teamClaimLines.provider, 'story')).execute();
}

beforeAll(async () => {
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  sc = await import('./story-claim.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'me' } })
    .execute();
  for (const [name, number, sha] of [
    ['api', 7, 'h1'],
    ['web', 8, 'h2'],
  ] as const) {
    const [repo] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}`, createdAt: new Date(NOW - 86_400_000) })
      .returning()
      .execute();
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_${name}`,
        accountId: 1,
        repoId: repo.id,
        number,
        title: 't',
        state: 'open',
        isDraft: false,
        headSha: sha,
        openedAt: new Date(NOW - 3_600_000),
        updatedAt: new Date(NOW - 3_600_000),
      })
      .returning()
      .execute();
    prIds.push(p.id);
  }
  ctx = { db, schema, log: { info: () => {}, warn: () => {}, error: () => {} } } as any as AgentContext;
});

beforeEach(async () => {
  sc._resetStoryClaimsForTest();
  await db.delete(schema.teamClaimLines).execute();
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

describe('storyClaimHeads', () => {
  it('the open members with a head, in this account, ordered by repository and number', async () => {
    const h = await sc.storyClaimHeads(ctx, 1, [
      { prId: prIds[1]!, headSha: 'h2', state: 'open' },
      { prId: prIds[0]!, headSha: 'h1', state: 'open' },
      { prId: 999, headSha: 'x', state: 'open' },
      { prId: prIds[0]!, headSha: '', state: 'open' },
    ]);
    expect(h.map((x) => `${x.owner}/${x.name}#${x.number}@${x.headSha}`)).toEqual(['acme/api#7@h1', 'acme/web#8@h2']);
    expect(await sc.storyClaimHeads(ctx, 1, [{ prId: prIds[0]!, headSha: 'h1', state: 'merged' }])).toEqual([]);
  });
});

describe('claim → finish', () => {
  it('claims every free head (ledger first), holds them, and settles them with the checked line', async () => {
    const f = fakeGh();
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    if (start.kind !== 'run') return;
    expect(f.posts.map((p) => [p.sha, p.context, p.state, p.description])).toEqual([
      ['h1', 'ensemble/story-check', 'pending', 'me is checking the story'],
      ['h2', 'ensemble/story-check', 'pending', 'me is checking the story'],
    ]);
    const rows = await storyRows();
    expect(rows.map((r) => r.state)).toEqual(['pending', 'pending']);
    expect(sc.storyClaimBusy(1, prIds[0]!, 'h1')).toBe(true);
    await sc.finishStoryClaim(ctx, start.handle, { kind: 'succeeded', gaps: 2 }, f.gh, now);
    expect(f.posts.slice(2).map((p) => [p.sha, p.state, p.description])).toEqual([
      ['h1', 'success', 'me checked the story · 2 gaps'],
      ['h2', 'success', 'me checked the story · 2 gaps'],
    ]);
    expect((await storyRows()).map((r) => r.state)).toEqual(['finished', 'finished']);
    expect(sc.storyClaimBusy(1, prIds[0]!, 'h1')).toBe(false);
    // Once only.
    await sc.finishStoryClaim(ctx, start.handle, { kind: 'unfinished' }, f.gh, now);
    expect(f.posts).toHaveLength(4);
  });

  it('a check that did not finish releases every head', async () => {
    const f = fakeGh();
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    if (start.kind !== 'run') throw new Error('expected run');
    await sc.finishStoryClaim(ctx, start.handle, { kind: 'unfinished' }, f.gh, now);
    expect(f.posts.slice(2).map((p) => p.description)).toEqual([storyUnfinishedLine('me'), storyUnfinishedLine('me')]);
    expect((await storyRows()).map((r) => r.state)).toEqual(['released', 'released']);
  });

  it('⚠ a teammate who has the REVIEW contexts does not hold the story check', async () => {
    const f = fakeGh();
    f.seed('h1', line('bob', 'success', NOW - 5 * MIN, reviewedLine('bob', 3)), teamClaimContext('claude'));
    f.seed('h1', line('bob', 'pending', NOW - MIN, reviewingLine('bob', 'codex')), teamClaimContext('codex'));
    f.seed('h2', line('bob', 'success', NOW - 5 * MIN, reviewedLine('bob', 1)), teamClaimContext('claude'));
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    expect(f.posts.every((p) => p.context === 'ensemble/story-check')).toBe(true);
    if (start.kind === 'run') await sc.finishStoryClaim(ctx, start.handle, { kind: 'unfinished' }, f.gh, now);
  });

  it('no login ⇒ runs without a line', async () => {
    const f = fakeGh({ login: null });
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    expect(f.posts).toEqual([]);
    expect(f.reads()).toBe(0);
  });

  it('an unreadable head gets no line; the others are claimed', async () => {
    const f = fakeGh({ readFails: (sha) => (sha === 'h2' ? new Error('boom') : null) });
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    expect(f.posts.map((p) => p.sha)).toEqual(['h1']);
    if (start.kind === 'run') await sc.finishStoryClaim(ctx, start.handle, { kind: 'succeeded', gaps: 0 }, f.gh, now);
  });

  it('a refused write (no access) runs without a line and closes the row', async () => {
    const f = fakeGh({ postFails: Object.assign(new Error('Forbidden'), { status: 403 }) });
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    expect((await storyRows()).map((r) => [r.state, r.lastError])).toEqual([
      ['released', 'no_access'],
      ['released', 'no_access'],
    ]);
    if (start.kind === 'run') await sc.finishStoryClaim(ctx, start.handle, { kind: 'succeeded', gaps: 1 }, f.gh, now);
  });
});

describe('a teammate holds the story check', () => {
  it('every head held ⇒ skip with no write; remembered; a moved head reads again and claims', async () => {
    const f = fakeGh();
    f.seed('h1', line('bob', 'success', NOW - 5 * MIN, storyCheckedLine('bob', 2)));
    f.seed('h2', line('bob', 'success', NOW - 5 * MIN, storyCheckedLine('bob', 2)));
    const first = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(first).toMatchObject({ kind: 'skip', skip: { kind: 'reviewed', login: 'bob' } });
    expect(f.posts).toEqual([]);
    expect(await storyRows()).toEqual([]);
    expect(sc.storyClaimBusy(1, prIds[0]!, 'h1')).toBe(false);
    // The states route reads the memory at these heads only.
    expect(sc.storyClaimSkipFor(1, 'jira:acme:PAY-1', heads(), NOW)).toMatchObject({ login: 'bob' });
    expect(sc.storyClaimSkipFor(1, 'jira:acme:PAY-1', heads(), NOW + TEAM_CLAIM_REVIEWED_RECHECK_MS)).toBeNull();
    // Again at the same heads: no GitHub read.
    const reads = f.reads();
    expect((await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh)).kind).toBe('skip');
    expect(f.reads()).toBe(reads);
    // A push to web#8: its new head is free.
    const moved = [heads()[0]!, { ...heads()[1]!, headSha: 'h3' }];
    expect(sc.storyClaimSkipFor(1, 'jira:acme:PAY-1', moved, NOW)).toBeNull();
    const again = await sc.claimStoryBeforeAutoRun(ctx, target(moved), { nowMs: now }, f.gh);
    expect(again.kind).toBe('run');
    expect(f.posts.map((p) => [p.sha, p.state])).toEqual([['h3', 'pending']]);
    if (again.kind === 'run') await sc.finishStoryClaim(ctx, again.handle, { kind: 'unfinished' }, f.gh, now);
  });

  it('⚠ the race lost on EVERY claimed head ⇒ stand down, re-post the winner, close the rows', async () => {
    const f = fakeGh();
    // Bob's claims land between our read and our re-read, earlier than ours (a clock skew).
    const orig = f.gh.postLine;
    let seeded = false;
    f.gh.postLine = async (...args) => {
      await orig(...args);
      if (!seeded && args[5].state === 'pending') {
        seeded = true;
        f.seed('h1', line('bob', 'pending', NOW - MIN, storyCheckingLine('bob')));
        f.seed('h2', line('bob', 'pending', NOW - MIN, storyCheckingLine('bob')));
      }
    };
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start).toMatchObject({ kind: 'skip', skip: { kind: 'reviewing', login: 'bob' } });
    expect(f.posts.filter((p) => p.description === 'bob is checking the story').map((p) => p.sha)).toEqual(['h1', 'h2']);
    expect((await storyRows()).map((r) => [r.state, r.lastError])).toEqual([
      ['released', 'stood down'],
      ['released', 'stood down'],
    ]);
    expect(sc.storyClaimBusy(1, prIds[0]!, 'h1')).toBe(false);
  });

  it('a split race (won one head, lost the other) still runs — a duplicate, never a check nobody runs', async () => {
    const f = fakeGh();
    const orig = f.gh.postLine;
    let seeded = false;
    f.gh.postLine = async (...args) => {
      await orig(...args);
      if (!seeded && args[5].state === 'pending') {
        seeded = true;
        f.seed('h2', line('bob', 'pending', NOW - MIN, storyCheckingLine('bob')));
      }
    };
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    expect(start.kind).toBe('run');
    if (start.kind !== 'run') return;
    expect(start.handle.heads.map((s) => s.marked)).toEqual([true, false]);
    await sc.finishStoryClaim(ctx, start.handle, { kind: 'succeeded', gaps: 0 }, f.gh, now);
    // Only the head it held gets the final line.
    expect(f.posts.filter((p) => p.state === 'success').map((p) => p.sha)).toEqual(['h1']);
  });

  it('⚠ never blind: a teammate who checked a head since our claim keeps it — nothing is posted there', async () => {
    const f = fakeGh();
    const start = await sc.claimStoryBeforeAutoRun(ctx, target(), { nowMs: now }, f.gh);
    if (start.kind !== 'run') throw new Error('expected run');
    f.tick(TEAM_CLAIM_LEASE_MS + MIN); // our laptop slept past the lease
    f.seed('h1', line('bob', 'success', NOW + TEAM_CLAIM_LEASE_MS, storyCheckedLine('bob', 1)));
    await sc.finishStoryClaim(ctx, start.handle, { kind: 'succeeded', gaps: 2 }, f.gh, () => NOW + TEAM_CLAIM_LEASE_MS + MIN);
    expect(f.posts.filter((p) => p.state === 'success').map((p) => p.sha)).toEqual(['h2']);
    const rows = await storyRows();
    expect(rows.find((r) => r.headSha === 'h1')).toMatchObject({ state: 'finished', lastError: 'superseded' });
  });
});

describe('the reconciler and teammates’ expired lines', () => {
  it("releases an orphaned story row on the story context with the story's words; a held one is left", async () => {
    const f = fakeGh();
    const start = await sc.claimStoryBeforeAutoRun(ctx, target([heads()[0]!]), { nowMs: now }, f.gh);
    if (start.kind !== 'run') throw new Error('expected run');
    const rel = await import('../claude-review/team-claim-release.js');
    rel._resetTeamClaimReleaseForTest();
    const busyReview: string[] = [];
    const deps = {
      busy: (_a: number, _p: number, provider: string) => {
        busyReview.push(provider);
        return false;
      },
      storyBusy: sc.storyClaimBusy,
      gh: f.gh,
      nowMs: NOW,
    };
    expect((await rel.releaseStaleOwnClaims(ctx, deps)).released).toBe(0); // still held in this process
    // The process "restarts": nothing holds it any more.
    sc._resetStoryClaimsForTest();
    const out = await rel.releaseStaleOwnClaims(ctx, deps);
    expect(out.released).toBe(1);
    expect(f.posts.at(-1)).toMatchObject({ sha: 'h1', context: 'ensemble/story-check', state: 'success', description: storyUnfinishedLine('me') });
    expect((await storyRows())[0]).toMatchObject({ state: 'released' });
    // The review's busy check is never asked about a story row.
    expect(busyReview).toEqual([]);
  });

  it('⚠ the AI Review tab never offers Clear for a story row', async () => {
    const f = fakeGh();
    const start = await sc.claimStoryBeforeAutoRun(ctx, target([heads()[0]!]), { nowMs: now }, f.gh);
    if (start.kind !== 'run') throw new Error('expected run');
    const tc = await import('../claude-review/team-claim.js');
    sc._resetStoryClaimsForTest();
    expect(await tc.teamClaimPendingFor(ctx, 1, prIds[0]!, 'h1', false, NOW)).toBeNull();
  });

  it("a teammate's expired story claim is released once, on their context", async () => {
    const f = fakeGh();
    f.seed('h1', line('bob', 'pending', NOW - MIN, storyCheckingLine('bob')));
    const first = await sc.claimStoryBeforeAutoRun(ctx, target([heads()[0]!]), { nowMs: now }, f.gh);
    expect(first).toMatchObject({ kind: 'skip', skip: { kind: 'reviewing' } });
    const later = NOW + TEAM_CLAIM_LEASE_MS + MIN;
    // Not yet: inside the lease.
    expect((await sc.releaseExpiredStoryTeammateLines(ctx, { gh: f.gh, nowMs: NOW, held: () => false })).released).toBe(0);
    // Taken back by a queued check of the ticket: left to its own claim.
    expect((await sc.releaseExpiredStoryTeammateLines(ctx, { gh: f.gh, nowMs: later, held: () => true })).released).toBe(0);
    const out = await sc.releaseExpiredStoryTeammateLines(ctx, { gh: f.gh, nowMs: later, held: () => false });
    expect(out.released).toBe(1);
    expect(f.posts.at(-1)).toMatchObject({ sha: 'h1', context: 'ensemble/story-check', state: 'success', description: releasedLine('bob', 'me') });
    // Once: the memory is gone and the release is recorded.
    expect((await sc.releaseExpiredStoryTeammateLines(ctx, { gh: f.gh, nowMs: later, held: () => false })).released).toBe(0);
    const { eq } = await import('drizzle-orm');
    const mates = await db.select().from(schema.teamClaimLines).where(eq(schema.teamClaimLines.whose, 'teammate')).execute();
    expect(mates).toMatchObject([{ provider: 'story', login: 'bob', state: 'released' }]);
  });

  it("⚠ a head a story check of ours is claiming now is left alone: its own pending line replaces bob's", async () => {
    const f = fakeGh();
    f.seed('h1', line('bob', 'pending', NOW - MIN, storyCheckingLine('bob')));
    expect((await sc.claimStoryBeforeAutoRun(ctx, target([heads()[0]!]), { nowMs: now }, f.gh)).kind).toBe('skip');
    const later = NOW + TEAM_CLAIM_LEASE_MS + MIN;
    // Another ticket's check holds the same head (the PR is on both tickets) before its own line is up
    // (here: its read failed, so it runs without one — the head is still held).
    const blind = fakeGh({ readFails: () => new Error('boom') });
    const second = await sc.claimStoryBeforeAutoRun(ctx, { accountId: 1, ident: 'jira:acme:PAY-2', heads: [heads()[0]!] }, { nowMs: () => later }, blind.gh);
    expect(second.kind).toBe('run');
    expect(sc.storyClaimBusy(1, prIds[0]!, 'h1')).toBe(true);
    const posted = f.posts.length;
    const out = await sc.releaseExpiredStoryTeammateLines(ctx, { gh: f.gh, nowMs: later, held: () => false });
    expect(out.released).toBe(0);
    expect(f.posts.length).toBe(posted);
    if (second.kind === 'run') await sc.finishStoryClaim(ctx, second.handle, { kind: 'unfinished' }, f.gh, () => later);
  });
});

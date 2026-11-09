// STILL-OPEN POINTS (docs/CLAUDE-REVIEW.md § Still-open points). What is pinned:
//
//   1. THE MARKER: a still-open judgement travels as `j=<id>:n,<id>:o`; this parser reads `still_open`,
//      and the parser every Limn before it shipped (copied verbatim below) reads `not_addressed` and
//      skips the unknown code — never breaks, never mis-reads.
//   2. THE PER-THREAD RULE: one reply per thread per head; a resolved thread is reopened ONCE EVER
//      (this account's claim, or ANY Limn's `r=1` reply on the thread); reopened once already, only a
//      warning / blocker starts ONE new thread (`c=`), a nit or question is left alone.
//   3. CLAIM BEFORE WRITE, NEVER RETRIED (real DB, fake GitHub): a second call writes nothing; a failed
//      reply is recorded and never sent again, and the thread is then left resolved.
//   4. THE PROSE GUARD: an open point the run did not record is cut from the summary; a recorded one
//      keeps the text as written.
//   5. THE FOLD: a teammate's still-open (its `o` + its "Still open:" reply) shows on the thread card,
//      newer wins against the reader's own judgement; My Turn's ball rule.
//
//   pnpm --filter @pierre-review/backend test claude-review/still-open
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  continuationThreadMap,
  limnFindingPost,
  limnReviewMarker,
  parseLimnReviewMarker,
  parseStillOpenMarker,
  stillOpenMarker,
  stillOpenReasonOf,
  stillOpenReasonText,
  type ClaudeThreadAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  claimKey,
  mergeLiveFacts,
  planStillOpen,
  stillOpenCandidates,
  stillOpenReplyBody,
  stillOpenThreadFacts,
  type StillOpenDeps,
} from './still-open.js';
import { claimsOpenPoint, runHasOpenPoints, stillOpenCountOf, withoutUnbackedOpenPoints } from './open-point-prose.js';
import { findingsNotApproved, minorTail } from './auto-verdict.js';
import { stillOpenAfterPost } from './auto-post.js';
import { judgedOutcomeOfFollowUp } from './post-meta.js';
import { newerStillOpenWord } from './thread-judgements.js';
import { stillOpenOwesAuthor } from '../../db/still-open-threads.js';

// ⚠ HOISTED above the imports: several modules imported below open the DB client at import time, so
// the path must be set before any of them loads (else they open the run's shared default file).
const DB_PATH = vi.hoisted(() => {
  const path = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-still-open.sqlite`;
  process.env.DATABASE_URL = path;
  process.env.DISABLE_SCHEDULER = 'true';
  return path;
});

const HEAD = 'a'.repeat(40);

// THE PARSER OF EVERY LIMN BEFORE `o` (limn-review-meta.ts at 1.0.1), verbatim.
function oldParseLimnJudged(v: string | undefined): Array<{ commentId: string; outcome: string }> {
  const JUDGED_OF_CODE: Record<string, string> = { a: 'addressed', n: 'not_addressed', x: 'no_longer_applies' };
  if (v == null) return [];
  const seen = new Set<string>();
  const out: Array<{ commentId: string; outcome: string }> = [];
  for (const tok of v.split(',')) {
    if (out.length >= 50) break;
    const m = /^(\d{1,20}):([anx])$/.exec(tok.trim());
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ commentId: m[1]!, outcome: JUDGED_OF_CODE[m[2]!]! });
  }
  return out;
}

describe('the marker: j= still open (o)', () => {
  it('writes o with its n twin; this parser reads still_open, an older one reads not_addressed', () => {
    const m = limnReviewMarker('n1', {
      headSha: HEAD,
      run: 'auto',
      judged: [
        { commentId: '11', outcome: 'still_open' },
        { commentId: '12', outcome: 'addressed' },
        { commentId: '13', outcome: 'not_addressed' },
      ],
    });
    expect(m).toContain('j=11:n,11:o,12:a,13:n');
    expect(parseLimnReviewMarker(m)?.judged).toEqual([
      { commentId: '11', outcome: 'still_open' },
      { commentId: '12', outcome: 'addressed' },
      { commentId: '13', outcome: 'not_addressed' },
    ]);
    const j = /\bj=(\S+)/.exec(m)![1];
    expect(oldParseLimnJudged(j)).toEqual([
      { commentId: '11', outcome: 'not_addressed' },
      { commentId: '12', outcome: 'addressed' },
      { commentId: '13', outcome: 'not_addressed' },
    ]);
  });

  it('an unknown code is skipped; an o never downgrades an a; the cap counts ids, not tokens', () => {
    expect(parseLimnReviewMarker('<!-- pierre:claude-review v=1 j=1:z,2:a,2:o,3:o -->')?.judged).toEqual([
      { commentId: '2', outcome: 'addressed' },
      { commentId: '3', outcome: 'still_open' },
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({ commentId: String(100 + i), outcome: 'still_open' as const }));
    const m = limnReviewMarker('n2', { judged: many });
    expect(parseLimnReviewMarker(m)?.judged).toHaveLength(50);
    expect(oldParseLimnJudged(/\bj=(\S+)/.exec(m)![1])).toHaveLength(50);
  });

  it('a follow-up still open is posted as still_open', () => {
    expect(judgedOutcomeOfFollowUp('not_addressed')).toBe('still_open');
  });
});

describe('the still-open reply and its marker', () => {
  it('round-trips; the reply is a Limn post (bot), never a finding', () => {
    const body = stillOpenReplyBody('The null case is still not handled. See line 4.', HEAD, '_Posted automatically by Limn’s Claude review._', true);
    expect(body.startsWith('**Still open:** The null case')).toBe(true);
    expect(parseStillOpenMarker(body)).toEqual({ headSha: HEAD, reopened: true, continuesCommentId: null });
    expect(limnFindingPost(body)).toEqual({ severity: null, reminder: false, stillOpen: true });
    expect(stillOpenReasonOf(body)).toBe('The null case is still not handled. See line 4.');
    expect(parseStillOpenMarker(stillOpenMarker({ headSha: HEAD, continuesCommentId: '77' }))?.continuesCommentId).toBe('77');
  });

  it('the reason is short, one line, and pings nobody', () => {
    const t = stillOpenReasonText(`@alice look.\n<!-- x --> ${'word '.repeat(80)}`);
    expect(t.length).toBeLessThanOrEqual(241);
    expect(t).not.toMatch(/@alice/);
    expect(t).not.toContain('<!--');
  });
});

describe('the per-thread rule', () => {
  const base = { resolved: false, reopenedBefore: false, repliedAtHead: false, escalatedBefore: false, severity: 'warning' as const };
  it('unresolved: one reply per head', () => {
    expect(planStillOpen(base)).toEqual({ reply: true, reopen: false, escalate: false });
    expect(planStillOpen({ ...base, repliedAtHead: true })).toEqual({ reply: false, reopen: false, escalate: false });
  });
  it('resolved: reopened once, ever', () => {
    expect(planStillOpen({ ...base, resolved: true })).toEqual({ reply: true, reopen: true, escalate: false });
    // A reply at this head already: unresolve without a second reply.
    expect(planStillOpen({ ...base, resolved: true, repliedAtHead: true })).toEqual({ reply: false, reopen: true, escalate: false });
  });
  it('a thread the READER resolved: nothing at all, on any PR (their resolve is their decision)', () => {
    expect(planStillOpen({ ...base, resolved: true, resolvedByReader: true })).toEqual({ reply: false, reopen: false, escalate: false });
    expect(planStillOpen({ ...base, resolved: true, resolvedByReader: true, ownPr: true })).toEqual({ reply: false, reopen: false, escalate: false });
    // Unresolved again: the flag says nothing.
    expect(planStillOpen({ ...base, resolvedByReader: true })).toEqual({ reply: true, reopen: false, escalate: false });
  });
  it('reopened before: a new thread only for a warning or a blocker, once', () => {
    const again = { ...base, resolved: true, reopenedBefore: true };
    expect(planStillOpen(again)).toEqual({ reply: false, reopen: false, escalate: true });
    expect(planStillOpen({ ...again, severity: 'blocker' }).escalate).toBe(true);
    expect(planStillOpen({ ...again, severity: 'nit' }).escalate).toBe(false);
    expect(planStillOpen({ ...again, severity: 'question' }).escalate).toBe(false);
    expect(planStillOpen({ ...again, severity: null }).escalate).toBe(false);
    expect(planStillOpen({ ...again, escalatedBefore: true }).escalate).toBe(false);
  });
  it("a SECOND Limn sees the first one's reopen and continuation on GitHub", () => {
    const mateReply = { body: stillOpenReplyBody('x', 'b'.repeat(40), '_f_', true) };
    const f = stillOpenThreadFacts({
      thread: { githubNodeId: 'T1', isResolved: true },
      threadComments: [{ body: 'root' }, mateReply],
      prComments: [{ body: `new thread ${stillOpenMarker({ headSha: HEAD, continuesCommentId: '500' })}` }],
      rootDatabaseId: '500',
      headSha: HEAD,
      claims: new Set(),
      severity: 'warning',
    });
    expect(f).toMatchObject({ reopenedBefore: true, repliedAtHead: false, escalatedBefore: true });
    expect(planStillOpen(f)).toEqual({ reply: false, reopen: false, escalate: false });
    // This account's own claims count the same.
    const g = stillOpenThreadFacts({
      thread: { githubNodeId: 'T2', isResolved: true },
      threadComments: [{ body: 'root' }],
      prComments: [],
      rootDatabaseId: null,
      headSha: HEAD,
      claims: new Set([claimKey('reopen', 'T2'), claimKey('reply', 'T2', HEAD)]),
      severity: 'nit',
    });
    expect(g).toMatchObject({ reopenedBefore: true, repliedAtHead: true });
  });
});

describe('D2, continuations and the live read (pure)', () => {
  const base = { resolved: true, reopenedBefore: false, repliedAtHead: false, escalatedBefore: false, severity: 'warning' as const };
  it("the reader's own PR: never a reopen or a new thread; a resolved thread gets one reply, ever", () => {
    expect(planStillOpen({ ...base, resolved: false, ownPr: true })).toEqual({ reply: true, reopen: false, escalate: false });
    expect(planStillOpen({ ...base, ownPr: true })).toEqual({ reply: true, reopen: false, escalate: false });
    expect(planStillOpen({ ...base, ownPr: true, repliedBefore: true })).toEqual({ reply: false, reopen: false, escalate: false });
    expect(planStillOpen({ ...base, ownPr: true, reopenedBefore: true, severity: 'blocker' })).toEqual({ reply: true, reopen: false, escalate: false });
    // A teammate's PR: as before.
    expect(planStillOpen({ ...base, ownPr: false })).toEqual({ reply: true, reopen: true, escalate: false });
  });
  it('a continuation thread is never continued again', () => {
    const f = stillOpenThreadFacts({
      thread: { githubNodeId: 'TC', isResolved: true },
      threadComments: [{ body: `**Warning**\n\nThis point is still open.\n\n${stillOpenMarker({ headSha: HEAD, continuesCommentId: '500' })}` }],
      prComments: [],
      rootDatabaseId: '900',
      headSha: HEAD,
      claims: new Set([claimKey('reopen', 'TC')]),
      severity: 'warning',
    });
    expect(f.escalatedBefore).toBe(true);
    expect(planStillOpen(f).escalate).toBe(false);
  });
  it('the live read: a teammate reply or reopen not synced yet stops the write; resolved is the live state', () => {
    const synced = { ...base, repliedBefore: false, ownPr: false };
    const ids = { githubNodeId: 'T1', rootDatabaseId: '500', headSha: HEAD };
    const mate = { body: stillOpenReplyBody('x', HEAD, '_f_', true) };
    const live = mergeLiveFacts(synced, { isResolved: true, comments: [{ body: 'root' }, mate], prRoots: [] }, ids);
    expect(live).toMatchObject({ reopenedBefore: true, repliedAtHead: true });
    // No second reply, no second reopen (a warning reopened once may now be continued instead).
    expect(planStillOpen(live)).toMatchObject({ reply: false, reopen: false });
    // A teammate's continuation (c=500) on the PR, seen only live.
    const cont = mergeLiveFacts(
      { ...synced, reopenedBefore: true },
      { isResolved: true, comments: [{ body: 'root' }], prRoots: [{ body: `x ${stillOpenMarker({ headSha: HEAD, continuesCommentId: '500' })}` }] },
      ids,
    );
    expect(planStillOpen(cont).escalate).toBe(false);
    // Unresolved on GitHub now: a reply, no reopen.
    expect(planStillOpen(mergeLiveFacts(synced, { isResolved: false, comments: [{ body: 'root' }], prRoots: [] }, ids))).toEqual({
      reply: true,
      reopen: false,
      escalate: false,
    });
  });
  it('continuationThreadMap: root c= only, the oldest wins, chains followed', () => {
    const m = stillOpenMarker;
    const map = continuationThreadMap([
      { threadId: 1, databaseId: '100', body: 'a', createdAt: 1 },
      { threadId: 1, databaseId: '101', body: `reply ${m({ headSha: HEAD, continuesCommentId: '100' })}`, createdAt: 2 },
      { threadId: 2, databaseId: '200', body: `new ${m({ headSha: HEAD, continuesCommentId: '100' })}`, createdAt: 5 },
      { threadId: 3, databaseId: '300', body: `later ${m({ headSha: HEAD, continuesCommentId: '100' })}`, createdAt: 9 },
      { threadId: 4, databaseId: '400', body: `chain ${m({ headSha: HEAD, continuesCommentId: '200' })}`, createdAt: 10 },
    ]);
    expect(map.get(1)).toBe(4);
    expect(map.get(2)).toBe(4);
    expect(map.has(3)).toBe(false);
  });
});

describe('which points a run holds open', () => {
  const ta = (over: Partial<ClaudeThreadAssessment> & { threadId: number }): ClaudeThreadAssessment =>
    ({
      ref: 'R1', sent: true, carried: false, authorLogin: 'bob', authorIsBot: false, path: 'a.ts', line: 1,
      excerpt: '', commentCount: 1, lastCommentAt: null, url: null, validity: 'valid', addressed: 'not_addressed',
      explanation: 'Still unhandled.', reason: 'The null case is not handled.', draftReply: null, assessedAtHead: HEAD, ...over,
    }) as ClaudeThreadAssessment;
  it("a person's thread and a Limn finding's; never another bot's; a disputed reply is marked (written only when resolved)", () => {
    const c = stillOpenCandidates(
      [
        {
          threadAssessments: [ta({ threadId: 1 }), ta({ threadId: 2, authorIsBot: true }), ta({ threadId: 3, authorIsBot: true }), ta({ threadId: 4, validity: 'not_valid' })],
          followUp: {
            items: [
              { threadId: 5, status: 'not_addressed', severity: 'warning', explanation: 'Not fixed.', priorFindingId: 50 },
              { threadId: 6, status: 'reply_disputed', severity: 'blocker', explanation: 'x', priorFindingId: 60 },
              { threadId: 7, status: 'addressed', severity: 'blocker', explanation: 'x', priorFindingId: 70 },
            ],
          } as never,
        },
      ],
      new Map([[3, { severity: 'blocker' as const }]]),
    );
    expect(c.map((x) => [x.threadId, x.source, x.severity])).toEqual([
      [1, 'thread', null],
      [3, 'thread', 'blocker'],
      [5, 'follow_up', 'warning'],
      [6, 'follow_up', 'blocker'],
    ]);
    expect(c.find((x) => x.threadId === 6)?.disputed).toBe(true);
    expect(c.find((x) => x.threadId === 5)?.disputed).toBeUndefined();
  });
  it("a pair: the later half's word on a thread wins", () => {
    const c = stillOpenCandidates(
      [{ threadAssessments: [ta({ threadId: 1 })], followUp: null }, { threadAssessments: [ta({ threadId: 1, addressed: 'addressed' })], followUp: null }],
      new Map(),
    );
    expect(c).toEqual([]);
  });
});

describe('the prose guard', () => {
  const pr454 = 'The change is sound and close to ready to merge, with one open point from the previous review.\n\n- Good: the parser is simpler.';
  it('PR 454: the clause goes when nothing is recorded open; stays when something is', () => {
    expect(claimsOpenPoint(pr454)).toBe(true);
    expect(withoutUnbackedOpenPoints(pr454, false)).toBe('The change is sound and close to ready to merge.\n\n- Good: the parser is simpler.');
    expect(withoutUnbackedOpenPoints(pr454, true)).toBe(pr454);
  });
  it('a whole sentence or bullet that is the claim is dropped; other text is untouched', () => {
    expect(withoutUnbackedOpenPoints('Looks good. One issue remains unresolved.\n- An outstanding question about retries.\n- Good: tests.', false)).toBe(
      'Looks good.\n- Good: tests.',
    );
    expect(withoutUnbackedOpenPoints('The retry loop now backs off. - Good: tests.', false)).toBe('The retry loop now backs off. - Good: tests.');
  });
  it('what counts as recorded', () => {
    expect(runHasOpenPoints({ findings: [{ severity: 'praise' }] })).toBe(false);
    expect(runHasOpenPoints({ findings: [{ severity: 'nit' }] })).toBe(true);
    expect(runHasOpenPoints({ findings: [], followUpItems: [{ status: 'partly_addressed' }] })).toBe(true);
    expect(runHasOpenPoints({ findings: [], threadAssessments: [{ validity: 'valid', addressed: 'not_addressed' }] })).toBe(true);
    expect(runHasOpenPoints({ findings: [], threadAssessments: [{ validity: 'not_valid', addressed: 'not_addressed' }] })).toBe(false);
  });
  it('the "Not approved" line names the held-open points instead of "No findings are open."', () => {
    expect(minorTail(0, 0, 0)).toBe('No findings are open.');
    expect(minorTail(0, 0, 1)).toBe('1 earlier point is still open.');
    expect(minorTail(1, 0, 2)).toBe('A nit is still open. 2 earlier points are still open.');
    const n = stillOpenCountOf([{ followUpItems: [{ status: 'not_addressed', priorFindingId: 1, threadId: 9 }], threadAssessments: [{ threadId: 9, validity: 'valid', addressed: 'addressed' }] }]);
    expect(n).toBe(1);
    expect(findingsNotApproved([{ by: 'Claude', verdict: 'COMMENT', summary: 'Sound.' }], [], undefined, 1)?.text).toBe(
      'Not approved: Claude left a comment, not an approval. 1 earlier point is still open.',
    );
  });
});

describe('the posting path and the fold, pure', () => {
  it('still-open runs only after a post or a nothing-new skip', () => {
    expect(stillOpenAfterPost({ kind: 'done', record: { status: 'posted' } } as never)).toBe(true);
    expect(stillOpenAfterPost({ kind: 'done', record: { status: 'failed' } } as never)).toBe(false);
    expect(stillOpenAfterPost({ kind: 'skipped', reason: 'nothing_new' })).toBe(true);
    expect(stillOpenAfterPost({ kind: 'skipped', reason: 'draft' })).toBe(false);
    expect(stillOpenAfterPost({ kind: 'off' })).toBe(false);
  });
  it('newer word wins; My Turn owes the author only at this head, unresolved, with no reply since', () => {
    const own = { open: true, at: 1, by: { you: true as const }, reason: null, severity: null, headSha: HEAD };
    const mate = { open: false, at: 2, by: { you: false as const, login: 'robin', name: 'Robin Dunn' }, reason: null, severity: null, headSha: HEAD };
    expect(newerStillOpenWord(own, mate)?.open).toBe(false);
    expect(newerStillOpenWord({ ...own, at: 3 }, mate)?.open).toBe(true);
    const so = { headSha: HEAD, threadResolved: false, at: '2026-11-05T10:00:00.000Z' };
    expect(stillOpenOwesAuthor({ stillOpen: so, prHeadSha: HEAD, authorRepliesAt: [] })).toBe(true);
    expect(stillOpenOwesAuthor({ stillOpen: so, prHeadSha: 'c'.repeat(40), authorRepliesAt: [] })).toBe(false);
    expect(stillOpenOwesAuthor({ stillOpen: { ...so, threadResolved: true }, prHeadSha: HEAD, authorRepliesAt: [] })).toBe(false);
    expect(stillOpenOwesAuthor({ stillOpen: so, prHeadSha: HEAD, authorRepliesAt: [Date.parse(so.at) + 1] })).toBe(false);
  });
});

// ── REAL DB, FAKE GITHUB ──────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let so: typeof import('./still-open.js');
let tj: typeof import('./thread-judgements.js');
const users: Record<string, number> = {};
let repoId = 0;
let seq = 0;

beforeAll(async () => {
  // No pre-clean: the client already opened this file at import (LIMN_TEST_RUN_DIR is fresh per run).
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  // The migrations may have made the local account already (no login): give it the reader's login.
  await db.update(schema.accounts).set({ githubLogin: 'me' }).where((await import('drizzle-orm')).eq(schema.accounts.id, 1)).execute();
  for (const login of ['me', 'bob', 'robin']) {
    await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_so_${login}`, displayName: login === 'robin' ? 'Robin Dunn' : null })
      .onConflictDoNothing()
      .execute();
    const [u] = await db.select().from(schema.users).where((await import('drizzle-orm')).eq(schema.users.githubLogin, login)).execute();
    users[login] = u.id;
  }
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  persist = await import('./persist.js');
  so = await import('./still-open.js');
  tj = await import('./thread-judgements.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview: vi.fn(), postFinding: vi.fn() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

async function pr(author: 'bob' | 'me' = 'bob'): Promise<number> {
  seq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({ githubNodeId: `PR_${seq}`, accountId: 1, repoId, number: seq, title: `pr ${seq}`, state: 'open', isDraft: false, headSha: HEAD, authorId: users[author], openedAt: new Date(), updatedAt: new Date() })
    .returning()
    .execute();
  return p.id;
}

async function thread(prId: number, o: { resolved: boolean; comments: Array<{ by: string; body: string; dbId?: string; poster?: string; at?: number }> }): Promise<{ id: number; node: string }> {
  seq += 1;
  const node = `T_${seq}`;
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: node, prId, path: 'src/a.ts', line: 4, isResolved: o.resolved, derivedState: o.resolved ? 'resolved' : 'untouched', createdAt: new Date(Date.now() - 3_600_000) })
    .returning()
    .execute();
  let i = 0;
  for (const c of o.comments) {
    i += 1;
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `C_${seq}_${i}`,
        threadId: t.id,
        prId,
        authorId: users[c.by],
        body: c.body,
        databaseId: c.dbId ?? `${seq}${i}`,
        createdAt: new Date(c.at ?? Date.now() - 3_000_000 + i * 1000),
        limnPostedByUserId: c.poster ? users[c.poster] : null,
      })
      .execute();
  }
  return { id: t.id, node };
}

async function judgingRun(prId: number, threadId: number, addressed: 'not_addressed' | 'addressed' = 'not_addressed'): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5' as any, 1, [], 'auto');
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: 'One point is still open.',
    verdict: 'COMMENT',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: [],
    threadAssessments: [
      {
        ref: 'R1', threadId, sent: true, carried: false, authorLogin: 'bob', authorIsBot: false, path: 'src/a.ts', line: 4,
        resolved: false, excerpt: 'x', commentCount: 1, lastCommentAt: null, url: null, validity: 'valid', addressed,
        explanation: 'The null case is still not handled.', reason: 'The null case is still not handled.', draftReply: null, assessedAtHead: HEAD,
      },
    ],
  });
  return id;
}

// GitHub's live word, by default the synced rows (a test overrides it to model a teammate's write
// that has not synced yet, or a failed read).
async function syncedLive(node: string) {
  const { eq } = await import('drizzle-orm');
  const [t] = await db.select().from(schema.reviewThreads).where(eq(schema.reviewThreads.githubNodeId, node)).execute();
  const all = await db.select().from(schema.reviewComments).where(eq(schema.reviewComments.prId, t.prId)).execute();
  const sorted = all.sort((a: any, b: any) => a.createdAt - b.createdAt || a.id - b.id);
  const roots = new Map<number, any>();
  for (const c of sorted) if (!roots.has(c.threadId)) roots.set(c.threadId, c);
  return {
    isResolved: !!t.isResolved,
    comments: sorted.filter((c: any) => c.threadId === t.id).map((c: any) => ({ body: c.body })),
    prRoots: [...roots.values()].map((c: any) => ({ body: c.body })),
  };
}

function fakeDeps(over: Partial<StillOpenDeps> = {}): StillOpenDeps & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    liveThread: vi.fn(async (_a: number, node: string) => syncedLive(node)),
    reply: vi.fn(async (_a, node, body) => {
      calls.push(`reply ${node} ${/r=1/.test(body) ? 'r=1' : ''}`.trim());
      return { commentId: `9${(n += 1)}` };
    }),
    unresolve: vi.fn(async (_a, node) => {
      calls.push(`unresolve ${node}`);
    }),
    stampUnresolved: vi.fn(async () => {}),
    newThread: vi.fn(async (_c, a) => {
      calls.push(`new ${a.finding.path} ${a.finding.severity}`);
      return { commentId: '777', postedCommentKind: 'inline' as const };
    }),
    notePrChanged: vi.fn(async () => {}),
    settle: vi.fn(async () => ({ visible: true })),
    ...over,
  };
}

describe('claim before write, never retried (real DB)', () => {
  it('a resolved thread: reply then unresolve, once; a second call writes nothing', async () => {
    const p = await pr();
    const t = await thread(p, { resolved: true, comments: [{ by: 'bob', body: 'Handle null.' }] });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps();
    const res = await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(res).toMatchObject({ replied: [t.id], reopened: [t.id], escalated: [], failed: [] });
    expect(d.calls).toEqual([`reply ${t.node} r=1`, `unresolve ${t.node}`]);
    const again = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, again);
    expect(again.calls).toEqual([]);
    const rows = await db.select().from(schema.claudeStillOpenPosts).execute();
    expect(rows.filter((r: any) => r.prId === p).map((r: any) => [r.action, r.status]).sort()).toEqual([
      ['reopen', 'posted'],
      ['reply', 'posted'],
    ]);
  });

  it('a failed reply is recorded, never sent again, and the thread stays resolved', async () => {
    const p = await pr();
    const t = await thread(p, { resolved: true, comments: [{ by: 'bob', body: 'Handle null.' }] });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps({ reply: vi.fn(async () => { throw new Error('502 Bad Gateway'); }) });
    const res = await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(res?.failed).toEqual([t.id]);
    expect(d.unresolve).not.toHaveBeenCalled();
    const rows = (await db.select().from(schema.claudeStillOpenPosts).execute()).filter((r: any) => r.prId === p);
    expect(rows.every((r: any) => r.status === 'failed')).toBe(true);
    const again = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, again);
    expect(again.calls).toEqual([]);
  });

  it("a thread another Limn reopened (r=1): a person's comment has no severity, so it is left alone", async () => {
    const p = await pr();
    const t = await thread(p, {
      resolved: true,
      comments: [
        { by: 'bob', body: 'Handle null.' },
        { by: 'robin', poster: 'robin', body: stillOpenReplyBody('Not yet.', 'b'.repeat(40), '_f_', true) },
      ],
    });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(d.calls).toEqual([]);
  });

  it('a Limn WARNING reopened once already gets ONE new thread; an unresolved one gets one reply per head', async () => {
    const p = await pr();
    const warn = await thread(p, {
      resolved: true,
      comments: [
        { by: 'robin', poster: 'robin', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->', dbId: '4242' },
        { by: 'robin', poster: 'robin', body: stillOpenReplyBody('Not yet.', 'b'.repeat(40), '_f_', true) },
      ],
    });
    const open = await thread(p, { resolved: false, comments: [{ by: 'bob', body: 'Rename this.' }] });
    const id = await persist.insertQueuedReview(ctx, p, HEAD, 'claude-opus-5-5' as any, 1, [], 'auto');
    const a = (threadId: number) => ({
      ref: 'R1', threadId, sent: true, carried: false, authorLogin: 'x', authorIsBot: true, path: 'src/a.ts', line: 4, resolved: false,
      excerpt: 'x', commentCount: 1, lastCommentAt: null, url: null, validity: 'valid', addressed: 'not_addressed',
      explanation: 'Still there.', reason: 'Still there.', draftReply: null, assessedAtHead: HEAD,
    });
    await persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1,
      excludedFiles: [], findings: [],
      threadAssessments: [a(warn.id) as any, { ...a(open.id), authorIsBot: false } as any],
    });
    const d = fakeDeps();
    const res = await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(res).toMatchObject({ escalated: [warn.id], replied: [open.id], reopened: [] });
    expect(d.calls.sort()).toEqual([`new src/a.ts warning`, `reply ${open.node}`].sort());
    const body = (d.newThread as any).mock.calls[0][1].finding.body as string;
    expect(parseStillOpenMarker(body)?.continuesCommentId).toBe('4242');
    expect(body).toContain('#discussion_r4242');
    const again = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, again);
    expect(again.calls).toEqual([]);
  });
});

describe('D2: the reader\'s own PR (real DB)', () => {
  it('a resolved thread gets the reply only, never a reopen; once ever; a warning is never continued', async () => {
    const p = await pr('me');
    const t = await thread(p, { resolved: true, comments: [{ by: 'bob', body: 'Handle null.' }] });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps();
    const res = await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(d.calls).toEqual([`reply ${t.node}`]);
    expect(res).toMatchObject({ replied: [t.id], reopened: [], escalated: [] });

    // A still-open reply (any head) is already on the resolved thread: nothing more.
    const t2 = await thread(p, {
      resolved: true,
      comments: [
        { by: 'bob', body: 'Handle null.' },
        { by: 'robin', poster: 'robin', body: stillOpenReplyBody('Not yet.', 'b'.repeat(40), '_f_', false) },
      ],
    });
    const id2 = await judgingRun(p, t2.id);
    const d2 = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id2 }, d2);
    expect(d2.calls).toEqual([]);

    // A Limn WARNING reopened once already: no new thread on the reader's own PR.
    const warn = await thread(p, {
      resolved: true,
      comments: [
        { by: 'robin', poster: 'robin', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->', dbId: '5151' },
        { by: 'robin', poster: 'robin', body: stillOpenReplyBody('Not yet.', 'b'.repeat(40), '_f_', true) },
      ],
    });
    const id3 = await judgingRun(p, warn.id);
    const d3 = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id3 }, d3);
    expect(d3.calls).toEqual([]);
  });
});

describe('gap 2: a disputed reply on a resolved thread (real DB)', () => {
  async function disputedRun(prId: number, threadId: number): Promise<number> {
    const id = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5' as any, 1, [], 'auto');
    await persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1,
      excludedFiles: [], findings: [],
      followUp: {
        priorReviewId: 0, priorHeadSha: HEAD, headMoved: false,
        items: [{ priorFindingId: 0, threadId, status: 'reply_disputed', severity: 'warning', explanation: 'The reply does not fix the null case.' }],
      } as any,
    });
    return id;
  }
  it('resolved: "Still open:" + the reopen; unresolved: left to the one pushback', async () => {
    const p = await pr();
    const resolved = await thread(p, { resolved: true, comments: [{ by: 'me', poster: 'me', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->' }, { by: 'bob', body: 'Not needed.' }] });
    const open = await thread(p, { resolved: false, comments: [{ by: 'me', poster: 'me', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->' }, { by: 'bob', body: 'Not needed.' }] });
    const d = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: await disputedRun(p, resolved.id) }, d);
    expect(d.calls).toEqual([`reply ${resolved.node} r=1`, `unresolve ${resolved.node}`]);
    const d2 = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: await disputedRun(p, open.id) }, d2);
    expect(d2.calls).toEqual([]);
  });
});

describe('gap 3: read GitHub live before writing (real DB)', () => {
  it("a teammate's reply and reopen GitHub has but sync has not: nothing is written", async () => {
    const p = await pr();
    const t = await thread(p, { resolved: true, comments: [{ by: 'bob', body: 'Handle null.' }] });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps({
      liveThread: vi.fn(async () => ({
        isResolved: true,
        comments: [{ body: 'Handle null.' }, { body: stillOpenReplyBody('Not yet.', HEAD, '_f_', true) }],
        prRoots: [],
      })),
    });
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(d.calls).toEqual([]);
    expect(d.liveThread).toHaveBeenCalledTimes(1);
  });
  it('a failed read writes nothing and records why (never tried again at this head)', async () => {
    const p = await pr();
    const t = await thread(p, { resolved: true, comments: [{ by: 'bob', body: 'Handle null.' }] });
    const id = await judgingRun(p, t.id);
    const d = fakeDeps({ liveThread: vi.fn(async () => { throw new Error('502 Bad Gateway'); }) });
    const res = await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, d);
    expect(d.calls).toEqual([]);
    expect(res?.unread).toEqual([t.id]);
    const rows = (await db.select().from(schema.claudeStillOpenPosts).execute()).filter((r: any) => r.prId === p);
    expect(rows.map((r: any) => [r.action, r.status])).toEqual([['read', 'failed']]);
    expect(rows[0].error).toMatch(/couldn't read the thread on GitHub/);
    const again = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: id }, again);
    expect(again.calls).toEqual([]);
    expect(again.liveThread).not.toHaveBeenCalled();
  });
  it('nothing planned from the synced facts: no read at all', async () => {
    const p = await pr();
    const t = await thread(p, {
      resolved: false,
      comments: [{ by: 'bob', body: 'Handle null.' }, { by: 'robin', poster: 'robin', body: stillOpenReplyBody('x', HEAD, '_f_', false) }],
    });
    const d = fakeDeps();
    await so.maybePostStillOpen(ctx, { accountId: 1, prId: p, reviewId: await judgingRun(p, t.id) }, d);
    expect(d.liveThread).not.toHaveBeenCalled();
  });
});

describe('gap 8: later runs and the author follow the continuation (real DB)', () => {
  it('a chain A → B → C (an older Limn continued a continuation) sends A and B both, oldest first', async () => {
    const p = await pr();
    const now = Date.now();
    const a = await thread(p, {
      resolved: true,
      comments: [
        { by: 'robin', poster: 'robin', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->', dbId: '6300', at: now - 900_000 },
        { by: 'bob', body: 'Done.', at: now - 850_000 },
      ],
    });
    const b = await thread(p, {
      resolved: true,
      comments: [
        { by: 'robin', poster: 'robin', body: `**Warning**\n\nStill open.\n\n<!-- pierre:claude-review-finding v=1 -->\n${stillOpenMarker({ headSha: HEAD, continuesCommentId: '6300' })}`, dbId: '6400', at: now - 800_000 },
        { by: 'bob', body: 'Done again.', at: now - 750_000 },
      ],
    });
    const c = await thread(p, {
      resolved: false,
      comments: [
        { by: 'robin', poster: 'robin', body: `**Warning**\n\nStill open, again.\n\n<!-- pierre:claude-review-finding v=1 -->\n${stillOpenMarker({ headSha: HEAD, continuesCommentId: '6400' })}`, dbId: '6500', at: now - 700_000 },
      ],
    });
    const { loadReviewThreadsForReview } = await import('../../db/review-threads-for-review.js');
    const loaded = await loadReviewThreadsForReview(1, p);
    const ids = loaded.threads.map((t) => t.threadId);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    const sent = loaded.threads.find((t) => t.threadId === c.id)!;
    expect(sent.comments.map((x) => x.body)).toEqual([
      expect.stringContaining('Handle null.'),
      'Done.',
      expect.stringContaining('Still open.'),
      'Done again.',
      expect.stringContaining('Still open, again.'),
    ]);
  });

  it('the thread loader sends the continuation once; the still-open card moves to it', async () => {
    const p = await pr();
    const now = Date.now();
    const orig = await thread(p, {
      resolved: true,
      comments: [
        { by: 'robin', poster: 'robin', body: '**Warning**\n\nHandle null.\n\n<!-- pierre:claude-review-finding v=1 -->', dbId: '6100', at: now - 900_000 },
        { by: 'bob', body: 'Done, I think.', at: now - 800_000 },
      ],
    });
    const cont = await thread(p, {
      resolved: false,
      comments: [
        {
          by: 'me',
          poster: 'me',
          body: `**Warning**\n\nThis point is still open.\n\n<!-- pierre:claude-review-finding v=1 -->\n${stillOpenMarker({ headSha: HEAD, continuesCommentId: '6100' })}`,
          dbId: '6200',
          at: now - 700_000,
        },
        { by: 'bob', body: 'Looking.', at: now - 600_000 },
      ],
    });
    const { loadReviewThreadsForReview } = await import('../../db/review-threads-for-review.js');
    const loaded = await loadReviewThreadsForReview(1, p);
    const ids = loaded.threads.map((t) => t.threadId);
    expect(ids).toContain(cont.id);
    expect(ids).not.toContain(orig.id);
    const sent = loaded.threads.find((t) => t.threadId === cont.id)!;
    expect(sent.isResolved).toBe(false);
    expect(sent.comments.map((c) => c.body)).toEqual([expect.stringContaining('Handle null.'), 'Done, I think.', 'Looking.']);

    // An earlier run judged the ORIGINAL thread still open: the card shows on the continuation.
    await judgingRun(p, orig.id);
    const [r] = await tj.getThreadJudgements(ctx, [p], 1);
    expect(r!.judgements.find((j) => j.threadId === orig.id)?.stillOpen ?? null).toBeNull();
    const moved = r!.judgements.find((j) => j.threadId === cont.id);
    expect(moved?.stillOpen).toMatchObject({ threadResolved: false, path: 'src/a.ts' });
    expect(moved?.resolved).toBe(false);
  });
  it("the follow-up, auto resolve and pushback follow the reader's OWN continuation only", async () => {
    const { followOwnContinuation } = await import('./finding-replies.js');
    const threads = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const c = (threadId: number, body: string, authorLogin: string, createdAt: number, databaseId: string) => ({ threadId, body, authorLogin, createdAt, databaseId });
    const contBody = `**Warning**\n\nx\n\n<!-- pierre:claude-review-finding v=1 -->\n${stillOpenMarker({ headSha: HEAD, continuesCommentId: '10' })}`;
    const own = [c(1, 'root <!-- pierre:claude-review-finding v=1 -->', 'me', 1, '10'), c(2, contBody, 'me', 2, '20')];
    expect(followOwnContinuation(threads[0]!, threads, own, continuationThreadMap(own), 'me').id).toBe(2);
    const mate = [c(1, 'root <!-- pierre:claude-review-finding v=1 -->', 'me', 1, '10'), c(3, contBody, 'robin', 2, '30')];
    expect(followOwnContinuation(threads[0]!, threads, mate, continuationThreadMap(mate), 'me').id).toBe(1);
  });
});

describe("a teammate's still-open on the thread cards (real DB)", () => {
  it("shows Robin's Limn with its reply's reason; a newer own judgement of 'addressed' wins", async () => {
    const p = await pr();
    const now = Date.now();
    const t = await thread(p, {
      resolved: false,
      comments: [
        { by: 'bob', body: 'Handle null.', dbId: '8100', at: now - 600_000 },
        { by: 'robin', poster: 'robin', body: stillOpenReplyBody('The null case is still open.', HEAD, '_f_', false), at: now - 300_000 },
      ],
    });
    const mate = await persist.insertQueuedReview(ctx, p, HEAD, 'claude-opus-5-5' as any, 1, [], 'manual');
    await db
      .update(schema.claudeReviews)
      .set({
        kind: 'teammate',
        status: 'succeeded',
        sourceUserId: users.robin,
        postedAt: new Date(now - 299_000),
        finishedAt: new Date(now - 299_000),
        teammate: { githubReviewId: '1', run: 'auto', pair: false, runs: [], limnVersion: '1.0.2', headInferred: false, judged: [{ commentId: '8100', outcome: 'still_open' }] },
      })
      .where((await import('drizzle-orm')).eq(schema.claudeReviews.id, mate))
      .execute();
    let [r] = await tj.getThreadJudgements(ctx, [p], 1);
    const j = r!.judgements.find((x) => x.threadId === t.id)!;
    expect(j.teammateOnly).toBe(true);
    expect(j.stillOpen).toMatchObject({ by: { you: false, login: 'robin', name: 'Robin Dunn' }, reason: 'The null case is still open.', path: 'src/a.ts', threadResolved: false });
    // The reader's own run, AFTER the teammate's post, finds it addressed: the newer word wins.
    await judgingRun(p, t.id, 'addressed');
    [r] = await tj.getThreadJudgements(ctx, [p], 1);
    expect(r!.judgements.find((x) => x.threadId === t.id)?.stillOpen ?? null).toBeNull();
  });
});

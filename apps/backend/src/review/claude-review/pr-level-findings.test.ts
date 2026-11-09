// PR-LEVEL FINDINGS — the pure half: the shared conversation pool, the reply gate (a cited ref of
// THIS finding), the still-open rule and the posted bodies.
//
//   pnpm --filter @pierre-review/backend test pr-level-findings
import { describe, expect, it } from 'vitest';
import type { ReviewFollowUpReport } from '../../platform/contract.js';
import { buildConversationPool, conversationPool, linksFinding, PR_LEVEL_REPLIES_MAX, type PoolComment } from './reply-text.js';
import { reconcileFollowUp, selectPriorFindings, type PriorFindingForFollowUp } from './follow-up.js';
import { parsePrLevelMarker, prLevelFollowUpMarker } from './finding-replies.js';
import { prLevelAckBody, prLevelStillOpenBody } from './pr-level-writes.js';
import { prLevelStillOpenItems } from './still-open.js';
import { buildUserPrompt } from './prompts.js';

const HEAD = 'a'.repeat(40);
const c = (author: string, atMs: number, body: string, commentId: string): PoolComment => ({
  author,
  body,
  atMs,
  commentId,
  kind: 'comment',
  url: `https://github.com/o/r/pull/1#issuecomment-${commentId}`,
});
const pf = (findingId: number, postedAtMs: number, title: string, commentId: string) => ({
  findingId,
  ownerFindingId: findingId,
  commentId,
  url: null,
  postedAtMs,
  title,
  body: `**Warning** ${title}.`,
  pushedBack: false,
});

describe('linksFinding', () => {
  const f = { commentId: '6739728311', title: 'Form saves cut an untouched over-long value', body: '**Blocker** Form saves cut it.' };
  it('a link to the finding comment, or a quote of its title, links it', () => {
    expect(linksFinding('See https://github.com/o/r/pull/1#issuecomment-6739728311', f)).toBe(true);
    expect(linksFinding('> Form saves cut an untouched over-long value\n\nNo.', f)).toBe(true);
    expect(linksFinding('#issuecomment-67397283119', f)).toBe(false); // a longer id is another comment
    expect(linksFinding('LGTM', f)).toBe(false);
  });
});

describe('the conversation pool', () => {
  it('ONE comment answering two findings gets ONE ref, listed under both', () => {
    const pool = buildConversationPool(
      [c('alex', 300, 'On both points: not changing this.', '9')],
      [pf(1, 100, 'First point here', '1'), pf(2, 200, 'Second point here', '2')],
      1_500,
    );
    expect(pool.get(1)!.replies.map((r) => r.ref)).toEqual(['C1']);
    expect(pool.get(2)!.replies.map((r) => r.ref)).toEqual(['C1']);
    expect(conversationPool([pool.get(1), pool.get(2)]).map((r) => r.ref)).toEqual(['C1']);
  });

  it('only comments AFTER the finding; linked ones first, then newest; at most five; refs oldest first', () => {
    const comments = [
      c('a', 50, 'before the finding', '1'),
      ...[1, 2, 3, 4, 5, 6].map((n) => c('a', 100 + n, `later ${n}`, `${10 + n}`)),
      c('b', 102, 'Re #issuecomment-77: wrong', '30'),
    ];
    const conv = buildConversationPool(comments, [pf(1, 100, 'A point about saves', '77')], 1_500).get(1)!;
    expect(conv.replies).toHaveLength(PR_LEVEL_REPLIES_MAX);
    expect(conv.replies[0]!.body).toBe('Re #issuecomment-77: wrong');
    expect(conv.linked).toEqual([conv.replies[0]!.ref]);
    expect(conv.replies.map((r) => r.body)).not.toContain('before the finding');
    expect(conv.replies.map((r) => r.body).slice(1)).toEqual(['later 6', 'later 5', 'later 4', 'later 3']);
    // Refs follow time across the kept set: the linked one (t=102) is C1.
    expect(conv.replies[0]!.ref).toBe('C1');
  });
});

const prLevel = (id: number, over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp => ({
  id,
  headSha: HEAD,
  path: 'src/a.ts',
  line: null,
  side: 'RIGHT',
  severity: 'warning',
  title: `point ${id}`,
  body: `body ${id}`,
  suggestion: null,
  diffHunk: null,
  anchored: false,
  fileInDiff: false,
  posted: true,
  carried: false,
  conversation: {
    ownerFindingId: id,
    commentId: `${id}00`,
    url: `https://github.com/o/r/pull/1#issuecomment-${id}00`,
    replies: [{ ref: 'C1', author: 'alex', body: 'Not changing this.', at: '2026-11-09T13:57:00.000Z', commentId: '9', kind: 'comment', url: 'u9' }],
    linked: [],
    pushedBack: false,
  },
  ...over,
});
const rep = (ref: string, o: Partial<ReviewFollowUpReport>): ReviewFollowUpReport => ({ ref, status: 'reply_accepted', explanation: 'x', ...o });

describe('the reply gate on a PR-level finding', () => {
  const plan = selectPriorFindings({ reviewId: 7, headSha: HEAD, findings: [prLevel(1), prLevel(2), prLevel(3)] }, 'b'.repeat(40));
  const items = reconcileFollowUp(plan, [
    rep('P1', { acceptKind: 'not_valid', reply: 'Fair.', replyRef: 'C1' }),
    rep('P2', { acceptKind: 'not_valid', reply: 'Fair.' }), // no ref
    rep('P3', { status: 'reply_disputed', reply: 'No.', replyRef: 'C7' }), // not one of its own
  ]);
  it('stands only with a cited ref of THAT finding; otherwise unreported', () => {
    expect(items[0]).toMatchObject({ status: 'reply_accepted', replyRef: 'C1', reply: { author: 'alex', excerpt: 'Not changing this.', url: 'u9' } });
    expect(items[1]!.status).toBe('not_checked');
    expect(items[2]!.status).toBe('not_checked');
  });
  it('every item names its PR comment, never a thread', () => {
    for (const it of items) {
      expect(it.threadId).toBeUndefined();
      expect(it.prComment?.commentId).toBe(`${it.priorFindingId}00`);
    }
  });
});

describe('the prompt', () => {
  it('a run with no PR conversation reads exactly as before (no pool, no rules)', () => {
    const base = {
      repoFullName: 'o/r', prNumber: 1, title: 't', body: '', headSha: 'b'.repeat(40), baseRef: 'main',
      changedFiles: ['src/a.ts'], excludedFiles: [], diff: 'diff',
    };
    const noConv = selectPriorFindings({ reviewId: 7, headSha: HEAD, findings: [prLevel(1, { conversation: null })] }, 'b'.repeat(40));
    const p = buildUserPrompt({ ...base, followUp: { plan: noConv, since: null }, nonce: '0123456789abcdef' } as never);
    expect(p).not.toContain('PR CONVERSATION');
    expect(p).not.toContain('replyRef');
  });
});

describe('still open on a PR-level finding', () => {
  it('the later run\'s word wins; a code-only item with a thread is not PR-level', () => {
    const it = (priorFindingId: number, status: string, prComment = true) => ({
      priorFindingId, status, how: `how ${priorFindingId}`, explanation: null,
      ...(prComment ? { prComment: { findingId: priorFindingId, commentId: '1', url: null } } : { threadId: 5 }),
    });
    const runs = [
      { followUp: { items: [it(1, 'not_addressed'), it(2, 'not_addressed'), it(3, 'not_addressed', false)] } },
      { followUp: { items: [it(2, 'addressed'), it(4, 'reply_disputed'), it(5, 'not_checked')] } },
    ] as never;
    expect([...prLevelStillOpenItems(runs)]).toEqual([
      [1, 'how 1'],
      [4, 'how 4'],
    ]);
  });

  it('the bodies link the finding, carry the marker, never ping, never forge a marker', () => {
    const body = prLevelStillOpenBody('@alice <!-- pierre:claude-review x --> still cut', '42', 'https://x/#issuecomment-42', '_Posted automatically._');
    expect(body).toMatch(/^\*\*Still open:\*\* /);
    expect(body).not.toContain('@alice');
    expect(body.match(/<!--/g)?.length).toBe(1);
    expect(parsePrLevelMarker(body)).toEqual({ on: '42', act: 'still_open' });
    expect(body).toContain('([the finding](https://x/#issuecomment-42))');
    expect(parsePrLevelMarker(prLevelAckBody('Addressed in abc1234.', '42', null, ''))).toEqual({ on: '42', act: 'ack' });
    expect(prLevelFollowUpMarker('not-a-number', 'ack')).toContain('on=0');
  });
});

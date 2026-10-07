// REPLIES TO LIMN'S OWN FINDINGS — the Previous review rows for 'reply_accepted' / 'reply_disputed':
// the heading, the note and the buttons a row may offer (the server builds the posted body).
//
// ⚠ The safety rule pinned here: "Post reply" is offered ONLY when no Limn reply can already be on
// the thread (an automatic one that went through, or may have), so a click never posts it twice.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ClaudeFollowUpItem, ClaudeReviewFollowUp, ClaudeSettledFinding } from '@pierre-review/shared';
import {
  FOLLOW_UP_STATUS_CLASS,
  isResolvedPushback,
  partitionFollowUp,
  replyActions,
  replyStatusHeading,
  settledEarlierHeading,
  settledEarlierRows,
} from '../src/lib/claudeReviewFollowUp.js';

const item = (o: Partial<ClaudeFollowUpItem>): ClaudeFollowUpItem => ({
  ref: 'P1',
  priorFindingId: 1,
  sent: true,
  carried: false,
  status: 'reply_accepted',
  explanation: null,
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 't',
  reraisedFindingId: null,
  response: 'Fair, a follow-up PR works.',
  threadId: 9,
  threadFindingId: 1,
  threadResolved: false,
  ...o,
});

describe('reply statuses', () => {
  it('headings name what happened', () => {
    expect(replyStatusHeading(item({ acceptKind: 'deferred' }))).toBe('Reply accepted: to be handled later');
    expect(replyStatusHeading(item({ acceptKind: 'not_valid' }))).toBe('Reply accepted: not an issue');
    expect(replyStatusHeading(item({ status: 'reply_disputed' }))).toBe('Pushed back');
    expect(replyStatusHeading(item({ status: 'not_addressed' }))).toBeNull();
  });

  it('every status has a chip colour; disputed is open, accepted is closed', () => {
    expect(FOLLOW_UP_STATUS_CLASS.reply_accepted).toBe(FOLLOW_UP_STATUS_CLASS.addressed);
    const { open, closed } = partitionFollowUp([item({ status: 'reply_accepted' }), item({ status: 'reply_disputed', priorFindingId: 2 })]);
    expect(open.map((i) => i.status)).toEqual(['reply_disputed']);
    expect(closed.map((i) => i.status)).toEqual(['reply_accepted']);
  });

  const R = 2; // this review's id
  it('a draft offers Post reply (+ Resolve for an accepted one)', () => {
    expect(replyActions(item({}), R)).toEqual({ note: null, showText: true, canPost: true, canResolve: true });
    expect(replyActions(item({ status: 'reply_disputed' }), R)).toEqual({ note: null, showText: true, canPost: true, canResolve: false });
    expect(replyActions(item({ threadId: null }), R)).toMatchObject({ canPost: false, canResolve: false });
    expect(replyActions(item({ threadResolved: true }), R)).toEqual({ note: 'The thread is resolved.', showText: true, canPost: false, canResolve: false });
  });

  it('never offers Post reply once a reply of Limn’s may be on the thread', () => {
    const ar = { at: '', outcome: 'reply_accepted' as const, byReviewId: R, headSha: 'h', error: null };
    expect(replyActions(item({ autoResolve: { ...ar, status: 'resolved', replyCommentId: 'C1' } }), R)).toEqual({
      note: 'Replied and resolved automatically.',
      showText: true,
      canPost: false,
      canResolve: false,
    });
    expect(replyActions(item({ autoResolve: { ...ar, status: 'resolved', replyCommentId: 'C1', manual: true } }), R).note).toBe('Replied and resolved.');
    expect(replyActions(item({ autoResolve: { ...ar, status: 'resolving', replyCommentId: null } }), R).canPost).toBe(false);
    // The reply went through, the resolve did not: Resolve only.
    expect(replyActions(item({ autoResolve: { ...ar, status: 'failed', replyCommentId: 'C1', error: '403' } }), R)).toMatchObject({
      canPost: false,
      canResolve: true,
    });
    // An UNCLEAR failure (a 5xx may have posted) is never offered again; a clear refusal is.
    expect(replyActions(item({ autoResolve: { ...ar, status: 'failed', replyCommentId: null, error: '502' } }), R)).toMatchObject({
      note: 'Couldn’t confirm the reply posted. Check the thread on GitHub.',
      canPost: false,
    });
    expect(replyActions(item({ autoResolve: { ...ar, status: 'failed', replyCommentId: null, error: 'Gone', refused: true } }), R)).toMatchObject({
      note: 'Couldn’t reply automatically: Gone',
      canPost: true,
    });
    const pb = { at: '', byReviewId: R, commentId: null, error: null };
    const d = (o: object) => replyActions(item({ status: 'reply_disputed', pushback: { ...pb, ...o } as never }), R);
    expect(d({ status: 'posted', commentId: 'C2' })).toEqual({ note: 'Posted automatically.', showText: true, canPost: false, canResolve: false });
    expect(d({ status: 'posted', commentId: 'C2', manual: true }).note).toBe('Posted.');
    expect(d({ status: 'posting' }).canPost).toBe(false);
    expect(d({ status: 'failed', error: 'Gone', refused: true })).toEqual({ note: 'Couldn’t post automatically: Gone', showText: true, canPost: true, canResolve: false });
    expect(d({ status: 'failed', error: 'Bad gateway' })).toMatchObject({ canPost: false });
  });

  it('a record from an EARLIER review is not this run’s post: says so, hides this run’s text', () => {
    const pb = { at: '', byReviewId: 1, commentId: 'C9', error: null, status: 'posted' as const };
    expect(replyActions(item({ status: 'reply_disputed', pushback: pb }), R)).toEqual({
      note: 'Limn already pushed back on this thread earlier.',
      showText: false,
      canPost: false,
      canResolve: false,
    });
    const ar = { at: '', outcome: 'addressed' as const, byReviewId: 1, headSha: 'h', error: 'x', status: 'failed' as const, replyCommentId: 'C1' };
    expect(replyActions(item({ autoResolve: ar }), R)).toMatchObject({ note: 'Limn already replied on this thread earlier.', showText: false, canPost: false });
  });
});

describe('a reply on a RESOLVED thread', () => {
  const R = 7;
  it('a pushback on a resolved thread stays OPEN, wears "Resolved on GitHub", and can still be posted by hand', () => {
    const it0 = item({ status: 'reply_disputed', response: 'Still unchecked on the API path.', threadId: 4, threadResolved: true });
    expect(isResolvedPushback(it0)).toBe(true);
    expect(partitionFollowUp([it0]).open).toEqual([it0]);
    expect(replyStatusHeading(it0)).toBe('Pushed back');
    expect(replyActions(it0, R)).toMatchObject({ canPost: true, canResolve: false });
    expect(isResolvedPushback(item({ status: 'reply_disputed', threadResolved: false }))).toBe(false);
    expect(isResolvedPushback(item({ status: 'reply_accepted', threadResolved: true }))).toBe(false);
  });
});

describe('settled in an earlier review', () => {
  const s = (o: Partial<ClaudeSettledFinding>): ClaudeSettledFinding => ({
    priorFindingId: 9,
    path: 'src/a.ts',
    line: 3,
    side: 'RIGHT',
    severity: 'warning',
    title: 'Null deref',
    acceptKind: 'not_valid',
    reply: { author: 'alice-dev', excerpt: 'Validated upstream.' },
    acceptedInReviewId: 5,
    ...o,
  });
  const fu = (items: ClaudeFollowUpItem[]): ClaudeReviewFollowUp => ({
    priorReviewId: 1,
    priorHeadSha: 'h',
    headMoved: false,
    changesSinceShown: false,
    items,
  });

  it('says how it was accepted', () => {
    expect(settledEarlierHeading(s({}))).toBe('Reply accepted: not an issue');
    expect(settledEarlierHeading(s({ acceptKind: 'deferred' }))).toBe('Reply accepted: to be handled later');
  });

  it('lists every one, minus praise and anything this run still lists — with or without a follow-up', () => {
    const a = s({});
    const b = s({ priorFindingId: 10 });
    const praise = s({ priorFindingId: 11, severity: 'praise' });
    expect(settledEarlierRows({ followUp: null, settledEarlier: [a, b, praise] })).toEqual([a, b]);
    expect(settledEarlierRows({ followUp: fu([item({ priorFindingId: 10 })]), settledEarlier: [a, b] })).toEqual([a]);
    expect(settledEarlierRows({ followUp: null, settledEarlier: undefined })).toEqual([]);
  });
});

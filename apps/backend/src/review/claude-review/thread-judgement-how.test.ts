// THE ONE-LINE "HOW" ON THE THREAD CARDS, AND THE NEWEST WORD MOVING THE PILL (pure halves of
// thread-judgements.ts; docs/CLAUDE-REVIEW.md § The one-line how, docs/TEAM-REVIEW.md).
import { describe, expect, it } from 'vitest';
import type { ClaudeFollowUpItemRecord, ClaudeReviewFollowUpRecord } from '@pierre-review/shared';
import { findingJudgementsFromFollowUps, teammateFindingJudgement, type StillOpenWord } from './thread-judgements.js';

const item = (over: Partial<ClaudeFollowUpItemRecord>): ClaudeFollowUpItemRecord => ({
  ref: 'P1',
  priorFindingId: 1,
  sent: true,
  carried: false,
  status: 'not_addressed',
  explanation: 'The insert still reads the old id. It needs the new column.',
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 't',
  threadId: 77,
  ...over,
});

const followUp = (items: ClaudeFollowUpItemRecord[]): ClaudeReviewFollowUpRecord =>
  ({ priorReviewId: 1, priorHeadSha: 'a', headMoved: true, items, leftOut: [] }) as unknown as ClaudeReviewFollowUpRecord;

describe('findingJudgementsFromFollowUps → the one line', () => {
  it('is the item\'s how', () => {
    const m = findingJudgementsFromFollowUps([{ id: 9, headSha: 'h', followUp: followUp([item({ how: 'Read the new column in insertRow' })]) }]);
    expect(m.get(77)!.reason).toBe('Read the new column in insertRow');
  });

  it('falls back to the explanation\'s first sentence on an older row', () => {
    const m = findingJudgementsFromFollowUps([{ id: 9, headSha: 'h', followUp: followUp([item({})]) }]);
    expect(m.get(77)!.reason).toBe('The insert still reads the old id.');
  });
});

describe('teammateFindingJudgement — the newest word wins, labelled with who judged it', () => {
  const own = findingJudgementsFromFollowUps([
    { id: 9, headSha: 'old', followUp: followUp([item({ how: 'Still reads the old id' })]), provider: 'claude', model: null },
  ]).get(77)!;
  const word = (over: Partial<StillOpenWord>): StillOpenWord => ({
    open: false,
    at: 2,
    by: { you: false, login: 'robin-dunn', name: 'Robin Dunn' },
    reason: null,
    severity: null,
    headSha: 'new',
    outcome: 'addressed',
    how: 'rowSelect now reads rowid',
    ...over,
  });

  it("a teammate's newer 'addressed' replaces the reader's older 'not addressed'", () => {
    const j = teammateFindingJudgement(own, word({}));
    expect(j.finding).toMatchObject({ status: 'addressed', reviewId: 9, judgedBy: { login: 'robin-dunn', name: 'Robin Dunn' } });
    expect(j.addressed).toBe('addressed');
    expect(j.reason).toBe('rowSelect now reads rowid');
    expect(j.assessedAtHead).toBe('new');
    // The older judgement's words were about older code.
    expect(j.explanation).toBeNull();
    expect(j.provider).toBeUndefined();
  });

  it('still open reads as not addressed, with the still-open reason when no how was sent', () => {
    const j = teammateFindingJudgement(own, word({ open: true, outcome: 'still_open', how: null, reason: 'Add the guard' }));
    expect(j.finding!.status).toBe('not_addressed');
    expect(j.reason).toBe('Add the guard');
  });

  it("the reader's own word is never relabelled", () => {
    expect(teammateFindingJudgement(own, word({ by: { you: true } }))).toBe(own);
  });
});

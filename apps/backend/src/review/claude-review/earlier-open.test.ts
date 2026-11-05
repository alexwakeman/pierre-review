// EARLIER POINTS HOLD THE VERDICT (decision D1, docs/CLAUDE-REVIEW.md § Auto-posting → AUTO VERDICT).
// Pure. Pinned:
//   1. THE FOLD: one word per thread (later half wins; a follow-up beats a thread judgement), a re-raised
//      follow-up item never counts twice, a settled one holds nothing, an unknown severity counts only
//      in `total`.
//   2. THE RULE: an earlier blocker ⇒ REQUEST_CHANGES; an earlier warning ⇒ never APPROVE; earlier
//      nits / questions follow the leftovers rule — in `autoVerdictFor`, the "Not approved" line, the
//      pair's code verdict and the replies outcome alike.
//
//   pnpm --filter @pierre-review/backend test claude-review/earlier-open
import { describe, expect, it } from 'vitest';
import { earlierOpenOf, loadLimnRootSeverities, NO_EARLIER_OPEN, type EarlierOpen } from './earlier-open.js';
import * as dbSchema from '../../db/schema.sqlite.js';
import { autoVerdictFor, blockerWarningCounts, findingsNotApproved, openFindingsReason } from './auto-verdict.js';
import { pairCodeVerdict } from './pair-view.js';
import { repliesNotApproved, repliesVerdict } from './replies-pass.js';

const open = { validity: 'valid', addressed: 'not_addressed' } as const;
const done = { validity: 'valid', addressed: 'addressed' } as const;
const e = (x: Partial<EarlierOpen>): EarlierOpen => ({ ...NO_EARLIER_OPEN, ...x });
const run = { by: 'Claude', verdict: 'APPROVE' as const, summary: null };

describe('the fold', () => {
  it('a teammate’s reminder root keeps its severity (as still-open.ts reads it); a still-open reply is no root', async () => {
    const MARK = '<!-- pierre:claude-review-finding v=1 -->';
    const rows = [
      { id: 1, threadId: 10, body: `**Warning**\n\n**Reminder:** first raised by robin.\n\n${MARK}`, createdAt: new Date(1) },
      { id: 2, threadId: 11, body: `**Blocker**\n\nNull deref.\n\n${MARK}`, createdAt: new Date(1) },
      { id: 3, threadId: 12, body: `**Reminder:** first raised by robin.\n\n${MARK}`, createdAt: new Date(1) },
    ];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q: any = { select: () => q, from: () => q, where: () => q, execute: async () => rows };
    const roots = await loadLimnRootSeverities({ db: q, schema: dbSchema } as any, 1, [10, 11, 12]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(roots.get(10)).toBe('warning');
    expect(roots.get(11)).toBe('blocker');
    expect(roots.get(12)).toBeNull();
  });

  it('thread judgements take the root Limn finding’s severity; a person’s point counts only in total', () => {
    const roots = new Map([[1, 'warning' as const], [2, 'blocker' as const]]);
    const r = earlierOpenOf([{ threadAssessments: [{ threadId: 1, ...open }, { threadId: 2, ...open }, { threadId: 3, ...open }] }], roots);
    expect(r).toEqual({ total: 3, blockers: 1, warnings: 1, nits: 0, questions: 0 });
  });

  it('a re-raised follow-up item counts in total only; a settled one holds nothing', () => {
    const items = [
      { status: 'not_addressed' as const, priorFindingId: 10, severity: 'warning' as const, threadId: 5 },
      { status: 'partly_addressed' as const, priorFindingId: 11, severity: 'blocker' as const, threadId: 6 },
      { status: 'reply_disputed' as const, priorFindingId: 12, severity: 'question' as const, threadId: null },
    ];
    const r = earlierOpenOf([{ findings: [{ priorFindingId: 10 }], followUpItems: items }]);
    expect(r).toEqual({ total: 3, blockers: 1, warnings: 0, nits: 0, questions: 1 });
    expect(earlierOpenOf([{ followUpItems: items }], new Map(), (id) => id === 11)).toEqual({ total: 2, blockers: 0, warnings: 1, nits: 0, questions: 1 });
  });

  it('one word per thread: a follow-up beats a thread judgement; a pair’s later half wins', () => {
    const roots = new Map([[1, 'warning' as const]]);
    const followUpSettles = earlierOpenOf(
      [{ threadAssessments: [{ threadId: 1, ...open }], followUpItems: [{ status: 'addressed', priorFindingId: 9, severity: 'warning', threadId: 1 }] }],
      roots,
    );
    expect(followUpSettles).toEqual(NO_EARLIER_OPEN);
    expect(earlierOpenOf([{ threadAssessments: [{ threadId: 1, ...open }] }, { threadAssessments: [{ threadId: 1, ...done }] }], roots)).toEqual(NO_EARLIER_OPEN);
    expect(earlierOpenOf([{ threadAssessments: [{ threadId: 1, ...done }] }, { threadAssessments: [{ threadId: 1, ...open }] }], roots).warnings).toBe(1);
  });
});

describe('the rule', () => {
  it('autoVerdictFor: an earlier blocker requests changes; a warning holds the approval; leftovers follow the setting', () => {
    expect(autoVerdictFor('APPROVE', [], 'nits_questions', e({ total: 1, blockers: 1 }))).toBe('REQUEST_CHANGES');
    expect(autoVerdictFor('COMMENT', [], 'nits_questions', e({ total: 1, blockers: 1 }))).toBe('REQUEST_CHANGES');
    expect(autoVerdictFor('APPROVE', [], 'nits_questions', e({ total: 1, warnings: 1 }))).toBe('COMMENT');
    expect(autoVerdictFor('APPROVE', [], 'nits_questions', e({ total: 2, nits: 1, questions: 1 }))).toBe('APPROVE');
    expect(autoVerdictFor('APPROVE', [], 'nits', e({ total: 1, questions: 1 }))).toBe('COMMENT');
    expect(autoVerdictFor('APPROVE', [], 'none', e({ total: 1, nits: 1 }))).toBe('COMMENT');
    // A point of unknown severity (a person's comment) never holds it.
    expect(autoVerdictFor('APPROVE', [], 'none', e({ total: 1 }))).toBe('APPROVE');
  });

  it('the "Not approved" line names earlier points apart', () => {
    expect(findingsNotApproved([run], [], undefined, e({ total: 1, warnings: 1 }))?.text).toBe('Not approved: 1 earlier warning is still open.');
    expect(
      findingsNotApproved([run], [{ severity: 'blocker', included: true, story: null }], undefined, e({ total: 2, warnings: 2 }))?.text,
    ).toBe('Not approved: a blocker and 2 earlier warnings are still open.');
    expect(
      findingsNotApproved([run], [], { pairStrictness: 'strict', approveLeftovers: 'nits' }, e({ total: 1, questions: 1 }))?.text,
    ).toBe('Not approved: 1 earlier question is still open.');
    expect(findingsNotApproved([run], [], undefined, e({ total: 1 }))).toBeNull();
    // The old number-only call still reads as "total".
    expect(findingsNotApproved([{ ...run, verdict: 'COMMENT' }], [], undefined, 1)?.text).toBe(
      'Not approved: Claude left a comment, not an approval. 1 earlier point is still open.',
    );
    expect(blockerWarningCounts([], e({ blockers: 1, warnings: 2 }))).toEqual({ blockers: 1, warnings: 2 });
    expect(openFindingsReason([], 'severe', 'nits_questions', e({ blockers: 1 }))?.text).toBe('Not approved: 1 earlier blocker is still open.');
  });

  it('the pair’s code verdict reads them too (strict and relaxed)', () => {
    expect(pairCodeVerdict('APPROVE', 'APPROVE', [], undefined, e({ total: 1, warnings: 1 }))).toBe('COMMENT');
    expect(pairCodeVerdict('APPROVE', 'COMMENT', [], { pairStrictness: 'relaxed', approveLeftovers: 'nits_questions' }, e({ total: 1, blockers: 1 }))).toBe(
      'REQUEST_CHANGES',
    );
    expect(pairCodeVerdict('APPROVE', 'APPROVE', [], undefined, NO_EARLIER_OPEN)).toBe('APPROVE');
  });

  it('the replies outcome: an accepted reply never approves over an earlier warning, and says why', () => {
    const items = [{ status: 'reply_accepted' as const, severity: 'warning' as const, title: 'W' }];
    const base = { open: [], unjudgedEarlierBlockers: 0, items };
    expect(repliesVerdict(base)).toBe('APPROVE');
    expect(repliesVerdict({ ...base, earlier: e({ total: 1, warnings: 1 }) })).toBeNull();
    expect(repliesNotApproved({ ...base, earlier: e({ total: 1, warnings: 1 }) })).toEqual({
      reason: { heldReason: 'open_findings', text: 'Not approved: 1 earlier warning is still open.' },
      held: false,
    });
    expect(repliesVerdict({ ...base, leftovers: 'nits', earlier: e({ total: 1, questions: 1 }) })).toBeNull();
    expect(repliesNotApproved({ ...base, leftovers: 'nits', earlier: e({ total: 1, questions: 1 }) })?.held).toBe(true);
  });
});

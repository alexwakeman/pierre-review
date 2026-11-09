import { describe, expect, it } from 'vitest';
import { criteriaCheckTone, type TicketAssessment, type TicketCriterion } from '@pierre-review/shared';
import { compareCriteriaChecks, criteriaCheckOf, latestRunPerTicket, type CriteriaMemberRow } from './pr-criteria.js';

// THE "Criteria 3/4" CHIP — the pure fold (docs/FRONTEND.md § PR chips).

const crit = (status: TicketCriterion['status'], i: number): TicketCriterion => ({
  ref: `AC${i + 1}`,
  index: i,
  text: `criterion ${i + 1}`,
  status,
  explanation: null,
  deliveredBy: [],
  evidence: [],
  expectedIn: null,
});
const assessment = (...s: TicketCriterion['status'][]): TicketAssessment => ({
  alignment: 'partly_aligned',
  summary: null,
  criteria: s.map(crit),
  missing: [],
  notRequested: [],
});
const member = (over: Partial<CriteriaMemberRow> = {}): CriteriaMemberRow => ({
  prId: 7,
  runId: 3,
  ident: 'jira:x#BMD-7',
  headSha: 'aaa',
  ...over,
});
const run = (a: TicketAssessment | null, id = 3) => ({ id, key: 'BMD-7', title: 'Story', assessment: a, completedAt: new Date(0) });

describe('latestRunPerTicket', () => {
  it('keeps the newest run per (PR, ticket), never across tickets', () => {
    const m = latestRunPerTicket([
      member({ runId: 3 }),
      member({ runId: 9 }),
      member({ runId: 5, ident: 'jira:x#BMD-8' }),
      member({ prId: 8, runId: 2 }),
    ]);
    expect(m.get(7)!.get('jira:x#BMD-7')!.runId).toBe(9);
    expect(m.get(7)!.get('jira:x#BMD-8')!.runId).toBe(5);
    expect(m.get(8)!.get('jira:x#BMD-7')!.runId).toBe(2);
  });
});

describe('criteriaCheckOf', () => {
  it('"met" is status met — partly met, not met, unclear and not checked are not done', () => {
    const c = criteriaCheckOf(member(), run(assessment('met', 'met', 'met', 'partly_met')), 'aaa')!;
    expect(c).toMatchObject({ met: 3, partlyMet: 1, notMet: 0, unsettled: 0, total: 4, olderHead: false });
    const d = criteriaCheckOf(member(), run(assessment('met', 'not_met', 'unclear', 'not_checked')), 'aaa')!;
    expect(d).toMatchObject({ met: 1, notMet: 1, unsettled: 2, total: 4 });
  });

  it('met outside code changes is DONE, counted apart; the chip goes green on met + outside code', () => {
    const c = criteriaCheckOf(member(), run(assessment('met', 'met_outside_code', 'met')), 'aaa')!;
    expect(c).toMatchObject({ met: 2, metOutsideCode: 1, partlyMet: 0, notMet: 0, unsettled: 0, total: 3 });
    expect(criteriaCheckTone(c)).toBe('met');
    expect(criteriaCheckTone({ met: 1, metOutsideCode: 1, notMet: 0, total: 3 })).toBe('partly');
  });

  it('a check with no criteria, or none at all, is no chip (unknown is never zero)', () => {
    expect(criteriaCheckOf(member(), run(assessment()), 'aaa')).toBeNull();
    expect(criteriaCheckOf(member(), run(null), 'aaa')).toBeNull();
    expect(criteriaCheckOf(member(), undefined, 'aaa')).toBeNull();
  });

  it('olderHead: the run read another head; an unknown current head says nothing', () => {
    expect(criteriaCheckOf(member(), run(assessment('met')), 'bbb')!.olderHead).toBe(true);
    expect(criteriaCheckOf(member(), run(assessment('met')), null)!.olderHead).toBe(false);
  });

  it('orders by key, numerically, pasted stories last', () => {
    const a = { ...criteriaCheckOf(member(), run(assessment('met')), 'aaa')!, key: 'BMD-10' };
    const b = { ...a, key: 'BMD-9' };
    const c = { ...a, key: null };
    expect([c, a, b].sort(compareCriteriaChecks).map((x) => x.key)).toEqual(['BMD-9', 'BMD-10', null]);
  });
});

describe('criteriaCheckTone', () => {
  it('all met → met; any not met → not_met; else partly', () => {
    expect(criteriaCheckTone({ met: 4, notMet: 0, total: 4 })).toBe('met');
    expect(criteriaCheckTone({ met: 3, notMet: 1, total: 4 })).toBe('not_met');
    expect(criteriaCheckTone({ met: 3, notMet: 0, total: 4 })).toBe('partly');
  });
});

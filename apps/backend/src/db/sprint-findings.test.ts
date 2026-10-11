import { describe, expect, it } from 'vitest';
import type { SprintAssessmentBody, StoryCriterionLabel, StoryIssueLabel, TicketLinkBlocker } from '@pierre-review/shared';
import { quotesOverlap, sameFindingSubject, sprintFindingsFor, type SprintFindingsInput } from './sprint-findings.js';

// Reports → This sprint: a ticket's ANCHORED findings (db/sprint-findings.ts) — code's no-criteria,
// the real open blockers, the current label's criteria / dependencies / gaps and a current
// assessment's findings, every quote re-verified against the text on the wire.

const crit = (n: number, o: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({ n, testable: true, reason: null, ...o });
const base = (o: Partial<SprintFindingsInput> = {}): SprintFindingsInput => ({
  provider: 'jira',
  title: 'Save the basket',
  description: 'The basket should feel instant. Ships once the API is ready (BMD-9).',
  acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days',
  issueType: 'Story',
  label: null,
  ...o,
});
const label = (o: Partial<StoryIssueLabel['story']> = {}, criteria?: StoryCriterionLabel[]): StoryIssueLabel => ({
  criteria: criteria ?? [crit(1), crit(2, { testable: false, reason: 'no unit given', rule: 'no_expected_result', quote: 'after 30 days' })],
  story: { dependencies: [], gaps: [], ...o },
});
const link = (key: string, o: Partial<TicketLinkBlocker> = {}): TicketLinkBlocker => ({
  key,
  title: `Title ${key}`,
  status: 'To Do',
  category: 'new',
  relation: 'is blocked by',
  url: null,
  ...o,
});

describe('sprintFindingsFor', () => {
  it('no criteria: one code finding, rule no_criteria, never quoted', () => {
    const f = sprintFindingsFor(base({ acceptanceCriteria: '', description: 'Nothing listed' }));
    expect(f).toEqual([
      expect.objectContaining({ id: 'u-none', issue: 'unclear_done', rule: 'no_criteria', quote: null, where: null, brief: 'No criteria', source: 'code' }),
    ]);
  });

  it('an untestable criterion carries its rule, verified quote and the labeller’s reason', () => {
    const [f] = sprintFindingsFor(base({ label: label() }));
    expect(f).toMatchObject({
      id: 'u-c2',
      issue: 'unclear_done',
      rule: 'no_expected_result',
      quote: 'after 30 days',
      where: 'criteria',
      brief: 'No expected result',
      detail: 'no unit given',
      suggestion: null,
      source: 'code',
    });
  });

  it('a quote that does not verify falls back to the criterion’s own sentence — a known position, never a guess', () => {
    const l = label({}, [crit(1), crit(2, { testable: false, reason: 'vague', rule: 'vague_term', quote: 'not in the ticket' })]);
    expect(sprintFindingsFor(base({ label: l }))[0]).toMatchObject({ quote: 'Basket expires after 30 days', where: 'criteria' });
  });

  it('a label that judged a different number of criteria is ignored', () => {
    const l = label({ gaps: [{ type: 'edge_case', text: 'No rule', quote: null }] }, [crit(1)]);
    expect(sprintFindingsFor(base({ label: l }))).toEqual([]);
  });

  it('blockers: real open ones only; a link is quoted by its key when the key is in the text; text blockers by the label’s quote', () => {
    const l = label({
      dependencies: [
        { kind: 'decision', what: 'copy sign-off', owner: 'PO', ticketKey: null, quote: 'Ships once the API is ready' },
        // An input, not a blocker: dropped.
        { kind: 'design', what: 'Figma', owner: null, ticketKey: null, quote: null },
      ],
    });
    const f = sprintFindingsFor(base({ label: l, links: [link('BMD-9'), link('BMD-10'), link('BMD-11', { category: 'done' })] }));
    const blocked = f.filter((x) => x.issue === 'blocked');
    expect(blocked.map((x) => [x.id, x.rule, x.quote])).toEqual([
      ['b-0', 'waits_on_ticket', 'BMD-9'],
      ['b-1', 'waits_on_ticket', null],
      ['b-2', 'waits_on_decision', 'Ships once the API is ready'],
    ]);
    expect(blocked[0]!.detail).toBe('BMD-9 Title BMD-9 (To Do)');
    expect(blocked[0]!.blocker).toMatchObject({ source: 'link', ticketKey: 'BMD-9' });
    // A key is anchored as a whole token only.
    const partial = sprintFindingsFor(base({ description: 'See BMD-95.', links: [link('BMD-9')] }));
    expect(partial.find((x) => x.issue === 'blocked')!.quote).toBeNull();
  });

  it('spec gaps: every stage, at most three, typed by rule; a gap about something absent is unanchored', () => {
    const l = label({
      gaps: [
        { type: 'error_handling', text: 'No behaviour when saving fails', quote: 'Basket survives a reload' },
        { type: 'rule', text: 'No rule for guests', quote: null },
        { type: 'non_functional', text: 'No speed target', quote: 'feel instant' },
      ],
    });
    const gaps = sprintFindingsFor(base({ label: l })).filter((x) => x.issue === 'spec_gaps');
    expect(gaps.map((g) => [g.id, g.rule, g.quote, g.where])).toEqual([
      ['g-0', 'error_handling', 'Basket survives a reload', 'criteria'],
      ['g-1', 'business_rule', null, null],
      ['g-2', 'non_functional', 'feel instant', 'description'],
    ]);
  });

  it('a current assessment adds Claude’s findings after code’s, its quote re-verified and its suggestion kept only with a quote', () => {
    const body: SprintAssessmentBody = {
      mode: 'plan' as const,
      plan: [],
      criterionChecks: [],
      coverage: null,
      summary: 'S',
      findings: [
        { issue: 'unclear_done', rule: 'vague_term', quote: 'feel instant', where: 'description', text: '“Instant” cannot be tested.', suggestion: 'loads in under 1 second', ref: null },
        { issue: 'spec_gaps', rule: 'edge_case', quote: 'gone from the ticket since', where: 'description', text: 'No rule for an empty basket.', suggestion: 'x', ref: { repo: 'a/b', path: 'src/x.ts' } },
      ],
      revisedCriteria: [],
      revisedDescription: null,
    };
    const f = sprintFindingsFor(base({ label: label() }), undefined, body);
    expect(f.map((x) => [x.id, x.source])).toEqual([
      ['u-c2', 'code'],
      ['claude-0', 'claude'],
      ['claude-1', 'claude'],
    ]);
    expect(f[1]).toMatchObject({ quote: 'feel instant', where: 'description', suggestion: 'loads in under 1 second', detail: '“Instant” cannot be tested.' });
    expect(f[2]).toMatchObject({ quote: null, where: null, suggestion: null, ref: { repo: 'a/b', path: 'src/x.ts' } });
  });

  it('ONE ROW PER THING: a Claude finding on the same passage or the same ticket key merges into the code row', () => {
    const l = label(
      {
        dependencies: [{ kind: 'ticket', what: 'Payments', owner: null, ticketKey: 'BMD-9', quote: 'Ships once the API is ready' }],
        gaps: [
          { type: 'edge_case', text: 'No behaviour when saving fails', quote: 'Basket survives a reload' },
          { type: 'rule', text: 'No rule for guests', quote: null },
        ],
      },
    );
    const body: SprintAssessmentBody = {
      mode: 'plan' as const,
      plan: [],
      criterionChecks: [],
      coverage: null,
      summary: 'S',
      findings: [
        // Same criterion passage (the code quote holds it): merged into u-c2.
        { issue: 'unclear_done', rule: 'vague_term', quote: 'expires after 30 days', where: 'criteria', text: 'Say what expiry shows.', suggestion: 'The basket is empty after 30 days', ref: null },
        // Names the same ticket key, no quote of its own: merged into the code blocker, keeps code's anchor.
        { issue: 'blocked', rule: 'waits_on_ticket', quote: null, where: null, text: 'Waits on BMD-9 Payments (To Do).', suggestion: null, ref: null },
        // Same gap passage: merged.
        { issue: 'spec_gaps', rule: 'error_handling', quote: 'Basket survives a reload', where: 'criteria', text: 'No behaviour when the save fails.', suggestion: null, ref: null },
        // Nothing in common: its own row.
        { issue: 'spec_gaps', rule: 'edge_case', quote: 'feel instant', where: 'description', text: 'No speed target.', suggestion: null, ref: null },
      ],
      revisedCriteria: [],
      revisedDescription: null,
    };
    const f = sprintFindingsFor(base({ label: l }), undefined, body);
    expect(f.map((x) => [x.issue, x.source, x.detail])).toEqual([
      ['unclear_done', 'claude', 'Say what expiry shows.'],
      ['blocked', 'claude', 'Waits on BMD-9 Payments (To Do).'],
      ['spec_gaps', 'code', 'No rule for guests'],
      ['spec_gaps', 'claude', 'No behaviour when the save fails.'],
      ['spec_gaps', 'claude', 'No speed target.'],
    ]);
    const blocked = f.find((x) => x.issue === 'blocked')!;
    expect(blocked).toMatchObject({ rule: 'waits_on_ticket', quote: 'Ships once the API is ready', blocker: { ticketKey: 'BMD-9' } });
    expect(f.find((x) => x.issue === 'unclear_done')).toMatchObject({ quote: 'expires after 30 days', suggestion: 'The basket is empty after 30 days' });
  });

  it('quotesOverlap / sameFindingSubject: containment, a shared run, a shared key; never across issues', () => {
    expect(quotesOverlap('Basket expires after 30 days', 'after  30 DAYS')).toBe(true);
    expect(quotesOverlap('The user is directed to the upload function', 'is directed to the upload function BMD-343')).toBe(true);
    expect(quotesOverlap('feel instant', 'after 30 days')).toBe(false);
    expect(quotesOverlap(null, 'x')).toBe(false);
    const code = { id: 'b-0', issue: 'blocked' as const, rule: 'waits_on_ticket' as const, quote: null, where: null, brief: '', detail: 'BMD-343 Upload (status unknown)', suggestion: null, source: 'code' as const, ref: null };
    expect(sameFindingSubject(code, { ...code, id: 'claude-0', source: 'claude', detail: 'Every AC depends on BMD-343.' })).toBe(true);
    expect(sameFindingSubject(code, { ...code, id: 'claude-0', source: 'claude', detail: 'Waits on BMD-34.' })).toBe(false);
    expect(sameFindingSubject(code, { ...code, issue: 'spec_gaps', id: 'claude-0', source: 'claude', detail: 'BMD-343' })).toBe(false);
  });

  it('the workspace checks filter findings like chips: an issue off, a type not checked', () => {
    const l = label({ gaps: [{ type: 'edge_case', text: 'No rule', quote: null }] });
    expect(sprintFindingsFor(base({ label: l }), { off: ['spec_gaps'], issueTypes: [] }).map((x) => x.issue)).toEqual(['unclear_done']);
    expect(sprintFindingsFor(base({ label: l }), { off: [], issueTypes: ['Bug'] })).toEqual([]);
  });
});

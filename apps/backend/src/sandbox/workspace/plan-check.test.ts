// THE PLAN VALIDATOR (plan-check.ts): every shape rule, the content problems, Fill gaps refs, the stack line
// rule and the quote finder. The checker script: plan-check-script.test.ts (real node + git).
import { describe, expect, it } from 'vitest';
import { findQuote, validateBuildPlan, type BuildPlanCheckContext } from './plan-check.js';
import { CTX, goodPlan } from './plan.test-support.js';

const shape = (raw: unknown, ctx: Partial<BuildPlanCheckContext> = {}): string[] => validateBuildPlan(raw, { ...CTX, ...ctx }).shapeProblems;

describe('validateBuildPlan — shape', () => {
  it('passes a good plan', () => {
    const r = validateBuildPlan(goodPlan(), CTX);
    expect(r.shapeProblems).toEqual([]);
    expect(r.contentProblems).toEqual([]);
    expect(r.plan).not.toBeNull();
  });
  it('refuses a non-object and a wrong schema', () => {
    expect(shape([])).toEqual(['The plan must be one JSON object.']);
    expect(shape(goodPlan({ schema: 'limn.plan/2' }))[0]).toMatch(/"schema"/);
  });
  it('refuses a missing summary and a non-list field', () => {
    expect(shape(goodPlan({ summary: '' })).join('\n')).toMatch(/"summary"/);
    expect(shape(goodPlan({ stack: {} })).join('\n')).toMatch(/"stack" must be a list/);
  });
  it('refuses repos that are empty, unknown or repeated', () => {
    expect(shape(goodPlan({ repos: [] })).join('\n')).toMatch(/at least one repository/);
    expect(shape(goodPlan({ repos: [{ repo: 'acme/other', why: 'x' }] })).join('\n')).toMatch(/not a repository of this session/);
    const twice = goodPlan({ repos: [{ repo: 'acme/api', why: 'x' }, { repo: 'ACME/API', why: 'y' }] });
    expect(shape(twice).join('\n')).toMatch(/listed twice/);
  });
  it('needs every criterion once, and only known ones', () => {
    const p = goodPlan();
    p.criteria = [p.criteria[0]];
    expect(shape(p).join('\n')).toMatch(/no entry for AC2/);
    const q = goodPlan();
    q.criteria.push({ ref: 'AC9', status: 'met', how: 'x', prs: [] });
    expect(shape(q).join('\n')).toMatch(/"AC9" is not a criterion/);
    const r = goodPlan();
    r.criteria.push({ ...r.criteria[0] });
    expect(shape(r).join('\n')).toMatch(/AC1 is listed twice/);
  });
  it('needs a PR for a planned criterion, and a PR that exists', () => {
    const p = goodPlan();
    p.criteria[0].prs = [];
    expect(shape(p).join('\n')).toMatch(/AC1 is planned, so "prs"/);
    const q = goodPlan();
    q.criteria[0].prs = ['P7'];
    expect(shape(q).join('\n')).toMatch(/names P7, which is not in "stack"/);
  });
  it('Fill gaps: a gap may not be "met"', () => {
    const p = goodPlan();
    p.criteria[1] = { ref: 'AC2', status: 'met', how: 'Done in #12.', prs: [] };
    expect(shape(p, { gaps: ['AC2'], fillGaps: true }).join('\n')).toMatch(/AC2 is a gap/);
    expect(shape(p, { gaps: ['AC1'], fillGaps: true })).toEqual([]);
  });
  it('the stack: ids, repos, limits, order, the line rule and the reason', () => {
    const dup = goodPlan();
    dup.stack[1].id = 'P1';
    expect(shape(dup).join('\n')).toMatch(/used twice/);
    const noPr = goodPlan();
    noPr.stack = [noPr.stack[0]];
    noPr.criteria[1].prs = ['P1'];
    expect(shape(noPr).join('\n')).toMatch(/acme\/web is in "repos" but has no pull request/);
    const later = goodPlan();
    later.stack[0].dependsOn = ['P2'];
    expect(shape(later).join('\n')).toMatch(/not an EARLIER pull request/);
    const four = goodPlan();
    four.stack = [1, 2, 3, 4].map((n) => ({ id: `P${n}`, repo: 'acme/api', title: `Part ${n}`, contains: 'x', criteria: [], dependsOn: n > 1 ? [`P${n - 1}`] : [] }));
    four.stack.push({ id: 'P5', repo: 'acme/web', title: 'Web', contains: 'x', criteria: [], dependsOn: [] });
    four.stackReason = 'Smaller reviews.';
    expect(shape(four).join('\n')).toMatch(/at most 3 per repository/);
    const broken = goodPlan();
    broken.stack.splice(1, 0, { id: 'P3', repo: 'acme/api', title: 'Second', contains: 'x', criteria: [], dependsOn: [] });
    broken.stackReason = 'Smaller reviews.';
    expect(shape(broken).join('\n')).toMatch(/must include P1 \(the stack in one repository is one line\)/);
    const unreasoned = goodPlan();
    unreasoned.stack.splice(1, 0, { id: 'P3', repo: 'acme/api', title: 'Second', contains: 'x', criteria: [], dependsOn: ['P1'] });
    expect(shape(unreasoned).join('\n')).toMatch(/"stackReason" must say why/);
    unreasoned.stackReason = 'The migration is reviewed apart.';
    expect(shape(unreasoned)).toEqual([]);
    const seven = goodPlan({ stack: Array.from({ length: 7 }, (_, i) => ({ id: `P${i + 1}`, repo: 'acme/api', title: 't', contains: 'c', criteria: [], dependsOn: [] })) });
    expect(shape(seven).join('\n')).toMatch(/at most 6/);
  });
  it('contentions: id form, uniqueness and 1..4 evidence items', () => {
    const p = goodPlan();
    p.contentions[0].id = 'X1';
    expect(shape(p).join('\n')).toMatch(/"C1", "C2"/);
    const none = goodPlan();
    none.contentions[0].evidence = [];
    expect(shape(none).join('\n')).toMatch(/1 to 4 items/);
    const five = goodPlan();
    five.contentions[0].evidence = Array(5).fill(five.contentions[0].evidence[0]);
    expect(shape(five).join('\n')).toMatch(/1 to 4 items/);
    const two = goodPlan();
    two.contentions.push({ ...two.contentions[0] });
    expect(shape(two).join('\n')).toMatch(/C1 is used twice/);
  });
  it('a point of contention needs a draft ticket update', () => {
    expect(shape(goodPlan({ ticketUpdate: null })).join('\n')).toMatch(/"ticketUpdate" is null, but "contentions" says the story is wrong/);
    expect(shape(goodPlan({ ticketUpdate: null, contentions: [] }))).toEqual([]);
  });
  it('a criterion not planned needs a draft ticket update too (the criteria need revising)', () => {
    const p = goodPlan({ ticketUpdate: null, contentions: [] });
    p.criteria[1] = { ...p.criteria[1], status: 'not_planned', prs: [], how: 'Out of scope: the export is another team.' };
    expect(shape(p).join('\n')).toMatch(/"ticketUpdate" is null, but a criterion is "not_planned"/);
  });
  it('criteria that live in the description go in "description", never "acceptanceCriteria"', () => {
    const tu = { description: null, acceptanceCriteria: '1. GIVEN a report', why: 'C1', contentions: ['C1'] };
    const ticket = { acLocation: 'description' as const, headings: ['Acceptance criteria'], criteriaStyle: 'numbered', gherkin: true };
    expect(shape(goodPlan({ ticketUpdate: tu }), { ticket }).join('\n')).toMatch(/criteria live in the ticket's description/);
    expect(shape(goodPlan({ ticketUpdate: { ...tu, description: '## Acceptance criteria\n1. GIVEN a report', acceptanceCriteria: null } }), { ticket })).toEqual([]);
    expect(shape(goodPlan({ ticketUpdate: tu }), { ticket: { ...ticket, acLocation: 'field' } })).toEqual([]);
  });
  it('the ticket update: one whole field at least, and a reason', () => {
    expect(shape(goodPlan({ ticketUpdate: { description: null, acceptanceCriteria: null, why: 'x', contentions: [] } })).join('\n')).toMatch(/must have a new/);
    expect(shape(goodPlan({ ticketUpdate: { description: 'New text.', acceptanceCriteria: null, why: '', contentions: [] } })).join('\n')).toMatch(/ticketUpdate.why/);
    expect(shape(goodPlan({ ticketUpdate: { description: null, acceptanceCriteria: 'GIVEN a report\nWHEN I export\nTHEN every row is in the file', why: 'C1', contentions: ['C1'] } }))).toEqual([]);
  });
});

describe('validateBuildPlan — content (named and dropped)', () => {
  it('drops evidence that names an unknown repository, run or a docs item outside a docs session', () => {
    const p = goodPlan();
    p.contentions[0].evidence = [
      { kind: 'code', repo: 'acme/infra', path: 'a.ts', lines: [1, 2], quote: 'const MAX_ROWS = 1000;' },
      { kind: 'data_run', run: 'svc-9', quote: 'count 1000 rows returned' },
      { kind: 'docs', link: 'billing/sections/01-refunds.md', quote: 'Refunds are allowed for 30 days.' },
      { kind: 'data_run', run: 'svc-1', quote: 'count 1000 rows returned' },
    ];
    const r = validateBuildPlan(p, CTX);
    expect(r.shapeProblems).toEqual([]);
    expect(r.droppedEvidence).toEqual({ C1: [0, 1, 2] });
    expect(r.contentProblems.join('\n')).toMatch(/svc-9" is not a run Limn recorded/);
    expect(r.contentProblems.join('\n')).toMatch(/no reference documents are in this session/);
  });
  it('drops a quote too short to check, an absolute or .. path, and a span over 120 lines', () => {
    const p = goodPlan();
    p.contentions[0].evidence = [
      { kind: 'code', repo: 'acme/api', path: 'a.ts', lines: [1, 1], quote: 'x = 1' },
      { kind: 'code', repo: 'acme/api', path: '../etc/passwd', lines: [1, 1], quote: 'root user entry here' },
      { kind: 'code', repo: 'acme/api', path: 'a.ts', lines: [1, 200], quote: 'const MAX_ROWS = 1000;' },
      { kind: 'data_file', what: 'seed', repo: 'acme/api', path: '.git/config', lines: [1, 1], quote: 'remote origin url here' },
    ];
    const r = validateBuildPlan(p, CTX);
    expect(r.droppedEvidence.C1).toEqual([0, 1, 2, 3]);
    expect(r.contentProblems.join('\n')).toMatch(/C1 has no evidence left/);
  });
  it('names a PR criterion that is not in TICKET.md', () => {
    const p = goodPlan();
    p.stack[0].criteria = ['AC1', 'AC7'];
    expect(validateBuildPlan(p, CTX).contentProblems).toEqual(['P1.criteria: "AC7" is not a criterion of TICKET.md.']);
  });
});

describe('findQuote', () => {
  const file = ['import x from "y";', '', 'export const MAX_ROWS = 1000;', '', 'function go() {', '  return   MAX_ROWS;', '}', 'export const MAX_ROWS = 1000;'].join('\n');
  it('finds a quote within the stated lines, whitespace folded', () => {
    expect(findQuote(file, 'function go() { return MAX_ROWS; }', 5, 7)).toEqual({ at: 'in', start: 5, end: 7 });
    expect(findQuote(file, 'function go() {\n return MAX_ROWS;', 4, 4)).toEqual({ at: 'in', start: 4, end: 6 });
  });
  it('moves the lines when the quote is unique elsewhere; ambiguous when it is not', () => {
    expect(findQuote(file, 'function go()', 40, 41)).toEqual({ at: 'moved', start: 5, end: 5 });
    expect(findQuote(file, 'export const MAX_ROWS = 1000;', 30, 30).at).toBe('ambiguous');
    expect(findQuote(file, 'export const MAX_ROWS = 1000;', 8, 8)).toEqual({ at: 'in', start: 8, end: 8 });
    expect(findQuote(file, 'nothing like this', 1, 1).at).toBe('none');
  });
});

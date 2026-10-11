import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_ASSESS_CAPS } from '@pierre-review/shared';
import { blockedFindingNamesOnlyNonBlocking, normaliseCitedPath, validateSprintAssessment } from './validate.js';

// The sprint assessment's server validator: every cited path is checked against a REAL temp checkout
// (dropped when missing, outside, absolute elsewhere, `..`, or in an unaccepted repo — the sentence is
// kept), every quote is checked against the ticket text (nulled when it does not hold — the finding is
// kept), caps cut text and lists, unknown issues or rules outside their issue are dropped, and an
// empty result is refused.

let root: string;
let web: string;
let api: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sprint-validate-'));
  web = join(root, 'web');
  api = join(root, 'api');
  outside = join(root, 'secret');
  for (const d of [web, api, outside]) mkdirSync(d, { recursive: true });
  mkdirSync(join(web, 'src', 'basket'), { recursive: true });
  writeFileSync(join(web, 'src', 'basket', 'store.ts'), 'export {}');
  writeFileSync(join(api, 'routes.ts'), 'export {}');
  writeFileSync(join(outside, 'keys.txt'), 'x');
  symlinkSync(outside, join(web, 'escape'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ctx = (mode: 'plan' | 'verify' = 'plan') => ({
  mode,
  repos: [
    { fullName: 'acme/web', path: web },
    { fullName: 'acme/api', path: api },
  ],
});

const body = (findings: unknown[], extra: Record<string, unknown> = {}) => ({
  summary: 'This may already be done.',
  findings,
  revisedCriteria: [],
  ...extra,
});

const TICKET = {
  title: 'Save the basket',
  description: 'The basket should feel  instant.\nShips once the API is ready.',
  criteria: ['Basket survives a reload', 'Basket expires after 30 days'],
};
const f = (o: Record<string, unknown> = {}) => ({ issue: 'unclear_done', rule: 'vague_term', text: 'Criterion 2 cannot be checked.', ...o });

describe('normaliseCitedPath', () => {
  it('normalises and refuses the unsafe', () => {
    expect(normaliseCitedPath('./src//basket/store.ts', web)).toBe('src/basket/store.ts');
    expect(normaliseCitedPath('src\\basket\\store.ts', web)).toBe('src/basket/store.ts');
    expect(normaliseCitedPath(join(web, 'src/basket/store.ts'), web)).toBe('src/basket/store.ts');
    expect(normaliseCitedPath('/etc/passwd', web)).toBeNull();
    expect(normaliseCitedPath('../secret/keys.txt', web)).toBeNull();
    expect(normaliseCitedPath('src/../../secret', web)).toBeNull();
    expect(normaliseCitedPath('src/\u0000x', web)).toBeNull();
    expect(normaliseCitedPath('', web)).toBeNull();
    expect(normaliseCitedPath(42, web)).toBeNull();
  });
});

describe('validateSprintAssessment', () => {
  it('keeps the sentence and a verified path; an unverified path is dropped, the sentence kept', () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ repo: 'acme/web', path: 'src/basket/store.ts' }, { repo: 'acme/web', path: 'src/basket/store.ts' }],
      [{ repo: 'ACME/API', path: 'routes.ts' }, { repo: 'acme/api', path: 'routes.ts' }],
      [{ repo: 'acme/web', path: 'src/missing.ts' }, null], // does not exist
      [{ repo: 'acme/other', path: 'routes.ts' }, null], // not an accepted repo
      [{ repo: 'acme/web', path: '../secret/keys.txt' }, null], // ..
      [{ repo: 'acme/web', path: '/etc/hosts' }, null], // absolute outside
      [{ repo: 'acme/web', path: 'escape/keys.txt' }, null], // symlink out of the checkout
      [{ path: 'routes.ts' }, null], // no repo, and two were checked out
      [{}, null], // nothing cited: not counted
    ];
    let refused = 0;
    for (const [cite, ref] of cases) {
      const v = validateSprintAssessment(body([f(cite)]), ctx());
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.body.findings).toEqual([
        { issue: 'unclear_done', rule: 'vague_term', quote: null, where: null, text: 'Criterion 2 cannot be checked.', suggestion: null, ref },
      ]);
      refused += v.dropped.paths;
    }
    expect(refused).toBe(6);
  });

  it('format 4: issue + a rule of THAT issue; code-only, foreign or unknown rules, retired ids and empty text are dropped; stable issue order', () => {
    const v = validateSprintAssessment(
      body([
        f({ issue: 'spec_gaps', rule: 'error_handling', text: 'No behaviour when the upload fails.' }),
        f({ issue: 'no_persona', rule: 'vague_term', text: 'old id' }),
        f({ issue: 'too_big', rule: 'vague_term', text: 'a retired id' }),
        f({ issue: 'unclear_done', rule: 'no_criteria', text: 'code-only rule' }),
        f({ issue: 'blocked', rule: 'edge_case', text: 'another issue’s rule' }),
        f({ issue: 'blocked', rule: 'made_up', text: 'unknown rule' }),
        f({ issue: 'blocked', rule: 'waits_on_ticket', text: '   ' }),
        f({ issue: 'blocked', rule: 'waits_on_ticket', text: 'Waits on BMD-12 pricing API (To Do), owned by Payments.' }),
        f({ issue: 'spec_gaps', rule: 'edge_case', text: 'Second gap, same issue: kept.' }),
        f({ text: 'Criterion 2 cannot be checked.' }),
      ]),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.findings.map((x) => [x.issue, x.rule])).toEqual([
      ['unclear_done', 'vague_term'],
      ['blocked', 'waits_on_ticket'],
      ['spec_gaps', 'error_handling'],
      ['spec_gaps', 'edge_case'],
    ]);
    expect(v.dropped.items).toBe(6);
    const over = validateSprintAssessment(
      body(Array.from({ length: SPRINT_ASSESS_CAPS.findings + 2 }, (_, i) => f({ text: `t${i}` }))),
      ctx(),
    );
    expect(over.ok && over.body.findings).toHaveLength(SPRINT_ASSESS_CAPS.findings);
    expect(over.ok && over.dropped.items).toBe(2);
  });

  it('⚠ every quote is VERIFIED against the ticket: kept in the ticket’s spelling with where; a miss is null with its suggestion, the finding kept', () => {
    const v = validateSprintAssessment(
      body([
        f({ quote: 'feel instant', suggestion: 'loads in under a second' }),
        f({ issue: 'blocked', rule: 'waits_on_external', quote: 'ONCE THE API IS READY' }),
        f({ quote: '2. Basket expires after 30 days', suggestion: 'expires 30 days after the last change' }),
        f({ quote: 'feel slow', suggestion: 'dropped with its quote' }),
        f({ quote: null, suggestion: 'no quote, no rewrite' }),
      ]),
      { ...ctx(), ticket: TICKET },
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.findings.map((x) => [x.quote, x.where, x.suggestion])).toEqual([
      ['feel instant', 'description', 'loads in under a second'],
      ['Basket expires after 30 days', 'criteria', 'expires 30 days after the last change'],
      [null, null, null],
      [null, null, null],
      ['once the API is ready', 'description', null],
    ]);
    expect(v.dropped.quotes).toBe(1);
    // Without the ticket text nothing can be verified: every quote is null.
    const blind = validateSprintAssessment(body([f({ quote: 'feel instant' })]), ctx());
    expect(blind.ok && blind.body.findings[0]!.quote).toBeNull();
  });

  it('cuts long text with an ellipsis and caps the revised criteria', () => {
    const long = (n: number) => 'w'.repeat(n + 50);
    const v = validateSprintAssessment(
      body([f({ issue: 'spec_gaps', rule: 'edge_case', text: long(SPRINT_ASSESS_CAPS.findingText) })], {
        summary: long(SPRINT_ASSESS_CAPS.summary),
        revisedCriteria: ['', long(SPRINT_ASSESS_CAPS.criterionText), ...Array.from({ length: SPRINT_ASSESS_CAPS.revisedCriteria + 2 }, (_, i) => `c${i}`)],
      }),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.summary.length).toBe(SPRINT_ASSESS_CAPS.summary);
    expect(v.body.summary.endsWith('…')).toBe(true);
    expect(v.body.findings[0]!.text.length).toBe(SPRINT_ASSESS_CAPS.findingText);
    expect(v.body.revisedCriteria).toHaveLength(SPRINT_ASSESS_CAPS.revisedCriteria);
    expect(v.body.revisedCriteria[0]!.length).toBe(SPRINT_ASSESS_CAPS.criterionText);
    // the empty one + 3 over the cap
    expect(v.dropped.items).toBe(4);
  });

  it('revisedDescription: kept when it changes the text; blank, unchanged or over the cap is not', () => {
    const ok = (d: unknown) => {
      const v = validateSprintAssessment(body([], { revisedDescription: d }), { ...ctx(), ticket: TICKET });
      return v.ok ? v.body.revisedDescription : 'refused';
    };
    expect(ok('  A new description.  ')).toBe('A new description.');
    expect(ok('   ')).toBeNull();
    expect(ok(undefined)).toBeNull();
    expect(ok(TICKET.description)).toBeNull();
    expect(ok('d'.repeat(SPRINT_ASSESS_CAPS.revisedDescription + 1))).toBeNull();
    // A description alone is a usable result.
    expect(validateSprintAssessment(body([], { summary: '', revisedDescription: 'New.' }), ctx()).ok).toBe(true);
  });

  it('a repo may be left out when exactly one was checked out', () => {
    const v = validateSprintAssessment(body([f({ path: 'src/basket' })]), {
      mode: 'plan',
      repos: [{ fullName: 'acme/web', path: web }],
    });
    expect(v.ok && v.body.findings[0]!.ref).toEqual({ repo: 'acme/web', path: 'src/basket' });
  });

  it('accepts a summary alone or revised criteria alone; refuses an empty result and a non-object', () => {
    expect(validateSprintAssessment(body([]), ctx()).ok).toBe(true);
    expect(validateSprintAssessment(body([], { summary: '', revisedCriteria: ['One outcome'] }), ctx()).ok).toBe(true);
    expect(validateSprintAssessment(body([f({ issue: 'nope' })], { summary: '   ' }), ctx()).ok).toBe(false);
    expect(validateSprintAssessment(null, ctx()).ok).toBe(false);
    expect(validateSprintAssessment('text', ctx()).ok).toBe(false);
    expect(validateSprintAssessment([], ctx()).ok).toBe(false);
  });

  it('PLAN: keeps ≤ planSteps steps with a VERIFIED existing path or a clean new path; the sentence survives a bad path', () => {
    const v = validateSprintAssessment(
      body([], {
        plan: [
          { repo: 'acme/web', path: 'src/basket', change: 'Add expiry to the basket store.' },
          { repo: 'acme/api', newPath: 'src/basket-expiry.ts', change: 'Add an expiry job.' },
          { repo: 'acme/web', path: 'src/missing.ts', change: 'Bad path, kept.' },
          { repo: 'acme/web', newPath: '../escape.ts', change: 'Unsafe new path, kept without it.' },
          { repo: 'acme/web', newPath: 'src/basket/store.ts', change: 'Says new, but it exists: a path.' },
          { repo: 'acme/other', path: 'x', change: 'Not an accepted repo: dropped.' },
          { repo: 'acme/web', change: '   ' },
          { repo: 'acme/web', change: 'Sixth kept step: a repo-level change.' },
        ],
        criterionChecks: [{ n: 1, status: 'met', evidence: 'ignored in plan mode' }],
        coverage: 'ignored',
      }),
      ctx('plan'),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.mode).toBe('plan');
    expect(v.body.criterionChecks).toEqual([]);
    expect(v.body.coverage).toBeNull();
    expect(v.body.plan).toEqual([
      { repo: 'acme/web', path: 'src/basket', newPath: null, change: 'Add expiry to the basket store.' },
      { repo: 'acme/api', path: null, newPath: 'src/basket-expiry.ts', change: 'Add an expiry job.' },
      { repo: 'acme/web', path: null, newPath: null, change: 'Bad path, kept.' },
      { repo: 'acme/web', path: null, newPath: null, change: 'Unsafe new path, kept without it.' },
      { repo: 'acme/web', path: 'src/basket/store.ts', newPath: null, change: 'Says new, but it exists: a path.' },
      { repo: 'acme/web', path: null, newPath: null, change: 'Sixth kept step: a repo-level change.' },
    ]);
    expect(v.dropped.paths).toBe(2);
    expect(v.dropped.items).toBe(2);
    const capped = validateSprintAssessment(
      body([], { plan: Array.from({ length: SPRINT_ASSESS_CAPS.planSteps + 2 }, (_, i) => ({ repo: 'acme/web', change: `s${i}` })) }),
      ctx('plan'),
    );
    expect(capped.ok && capped.body.plan).toHaveLength(SPRINT_ASSESS_CAPS.planSteps);
    // A plan alone is a usable result.
    expect(validateSprintAssessment(body([], { summary: '', plan: [{ repo: 'acme/web', change: 'One.' }] }), ctx('plan')).ok).toBe(true);
  });

  it('VERIFY: one check per criterion number in range, sorted; ref and tests VERIFIED (tests found in any accepted repo)', () => {
    const v = validateSprintAssessment(
      body([], {
        criterionChecks: [
          { n: 2, status: 'partly', evidence: 'Expiry is set, never enforced.', repo: 'acme/web', path: 'src/basket/store.ts', tests: null },
          { n: 1, status: 'met', evidence: 'Saved to local storage.', repo: 'acme/web', path: 'src/basket/store.ts', tests: 'routes.ts' },
          { n: 1, status: 'met', evidence: 'duplicate n: dropped' },
          { n: 3, status: 'met', evidence: 'out of range: dropped' },
          { n: 2.5, status: 'met', evidence: 'not an integer: dropped' },
          { n: 2, status: 'maybe', evidence: 'bad status: dropped' },
        ],
        coverage: 'Criterion 1 has a test; criterion 2 has none.',
        plan: [{ repo: 'acme/web', change: 'ignored in verify mode' }],
      }),
      { ...ctx('verify'), criteriaCount: 2 },
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.mode).toBe('verify');
    expect(v.body.plan).toEqual([]);
    expect(v.body.criterionChecks).toEqual([
      { n: 1, status: 'met', evidence: 'Saved to local storage.', ref: { repo: 'acme/web', path: 'src/basket/store.ts' }, tests: { repo: 'acme/api', path: 'routes.ts' } },
      { n: 2, status: 'partly', evidence: 'Expiry is set, never enforced.', ref: { repo: 'acme/web', path: 'src/basket/store.ts' }, tests: null },
    ]);
    expect(v.body.coverage).toBe('Criterion 1 has a test; criterion 2 has none.');
    expect(v.dropped.items).toBe(4);
    // A test path that exists nowhere is dropped (counted), the check kept.
    const miss = validateSprintAssessment(
      body([], { criterionChecks: [{ n: 1, status: 'not_met', evidence: 'No expiry.', tests: 'test/nope.test.ts' }] }),
      { ...ctx('verify'), criteriaCount: 1 },
    );
    expect(miss.ok && miss.body.criterionChecks[0]!.tests).toBeNull();
    expect(miss.ok && miss.dropped.paths).toBe(1);
  });
});

describe('a blocked finding about a ticket that cannot block is dropped', () => {
  const references = [
    { key: 'ABC-1066', relation: 'concurrent' as const, done: false },
    { key: 'ABC-343', relation: 'builds_on' as const, done: true },
    { key: 'ABC-850', relation: 'depends_on' as const, done: true },
    { key: 'ABC-12', relation: 'depends_on' as const, done: null },
    { key: 'ABC-13', relation: 'blocked_by' as const, done: false },
  ];
  const blocked = (text: string, quote: string | null = null) => ({ issue: 'blocked', rule: 'waits_on_ticket', text, quote });

  it('drops one naming only non-blocking known tickets; keeps a real blocker, an unknown key or no key', () => {
    const v = validateSprintAssessment(
      body([
        blocked('Waits on ABC-1066 (Lost habitats), which is In Development.'),
        blocked('Depends on ABC-343, status not stated.'),
        blocked('Waits on ABC-850 and ABC-343.'),
        blocked('Waits on ABC-12 (status unknown).'),
        blocked('Waits on ABC-1066 and ABC-13.'),
        blocked('Waits on ZZZ-1 owned by another team.'),
        blocked('Waits on a sign-off from the product owner.'),
      ]),
      { ...ctx(), references },
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.findings.map((x) => x.text)).toEqual([
      'Waits on ABC-12 (status unknown).',
      'Waits on ABC-1066 and ABC-13.',
      'Waits on ZZZ-1 owned by another team.',
      'Waits on a sign-off from the product owner.',
    ]);
    expect(v.dropped.items).toBe(3);
  });

  it('reads the quote too, ignores other issues, and does nothing without references', () => {
    expect(blockedFindingNamesOnlyNonBlocking('Must be built alongside.', 'concurrently with ABC-1066', references)).toBe(true);
    expect(blockedFindingNamesOnlyNonBlocking('Waits on ABC-1066.', null, undefined)).toBe(false);
    const v = validateSprintAssessment(body([{ issue: 'spec_gaps', rule: 'edge_case', text: 'ABC-1066 leaves lost rows undefined.' }]), { ...ctx(), references });
    expect(v.ok && v.body.findings).toHaveLength(1);
  });
});

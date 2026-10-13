import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_ASSESS_CAPS } from '@pierre-review/shared';
import { normaliseCitedPath, validateSprintAssessment } from './validate.js';

// The sprint assessment's server validator (format 6): every cited path is checked against a REAL temp
// checkout (dropped when missing, outside, absolute elsewhere, `..`, or in an unaccepted repo — the
// sentence is kept), caps cut text, findings and revisions are IGNORED, and an empty result is refused.

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

const body = (extra: Record<string, unknown> = {}) => ({ summary: 'Two repos change.', ...extra });
const check = (o: Record<string, unknown> = {}) => ({ n: 1, status: 'met', evidence: 'Saved to local storage.', ...o });

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
      const v = validateSprintAssessment(body({ criterionChecks: [check(cite)] }), { ...ctx('verify'), criteriaCount: 1 });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.body.criterionChecks).toEqual([{ n: 1, status: 'met', evidence: 'Saved to local storage.', ref, tests: null }]);
      refused += v.dropped.paths;
    }
    expect(refused).toBe(6);
  });

  it('format 6: findings and revised criteria / description are ignored, never stored', () => {
    const v = validateSprintAssessment(
      body({
        findings: [{ issue: 'unclear_done', rule: 'vague_term', text: 'Criterion 2 cannot be checked.' }],
        revisedCriteria: ['One outcome'],
        revisedDescription: 'A new description.',
      }),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body).toEqual({ mode: 'plan', summary: 'Two repos change.', plan: [], criterionChecks: [], coverage: null });
    // Findings or revisions alone are not a result.
    expect(validateSprintAssessment(body({ summary: '', revisedCriteria: ['One outcome'] }), ctx()).ok).toBe(false);
  });

  it('cuts a long summary with an ellipsis', () => {
    const v = validateSprintAssessment(body({ summary: 'w'.repeat(SPRINT_ASSESS_CAPS.summary + 50) }), ctx());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.summary.length).toBe(SPRINT_ASSESS_CAPS.summary);
    expect(v.body.summary.endsWith('…')).toBe(true);
  });

  it('a repo may be left out when exactly one was checked out', () => {
    const v = validateSprintAssessment(body({ plan: [{ path: 'src/basket', change: 'Add expiry.' }] }), {
      mode: 'plan',
      repos: [{ fullName: 'acme/web', path: web }],
    });
    expect(v.ok && v.body.plan[0]).toEqual({ repo: 'acme/web', path: 'src/basket', newPath: null, change: 'Add expiry.' });
  });

  it('accepts a summary alone; refuses an empty result and a non-object', () => {
    expect(validateSprintAssessment(body(), ctx()).ok).toBe(true);
    expect(validateSprintAssessment(body({ summary: '   ' }), ctx()).ok).toBe(false);
    expect(validateSprintAssessment(null, ctx()).ok).toBe(false);
    expect(validateSprintAssessment('text', ctx()).ok).toBe(false);
    expect(validateSprintAssessment([], ctx()).ok).toBe(false);
  });

  it('PLAN: keeps ≤ planSteps steps with a VERIFIED existing path or a clean new path; the sentence survives a bad path', () => {
    const v = validateSprintAssessment(
      body({
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
      body({ plan: Array.from({ length: SPRINT_ASSESS_CAPS.planSteps + 2 }, (_, i) => ({ repo: 'acme/web', change: `s${i}` })) }),
      ctx('plan'),
    );
    expect(capped.ok && capped.body.plan).toHaveLength(SPRINT_ASSESS_CAPS.planSteps);
    // A plan alone is a usable result.
    expect(validateSprintAssessment(body({ summary: '', plan: [{ repo: 'acme/web', change: 'One.' }] }), ctx('plan')).ok).toBe(true);
  });

  it('VERIFY: one check per criterion number in range, sorted; ref and tests VERIFIED (tests found in any accepted repo)', () => {
    const v = validateSprintAssessment(
      body({
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
      body({ criterionChecks: [{ n: 1, status: 'not_met', evidence: 'No expiry.', tests: 'test/nope.test.ts' }] }),
      { ...ctx('verify'), criteriaCount: 1 },
    );
    expect(miss.ok && miss.body.criterionChecks[0]!.tests).toBeNull();
    expect(miss.ok && miss.dropped.paths).toBe(1);
  });
});

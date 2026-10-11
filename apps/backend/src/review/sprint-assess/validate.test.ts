import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_ASSESS_CAPS } from '@pierre-review/shared';
import { normaliseCitedPath, validateSprintAssessment } from './validate.js';

// The sprint assessment's server validator: every cited path is checked against a REAL temp checkout
// (dropped when missing, outside, absolute elsewhere, `..`, or in an unaccepted repo — the sentence is
// kept), caps cut text and lists, unknown or repeated issue ids are dropped, and an empty result is
// refused.

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

const ctx = () => ({
  repos: [
    { fullName: 'acme/web', path: web },
    { fullName: 'acme/api', path: api },
  ],
});

const body = (issues: unknown[], extra: Record<string, unknown> = {}) => ({
  summary: 'This may already be done.',
  issues,
  revisedCriteria: [],
  ...extra,
});

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
      const v = validateSprintAssessment(body([{ id: 'unclear_done', text: 'Criterion 2 cannot be checked.', ...cite }]), ctx());
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.body.issues).toEqual([{ id: 'unclear_done', text: 'Criterion 2 cannot be checked.', ref }]);
      refused += v.dropped.paths;
    }
    expect(refused).toBe(6);
  });

  it('drops unknown, retired and repeated ids, empty sentences and a fourth entry; sorts in issue order', () => {
    const v = validateSprintAssessment(
      body([
        { id: 'spec_gaps', text: 'No behaviour when the upload fails.' },
        { id: 'no_persona', text: 'old id' },
        { id: 'too_big', text: 'a retired id' },
        { id: 'spec_gaps', text: 'a repeat' },
        { id: 'blocked', text: '   ' },
        { id: 'blocked', text: 'Waits on BMD-12 pricing API (To Do), owned by Payments.' },
        { id: 'unclear_done', text: 'Criterion 2 cannot be checked.' },
      ]),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.issues.map((i) => i.id)).toEqual(['unclear_done', 'blocked', 'spec_gaps']);
    expect(v.dropped.items).toBe(4);
    const fourth = validateSprintAssessment(
      body([
        { id: 'unclear_done', text: 'a' },
        { id: 'blocked', text: 'b' },
        { id: 'spec_gaps', text: 'c' },
        { id: 'unclear_done', text: 'd' },
      ]),
      ctx(),
    );
    expect(fourth.ok && fourth.body.issues).toHaveLength(SPRINT_ASSESS_CAPS.issues);
  });

  it('cuts long text with an ellipsis and caps the revised criteria', () => {
    const long = (n: number) => 'w'.repeat(n + 50);
    const v = validateSprintAssessment(
      body([{ id: 'spec_gaps', text: long(SPRINT_ASSESS_CAPS.issueText) }], {
        summary: long(SPRINT_ASSESS_CAPS.summary),
        revisedCriteria: ['', long(SPRINT_ASSESS_CAPS.criterionText), ...Array.from({ length: SPRINT_ASSESS_CAPS.revisedCriteria + 2 }, (_, i) => `c${i}`)],
      }),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.summary.length).toBe(SPRINT_ASSESS_CAPS.summary);
    expect(v.body.summary.endsWith('…')).toBe(true);
    expect(v.body.issues[0]!.text.length).toBe(SPRINT_ASSESS_CAPS.issueText);
    expect(v.body.revisedCriteria).toHaveLength(SPRINT_ASSESS_CAPS.revisedCriteria);
    expect(v.body.revisedCriteria[0]!.length).toBe(SPRINT_ASSESS_CAPS.criterionText);
    // the empty one + 3 over the cap
    expect(v.dropped.items).toBe(4);
  });

  it('a repo may be left out when exactly one was checked out', () => {
    const v = validateSprintAssessment(body([{ id: 'unclear_done', text: 'x', path: 'src/basket' }]), {
      repos: [{ fullName: 'acme/web', path: web }],
    });
    expect(v.ok && v.body.issues[0]!.ref).toEqual({ repo: 'acme/web', path: 'src/basket' });
  });

  it('accepts a summary alone or revised criteria alone; refuses an empty result and a non-object', () => {
    expect(validateSprintAssessment(body([]), ctx()).ok).toBe(true);
    expect(validateSprintAssessment(body([], { summary: '', revisedCriteria: ['One outcome'] }), ctx()).ok).toBe(true);
    expect(validateSprintAssessment(body([{ id: 'nope', text: 'x' }], { summary: '   ' }), ctx()).ok).toBe(false);
    expect(validateSprintAssessment(null, ctx()).ok).toBe(false);
    expect(validateSprintAssessment('text', ctx()).ok).toBe(false);
    expect(validateSprintAssessment([], ctx()).ok).toBe(false);
  });
});

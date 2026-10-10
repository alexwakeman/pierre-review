import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_ASSESS_CAPS } from '@pierre-review/shared';
import { normaliseCitedPath, validateSprintAssessment } from './validate.js';

// The sprint assessment's server validator: every cited path is checked against a REAL temp checkout
// (dropped when missing, outside, absolute elsewhere, `..`, or in an unaccepted repo), caps cut text
// and lists, unknown criterion numbers are dropped, and an empty result is refused.

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
  criteria: ['Basket survives a reload', 'Basket expires after 30 days'],
  repos: [
    { fullName: 'acme/web', path: web },
    { fullName: 'acme/api', path: api },
  ],
});

const body = (criteria: unknown[], extra: Record<string, unknown> = {}) => ({
  criteria,
  gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: [], edgeCases: [] },
  suggestion: { rewrittenCriteria: [], addedCriteria: [], split: null, questionsForOwner: [], summary: 'Ready.' },
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
  it('keeps verified paths and drops every other kind', () => {
    const v = validateSprintAssessment(
      body([
        {
          n: 1,
          testableAgainstCode: true,
          existing: 'partial',
          note: 'Stored in memory only.',
          landsIn: [
            { repo: 'acme/web', path: 'src/basket/store.ts', symbol: 'saveBasket' },
            { repo: 'ACME/API', path: 'routes.ts' },
            { repo: 'acme/web', path: 'src/missing.ts' }, // does not exist
            { repo: 'acme/other', path: 'routes.ts' }, // not an accepted repo
            { repo: 'acme/web', path: '../secret/keys.txt' }, // ..
            { repo: 'acme/web', path: '/etc/hosts' }, // absolute outside
            { repo: 'acme/web', path: 'escape/keys.txt' }, // symlink out of the checkout
          ],
        },
      ]),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.criteria[0]!.landsIn).toEqual([
      { repo: 'acme/web', path: 'src/basket/store.ts', symbol: 'saveBasket' },
      { repo: 'acme/api', path: 'routes.ts', symbol: null },
    ]);
    expect(v.dropped.paths).toBe(5);
    expect(v.body.criteria[0]!.criterion).toBe('Basket survives a reload');
  });

  it('drops unknown and repeated criterion numbers; the criterion text is the server’s', () => {
    const v = validateSprintAssessment(
      body([
        { n: 2, criterion: 'model echo', testableAgainstCode: false, existing: 'bogus', note: 'n', landsIn: [] },
        { n: 2, testableAgainstCode: true, existing: 'full', note: 'dup', landsIn: [] },
        { n: 9, testableAgainstCode: true, existing: 'full', note: 'unknown', landsIn: [] },
        { n: 0, testableAgainstCode: true, existing: 'full', note: 'zero', landsIn: [] },
      ]),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.criteria).toHaveLength(1);
    expect(v.body.criteria[0]).toMatchObject({ n: 2, criterion: 'Basket expires after 30 days', existing: 'unclear', testableAgainstCode: false });
    expect(v.dropped.items).toBe(3);
  });

  it('cuts long text with an ellipsis and caps lists', () => {
    const long = 'w'.repeat(SPRINT_ASSESS_CAPS.text.summary + 50);
    const many = Array.from({ length: SPRINT_ASSESS_CAPS.listItems + 3 }, (_, i) => `edge ${i}`);
    const v = validateSprintAssessment(
      body([], {
        gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: [], edgeCases: many },
        suggestion: {
          rewrittenCriteria: [{ n: 1, text: 'Reload keeps the basket' }, { n: 5, text: 'bad n' }],
          addedCriteria: ['', 'Show a saved badge'],
          split: Array.from({ length: SPRINT_ASSESS_CAPS.splitParts + 1 }, (_, i) => ({ title: `Part ${i}`, criteria: ['c'] })),
          questionsForOwner: ['Is 30 days a legal requirement?'],
          summary: long,
        },
      }),
      ctx(),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.body.suggestion.summary.length).toBe(SPRINT_ASSESS_CAPS.text.summary);
    expect(v.body.suggestion.summary.endsWith('…')).toBe(true);
    expect(v.body.gaps.edgeCases).toHaveLength(SPRINT_ASSESS_CAPS.listItems);
    expect(v.body.suggestion.rewrittenCriteria).toEqual([{ n: 1, text: 'Reload keeps the basket' }]);
    expect(v.body.suggestion.addedCriteria).toEqual(['Show a saved badge']);
    expect(v.body.suggestion.split).toHaveLength(SPRINT_ASSESS_CAPS.splitParts);
    // 3 over-cap edges + bad n + empty added + 1 extra split part
    expect(v.dropped.items).toBe(6);
  });

  it('a repo may be left out when exactly one was checked out', () => {
    const v = validateSprintAssessment(
      body([{ n: 1, testableAgainstCode: true, existing: 'none', note: 'x', landsIn: [{ path: 'src/basket' }] }]),
      { criteria: ['a'], repos: [{ fullName: 'acme/web', path: web }] },
    );
    expect(v.ok && v.body.criteria[0]!.landsIn).toEqual([{ repo: 'acme/web', path: 'src/basket', symbol: null }]);
  });

  it('refuses an empty result and a non-object', () => {
    expect(validateSprintAssessment(body([], { suggestion: { summary: '   ' } }), ctx()).ok).toBe(false);
    expect(validateSprintAssessment(null, ctx()).ok).toBe(false);
    expect(validateSprintAssessment('text', ctx()).ok).toBe(false);
  });
});

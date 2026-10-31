// THE DATA-FLOW VALIDATOR: every cap refuses with what to do about it, steps are numbered and form ONE
// chain, a write ends where data is kept, every changed code file sits on a step, text is plain,
// `files` is FILTERED (never refused) to the change, and a decline is accepted only on its own.
import { describe, expect, it } from 'vitest';
import {
  DESIGN_CAPTION_MAX,
  DESIGN_TITLE_MAX,
  FLOW_DECLINE_MAX,
  FLOW_FILES_MUST_MAP,
  FLOW_MAX_PARTICIPANTS,
  FLOW_MAX_STEPS,
  FLOW_PARTICIPANT_LABEL_MAX,
  FLOW_STEP_FILES_MAX,
  FLOW_STEP_LABEL_MAX,
} from '@pierre-review/shared';
import { acceptedAsPayload, flowRelevantFile, validateDesign, type DesignContext } from './validate.js';

const PR: DesignContext = { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: ['src/import.ts', 'src/rates.ts', 'test/rates.test.ts', 'README.md'] }] };
const STORY: DesignContext = {
  kind: 'story',
  prs: [
    { ref: 'PR1', changedFiles: ['api/routes/rates.ts', 'api/db/rates.ts'] },
    { ref: 'PR2', changedFiles: ['web/src/RatesPage.tsx'] },
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = (): any => ({
  title: 'Rate import',
  caption: 'Rows are checked, then each rate is stored once.',
  participants: [
    { id: 'imp', kind: 'service', label: 'Rate importer', change: 'new' },
    { id: 'db', kind: 'db', label: 'rates table', change: 'unchanged' },
  ],
  steps: [
    { n: 1, from: 'imp', to: 'imp', kind: 'transform', label: 'CSV rows into rates', files: ['src/import.ts'] },
    { n: 2, from: 'imp', to: 'imp', kind: 'validate', label: 'rows with no account are dropped', files: [] },
    { n: 3, from: 'imp', to: 'db', kind: 'write', label: 'one rate per currency', files: ['src/rates.ts'] },
  ],
  noDiagram: null,
});
const refused = (raw: unknown, ctx: DesignContext = PR): string => {
  const v = validateDesign(raw, ctx);
  expect(v.ok).toBe(false);
  return v.ok ? '' : v.message;
};

describe('validateDesign — accepts and cleans', () => {
  it('accepts an ordered chain, cleaning text and keeping only changed paths', () => {
    const raw = base();
    raw.title = '  Rate\n import ';
    raw.steps[0].files = ['./src/import.ts', 'src/nope.ts', 'checkout/src/import.ts'];
    const v = validateDesign(raw, PR);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.title).toBe('Rate import');
    expect(v.value.declined).toBeNull();
    expect(v.value.flow!.steps[0]).toEqual({ n: 1, from: 'imp', to: 'imp', kind: 'transform', label: 'CSV rows into rates', pr: null, files: ['src/import.ts'] });
    expect(v.value.flow!.participants.map((p) => p.pr)).toEqual([null, null]);
  });

  it('a PR design never keeps a pr ref; an empty title or caption is null', () => {
    const raw = base();
    raw.title = '';
    raw.caption = ' ';
    raw.participants[0].pr = 'PR1';
    raw.steps[0].pr = 'PR1';
    const v = validateDesign(raw, PR);
    expect(v.ok && v.value.title).toBeNull();
    expect(v.ok && v.value.caption).toBeNull();
    expect(v.ok && v.value.flow!.participants[0]!.pr).toBeNull();
    expect(v.ok && v.value.flow!.steps[0]!.pr).toBeNull();
  });

  it('a story step takes the member owning its first file; files are scoped to its pr', () => {
    const raw = {
      title: 'Rates page',
      caption: null,
      participants: [
        { id: 'page', kind: 'ui', label: 'Rates page', change: 'new', pr: 'PR2' },
        { id: 'route', kind: 'api', label: 'GET rates', change: 'new', pr: 'PR1' },
        { id: 'db', kind: 'db', label: 'rates table', change: 'unchanged', pr: null },
      ],
      steps: [
        { n: 1, from: 'page', to: 'route', kind: 'call', label: 'currency filter', files: ['web/src/RatesPage.tsx'] },
        { n: 2, from: 'route', to: 'db', kind: 'read', label: 'rates for the currency', pr: 'pr1', files: ['api/db/rates.ts', 'web/src/RatesPage.tsx'] },
        { n: 3, from: 'route', to: 'page', kind: 'return', label: 'rate list', pr: 'PR1', files: ['api/routes/rates.ts'] },
      ],
    };
    const v = validateDesign(raw, STORY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.flow!.steps.map((s) => [s.pr, s.files])).toEqual([
      ['PR2', ['web/src/RatesPage.tsx']],
      ['PR1', ['api/db/rates.ts']],
      ['PR1', ['api/routes/rates.ts']],
    ]);
  });

  it('a decline is accepted alone, with its reason (a leading "No diagram:" dropped)', () => {
    const v = validateDesign({ title: '', caption: '', participants: [], steps: [], noDiagram: 'No diagram: this change only renames helpers' }, PR);
    expect(v).toEqual({ ok: true, value: { title: null, caption: null, flow: null, declined: 'this change only renames helpers' } });
    expect(acceptedAsPayload(v.ok ? v.value : (null as never))).toMatchObject({ noDiagram: 'this change only renames helpers', steps: [] });
  });

  it('round-trips through acceptedAsPayload (the manager re-validates what the tool accepted)', () => {
    const v = validateDesign(base(), PR);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(validateDesign(acceptedAsPayload(v.value), PR)).toEqual(v);
  });
});

describe('validateDesign — refuses with what to fix', () => {
  it('the chain rule: a step must start where the data already is', () => {
    const raw = base();
    raw.participants.push({ id: 'mail', kind: 'external', label: 'Mailer', change: 'unchanged' });
    raw.steps.push({ n: 4, from: 'mail', to: 'db', kind: 'read', label: 'addresses', files: [] });
    expect(refused(raw)).toMatch(/step 4 starts at "mail", which no earlier step reached/);
  });

  it('steps are numbered 1..n in order', () => {
    const raw = base();
    raw.steps[1].n = 5;
    expect(refused(raw)).toMatch(/step 2 is numbered "5"; number the steps 1, 2, 3/);
  });

  it('a step naming a missing participant, a self step that is not a check, a write that ends nowhere kept', () => {
    const raw = base();
    raw.participants.push({ id: 'ui', kind: 'ui', label: 'Rates page', change: 'new' });
    raw.steps.push({ n: 4, from: 'db', to: 'ghost', kind: 'read', label: 'x', files: [] });
    raw.steps.push({ n: 5, from: 'db', to: 'db', kind: 'read', label: 'x', files: [] });
    raw.steps.push({ n: 6, from: 'imp', to: 'ui', kind: 'write', label: 'x', files: [] });
    const m = refused(raw);
    expect(m).toMatch(/step 4 goes to "ghost", which is not a participant id/);
    expect(m).toMatch(/step 5 goes from "db" to itself as a read; only a validate or a transform/);
    expect(m).toMatch(/step 6 is a write to "ui" \(Screen\); a write ends where data is kept/);
  });

  it('a participant in no step, an unknown kind or change, duplicate ids', () => {
    const raw = base();
    raw.participants.push({ id: 'idle', kind: 'service', label: 'Idle', change: 'new' });
    raw.participants.push({ id: 'imp', kind: 'robot', label: 'Dup', change: 'maybe' });
    const m = refused(raw);
    expect(m).toMatch(/participant "idle" is in no step/);
    expect(m).toMatch(/participant id "imp" is used twice/);
    expect(m).toMatch(/kind "robot" must be one of/);
    expect(m).toMatch(/change "maybe" must be one of/);
  });

  it('every changed code file (tests and docs aside) sits on a step', () => {
    const raw = base();
    raw.steps[2].files = [];
    expect(refused(raw)).toMatch(/these changed files are on no step: src\/rates\.ts; put each/);
    // Over the cap, at least FLOW_FILES_MUST_MAP must be placed.
    const many = Array.from({ length: FLOW_FILES_MUST_MAP + 3 }, (_, i) => `src/m${i}.ts`);
    const big: DesignContext = { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: many }] };
    const r = base();
    r.steps = [
      { n: 1, from: 'imp', to: 'imp', kind: 'transform', label: 'a', files: many.slice(0, 4) },
      { n: 2, from: 'imp', to: 'db', kind: 'write', label: 'b', files: many.slice(4, 7) },
    ];
    expect(refused(r, big)).toMatch(new RegExp(`only 7 changed files are on a step; put at least ${FLOW_FILES_MUST_MAP}`));
    r.steps[1].files = many.slice(4, 8);
    expect(validateDesign(r, big).ok).toBe(true);
  });

  it('caps: participants, steps, files per step, every string', () => {
    const raw = base();
    raw.title = 'x'.repeat(DESIGN_TITLE_MAX + 1);
    raw.caption = 'y'.repeat(DESIGN_CAPTION_MAX + 1);
    raw.participants[0].label = 'z'.repeat(FLOW_PARTICIPANT_LABEL_MAX + 1);
    raw.steps[0].label = 'w'.repeat(FLOW_STEP_LABEL_MAX + 1);
    raw.steps[0].files = Array.from({ length: FLOW_STEP_FILES_MAX + 1 }, () => 'src/import.ts');
    const m = validateDesign(raw, PR);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.problems.join('\n')).toMatch(new RegExp(`title is ${DESIGN_TITLE_MAX + 1} characters`));
    expect(m.problems.join('\n')).toMatch(/caption is/);
    expect(m.problems.join('\n')).toMatch(/participant "imp" label is/);
    expect(m.problems.join('\n')).toMatch(/step 1 label is/);
    expect(m.problems.join('\n')).toMatch(new RegExp(`step 1 lists ${FLOW_STEP_FILES_MAX + 1} files`));
    const wide = base();
    wide.participants = Array.from({ length: FLOW_MAX_PARTICIPANTS + 1 }, (_, i) => ({ id: `p${i}`, kind: 'service', label: 'P', change: 'new' }));
    expect(refused(wide)).toMatch(new RegExp(`${FLOW_MAX_PARTICIPANTS + 1} participants; merge`));
    const long = base();
    long.steps = Array.from({ length: FLOW_MAX_STEPS + 1 }, (_, i) => ({ n: i + 1, from: 'imp', to: 'db', kind: 'write', label: 's', files: [] }));
    expect(refused(long)).toMatch(new RegExp(`${FLOW_MAX_STEPS + 1} steps; merge`));
  });

  it('too few participants or steps points at noDiagram', () => {
    expect(refused({ title: 't', participants: [], steps: [] })).toMatch(/set noDiagram instead/);
  });

  it('plain text only: tags and links are refused', () => {
    const raw = base();
    raw.steps[0].label = '<img src=x>';
    raw.participants[1].label = 'see https://evil.example';
    const m = refused(raw);
    expect(m).toMatch(/tag-like/);
    expect(m).toMatch(/link or URL/);
  });

  it('a story pr ref must be one the prompt gave', () => {
    const raw = {
      participants: [
        { id: 'a', kind: 'api', label: 'A', change: 'new', pr: 'PR9' },
        { id: 'b', kind: 'db', label: 'B', change: 'new', pr: 'PR1' },
      ],
      steps: [
        { n: 1, from: 'a', to: 'b', kind: 'write', label: 'x', pr: 'PR1', files: ['api/routes/rates.ts', 'api/db/rates.ts'] },
        { n: 2, from: 'b', to: 'a', kind: 'return', label: 'y', pr: 'PR2', files: ['web/src/RatesPage.tsx'] },
      ],
    };
    expect(refused(raw, STORY)).toMatch(/participant "a" names pr "PR9"; use one of: PR1, PR2, or null/);
  });

  it('a decline with steps, a decline too long, and a decline on a PLANNED design are refused', () => {
    const both = base();
    both.noDiagram = 'this change only edits copy';
    expect(refused(both)).toMatch(/noDiagram is set but participants or steps are not empty/);
    expect(refused({ participants: [], steps: [], noDiagram: 'x'.repeat(FLOW_DECLINE_MAX + 1) })).toMatch(/noDiagram is/);
    expect(refused({ participants: [], steps: [], noDiagram: 'nothing moves' }, { kind: 'planned', prs: [] })).toMatch(
      /noDiagram is not allowed here/,
    );
  });

  it('flowRelevantFile: code yes; tests, docs and lockfiles no (the existing classifiers)', () => {
    expect(flowRelevantFile('src/a.ts')).toBe(true);
    expect(flowRelevantFile('src/a.test.ts')).toBe(false);
    expect(flowRelevantFile('docs/a.md')).toBe(false);
    expect(flowRelevantFile('pnpm-lock.yaml')).toBe(false);
  });
});

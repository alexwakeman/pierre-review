// ── OPEN POINTS (docs/TRACKERS.md § Open points) ──────────────────────────────────────────────────
// Pinned here: the description extractor (headings, bold labels, "Label:" lines, where a section
// ends, list vs paragraph points, "None" dropped, code fences ignored, caps), the field-name match,
// and THE ONE RULE `deriveOpenPoints` (auto / field / none, the description as the fallback, the
// source on every point). Plus the Settings rows' open-points column (acFieldTypeRows).
import { describe, expect, it } from 'vitest';
import type { JiraAcCandidate } from '@pierre-review/shared';
import {
  OPEN_POINTS_MAX,
  OPEN_POINT_MAX_CHARS,
  deriveOpenPoints,
  descriptionOpenPoints,
  openPointsFieldByName,
  splitPoints,
} from './open-points.js';
import { acFieldTypeRows } from './ac-field-settings.js';

const cand = (id: string, name: string, text: string): JiraAcCandidate => ({ id, name, text, match: null });

describe('descriptionOpenPoints', () => {
  it('reads a markdown heading section as list items, and stops at the next heading', () => {
    const d = [
      'As a user I want to upload a file.',
      '',
      '## Open points',
      '- Content depends on UCD confirming',
      '- Max file size TBC with ops',
      '',
      '## Notes',
      '- Not a point',
    ].join('\n');
    expect(descriptionOpenPoints(d)).toEqual(['Content depends on UCD confirming', 'Max file size TBC with ops']);
  });

  it('accepts bold labels, "Label:" lines, other names and inline text after the colon', () => {
    expect(descriptionOpenPoints('Intro\n\n**Open questions**\n1. Which date format?\n2) Who signs off?')).toEqual([
      'Which date format?',
      'Who signs off?',
    ]);
    expect(descriptionOpenPoints('Outstanding: wording of the error message\nmore detail on it')).toEqual([
      'wording of the error message more detail on it',
    ]);
    expect(descriptionOpenPoints('### To be confirmed\nThe colour of the banner.\n\nThe icon.')).toEqual([
      'The colour of the banner.',
      'The icon.',
    ]);
    expect(descriptionOpenPoints('h\n\nTBC:\n- [ ] layout on mobile')).toEqual(['layout on mobile']);
  });

  it('ends a section at a bold label or a short "Label:" line', () => {
    expect(descriptionOpenPoints('## Open points\n- A\n**Acceptance criteria**\n- B')).toEqual(['A']);
    expect(descriptionOpenPoints('Open points:\n- A\nDesign notes:\n- B')).toEqual(['A']);
  });

  it('joins a continuation line to its item and drops "None"', () => {
    expect(descriptionOpenPoints('## Open points\n- Copy for the\n  confirmation page\n- None')).toEqual([
      'Copy for the confirmation page',
    ]);
    expect(descriptionOpenPoints('## Open points\nNone.')).toEqual([]);
    expect(descriptionOpenPoints('Open points: N/A')).toEqual([]);
  });

  it('finds nothing without a section, and does not treat a sentence as a label', () => {
    expect(descriptionOpenPoints('We have open points to discuss later in the sprint.')).toEqual([]);
    expect(descriptionOpenPoints('- Open points are tracked elsewhere')).toEqual([]);
    expect(descriptionOpenPoints('')).toEqual([]);
    expect(descriptionOpenPoints(null)).toEqual([]);
  });

  it('ignores a heading inside a code fence', () => {
    expect(descriptionOpenPoints('```\n## Open points\n- not real\n```\nText')).toEqual([]);
  });

  it('caps the number and length of points', () => {
    const many = ['## Open points', ...Array.from({ length: 40 }, (_, i) => `- point ${i}`)].join('\n');
    expect(descriptionOpenPoints(many)).toHaveLength(OPEN_POINTS_MAX);
    const long = descriptionOpenPoints(`## Open points\n- ${'x'.repeat(2000)}`);
    expect(long[0]!.length).toBeLessThanOrEqual(OPEN_POINT_MAX_CHARS + 1);
    expect(long[0]!.endsWith('…')).toBe(true);
  });

  it('stays linear on a long hostile line', () => {
    const hostile = `## Open points\n- ${'*_:'.repeat(20_000)}\n${'#'.repeat(50_000)}`;
    const t = Date.now();
    descriptionOpenPoints(hostile);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('splitPoints', () => {
  it('splits paragraphs when there is no list', () => {
    expect(splitPoints('One.\n\nTwo\nstill two.')).toEqual(['One.', 'Two still two.']);
  });
  it('keeps prose before the first list item as its own point', () => {
    expect(splitPoints('Waiting on design:\n- header\n- footer')).toEqual(['Waiting on design:', 'header', 'footer']);
  });
});

describe('openPointsFieldByName', () => {
  it('prefers an exact name, then one that contains the words', () => {
    const c = [cand('c1', 'Open points for design', 'x'), cand('c2', 'Open Points', 'y'), cand('c3', 'Notes', 'z')];
    expect(openPointsFieldByName(c)?.id).toBe('c2');
    expect(openPointsFieldByName([c[0]!, c[2]!])?.id).toBe('c1');
    expect(openPointsFieldByName([cand('c4', 'Open questions', 'q')])?.id).toBe('c4');
    expect(openPointsFieldByName([c[2]!])).toBeNull();
  });
});

describe('deriveOpenPoints — the one rule', () => {
  const desc = 'Story\n\n## Open points\n- From the description';
  const fields = [cand('customfield_1', 'Open Points', '- From the field\n- Second'), cand('customfield_2', 'Design notes', 'Waiting on UCD')];

  it("'auto' reads the field named for open points, marked with its source", () => {
    const r = deriveOpenPoints(fields, desc, null);
    expect(r.field).toEqual({ id: 'customfield_1', name: 'Open Points' });
    expect(r.points).toEqual([
      { text: 'From the field', source: 'field', fieldName: 'Open Points' },
      { text: 'Second', source: 'field', fieldName: 'Open Points' },
    ]);
  });

  it("'auto' falls back to the description when the field is empty or absent", () => {
    const r = deriveOpenPoints([cand('customfield_1', 'Open Points', 'None')], desc, { mode: 'auto', fieldId: null });
    expect(r.field).toBeNull();
    expect(r.points).toEqual([{ text: 'From the description', source: 'description', fieldName: null }]);
  });

  it("'field' reads the chosen field, whatever its name", () => {
    const r = deriveOpenPoints(fields, desc, { mode: 'field', fieldId: 'customfield_2' });
    expect(r.points).toEqual([{ text: 'Waiting on UCD', source: 'field', fieldName: 'Design notes' }]);
  });

  it("'field' on a ticket without that field reads the description", () => {
    const r = deriveOpenPoints(fields, desc, { mode: 'field', fieldId: 'customfield_9' });
    expect(r.points.map((p) => p.source)).toEqual(['description']);
  });

  it("'none' reads only the description", () => {
    const r = deriveOpenPoints(fields, desc, { mode: 'none', fieldId: null });
    expect(r.field).toBeNull();
    expect(r.points).toEqual([{ text: 'From the description', source: 'description', fieldName: null }]);
  });
});

describe('acFieldTypeRows — the open-points column', () => {
  const ticket = (over: Partial<Parameters<typeof acFieldTypeRows>[0][number]> = {}) => ({
    apiRoot: 'https://x.atlassian.net/rest/api/3',
    issueTypeId: '10001',
    issueTypeName: 'Story',
    acFieldId: null,
    acFieldName: null,
    candidatesJson: JSON.stringify([cand('customfield_7', 'Open points', '- A')]),
    description: null,
    ...over,
  });

  it('is absent without the open-points callback (the rows are as before)', () => {
    const [row] = acFieldTypeRows([ticket()], () => null);
    expect(row!.openPoints).toBeUndefined();
  });

  it("names the mode, the chosen field and the field in use", () => {
    const [auto] = acFieldTypeRows([ticket(), ticket()], () => null, () => null);
    expect(auto!.openPoints).toEqual({ mode: 'auto', chosen: null, inUse: { id: 'customfield_7', name: 'Open points' } });
    const [chosen] = acFieldTypeRows([ticket()], () => null, () => ({ mode: 'field', fieldId: 'customfield_7', fieldName: 'Open points' }));
    expect(chosen!.openPoints).toEqual({
      mode: 'field',
      chosen: { id: 'customfield_7', name: 'Open points' },
      inUse: { id: 'customfield_7', name: 'Open points' },
    });
    const [none] = acFieldTypeRows([ticket()], () => null, () => ({ mode: 'none', fieldId: null, fieldName: null }));
    expect(none!.openPoints).toEqual({ mode: 'none', chosen: null, inUse: null });
  });
});

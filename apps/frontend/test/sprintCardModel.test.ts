// THE OPENED SPRINT CARD'S PURE FOLDS (components/Activity/sprintModel.ts, lib/copy.ts).
//
//   1. Criteria are never shown twice: a criteria field renders apart; criteria inside the description
//      do not.
//   2. A finding's quote is looked for in the block that renders its source.
//   3. The repo picker lists every repo not accepted, the suggested ones first and tagged.
//   4. A finding copies as one Markdown block.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintCardModel.test.ts
import { describe, expect, it } from 'vitest';
import type { SprintFinding } from '@pierre-review/shared';
import {
  findingSnippet,
  repoPickerOptions,
  sprintCriteriaShown,
  sprintFindingBlock,
} from '../src/components/Activity/sprintModel.js';
import { sprintFindingMarkdown } from '../src/lib/copy.js';

const base = { acField: null, acceptanceCriteria: '', description: '', criteria: { items: [] as string[], source: 'none' as const } };

describe('sprintCriteriaShown', () => {
  it('renders a Jira criteria field apart', () => {
    expect(
      sprintCriteriaShown({ ...base, acField: { id: 'cf', name: 'AC' }, acceptanceCriteria: '- a\n- b', criteria: { items: ['a', 'b'], source: 'acceptance_criteria' } }),
    ).toEqual({ kind: 'field', markdown: '- a\n- b' });
  });
  it('shows nothing apart when the criteria are in the description', () => {
    expect(
      sprintCriteriaShown({ ...base, description: '## Acceptance criteria\n- **Upload** works', criteria: { items: ['Upload works'], source: 'description_heading' } }),
    ).toBeNull();
    expect(
      sprintCriteriaShown({ ...base, description: 'Body\n- [ ] Upload works', acceptanceCriteria: '- [ ] Upload works', criteria: { items: ['Upload works'], source: 'acceptance_criteria' } }),
    ).toBeNull();
  });
  it('lists lifted criteria the description does not hold', () => {
    expect(
      sprintCriteriaShown({ ...base, description: 'Body', criteria: { items: ['Sub-issue one'], source: 'acceptance_criteria' } }),
    ).toEqual({ kind: 'items', items: ['Sub-issue one'] });
  });
});

describe('sprintFindingBlock', () => {
  it('routes by where, criteria into the description when not shown apart', () => {
    expect(sprintFindingBlock({ quote: 'x', where: 'title' }, false)).toBe('title');
    expect(sprintFindingBlock({ quote: 'x', where: 'criteria' }, true)).toBe('criteria');
    expect(sprintFindingBlock({ quote: 'x', where: 'criteria' }, false)).toBe('description');
    expect(sprintFindingBlock({ quote: 'x', where: null }, true)).toBe('description');
    expect(sprintFindingBlock({ quote: null, where: null }, true)).toBeNull();
  });
});

describe('repoPickerOptions', () => {
  it('every repo not accepted, suggested first and tagged, the rest by name', () => {
    const r = (repoId: number, fullName: string) => ({ repoId, fullName });
    expect(
      repoPickerOptions([r(1, 'o/zeta'), r(2, 'o/alpha'), r(3, 'o/mid'), r(4, 'o/beta')], [r(3, 'o/mid')], [r(1, 'o/zeta')]),
    ).toEqual([
      { repoId: 1, text: 'o/zeta · suggested' },
      { repoId: 2, text: 'o/alpha' },
      { repoId: 4, text: 'o/beta' },
    ]);
  });
});

describe('findingSnippet', () => {
  it('cuts at a word and adds an ellipsis', () => {
    expect(findingSnippet('short')).toBe('short');
    expect(findingSnippet('one two three four five six', 14)).toBe('one two three…');
  });
});

describe('sprintFindingMarkdown', () => {
  it('copies the issue, rule, quote, detail, suggestion and file', () => {
    const f: SprintFinding = {
      id: 'claude-0', issue: 'unclear_done', rule: 'vague_term', quote: 'fast', where: 'criteria', brief: 'Vague word',
      detail: 'No number.', suggestion: 'within 2 seconds', source: 'claude', ref: { repo: 'o/r', path: 'src/a.ts' },
    };
    expect(sprintFindingMarkdown(f)).toBe(
      '**Unclear when done · Vague word**\n\n> fast\n\nNo number.\n\nSuggested: within 2 seconds\n\n`src/a.ts` in `o/r`',
    );
  });
});

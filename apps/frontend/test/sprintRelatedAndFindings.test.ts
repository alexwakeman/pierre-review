// Reports → This sprint: the card's related-ticket pill groups (shared `sprintRelatedGroups`), the
// findings panel's same-rule grouping (`groupSprintFindings`) and the tracker-text tidy for a list
// indented under an empty bullet (`flattenEmptyListItems`).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintRelatedAndFindings.test.ts
import { describe, expect, it } from 'vitest';
import { isBlockingSprintRelation, sprintRelatedGroups, type SprintFinding, type SprintRelatedTicket } from '@pierre-review/shared';
import { groupSprintFindings } from '../src/components/Activity/sprintModel.js';
import { flattenEmptyListItems } from '../src/lib/ticketMarkdown.js';

const rel = (key: string, relation: SprintRelatedTicket['relation'], done: boolean | null = false): SprintRelatedTicket => ({
  ident: `jira:https://x.atlassian.net#${key}`,
  key,
  title: null,
  status: null,
  relation,
  done,
  url: null,
});

describe('sprintRelatedGroups — Blocked by / Coordinate with / Related', () => {
  it('blocks only on an open blocking link or depends_on; concurrent is coordinate; the rest related', () => {
    const list = [
      rel('A-1', 'blocked_by'),
      rel('A-2', 'depends_on', null),
      rel('A-3', 'depends_on', true),
      rel('A-4', 'concurrent'),
      rel('A-5', 'out_of_scope'),
      rel('A-6', 'builds_on', true),
      rel('A-7', 'mentioned', null),
      rel('A-8', 'concurrent', true),
    ];
    const g = sprintRelatedGroups(list);
    expect(g.blockedBy.map((r) => r.key)).toEqual(['A-1', 'A-2']);
    expect(g.coordinate.map((r) => r.key)).toEqual(['A-4']);
    expect(g.related.map((r) => r.key)).toEqual(['A-3', 'A-5', 'A-6', 'A-7', 'A-8']);
    // Unknown status still blocks (it reads "status unknown"); out of scope never does.
    expect(isBlockingSprintRelation({ relation: 'depends_on', done: null })).toBe(true);
    expect(isBlockingSprintRelation({ relation: 'out_of_scope', done: false })).toBe(false);
  });
});

const finding = (id: string, rule: SprintFinding['rule'], issue: SprintFinding['issue'] = 'unclear_done'): SprintFinding => ({
  id,
  issue,
  rule,
  quote: null,
  where: null,
  brief: rule === 'bundled' ? 'Several outcomes' : rule,
  detail: '',
  suggestion: null,
  source: 'code',
  ref: null,
});

describe('groupSprintFindings — one row per rule met more than once', () => {
  it('folds same issue + rule into a counted row at its first place; singles stay rows', () => {
    const rows = groupSprintFindings([
      finding('u-c1', 'no_expected_result'),
      finding('u-c2', 'bundled'),
      finding('u-c3', 'vague_term'),
      finding('u-c4', 'bundled'),
      finding('u-c5', 'bundled'),
      finding('g-0', 'edge_case', 'spec_gaps'),
    ]);
    expect(rows.map((r) => (r.kind === 'one' ? r.finding.id : `${r.label} · ${r.findings.length}`))).toEqual([
      'u-c1',
      'Several outcomes · 3',
      'u-c3',
      'g-0',
    ]);
    const g = rows[1]!;
    expect(g.kind === 'group' && g.findings.map((f) => f.id)).toEqual(['u-c2', 'u-c4', 'u-c5']);
  });
  it('the same rule under another issue is another group', () => {
    const rows = groupSprintFindings([finding('a', 'bundled'), finding('b', 'bundled', 'spec_gaps')]);
    expect(rows.every((r) => r.kind === 'one')).toBe(true);
  });
});

describe('flattenEmptyListItems — "- - a" is a list, not a bullet holding a bullet', () => {
  it('prints the inner list in the empty item’s place (BMD-1056’s shape)', () => {
    const md = 'Enhances:\n\n- - https://x/browse/A-1\n  - https://x/browse/A-2\n  - https://x/browse/A-3\n\nNext';
    expect(flattenEmptyListItems(md)).toBe('Enhances:\n\n- https://x/browse/A-1\n- https://x/browse/A-2\n- https://x/browse/A-3\n\nNext');
  });
  it('keeps the inner list’s own nesting, under an indented outer item', () => {
    expect(flattenEmptyListItems('- a\n  - - b\n    - c\n      - d\n- e')).toBe('- a\n  - b\n  - c\n    - d\n- e');
  });
  it('leaves ordinary lists, rules and prose alone', () => {
    for (const md of ['- a\n  - b', '- - -', '* * *', 'a - - b', 'x\n---\ny']) expect(flattenEmptyListItems(md)).toBe(md);
  });
});

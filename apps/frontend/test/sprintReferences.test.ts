// The drawer's "Other tickets" model (components/Activity/sprintReferences.ts) — pure. Pinned: the group
// order (what the ticket waits on first), the labels, the within-group sort, and when a quote is shown
// under the reason.
import { describe, expect, it } from 'vitest';
import type { SprintTicketReference } from '@pierre-review/shared';
import {
  DRAWER_REFERENCE_ORDER,
  drawerReferenceGroups,
  referenceQuote,
  referenceWhy,
} from '../src/components/Activity/sprintReferences.js';

const ref = (key: string, relation: SprintTicketReference['relation'], o: Partial<SprintTicketReference> = {}): SprintTicketReference => ({
  ident: `jira:x#${key}`,
  key,
  title: key,
  status: null,
  done: null,
  relation,
  quote: null,
  why: null,
  inGraph: false,
  url: null,
  ...o,
});

describe('drawerReferenceGroups', () => {
  it('waits-on first, then alongside, history, and the loose ties last', () => {
    expect(DRAWER_REFERENCE_ORDER).toEqual(['blocked_by', 'depends_on', 'concurrent', 'builds_on', 'supersedes', 'linked', 'context', 'out_of_scope']);
    const g = drawerReferenceGroups([
      ref('A-1', 'out_of_scope'),
      ref('A-2', 'context'),
      ref('A-3', 'linked'),
      ref('A-9', 'depends_on', { done: true }),
      ref('A-10', 'depends_on'),
      ref('A-4', 'blocked_by'),
      ref('A-5', 'concurrent'),
    ]);
    expect(g.map((x) => [x.label, x.refs.map((r) => r.key)])).toEqual([
      ['Blocked by', ['A-4']],
      // Not-done first, then by key.
      ['Depends on', ['A-10', 'A-9']],
      ['Built alongside', ['A-5']],
      ['Related', ['A-3']],
      ['Context', ['A-2']],
      ['Out of scope', ['A-1']],
    ]);
    expect(drawerReferenceGroups([])).toEqual([]);
  });
});

describe('the reason and the quote', () => {
  it('prints the reason; a blank one is none', () => {
    expect(referenceWhy({ why: ' Needs the export first. ' })).toBe('Needs the export first.');
    expect(referenceWhy({ why: '  ' })).toBeNull();
    expect(referenceWhy({ why: null })).toBeNull();
    expect(referenceWhy({})).toBeNull();
  });

  it('shows the quote only when it adds to the reason', () => {
    // No reason: the quote is all there is.
    expect(referenceQuote({ why: null, quote: 'once ENG-7 ships' })).toBe('once ENG-7 ships');
    // The reason already carries the words (case, quotes and punctuation aside): hidden.
    expect(referenceQuote({ why: 'Waits until “ENG-7 ships”.', quote: 'ENG-7 ships' })).toBeNull();
    // Different words: shown under it.
    expect(referenceQuote({ why: 'Needs the saved-basket API.', quote: 'once ENG-7 ships' })).toBe('once ENG-7 ships');
    expect(referenceQuote({ why: 'x', quote: ' ' })).toBeNull();
    expect(referenceQuote({ why: 'x', quote: null })).toBeNull();
  });
});

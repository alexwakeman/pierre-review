// A reference's words (components/Activity/sprintReferences.ts) — pure. Pinned: when a quote is shown
// under the reason.
import { describe, expect, it } from 'vitest';
import type { SprintTicketReference } from '@pierre-review/shared';
import {
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

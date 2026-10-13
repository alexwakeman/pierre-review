// The tracker-text tidy for a list indented under an empty bullet (`flattenEmptyListItems`).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketMarkdown.test.ts
import { describe, expect, it } from 'vitest';
import { flattenEmptyListItems } from '../src/lib/ticketMarkdown.js';

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

// THE AI REVIEW TAB'S STICKY RAIL (components/RailLayout.tsx `stickyRailTop`, config `sticky`): the
// rail sticks 8px under its scroll pane's top while it fits; taller, it scrolls with the page until its
// end is 8px above the pane's bottom, then holds. Only the review layout sets it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stickyRailTop } from '../src/components/RailLayout.js';

describe('stickyRailTop', () => {
  it('a rail that fits sticks just under the pane top', () => {
    expect(stickyRailTop(500, 768)).toBe(8);
    expect(stickyRailTop(752, 768)).toBe(8);
  });
  it('a taller rail holds with its end in view', () => {
    // 900 tall in a 768 pane: top = 768 - 8 - 900.
    expect(stickyRailTop(900, 768)).toBe(-140);
  });
  it('only the review layout is sticky', () => {
    const read = (f: string): string => readFileSync(join(__dirname, '../src', f), 'utf8');
    expect(read('components/ClaudeReviewTab.tsx')).toMatch(/sticky: true,/);
    expect(read('components/Ticket/StoryLayout.tsx')).not.toMatch(/sticky: true/);
  });
});

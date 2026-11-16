// THE CRITERIA MAP (docs/FRONTEND.md § The story view → The criteria map) and A ONE-PR TICKET'S DESIGN.
//
// Pins:
//   1. ONE list, no lines: no SVG, no layout measuring; each link's "how" truncates to one line.
//   2. The map mounts in the story view's review path (no request of its own) and names its section.
//   3. `soloDesignPr`: only a story read that counts exactly ONE member stands in that PR's design.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/criteriaMap.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { soloDesignPr } from '../src/lib/sequenceDiagrams.js';

const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

describe('one list', () => {
  const map = src('components/Activity/CriteriaMap.tsx');
  it('draws no lines and measures nothing', () => {
    expect(map).not.toMatch(/<svg|<path|ResizeObserver|criteriaMapLayout/);
  });
  it("keeps each link's how on one line, never wrapping", () => {
    expect(map).toMatch(/className="min-w-0 flex-1 truncate[^"]*" data-testid="criteria-map-how"/);
    expect(map).toContain('<PrStateMark merged={merged} />');
  });
});

describe('wiring', () => {
  it('the story view mounts the map from the loaded review, as its own section', () => {
    expect(src('components/Activity/TicketStorySection.tsx')).toMatch(/<CriteriaMapSection review=\{review\} \/>/);
    const map = src('components/Activity/CriteriaMap.tsx');
    expect(map).toContain('data-story-section="criteria-map"');
    // No read of its own: no hook from hooks/.
    expect(map).not.toMatch(/from '\.\.\/\.\.\/hooks\//);
    expect(map).toMatch(/<InfoButton title="How the code meets each criterion">/);
  });
});

describe('soloDesignPr', () => {
  const pr = { prId: 7, repo: 'acme/api', number: 7, title: 't', state: 'open' as const, headSha: 'a'.repeat(40) };
  it('stands in the one PR only while the story counts one', () => {
    expect(soloDesignPr({ memberCount: 1, soloPr: pr })).toBe(pr);
    expect(soloDesignPr({ memberCount: 2, soloPr: pr })).toBeNull();
    expect(soloDesignPr({ memberCount: 1 })).toBeNull();
    expect(soloDesignPr(undefined)).toBeNull();
  });
  it('the story design section draws it, with that PR\'s own redraw', () => {
    const s = src('components/Activity/StoryDesignSection.tsx');
    expect(s).toMatch(/if \(design\.solo != null\) return <SoloDesignSection solo=\{design\.solo\} \/>/);
    expect(s).toMatch(/useRedrawPrDiagram\(soloId\)/);
  });
});

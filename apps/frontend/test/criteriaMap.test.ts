// THE CRITERIA MAP (docs/FRONTEND.md § The story view → The criteria map) and A ONE-PR TICKET'S DESIGN.
//
// Pins:
//   1. The PRs are drawn in link order (mean criterion position), unlinked after, card-less last.
//   2. Lines enter a PR box spread over its middle half; a lone line enters at its middle.
//   3. The map mounts in the story view's review path (no request of its own) and names its section.
//   4. `soloDesignPr`: only a story read that counts exactly ONE member stands in that PR's design.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/criteriaMap.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { criteriaMap, type CriteriaMapMemberIn } from '@pierre-review/shared';
import { entryY, linkPath, orderMapPrs } from '../src/lib/criteriaMapLayout.js';
import { soloDesignPr } from '../src/lib/sequenceDiagrams.js';

const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

const CRITERIA = [
  { ref: 'AC1', text: 'Export a report as CSV', status: 'met' },
  { ref: 'AC2', text: 'Columns follow the table order', status: 'partly_met' },
  { ref: 'AC3', text: 'Large exports stream to the browser', status: 'not_met' },
];
const m = (prId: number, lines: string[] | null): CriteriaMapMemberIn => ({
  prId,
  repo: 'acme/api',
  number: prId,
  title: null,
  state: 'open',
  card: lines == null ? null : { criteria: lines.map((criterion) => ({ criterion, how: 'x', files: [] })) },
});

describe('orderMapPrs', () => {
  it('orders by the criteria each PR links to; unlinked next; no card last', () => {
    const map = criteriaMap(CRITERIA, [m(1, null), m(2, ['AC3']), m(3, []), m(4, ['AC1', 'AC2'])]);
    expect(orderMapPrs(map).map((p) => p.prId)).toEqual([4, 2, 3, 1]);
  });
});

describe('line geometry', () => {
  it('spreads entries over the middle half of a box', () => {
    expect(entryY(100, 40, 0, 1)).toBe(120);
    expect(entryY(100, 40, 0, 3)).toBe(110);
    expect(entryY(100, 40, 2, 3)).toBe(130);
  });
  it('a path leaves and enters horizontally', () => {
    expect(linkPath(0, 10, 100, 50)).toBe('M 0 10 C 50 10, 50 50, 100 50');
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

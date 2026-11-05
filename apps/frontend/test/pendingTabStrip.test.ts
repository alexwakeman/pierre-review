// The Pending board's tab STRIP and its header — source-level pins (`AttentionView.tsx`).
//
// WHAT THIS PINS:
//
//   1. THE PENDING TABS ARE PR DETAIL'S BUTTON TABS. Both strips draw through the one `Tabs`
//      component with `variant="boxed"`, so a reader sees one kind of clickable tab everywhere.
//      An explicit icon colour would override the strip's own tint (accent when on), so none.
//   2. MY TURN SAYS WHAT IT IS, IN ONE VISIBLE SENTENCE — on that tab only; the rest stays
//      behind the ⓘ.
//   3. "PLAN MY DAY" IS GONE — no button, no hook, no client method, no `['work-plan']` key.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/pendingTabStrip.test.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');
const read = (p: string): string => readFileSync(join(src, p), 'utf8');
const view = read('components/Activity/AttentionView.tsx');

/** The JSX of the board's own `<Tabs … />` (the one labelled "Pending"). */
function pendingTabsJsx(): string {
  const at = view.indexOf('label="Pending"');
  expect(at).toBeGreaterThan(0);
  const start = view.lastIndexOf('<Tabs', at);
  const end = view.indexOf('/>', at);
  return view.slice(start, end);
}

describe('the Pending tab strip', () => {
  it('is the boxed button strip PR detail uses', () => {
    expect(pendingTabsJsx()).toMatch(/variant="boxed"/);
    expect(read('components/PrDetail.tsx')).toMatch(/variant="boxed"/);
  });

  it('leaves the icon colour to the strip', () => {
    const icon = view.match(/<PendingTabIcon tab=\{t\.key\}[^>]*\/>/)?.[0];
    expect(icon).toBeDefined();
    expect(icon).not.toMatch(/className=/);
  });
});

describe('My turn', () => {
  it('shows one plain sentence, on its own tab only', () => {
    expect(view).toMatch(
      /tabKey === 'my_turn' && \(\s*<p[^>]*data-testid="pending-my-turn-purpose"[^>]*>\s*Pull requests where the next move is yours\.\s*<\/p>/,
    );
  });
});

describe('"Plan my day" is removed', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(src);

  it('has no hook, button, client method or query key left', () => {
    expect(existsSync(join(src, 'hooks', 'useWorkPlan.ts'))).toBe(false);
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect([f, /Plan my day|useWorkPlan|workPlanGenerate|'work-plan'|\/api\/pro\/work-plan/.test(s)]).toEqual([f, false]);
    }
  });
});

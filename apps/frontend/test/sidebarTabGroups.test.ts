// The sidebar's Open tabs, "Group by author" (lib/sidebarTabGroups.ts): the reader's own PRs first,
// then the other authors A–Z by the name shown, then "Other" for tabs with no author; inside a group
// the strip's order holds. The author comes from the tab's meta only (no fetch per tab).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sidebarTabGroups.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupTabsByAuthor, tabAuthor } from '../src/lib/sidebarTabGroups.js';
import type { Tab } from '../src/store/pinnedTabs.js';

const pr = (key: string, login: string | null, name: string | null = null, kind: 'pr-detail' | 'pr-focus' = 'pr-detail'): Tab =>
  ({
    key,
    kind,
    meta: { id: 1, number: 1, title: key, repoFullName: 'acme/web', authorLogin: login, authorDisplayName: name, authorAvatarUrl: null },
  }) as unknown as Tab;
const other = (key: string): Tab => ({ key, kind: 'search' }) as unknown as Tab;

describe('groupTabsByAuthor', () => {
  it('puts the reader first, then authors A–Z by display name, then Other', () => {
    const tabs = [pr('a', 'zed', 'Zed Ng'), other('s'), pr('b', 'robin', 'Robin Hart'), pr('c', 'alex', 'Alex W'), pr('d', 'bea', null)];
    const g = groupTabsByAuthor(tabs, 'alex');
    expect(g.map((x) => x.label)).toEqual(['Alex W', 'bea', 'Robin Hart', 'Zed Ng', 'Other']);
    expect(g[0]!.mine).toBe(true);
    expect(g.at(-1)!.tabs.map((t) => t.key)).toEqual(['s']);
  });

  it('keeps the strip order inside a group and matches logins case-insensitively', () => {
    const tabs = [pr('1', 'Robin', 'Robin'), pr('2', 'alex'), pr('3', 'robin', 'Robin'), pr('4', 'ALEX', null, 'pr-focus')];
    const g = groupTabsByAuthor(tabs, 'Alex');
    expect(g.map((x) => [x.label, x.tabs.map((t) => t.key)])).toEqual([
      ['alex', ['2', '4']],
      ['Robin', ['1', '3']],
    ]);
  });

  it('with no reader known, nobody is "mine" and no Other group appears when every tab has an author', () => {
    const g = groupTabsByAuthor([pr('1', 'b'), pr('2', 'a')], null);
    expect(g.map((x) => x.label)).toEqual(['a', 'b']);
    expect(g.some((x) => x.mine)).toBe(false);
  });

  it('a non-PR tab, or a PR tab with no author, has no author', () => {
    expect(tabAuthor(other('x'))).toBeNull();
    expect(tabAuthor(pr('y', null))).toBeNull();
    expect(tabAuthor(pr('z', 'k', '  '))).toEqual({ login: 'k', name: 'k' });
  });
});

describe('the sidebar wiring', () => {
  const sidebar = readFileSync(join(__dirname, '..', 'src', 'components', 'shell', 'Sidebar.tsx'), 'utf8');
  const shell = readFileSync(join(__dirname, '..', 'src', 'store', 'shell.ts'), 'utf8');
  it('the toggle is an icon button with an accessible name, and the choice is remembered in try/catch', () => {
    expect(sidebar).toMatch(/aria-label="Group by author"/);
    expect(sidebar).toMatch(/aria-pressed=\{byAuthor\}/);
    expect(sidebar).toMatch(/<PeopleIcon size=\{14\} \/>/);
    expect(shell).toMatch(/TABS_BY_AUTHOR_KEY = 'limn:sidebarTabsByAuthor'/);
    expect(shell.slice(shell.indexOf('setTabsByAuthor: (on) =>'))).toMatch(/^setTabsByAuthor: \(on\) => \{\s*try \{/);
  });
});

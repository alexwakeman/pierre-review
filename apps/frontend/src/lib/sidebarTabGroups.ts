import type { Tab } from '../store/pinnedTabs.js';

// The sidebar's Open tabs, grouped under each pull request's AUTHOR ("Group by author"). Pure, so
// the order reads as a test (test/sidebarTabGroups.test.ts).
//
// The author comes from the tab's own meta (`TabMeta.authorLogin` / `authorDisplayName`, written
// when the tab was opened from a list that already held the PR) — never a fetch per tab. A tab
// with no author (a story, a drill-down, a PR opened before its author was known) goes under
// "Other", last.
//
// ORDER: the reader's own PRs first, then the other authors alphabetically by the name shown
// (case-insensitive), then "Other". Inside a group the tabs keep the strip's order.

export interface SidebarTabGroup {
  /** Stable key: `a:<login>` for an author, `other` for tabs with none. */
  key: string;
  /** The heading: the author's display name, else the login; "Other" for the rest. */
  label: string;
  /** The reader's own pull requests. */
  mine: boolean;
  tabs: Tab[];
}

/** The tab's PR author, from its meta (pr-detail and pr-focus tabs only). */
export function tabAuthor(tab: Tab): { login: string; name: string } | null {
  if (tab.kind !== 'pr-detail' && tab.kind !== 'pr-focus') return null;
  const login = tab.meta?.authorLogin ?? null;
  if (login == null || login === '') return null;
  const name = tab.meta?.authorDisplayName?.trim() || login;
  return { login, name };
}

export function groupTabsByAuthor(tabs: readonly Tab[], myLogin: string | null | undefined): SidebarTabGroup[] {
  const me = myLogin?.toLowerCase() ?? null;
  const byLogin = new Map<string, SidebarTabGroup>();
  const other: Tab[] = [];
  for (const t of tabs) {
    const a = tabAuthor(t);
    if (a == null) {
      other.push(t);
      continue;
    }
    const k = a.login.toLowerCase();
    let g = byLogin.get(k);
    if (g == null) {
      g = { key: `a:${k}`, label: a.name, mine: me != null && k === me, tabs: [] };
      byLogin.set(k, g);
    }
    g.tabs.push(t);
  }
  const groups = [...byLogin.values()].sort((x, y) => {
    if (x.mine !== y.mine) return x.mine ? -1 : 1;
    const c = x.label.localeCompare(y.label, undefined, { sensitivity: 'base' });
    return c !== 0 ? c : x.key.localeCompare(y.key);
  });
  if (other.length > 0) groups.push({ key: 'other', label: 'Other', mine: false, tabs: other });
  return groups;
}

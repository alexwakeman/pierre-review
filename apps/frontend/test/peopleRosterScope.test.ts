// The Reports People picker's ROSTER scope — the timeline half of the same lesson
// workspaceOpenPrsScope.test.ts pins for open PRs.
//
// The picker is mounted on the Reports pane (Activity board). Neither of the Timeline board's
// two narrowings — the repo picker (`filters.repoIds`) and the Range preset (`resolveRange`) —
// has a control there, so a builder that reads either narrows the roster with no visible cause:
//
//  • a repo narrowing left on the board drops workspace members who are active only in the
//    un-narrowed repos (the picker's universe is placed ∪ selected — `includeRosterRemainder`
//    is false, so an unplaced member cannot be found at all, not even by typing their name);
//  • a short board range shrinks the roster to that range's actives, and an OLDER completed
//    period then cannot offer anyone who has been quiet since — which is the common case, since
//    the period picker only offers COMPLETED periods.
//
// `rosterTimelineSearch` is therefore its own builder, and this pins the two properties that
// make it one: no `repoIds` ever, and the window is the argument's, not the store's.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { rosterTimelineSearch } from '../src/hooks/useTimeline.js';
import { buildTimelineSearch, useFilters, type FilterState } from '../src/store/filters.js';

const WINDOW = { fromMs: Date.UTC(2026, 6, 22), toMs: Date.UTC(2026, 7, 5) };

describe('rosterTimelineSearch', () => {
  // ⚠ THE STORE IS PUT IN THE NARROWED STATE ON PURPOSE — without it this suite is VACUOUS.
  // The builder takes no state, so against a default store a regression that reads the picker
  // back out of it produces the identical string and every assertion below still passes.
  beforeEach(() => {
    useFilters.setState({ workspaceId: 3, repoIds: [4, 9], preset: '7d' } as Partial<FilterState>);
  });

  it('is the workspace + the CALLER’s window + bots, and nothing else', () => {
    const s = new URLSearchParams(rosterTimelineSearch(3, WINDOW));
    expect(s.get('workspace')).toBe('3');
    expect(s.get('from')).toBe(new Date(WINDOW.fromMs).toISOString());
    expect(s.get('to')).toBe(new Date(WINDOW.toMs).toISOString());
    expect(s.get('excludeBots')).toBe('false');
    expect([...s.keys()].sort()).toEqual(['excludeBots', 'from', 'to', 'workspace']);
  });

  it('never emits the Timeline repo picker’s narrowing, which the board builder does', () => {
    expect(rosterTimelineSearch(3, WINDOW)).not.toContain('repoIds');
    // The falsifiable half: the board's own builder, on the SAME store, does carry it.
    expect(buildTimelineSearch(useFilters.getState())).toContain('repoIds=4%2C9');
  });

  it('ignores the board Range preset entirely — two presets, one roster string', () => {
    const a = rosterTimelineSearch(3, WINDOW);
    useFilters.setState({ preset: '90d' } as Partial<FilterState>);
    expect(rosterTimelineSearch(3, WINDOW)).toBe(a);
  });

  it('omits `workspace` while the scope is unresolved (the hook is disabled then)', () => {
    expect(rosterTimelineSearch(null, WINDOW)).not.toContain('workspace=');
  });

  it('omits the window when there is no period yet (the hook is disabled then too)', () => {
    expect(rosterTimelineSearch(3, null)).toBe('workspace=3&excludeBots=false');
  });
});

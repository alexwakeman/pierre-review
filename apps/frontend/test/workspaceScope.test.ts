// The active workspace: how it is persisted, how it is NOT reset, and how it reaches the wire.
//
// A workspace id is a plain number, so almost everything about it is uninteresting — except at the
// three seams where a wrong answer is silent:
//
//   • RESTORING A RETURNING USER. localStorage still holds `teamScope` in one of five old shapes
//     ('all' | 'none' | 'teams' | 'teams:1,2' | a bare team id). The migration PRESERVED team ids,
//     so `teamScope: 3` looks exactly like a plausible workspace id — coercing it would silently
//     select workspace 3, whose repo membership is not team 3's, and the user would never see an
//     error. Three of the five shapes have no image at all. The rule is DISCARD, all five.
//
//   • "CLEAR FILTERS". Persistence, restore and reset are all driven by one list (FilterDefaults),
//     so anything in it is wiped by clearing a date range. A workspace in that list would make
//     "Clear filters" a silent context switch into Default. It lives in its own slice instead, and
//     the structural proof is that `pickFilterBarState` has no such key.
//
//   • THE WIRE. `?workspace=` is emitted ALWAYS once resolved — never diffed against a default,
//     because there is no static default (the Default workspace's id varies per account) — and
//     `repoIds` is emitted whenever non-null INCLUDING EMPTY. `[]` is a real narrowing ("this
//     workspace has no repos"), and the old `length > 0` guard is exactly what let an empty
//     workspace fall back to rendering the entire account.
//
// ⚠ NOT COVERED HERE, and it should be: the legacy `?team=` URL rule (`?team=<int>` maps across,
// every sentinel is ignored AND discards `?repos=`) lives in `readWorkspaceFromUrl` /
// `readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported. Re-implementing them in
// the test would pin a copy, not the code.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildOpenPrsSearch,
  buildTimelineSearch,
  pickFilterBarState,
  pickScopeState,
  sanitizePersistedFilters,
  sanitizePersistedScope,
  useFilters,
  workspaceScopeKey,
  type FilterState,
} from '../src/store/filters.js';

/** A FilterState snapshot with the fields under test overridden — never the live store. */
function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

describe('workspaceScopeKey — the one spelling of the cache/result segment', () => {
  it('is `ws:<id>`', () => {
    expect(workspaceScopeKey(3)).toBe('ws:3');
  });

  // ⚠ THE PREFIX IS LOAD-BEARING, NOT DECORATION. A bare `String(workspaceId)` would alias the
  // legacy team-scope wire string '3' (team 3, a different repo set) onto workspace 3, and any
  // answer cached under the old name would be served under the new one. It is also the vocabulary
  // the plugin persists in `scope_key`, so a cached AI answer and the slot it renders into agree
  // by construction.
  it('is never a bare number — that would alias a legacy team scope string', () => {
    expect(workspaceScopeKey(3)).not.toBe('3');
    expect(workspaceScopeKey(3)).not.toBe(String(3));
  });

  it('distinct ids get distinct keys', () => {
    expect(workspaceScopeKey(3)).not.toBe(workspaceScopeKey(4));
  });
});

describe('sanitizePersistedScope — the returning user’s blob', () => {
  it('restores a plain positive integer', () => {
    expect(sanitizePersistedScope({ workspaceId: 3 })).toEqual({ workspaceId: 3 });
  });

  // ⚠ ALL FIVE OLD SHAPES ARE DISCARDED, INCLUDING THE BARE NUMBER. Half-migrating persisted
  // state is worse than dropping it: `teamScope: 3` would read as workspace 3 and quietly select
  // a different repo set, while 'all' / 'none' / 'teams' / 'teams:1,2' have no image at all.
  // Leaving `workspaceId` null lets the sync effect resolve the account's Default — the only
  // honest answer.
  const legacy: unknown[] = [
    { teamScope: 'all' },
    { teamScope: 'none' },
    { teamScope: 'teams' },
    { teamScope: 'teams:1,2' },
    { teamScope: 3 },
    { teamScope: [2, 4] },
  ];
  for (const raw of legacy) {
    it(`drops the legacy shape ${JSON.stringify(raw)} rather than coercing it`, () => {
      const out = sanitizePersistedScope(raw);
      expect(out).toEqual({});
      expect('workspaceId' in out).toBe(false);
      expect(out.workspaceId).toBeUndefined();
    });
  }

  it('rejects anything that is not a positive integer', () => {
    for (const bad of [
      { workspaceId: '3' },
      { workspaceId: 0 },
      { workspaceId: -1 },
      { workspaceId: 1.5 },
      { workspaceId: null },
      { workspaceId: Number.NaN },
      { workspaceId: [3] },
      null,
      undefined,
      'ws:3',
      42,
    ]) {
      expect(sanitizePersistedScope(bad)).toEqual({});
    }
  });

  it('round-trips what pickScopeState writes', () => {
    const picked = pickScopeState(state({ workspaceId: 9 }));
    expect(picked).toEqual({ workspaceId: 9 });
    expect(sanitizePersistedScope(picked)).toEqual({ workspaceId: 9 });
  });

  // An unresolved scope must persist as "unresolved", not as a fabricated id.
  it('a null workspace persists as nothing to restore', () => {
    expect(sanitizePersistedScope(pickScopeState(state({ workspaceId: null })))).toEqual({});
  });
});

describe('the FILTER slice never carries the workspace', () => {
  // ⚠ THE STRUCTURAL GUARANTEE BEHIND "Clear filters doesn't teleport you". Persistence
  // (pickFilterBarState), restore (sanitizePersistedFilters, whitelisting against
  // freshFilterDefaults()) and reset (resetAllFilters) share ONE list. A workspace in it is reset
  // by clearing a date range.
  it('pickFilterBarState emits no workspaceId', () => {
    const picked = pickFilterBarState(state({ workspaceId: 7 }));
    expect('workspaceId' in picked).toBe(false);
  });

  it('sanitizePersistedFilters drops a legacy teamScope in every shape', () => {
    for (const teamScope of ['all', 'none', 'teams', 'teams:1,2', 3, [2, 4]]) {
      const out = sanitizePersistedFilters({ teamScope } as unknown as Partial<FilterState>);
      expect('teamScope' in out).toBe(false);
      expect('workspaceId' in out).toBe(false);
    }
  });

  // The same whitelist also stops a workspace RIDING IN on the filter blob — which would put it
  // back under "Clear filters" through the side door.
  it('sanitizePersistedFilters drops a workspaceId smuggled into the filter blob', () => {
    const out = sanitizePersistedFilters({ workspaceId: 9 } as unknown as Partial<FilterState>);
    expect('workspaceId' in out).toBe(false);
  });

  it('but still restores the real filter keys', () => {
    const out = sanitizePersistedFilters({
      teamScope: 'teams:1,2',
      repoIds: [4, 9],
      preset: '30d',
    } as unknown as Partial<FilterState>);
    expect(out).toEqual({ repoIds: [4, 9], preset: '30d' });
  });
});

describe('resetAllFilters preserves the workspace', () => {
  beforeEach(() => {
    useFilters.getState().setWorkspace(5, [1, 2]);
  });

  it('clears the filters but leaves the active workspace alone', () => {
    useFilters.setState({ preset: '90d', excludeBots: true });
    useFilters.getState().resetAllFilters();
    const s = useFilters.getState();
    expect(s.preset).toBe('14d');
    expect(s.excludeBots).toBe(false);
    expect(s.repoIds).toBeNull();
    // ⚠ THE ASSERTION. A workspace reset here is a silent context switch into Default, triggered
    // by a control whose label promises only to clear filters.
    expect(s.workspaceId).toBe(5);
  });
});

describe('the wire — buildOpenPrsSearch / buildTimelineSearch', () => {
  it('always emits ?workspace once resolved, never diffed against a default', () => {
    // There IS no static default to diff against: the Default workspace's id varies per account,
    // so an omitted param would let the server answer for a workspace the header does not name.
    expect(buildOpenPrsSearch(state({ workspaceId: 5, repoIds: null }))).toContain('workspace=5');
    expect(buildTimelineSearch(state({ workspaceId: 5, repoIds: null }))).toContain('workspace=5');
    // Even for workspace 1, which a "diff against the default" implementation would drop.
    expect(buildOpenPrsSearch(state({ workspaceId: 1, repoIds: null }))).toContain('workspace=1');
  });

  it('omits ?workspace only while the id is unresolved', () => {
    expect(buildOpenPrsSearch(state({ workspaceId: null, repoIds: null }))).not.toContain(
      'workspace=',
    );
    expect(buildTimelineSearch(state({ workspaceId: null, repoIds: null }))).not.toContain(
      'workspace=',
    );
    // …and never as the literal string "null", which is what an unconditional set() produces.
    expect(buildOpenPrsSearch(state({ workspaceId: null }))).not.toContain('null');
  });

  // ⚠ AN EMPTY ARRAY IS A NARROWING, NOT THE ABSENCE OF ONE. The old `if (ids && ids.length > 0)`
  // collapsed "show nothing" into "no filter", so an empty workspace rendered the whole account.
  it('emits repoIds when EMPTY, and omits it only when null', () => {
    expect(buildOpenPrsSearch(state({ workspaceId: 5, repoIds: [] }))).toContain('repoIds=');
    expect(buildTimelineSearch(state({ workspaceId: 5, repoIds: [] }))).toContain('repoIds=');
    expect(buildOpenPrsSearch(state({ workspaceId: 5, repoIds: null }))).not.toContain('repoIds');
    expect(buildTimelineSearch(state({ workspaceId: 5, repoIds: null }))).not.toContain('repoIds');
  });

  it('emits a non-empty narrowing as a csv', () => {
    expect(buildOpenPrsSearch(state({ workspaceId: 5, repoIds: [4, 9] }))).toContain('repoIds=4%2C9');
  });

  // A pr-focus tab fetches exactly its subject PR and BYPASSES the repo scope entirely, so naming
  // a workspace could not change the response — it would only churn the query key every time the
  // scope changed and reset the isolate boot. Deliberately scope-free; still bound by accountId.
  it('the prIds override path emits neither workspace nor repoIds', () => {
    const q = buildTimelineSearch(
      state({ workspaceId: 5, repoIds: [4] }),
      true,
      true,
      true,
      true,
      null,
      true,
      [101],
    );
    expect(q).toBe('prIds=101');
  });
});

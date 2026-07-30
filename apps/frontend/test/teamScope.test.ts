// The multi-team scope predicate — the ONE gate the Feed's "Compare teams" sub-tab and the
// Activity rail's per-team grouping both go through.
//
// This is where the bug lived. Both surfaces used to test `teamScope === 'teams'`, the All-Teams
// SENTINEL, so selecting an explicit two-of-five teams made the Compare tab vanish and the rail
// un-group. The reason the naive tests are wrong is `teamSetToScope`'s canonicalisation, which is
// exercised alongside the predicate here so the two can never drift:
//   • a selection covering EVERY team collapses to 'teams'  → `Array.isArray` is wrong
//   • a ONE-team selection collapses to a bare `number`     → `Array.isArray` is wrong again
//   • an explicit subset stays a `number[]`                 → `=== 'teams'` is wrong
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { TeamScope } from '@pierre-review/shared';
import {
  isMultiTeamScope,
  scopeToParam,
  scopeToTeamSet,
  teamIdsInScope,
  teamSetToScope,
} from '../src/store/filters.js';

const ALL = [1, 2, 3, 4, 5];

describe('teamIdsInScope — every TeamScope variant', () => {
  it("'all' resolves to no team (it is the unscoped option, not a team selection)", () => {
    expect(teamIdsInScope('all', ALL)).toEqual([]);
  });

  it("'none' (repos in no team) resolves to no team", () => {
    expect(teamIdsInScope('none', ALL)).toEqual([]);
  });

  it("'teams' (the All-Teams sentinel) resolves to every team", () => {
    expect(teamIdsInScope('teams', ALL)).toEqual(ALL);
  });

  it('a bare number resolves to that one team', () => {
    expect(teamIdsInScope(3, ALL)).toEqual([3]);
  });

  it('an explicit subset resolves to itself', () => {
    expect(teamIdsInScope([2, 4], ALL)).toEqual([2, 4]);
  });

  it('drops ids for teams that no longer exist', () => {
    // A team can be deleted while a scope still names it. Without the live filter, a stale id
    // inflates the count and a surface flickers into (or sticks in) multi-team mode.
    expect(teamIdsInScope([2, 99], ALL)).toEqual([2]);
    expect(teamIdsInScope(99, ALL)).toEqual([]);
  });

  it('resolves to nothing when the account has no teams at all', () => {
    expect(teamIdsInScope('teams', [])).toEqual([]);
    expect(teamIdsInScope([1, 2], [])).toEqual([]);
  });
});

describe('isMultiTeamScope — the 2+ teams gate', () => {
  it('is false for the unscoped options', () => {
    expect(isMultiTeamScope('all', ALL)).toBe(false);
    expect(isMultiTeamScope('none', ALL)).toBe(false);
  });

  it('is false for exactly one team (single-team scope must not regress into grouping)', () => {
    expect(isMultiTeamScope(3, ALL)).toBe(false);
  });

  it('is TRUE for an explicit multi-select — the case the old gate dropped', () => {
    expect(isMultiTeamScope([2, 4], ALL)).toBe(true);
  });

  it("is TRUE for the All-Teams sentinel when the account has 2+ teams", () => {
    expect(isMultiTeamScope('teams', ALL)).toBe(true);
  });

  it("is FALSE for the All-Teams sentinel on a ONE-team account (nothing to compare)", () => {
    expect(isMultiTeamScope('teams', [7])).toBe(false);
  });

  it('is false once a stale id is filtered out, leaving one live team', () => {
    expect(isMultiTeamScope([2, 99], ALL)).toBe(false);
  });
});

describe('teamSetToScope canonicalisation — why the naive predicates fail', () => {
  it('collapses a full selection to the "teams" sentinel (breaks Array.isArray)', () => {
    const scope = teamSetToScope([...ALL], ALL);
    expect(scope).toBe('teams');
    expect(Array.isArray(scope)).toBe(false);
    expect(isMultiTeamScope(scope, ALL)).toBe(true); // …but the predicate still says multi
  });

  it('collapses a one-team selection to a bare number (breaks Array.isArray)', () => {
    const scope = teamSetToScope([4], ALL);
    expect(scope).toBe(4);
    expect(isMultiTeamScope(scope, ALL)).toBe(false);
  });

  it("keeps a subset as a sorted array (breaks === 'teams')", () => {
    const scope = teamSetToScope([4, 2], ALL);
    expect(scope).toEqual([2, 4]);
    expect(scope === 'teams').toBe(false);
    expect(isMultiTeamScope(scope, ALL)).toBe(true);
  });

  it('an empty selection means unscoped, not multi-team', () => {
    const scope = teamSetToScope([], ALL);
    expect(scope).toBe('all');
    expect(isMultiTeamScope(scope, ALL)).toBe(false);
  });
});

describe('scopeToParam — the wire string the compare route selects teams by', () => {
  // The route resolves these against the CALLER'S OWN teams, so the strings below are the
  // complete set the backend must understand.
  const cases: [TeamScope, string][] = [
    ['all', 'all'],
    ['none', 'none'],
    ['teams', 'teams'],
    [4, '4'],
    [[4, 2], 'teams:2,4'], // sorted → order-independent cache key
  ];
  for (const [scope, wire] of cases) {
    it(`${JSON.stringify(scope)} → "${wire}"`, () => {
      expect(scopeToParam(scope)).toBe(wire);
    });
  }

  it('round-trips a multi-select back to the same team ids', () => {
    const scope = teamSetToScope([4, 2], ALL);
    expect(scopeToParam(scope)).toBe('teams:2,4');
    expect(scopeToTeamSet(scope, ALL)).toEqual([2, 4]);
  });
});

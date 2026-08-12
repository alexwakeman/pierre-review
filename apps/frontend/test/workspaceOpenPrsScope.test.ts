// The ACTIVITY-side open-PR scope, and why it is a second builder rather than a reuse.
//
// `filters.repoIds` is the FilterBar's per-repo show/hide. Its picker is mounted ONLY while the
// Timeline board is the active tab, and it narrows ONLY that board. Every Activity surface — the
// Feed's open-PR panel, the "Showing only #N" isolation banner, the 'feed'-scoped open-PRs
// drill-down — covers the WHOLE active workspace, and you narrow those by clicking a repo in the
// Activity rail instead.
//
// So the two open-PR readers must disagree exactly once: when the board is narrowed.
//
//   useOpenPrs / useSearchOpenPrs  → buildOpenPrsSearch  → honours filters.repoIds  (TIMELINE)
//   useWorkspaceOpenPrs            → workspaceOpenPrsSearch → workspace only        (ACTIVITY)
//   useScopedOpenPrs               → scopedOpenPrsSearch → workspace + an EXPLICIT
//                                    repo argument, never the store          (DRILL-DOWN)
//
// Two failure modes hide in that pair, and neither raises anything:
//
//  1. If the Activity builder ever picked up `repoIds`, an Activity list would silently come back
//     short — scoped by a control that is not on screen and cannot be cleared from there. The
//     isolation banner made that concrete: it resolves the isolated PR's title out of this list,
//     so a board narrowed to other repos left the banner stuck on the generic "the selected PR".
//  2. If the two builders stopped agreeing BYTE FOR BYTE in the common case (picker unset), they
//     would stop sharing a React Query cache entry — the key IS the string — and the app would
//     fetch the identical list twice, forever, with both copies rendering correctly.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { scopedOpenPrsSearch, workspaceOpenPrsSearch } from '../src/hooks/useTriage.js';
import { buildOpenPrsSearch, useFilters, type FilterState } from '../src/store/filters.js';

// buildOpenPrsSearch reads exactly three fields; the rest of FilterState (and its actions) are
// irrelevant to it, so a partial stands in.
function state(partial: {
  workspaceId: number | null;
  repoIds: number[] | null;
  userIds?: number[] | null;
}): FilterState {
  return {
    workspaceId: partial.workspaceId,
    repoIds: partial.repoIds,
    userIds: partial.userIds ?? null,
  } as unknown as FilterState;
}

describe('workspaceOpenPrsSearch', () => {
  // ⚠ THE STORE IS PUT IN THE NARROWED STATE ON PURPOSE, AND WITHOUT THIS THE WHOLE SUITE IS
  // VACUOUS. `workspaceOpenPrsSearch` takes only a workspace id, so with the store left at its
  // default (`repoIds: null`) a regression that reads the picker back out of the store produces
  // the identical string and every assertion below still passes. Leaving the picker set to a real
  // narrowing is what makes "it ignores the picker" an observation rather than a restatement.
  beforeEach(() => {
    useFilters.setState({ workspaceId: 3, repoIds: [4, 9] });
  });

  it('is the workspace and NOTHING else', () => {
    expect(workspaceOpenPrsSearch(3)).toBe('workspace=3');
  });

  it('sends nothing while the workspace is unresolved (the hook is disabled then)', () => {
    expect(workspaceOpenPrsSearch(null)).toBe('');
  });

  // ⚠ THE SCOPE CLAIM. A repo picker set on the Timeline must not reach an Activity list.
  it('ignores the timeline repo picker entirely — including an EMPTY narrowing', () => {
    for (const repoIds of [null, [], [4], [4, 9]]) {
      expect(workspaceOpenPrsSearch(3)).toBe('workspace=3');
      // …while the timeline builder, given the same picker state, does narrow.
      // (URLSearchParams percent-encodes the separating comma — read the param back rather than
      // pinning the encoding, which is not what this test is about.)
      const timeline = new URLSearchParams(
        buildOpenPrsSearch(state({ workspaceId: 3, repoIds }), false),
      );
      expect(timeline.get('workspace')).toBe('3');
      expect(timeline.get('repoIds')).toBe(repoIds == null ? null : repoIds.join(','));
    }
  });

  // ⚠ THE CACHE CLAIM. Unset picker ⇒ byte-identical ⇒ one shared cache entry, no extra fetch.
  it('is byte-identical to the timeline builder while the picker is unset', () => {
    expect(workspaceOpenPrsSearch(3)).toBe(
      buildOpenPrsSearch(state({ workspaceId: 3, repoIds: null }), false),
    );
  });

  // …and only then. A narrowed board is exactly when the two SHOULD be two fetches.
  it('diverges from the timeline builder once the board is narrowed', () => {
    expect(workspaceOpenPrsSearch(3)).not.toBe(
      buildOpenPrsSearch(state({ workspaceId: 3, repoIds: [4] }), false),
    );
  });
});

// The open-PRs drill-down's builder: its narrowing is the EXPLICIT `repoIds` argument (the tab's
// repo/group scope), never the store's picker. Same store-narrowing discipline as above — the
// beforeEach leaves the Timeline picker SET, so "it ignores filters.repoIds" is an observation.
describe('scopedOpenPrsSearch', () => {
  beforeEach(() => {
    useFilters.setState({ workspaceId: 3, repoIds: [4, 9] });
  });

  // ⚠ THE CACHE CLAIM. Unscoped (repoIds == null) ⇒ byte-identical to the Activity builder ⇒
  // the workspace-wide drill-down shares its cache entry, no extra fetch.
  it('is byte-identical to workspaceOpenPrsSearch when unscoped', () => {
    expect(scopedOpenPrsSearch(3, null)).toBe('workspace=3');
    expect(scopedOpenPrsSearch(3, null)).toBe(workspaceOpenPrsSearch(3));
  });

  // ⚠ THE SCOPE CLAIM. The picker is [4, 9] right now; neither id may leak into the string.
  it('ignores the timeline repo picker — the narrowing is the argument alone', () => {
    expect(scopedOpenPrsSearch(3, null)).toBe('workspace=3');
    const p = new URLSearchParams(scopedOpenPrsSearch(3, [5]));
    expect(p.get('repoIds')).toBe('5');
  });

  // ⚠ THE WORKSPACE CLAIM. `repoIds` ALONE IS NOT A SCOPE: /api/open-prs resolves the workspace
  // from `?workspace=` (absent ⇒ the account's DEFAULT) and returns membership ∩ repoIds, so a
  // bare `repoIds=<id>` comes back EMPTY for any repo moved into another workspace.
  it('always keeps workspace= alongside repoIds=', () => {
    const p = new URLSearchParams(scopedOpenPrsSearch(3, [5]));
    expect(p.get('workspace')).toBe('3');
    expect(p.get('repoIds')).toBe('5');
    // A group scope's multi-repo narrowing keeps it too.
    const g = new URLSearchParams(scopedOpenPrsSearch(3, [5, 7]));
    expect(g.get('workspace')).toBe('3');
    expect(g.get('repoIds')).toBe('5,7');
  });
});

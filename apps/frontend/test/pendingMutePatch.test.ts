// What ONE Save on the Pending-mute section is allowed to send.
//
// The section holds TWO INDEPENDENTLY-OWNED FACTS at ONE grain — "mute this whole workspace" and
// "mute these repositories" — which are OR-ed, never chained. `null`-means-inherit is a named bug
// class in this codebase (the reviewer price, the Slack target, the sprint cadence all had it),
// and the shape that reintroduces it here is not a schema change: it is a Save that sends BOTH
// keys every time. A key you send is a claim you are making. Sending an unchanged `muted:false`
// alongside a repo edit overwrites whatever the workspace switch holds on the server — which, on
// a tab that has been open since before someone else muted the workspace, is a silent revert.
//
// The second rule is about BLAST RADIUS. `mutedRepoIds` is the WHOLE set for this workspace, not
// a delta: the server replaces the muted set inside the named workspace's membership and leaves
// every other workspace's rows alone. So `[]` here means "nothing in THIS workspace is muted",
// never "clear the account" — and the patch must therefore be able to carry an empty array
// distinguishably from carrying nothing.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { buildPendingMutePatch } from '../src/components/settings/PendingMuteSection.js';

const base = { workspaceDirty: false, reposDirty: false, muted: false, repoIds: [] as number[] };

describe('buildPendingMutePatch — only the half that changed goes on the wire', () => {
  // ⚠ THE LOAD-BEARING ONE. The two facts are a UNION; a key that rides along unchanged is an
  // assertion the user never made, and it overwrites the other grain's stored value.
  it('a workspace-only edit carries NO repo list', () => {
    const patch = buildPendingMutePatch({ ...base, workspaceDirty: true, muted: true });
    expect(patch).toEqual({ muted: true });
    expect('mutedRepoIds' in patch).toBe(false);
  });

  it('a repo-only edit carries NO workspace switch', () => {
    const patch = buildPendingMutePatch({ ...base, reposDirty: true, repoIds: [7, 3] });
    expect(patch).toEqual({ mutedRepoIds: [3, 7] });
    expect('muted' in patch).toBe(false);
  });

  it('sends both when both changed', () => {
    const patch = buildPendingMutePatch({
      workspaceDirty: true,
      reposDirty: true,
      muted: true,
      repoIds: [2],
    });
    expect(patch).toEqual({ muted: true, mutedRepoIds: [2] });
  });

  // ⚠ AN EMPTY ARRAY IS A REAL ANSWER, NOT AN ABSENT ONE — "nothing in this workspace is muted".
  // Collapsing it to `undefined` would make un-muting the last repository a no-op that reports
  // success, which is the worst shape a settings write can have.
  it('un-muting the last repository sends an EMPTY array, not nothing', () => {
    const patch = buildPendingMutePatch({ ...base, reposDirty: true, repoIds: [] });
    expect(patch).toEqual({ mutedRepoIds: [] });
    expect(patch.mutedRepoIds).toBeDefined();
  });

  // ⚠ SORTED, so a re-order of the same set is not a different payload. The checkbox list builds
  // the array in CLICK order, so ticking A then B and ticking B then A would otherwise produce
  // two different bodies for one state.
  it('sorts the repo ids so click order is not part of the payload', () => {
    const a = buildPendingMutePatch({ ...base, reposDirty: true, repoIds: [9, 1, 5] });
    const b = buildPendingMutePatch({ ...base, reposDirty: true, repoIds: [5, 9, 1] });
    expect(a).toEqual(b);
    expect(a.mutedRepoIds).toEqual([1, 5, 9]);
  });

  // Save is disabled when neither half is dirty, but "disabled" is a UI state, not a guarantee.
  it('an empty patch is legal', () => {
    expect(buildPendingMutePatch(base)).toEqual({});
  });
});

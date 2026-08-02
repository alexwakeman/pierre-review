// The detected-reviewers cache key.
//
// The regression this exists for is silent and off-screen. Several surfaces read this route
// UNNARROWED — the bot colour map (useBotColors), the feed's vendor tag (FeedView) and
// ThreadList's resolve-eligibility map — while the Bots → Settings list may read it narrowed to a
// subset of the workspace's repos. The two responses have the same TypeScript shape, so if the
// narrowing is missing from the key the narrow listing populates the entry the unnarrowed callers
// read and they quietly lose bots: a reviewer's colour reverts to neutral gray and its feed tag
// disappears, with no error anywhere.
//
// ── WHAT CHANGED WITH WORKSPACES: THREE SEGMENTS, NOT TWO ──────────────────────────────────────
// The old key had ONE scope slot, which conflated two questions that are now independent:
//
//   'ws:<id>'  — the JUDGEMENT grain. Which workspace's `workspace_reviewers` rows decide who is
//                a bot, what its vendor is and what it costs. Identity is per workspace now, so
//                two workspaces are two different answers to "what colour is CodeRabbit".
//   repo slot  — a DISPLAY narrowing INSIDE that workspace. It changes which footprints are
//                shown, never the verdict.
//
// Both must occupy their own slot. Two workspaces sitting on `repoIds = null` build the SAME
// request-less key without the workspace segment — each means "every repo in MY workspace", which
// only the server can expand — so React Query would serve one workspace's identities under the
// other's name, with no refetch and no error.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { detectedReviewersQueryKey } from '../src/hooks/useBotTriage.js';

describe('detectedReviewersQueryKey', () => {
  it('is THREE segments: the name, the workspace, the repo narrowing', () => {
    expect(detectedReviewersQueryKey(3, null)).toEqual(['bot-reviewers', 'ws:3', 'all']);
    expect(detectedReviewersQueryKey(3, [4])).toEqual(['bot-reviewers', 'ws:3', '4']);
  });

  // ⚠ THE LOAD-BEARING ONE. Workspace ids and repo ids are independent autoincrements, so both
  // are bare integers; without the `ws:` namespace, workspace 7 and repo 7 land in the same cache
  // slot and one listing is served under the other's name.
  it('namespaces the workspace slot, so a repo id can never alias a workspace id', () => {
    expect(detectedReviewersQueryKey(7, null)[1]).toBe('ws:7');
    expect(detectedReviewersQueryKey(null, [7])[1]).not.toBe('7');
    expect(detectedReviewersQueryKey(7, null)).not.toEqual(detectedReviewersQueryKey(null, [7]));
    // …and the two slots stay distinct even when the SAME integer names both, which is the exact
    // collision a single conflated slot produced.
    expect(detectedReviewersQueryKey(7, [7])).not.toEqual(detectedReviewersQueryKey(7, null));
  });

  // The other half of the same rule: with `repoIds = null` the query STRING is identical for every
  // workspace (the server expands the membership), so only the key can tell them apart.
  it('two workspaces on the same (absent) repo narrowing never share an entry', () => {
    expect(detectedReviewersQueryKey(3, null)).not.toEqual(detectedReviewersQueryKey(4, null));
    expect(detectedReviewersQueryKey(3, [4])).not.toEqual(detectedReviewersQueryKey(4, [4]));
  });

  // An unresolved workspace is a real, distinct state: the query is held IDLE by skipToken until
  // `listWorkspaces()` lands. It must not be able to occupy a resolved workspace's slot, or an
  // empty never-fetched entry would shadow real data.
  it('a not-yet-resolved workspace gets its own slot', () => {
    expect(detectedReviewersQueryKey(null, null)[1]).toBe('ws:pending');
    expect(detectedReviewersQueryKey(null, null)).not.toEqual(detectedReviewersQueryKey(1, null));
  });

  it('every "no narrowing" spelling collapses to the entry the unnarrowed callers share', () => {
    const target = detectedReviewersQueryKey(3);
    expect(detectedReviewersQueryKey(3, null)).toEqual(target);
    expect(detectedReviewersQueryKey(3, [])).toEqual(target);
  });

  it('different repo narrowings within one workspace never share a key', () => {
    expect(detectedReviewersQueryKey(3, [4])).not.toEqual(detectedReviewersQueryKey(3, [9]));
  });

  it('repo id order does not open a second entry (the same set is one key)', () => {
    expect(detectedReviewersQueryKey(3, [9, 4])).toEqual(detectedReviewersQueryKey(3, [4, 9]));
  });

  it('keeps the "bot-reviewers" prefix so the reclassify invalidation still sweeps every entry', () => {
    // RECLASSIFY_INVALIDATE_KEYS invalidates by the bare prefix, deliberately: a write is
    // workspace-wide but several workspaces can be cached at once (Compare, a tab left open on
    // another scope), and only a prefix sweeps them all.
    for (const k of [
      detectedReviewersQueryKey(null),
      detectedReviewersQueryKey(3),
      detectedReviewersQueryKey(3, [7]),
    ]) {
      expect(k[0]).toBe('bot-reviewers');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { rankTeamRequests } from './team-reviewers.js';

// Locks the pure aggregation/ranking behind the history-based team suggester (the network
// fetch is a thin cached wrapper around this). Builds PR-timeline nodes the way GitHub's
// `timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT])` returns them.
type Ev = { createdAt?: string | null; requestedReviewer?: { __typename: string; slug?: string } | null };
const pr = (number: number, evs: Ev[]) => ({
  number,
  timelineItems: { nodes: evs },
});
const team = (slug: string, createdAt: string): Ev => ({
  createdAt,
  requestedReviewer: { __typename: 'Team', slug },
});
// A User review-request (no slug) — the suggester must ignore these.
const user = (createdAt: string): Ev => ({
  createdAt,
  requestedReviewer: { __typename: 'User' },
});

describe('rankTeamRequests', () => {
  it('ranks teams by DISTINCT-PR count (a re-request on one PR is not double-weighted)', () => {
    const nodes = [
      pr(1, [team('platform', '2026-07-01T00:00:00Z'), team('platform', '2026-07-02T00:00:00Z')]),
      pr(2, [team('platform', '2026-07-03T00:00:00Z')]),
      pr(3, [team('platform', '2026-07-04T00:00:00Z')]),
      pr(4, [team('security', '2026-07-05T00:00:00Z')]),
      pr(5, [team('security', '2026-07-06T00:00:00Z')]),
    ];
    const ranked = rankTeamRequests(nodes, 'acme');
    expect(ranked.map((t) => [t.slug, t.count])).toEqual([
      ['platform', 3], // 3 distinct PRs (PR 1's double request counts once)
      ['security', 2],
    ]);
    expect(ranked[0]!.name).toBe('acme/platform'); // the requestable 'org/team' handle
  });

  it('drops teams under the minPrs threshold (a one-off request is not a pattern)', () => {
    const nodes = [
      pr(1, [team('platform', '2026-07-01T00:00:00Z')]),
      pr(2, [team('platform', '2026-07-02T00:00:00Z')]),
      pr(3, [team('oneoff', '2026-07-03T00:00:00Z')]),
    ];
    expect(rankTeamRequests(nodes, 'acme').map((t) => t.slug)).toEqual(['platform']);
    // A lower threshold keeps the one-off.
    expect(rankTeamRequests(nodes, 'acme', 1).map((t) => t.slug).sort()).toEqual([
      'oneoff',
      'platform',
    ]);
  });

  it('ignores User review-requests and tracks the most-recent request time', () => {
    const nodes = [
      pr(1, [user('2026-07-09T00:00:00Z'), team('platform', '2026-07-01T00:00:00Z')]),
      pr(2, [team('platform', '2026-07-08T00:00:00Z')]),
    ];
    const ranked = rankTeamRequests(nodes, 'acme');
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.slug).toBe('platform');
    expect(ranked[0]!.lastAt).toBe('2026-07-08T00:00:00Z');
  });

  it('breaks a count tie by recency', () => {
    const nodes = [
      pr(1, [team('newer', '2026-07-10T00:00:00Z')]),
      pr(2, [team('newer', '2026-07-11T00:00:00Z')]),
      pr(3, [team('older', '2026-07-01T00:00:00Z')]),
      pr(4, [team('older', '2026-07-02T00:00:00Z')]),
    ];
    expect(rankTeamRequests(nodes, 'acme').map((t) => t.slug)).toEqual(['newer', 'older']);
  });

  it('returns [] on no team requests (repo does not use them)', () => {
    expect(rankTeamRequests([pr(1, [user('2026-07-01T00:00:00Z')]), pr(2, [])], 'acme')).toEqual([]);
  });
});

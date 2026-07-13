// History-based TEAM reviewer suggestions (CORE). GitHub lets a PR request an `@org/team` as
// a reviewer; that request is EPHEMERAL (GitHub drops it from `reviewRequests` once a member
// reviews), but the PR timeline keeps a permanent `ReviewRequestedEvent` for it. This mines a
// repo's recent PRs for those team requests, ranks the teams by how often they're asked to
// review here, and returns the top few — the "which team usually reviews this repo" signal
// that CODEOWNERS provides statically but many repos never declare.
//
// Best-effort throughout: any failure (network, org wall, a repo that simply doesn't use team
// review-requests) degrades to "no team suggestion", NEVER an error on the PR-detail path.
//
// Auth caveat (same reality codeowners.ts notes for the org/teams API): a Team
// `requestedReviewer` is only visible to a token with org/team visibility — org membership,
// or a GitHub App installed with org read. For an outside token GitHub returns no team on the
// event, so this yields nothing. That's fine: it lights up for your own org's repos (the
// common case — you watch your org's repos with your own token) and stays silent elsewhere.
import { getGraphqlClientFor } from './client.js';

export interface TeamSuggestion {
  slug: string; // the assign key → sent as `team_reviewers` (e.g. 'bng-metric')
  name: string; // 'org/team' handle (matches CODEOWNERS + how the client renders `@name`)
  count: number; // DISTINCT recent PRs that requested this team (the strength of the signal)
  lastAt: string; // ISO of the most-recent request (freshness / tie-break)
}

// The slice of the GraphQL response we read. `requestedReviewer` is a union; we only care
// about the `Team` members (User requests are handled by the history-USER suggester).
interface TeamNode {
  __typename: string;
  slug?: string | null;
}
interface PrNode {
  number: number;
  timelineItems: {
    nodes: Array<{ createdAt?: string | null; requestedReviewer?: TeamNode | null }>;
  };
}

// Per-(account, repo) cache. Which team reviews a repo is very stable, so a longish TTL keeps
// the extra GraphQL call off the hot path. Cached even when EMPTY (the "repo doesn't use team
// requests" / "token can't see teams" case) so we don't re-query on every PR open. Keyed by
// account so one tenant's token result never leaks to another.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, { ranked: TeamSuggestion[]; at: number }>();

const PRS_SCANNED = 50; // recent PRs to mine — bounded for GraphQL node cost
const DEFAULT_MIN_PRS = 2; // ignore a one-off request; require a repeated pattern
const DEFAULT_TOP_N = 2; // at most this many team suggestions

const TEAM_HISTORY_QUERY = `
  query TeamReviewHistory($owner: String!, $name: String!, $prs: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: $prs, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: 20) {
            nodes {
              ... on ReviewRequestedEvent {
                createdAt
                requestedReviewer {
                  __typename
                  ... on Team { slug }
                }
              }
            }
          }
        }
      }
    }
  }`;

// Aggregate team review-requests from PR timeline nodes → teams ranked by DISTINCT-PR count
// then recency, dropping any under `minPrs`. Pure (no network) so it's unit-testable. Counting
// distinct PRs (not raw events) means a re-request on a single PR isn't double-weighted.
export function rankTeamRequests(
  prNodes: PrNode[],
  owner: string,
  minPrs: number = DEFAULT_MIN_PRS,
): TeamSuggestion[] {
  const agg = new Map<string, { prs: Set<number>; lastAt: string }>();
  for (const pr of prNodes) {
    for (const ev of pr.timelineItems?.nodes ?? []) {
      const rr = ev.requestedReviewer;
      if (!rr || rr.__typename !== 'Team' || !rr.slug) continue;
      const cur = agg.get(rr.slug) ?? { prs: new Set<number>(), lastAt: '' };
      cur.prs.add(pr.number);
      const when = ev.createdAt ?? '';
      if (when > cur.lastAt) cur.lastAt = when;
      agg.set(rr.slug, cur);
    }
  }
  return [...agg.entries()]
    .map(([slug, v]): TeamSuggestion => ({
      slug,
      name: `${owner}/${slug}`,
      count: v.prs.size,
      lastAt: v.lastAt,
    }))
    .filter((t) => t.count >= minPrs)
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0),
    );
}

// Mine a repo's recent PRs for the team(s) most often requested to review here (cached per
// repo). Returns the top `topN`. Never throws — a failure/permission-wall yields [].
export async function suggestTeamsFromHistory(
  token: string,
  owner: string,
  name: string,
  accountId: number,
  opts: { minPrs?: number; topN?: number } = {},
): Promise<TeamSuggestion[]> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const key = `${accountId}:${owner}/${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ranked.slice(0, topN);

  let ranked: TeamSuggestion[] = [];
  try {
    const client = getGraphqlClientFor(token);
    const data = await client<{
      repository: { pullRequests: { nodes: PrNode[] } | null } | null;
    }>(TEAM_HISTORY_QUERY, { owner, name, prs: PRS_SCANNED });
    ranked = rankTeamRequests(
      data.repository?.pullRequests?.nodes ?? [],
      owner,
      opts.minPrs ?? DEFAULT_MIN_PRS,
    );
  } catch {
    ranked = [];
  }
  cache.set(key, { ranked, at: Date.now() });
  return ranked.slice(0, topN);
}

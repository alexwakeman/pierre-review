import { and, eq } from 'drizzle-orm';
import { githubIssueKey } from '@pierre-review/shared';
import type { TrackerContext } from '../context.js';
import { githubAccessFor } from '../context.js';
import { JiraFetchError } from '../jira/fetch.js';
import type { LinkerPr, TrackerLinker } from '../types.js';
import { githubGraphql, noteGithubBudget } from './reader.js';

// GITHUB ISSUES — THE LINKER: which issues each pull request CLOSES, read from GitHub and stored on
// the PR (`pull_requests.closing_issues`, migration 0089 / pg 0076).
//
// ⚠ EXACT, NOT HEURISTIC. A PR's tickets are GitHub's `closingIssuesReferences` — "Fixes #12",
// "Closes owner/repo#12" (cross-repository included) or a link made in the PR's Development panel.
// A bare "#12" mention is not a ticket, and nothing here reads the PR text at all.
//
// ⚠ COST — ZERO FOR EVERY OTHER WORKSPACE. This is NOT a field on the repo walk's query: the walk is
// shared by every workspace, and a `closingIssuesReferences` connection on it would charge Jira and
// tracker-less workspaces for a GitHub-only fact. Instead the tracker worker runs this step, and only
// for PRs whose workspace's tracker is GitHub Issues: `nodes(ids:)` over up to `LINK_NODE_BATCH` PRs
// with ONE small connection each — measured at 1 point per batch. A PR is due when its links were
// never read, when GitHub's `updatedAt` moved past the last read (an edited body), or — while open —
// every `LINK_TTL_MS` (a Development-panel link may not move `updatedAt`). At most
// `LINK_REFRESH_MAX` PRs per pass.
//
// ⚠ A COLUMN IS CLEARED ONLY ON A POSITIVE STATEMENT: a node GitHub did not return, or returned with
// the selection nulled, is left exactly as it was — NULL stays "never read".

export const LINK_NODE_BATCH = 50;
export const LINK_REFRESH_MAX = 200;
export const LINK_TTL_MS = 30 * 60_000;
/** Issues kept per PR, in GitHub's order (a PR closing more is vanishingly rare). */
export const LINK_ISSUE_CAP = 10;

export const PR_CLOSING_ISSUES_QUERY = /* GraphQL */ `
  query TrackerClosingIssues($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        closingIssuesReferences(first: ${LINK_ISSUE_CAP}) {
          nodes { number repository { nameWithOwner } }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

interface GqlNode {
  id?: string;
  closingIssuesReferences?: {
    nodes?: Array<{ number?: number; repository?: { nameWithOwner?: string } | null } | null> | null;
  } | null;
}

/** GitHub's references → the stored keys, de-duplicated, in GitHub's order. */
export function closingKeysOf(node: GqlNode): string[] | null {
  const conn = node.closingIssuesReferences;
  if (conn == null || !Array.isArray(conn.nodes)) return null;
  const out: string[] = [];
  for (const n of conn.nodes) {
    const nwo = n?.repository?.nameWithOwner;
    if (typeof nwo !== 'string' || typeof n?.number !== 'number') continue;
    const key = githubIssueKey(nwo, n.number);
    if (key != null && !out.includes(key)) out.push(key);
  }
  return out;
}

function isDue(pr: LinkerPr, now: number): boolean {
  if (pr.githubNodeId == null || pr.githubNodeId === '') return false;
  const checked = pr.closingIssuesCheckedAt != null ? new Date(pr.closingIssuesCheckedAt).getTime() : null;
  if (checked == null) return true;
  if (pr.updatedAt != null && new Date(pr.updatedAt).getTime() > checked) return true;
  return pr.state === 'open' && now - checked >= LINK_TTL_MS;
}

const rank = (pr: LinkerPr): number => (pr.closingIssuesCheckedAt == null ? 0 : pr.state === 'open' ? 1 : 2);

async function refresh(
  ctx: TrackerContext,
  accountId: number,
  prs: readonly LinkerPr[],
  opts: { now: number },
): Promise<{ read: number; skipped: number }> {
  const gh = githubAccessFor(ctx, accountId);
  const due = prs
    .filter((p) => isDue(p, opts.now))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.closingIssuesCheckedAt != null ? new Date(a.closingIssuesCheckedAt).getTime() : 0) -
          (b.closingIssuesCheckedAt != null ? new Date(b.closingIssuesCheckedAt).getTime() : 0) ||
        a.id - b.id,
    )
    .slice(0, LINK_REFRESH_MAX);
  if (gh == null || due.length === 0) return { read: 0, skipped: due.length };
  const byNode = new Map(due.map((p) => [p.githubNodeId, p]));
  const pr = ctx.schema.pullRequests;
  let read = 0;
  for (let i = 0; i < due.length; i += LINK_NODE_BATCH) {
    const batch = due.slice(i, i + LINK_NODE_BATCH);
    type Resp = { nodes?: Array<GqlNode | null> | null; rateLimit?: { remaining?: number | null; resetAt?: string | null } | null };
    let data: Resp | null;
    try {
      ({ data } = await githubGraphql<Resp>(gh, PR_CLOSING_ISSUES_QUERY, { ids: batch.map((p) => p.githubNodeId) }));
    } catch (err) {
      // A low budget / a limit / a refused token: stop this pass; the rest stay due. Never thrown.
      const code = err instanceof JiraFetchError ? err.code : 'unknown';
      ctx.log.warn({ accountId, code, route: 'tracker-github-links' }, 'GitHub issue links not read (retried later)');
      break;
    }
    noteGithubBudget(accountId, data?.rateLimit);
    const at = new Date(opts.now);
    for (const node of data?.nodes ?? []) {
      if (node?.id == null) continue;
      const p = byNode.get(node.id);
      const keys = closingKeysOf(node);
      if (p == null || keys == null) continue; // not a positive statement: leave the row alone
      await ctx.db
        .update(pr)
        .set({ closingIssues: keys, closingIssuesCheckedAt: at })
        .where(and(eq(pr.accountId, accountId), eq(pr.id, p.id)))
        .execute();
      read += 1;
    }
  }
  return { read, skipped: due.length - read };
}

export const githubLinker = { required: true, refresh, isDue } satisfies TrackerLinker;

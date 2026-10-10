import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import { JiraFetchError } from '../jira/fetch.js';
import { githubGraphql, noteGithubBudget, SUB_ISSUE_CAP, toFetchedTicket } from '../github/reader.js';
import type { GithubCallAccess } from '../types.js';
import type { SprintFetchedTicket, SprintListResult, SprintLister } from './types.js';

// GITHUB ISSUES — THE SPRINT LIST (docs/TRACKERS.md § The sprint list read). GitHub's nearest thing
// to a sprint is a MILESTONE: the open milestone with the NEAREST due date (today or later) across
// the workspace's repos; an undated one ranks after every dated one, and an overdue one is not
// picked. Its open issues are read in EVERY repo with an open milestone of the same title (a team
// that names one milestone per repo for the same release reads as one list).
//
// No open milestone → the status fallback (`none_active`): open issues updated in the window.
// Read with the ACCOUNT's own GitHub token (`TrackerCall.github`), through `githubGraphql` — the
// reader's budget pre-emption and limit rules — and folded by the SAME `toFetchedTicket`.

/** Repos read per pass at most (each costs one milestone query). */
export const SPRINT_GITHUB_REPOS_MAX = 20;
const PAGE = 50;

export const GITHUB_MILESTONES_QUERY = /* GraphQL */ `
  query LimnSprintMilestones($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      milestones(states: OPEN, first: 20, orderBy: { field: DUE_DATE, direction: ASC }) {
        nodes { title dueOn number }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

const ISSUE_FIELDS = /* GraphQL */ `
  number
  title
  url
  state
  stateReason
  body
  createdAt
  closedAt
  updatedAt
  issueType { id name }
  assignees(first: 1) { nodes { login avatarUrl } }
  subIssues(first: ${SUB_ISSUE_CAP}) { totalCount nodes { number title state } }
`;

export const GITHUB_MILESTONE_ISSUES_QUERY = /* GraphQL */ `
  query LimnSprintMilestoneIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      milestone(number: $number) {
        issues(states: OPEN, first: ${PAGE}, after: $after) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

export const GITHUB_FALLBACK_ISSUES_QUERY = /* GraphQL */ `
  query LimnSprintFallbackIssues($owner: String!, $name: String!, $since: DateTime!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, filterBy: { since: $since }, first: ${PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

type GqlIssue = Parameters<typeof toFetchedTicket>[1] & { updatedAt?: string | null };

interface IssuePage {
  nodes?: Array<GqlIssue | null> | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
}

interface Milestone {
  title: string;
  dueOn: string | null;
  number: number;
}

const DAY_MS = 86_400_000;

const isoDate = (s: string | null | undefined): Date | null => {
  if (s == null) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function splitRepo(full: string): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full.trim());
  return m == null ? null : { owner: m[1]!, name: m[2]! };
}

/**
 * The milestone to read: the nearest due date on or after today (UTC day), then undated ones; an
 * overdue milestone is never picked. Ties keep the first repo's. Exported for its test.
 */
export function pickMilestone(
  byRepo: ReadonlyArray<{ repo: string; milestones: readonly Milestone[] }>,
  nowMs: number,
): { title: string; dueOn: string | null } | null {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  let best: { title: string; dueOn: string | null; at: number } | null = null;
  for (const r of byRepo) {
    for (const m of r.milestones) {
      const due = isoDate(m.dueOn);
      if (due != null && due.getTime() < today) continue;
      const at = due != null ? due.getTime() : Number.POSITIVE_INFINITY;
      if (best == null || at < best.at) best = { title: m.title, dueOn: due != null ? m.dueOn : null, at };
    }
  }
  return best == null ? null : { title: best.title, dueOn: best.dueOn };
}

export function toGithubSprintTicket(repo: string, issue: GqlIssue, sprintName: string | null): SprintFetchedTicket | null {
  if (typeof issue.number !== 'number') return null;
  const key = `${repo.toLowerCase()}#${issue.number}`;
  return {
    ...toFetchedTicket(key, issue),
    url: issue.url != null && /^https:\/\//i.test(issue.url) ? issue.url : null,
    projectKey: repo.toLowerCase(),
    epic: null,
    components: null,
    sprintName,
    issueUpdatedAt: isoDate(issue.updatedAt),
  };
}

async function readPages(
  gh: GithubCallAccess,
  repo: string,
  query: string,
  vars: Record<string, unknown>,
  pick: (data: unknown) => IssuePage | null | undefined,
  sprintName: string | null,
  into: { tickets: SprintFetchedTicket[]; truncated: boolean },
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const { data } = await githubGraphql<{ rateLimit?: { remaining?: number | null; resetAt?: string | null } | null }>(
      gh,
      query,
      { ...vars, after },
    );
    noteGithubBudget(gh.accountId, data?.rateLimit);
    const page = pick(data);
    for (const n of page?.nodes ?? []) {
      if (n == null) continue;
      if (into.tickets.length >= SPRINT_TICKETS_MAX) {
        into.truncated = true;
        return;
      }
      const t = toGithubSprintTicket(repo, n, sprintName);
      if (t != null) into.tickets.push(t);
    }
    const next = page?.pageInfo?.hasNextPage === true ? (page.pageInfo.endCursor ?? null) : null;
    if (next == null) return;
    if (into.tickets.length >= SPRINT_TICKETS_MAX) {
      into.truncated = true;
      return;
    }
    after = next;
  }
}

export function makeGithubLister(now: () => number = Date.now): SprintLister {
  return async (a): Promise<SprintListResult> => {
    const gh = a.call.github;
    if (gh == null) throw new JiraFetchError('unauthorized');
    const repos = a.repos.map((r) => ({ full: r, parts: splitRepo(r) })).filter((r) => r.parts != null);
    if (repos.length === 0) throw new JiraFetchError('not_found');
    const cut = repos.length > SPRINT_GITHUB_REPOS_MAX;
    const read = repos.slice(0, SPRINT_GITHUB_REPOS_MAX);
    const byRepo: Array<{ repo: string; owner: string; name: string; milestones: Milestone[] }> = [];
    for (const r of read) {
      const { data } = await githubGraphql<{
        repository?: { milestones?: { nodes?: Array<Partial<Milestone> | null> | null } | null } | null;
        rateLimit?: { remaining?: number | null; resetAt?: string | null } | null;
      }>(gh, GITHUB_MILESTONES_QUERY, { owner: r.parts!.owner, name: r.parts!.name });
      noteGithubBudget(gh.accountId, data?.rateLimit);
      const milestones = (data?.repository?.milestones?.nodes ?? []).flatMap((m) =>
        m != null && typeof m.title === 'string' && typeof m.number === 'number'
          ? [{ title: m.title.trim().slice(0, 200), dueOn: m.dueOn ?? null, number: m.number }]
          : [],
      );
      byRepo.push({ repo: r.full, owner: r.parts!.owner, name: r.parts!.name, milestones });
    }
    const into = { tickets: [] as SprintFetchedTicket[], truncated: false };
    const pick = pickMilestone(byRepo, now());
    if (pick != null) {
      const inRepos: string[] = [];
      for (const r of byRepo) {
        const m = r.milestones.find((x) => x.title === pick.title);
        if (m == null) continue;
        inRepos.push(r.repo);
        await readPages(
          gh,
          r.repo,
          GITHUB_MILESTONE_ISSUES_QUERY,
          { owner: r.owner, name: r.name, number: m.number },
          (d) => (d as { repository?: { milestone?: { issues?: IssuePage | null } | null } | null } | null)?.repository?.milestone?.issues,
          pick.title,
          into,
        );
        if (into.truncated) break;
      }
      return {
        source: { kind: 'milestone', provider: 'github', name: pick.title, dueOn: pick.dueOn, repos: inRepos },
        tickets: into.tickets,
        truncated: into.truncated || cut,
      };
    }
    for (const r of byRepo) {
      await readPages(
        gh,
        r.repo,
        GITHUB_FALLBACK_ISSUES_QUERY,
        { owner: r.owner, name: r.name, since: new Date(a.fallbackWindow.fromMs).toISOString() },
        (d) => (d as { repository?: { issues?: IssuePage | null } | null } | null)?.repository?.issues,
        null,
        into,
      );
      if (into.truncated) break;
    }
    return {
      source: {
        kind: 'status_fallback',
        provider: 'github',
        reason: 'none_active',
        from: new Date(a.fallbackWindow.fromMs).toISOString(),
        to: new Date(a.fallbackWindow.toMs).toISOString(),
      },
      tickets: into.tickets,
      truncated: into.truncated || cut,
    };
  };
}

export const listGithubMilestone: SprintLister = makeGithubLister();


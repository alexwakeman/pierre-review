import { SPRINT_TICKETS_MAX, type GithubProjectsAccess } from '@pierre-review/shared';
import { isRateLimitError } from '../../github/client.js';
import { isBudgetLow, noteLimited } from '../../github/rate-budget.js';
import { JiraFetchError } from '../jira/fetch.js';
import { githubGraphql, noteGithubBudget, SUB_ISSUE_CAP, githubStatusOrder, toFetchedTicket } from '../github/reader.js';
import type { GithubCallAccess } from '../types.js';
import type { SprintFetchedTicket, SprintListDates, SprintListResult, SprintLister } from './types.js';

// GITHUB ISSUES — THE SPRINT LIST (docs/TRACKERS.md § The sprint list read). Three sources, in order:
//
// 1. A GITHUB PROJECTS (v2) ITERATION (§ GitHub Projects iterations): the CURRENT iteration (its
//    start..start + duration holds today) of an iteration field on a project this workspace's issues
//    belong to — the one holding the most of the scanned issues when several are current. Its tickets
//    are the project's items in that iteration that are issues in THIS workspace's repos (never another
//    workspace's), open or closed; its dates are the iteration's. Projects need `read:project`, which
//    `gh` does not grant by default: a missing scope, FORBIDDEN or NOT_FOUND falls back SILENTLY to
//    (2), and a missing scope is noted on the source (`projectsAccess: 'needs_scope'`) for ONE line.
// 2. A MILESTONE: the open milestone with the NEAREST due date (today or later) across the
//    workspace's repos; an undated one ranks after every dated one, and an overdue one is not
//    picked. Its open issues are read in EVERY repo with an open milestone of the same title (a team
//    that names one milestone per repo for the same release reads as one list).
// 3. No open milestone → the status fallback (`none_active`): open issues updated in the window.
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

export function splitRepo(full: string): { owner: string; name: string } | null {
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

/** A milestone's dates: its due date as the end, no start. null when it has no due date. Pure. */
export function milestoneDates(dueOn: string | null): SprintListDates | null {
  const end = isoDate(dueOn);
  return end == null ? null : { startsAt: null, endsAt: end };
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

// ── GitHub Projects iterations ────────────────────────────────────────────────────────────────────

/** Issues scanned per repo for their project iterations (one page, most recently updated first). */
export const SPRINT_ITERATION_SCAN_ISSUES = 50;
/** Projects looked at per scanned issue. */
export const SPRINT_ITERATION_PROJECTS_PER_ISSUE = 5;
/** Items of the picked project read per pass at most (pages of `ITEM_PAGE`); more → `truncated`. */
export const SPRINT_ITERATION_ITEMS_MAX = 500;
const ITEM_PAGE = 50;

export const GITHUB_ITERATION_SCAN_QUERY = /* GraphQL */ `
  query LimnSprintIterationScan($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issues(first: ${SPRINT_ITERATION_SCAN_ISSUES}, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          projectItems(first: ${SPRINT_ITERATION_PROJECTS_PER_ISSUE}, includeArchived: false) {
            nodes {
              project { id title closed }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldIterationValue {
                    iterationId
                    title
                    startDate
                    duration
                    field { ... on ProjectV2IterationField { id name } }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

export const GITHUB_ITERATION_ITEMS_QUERY = /* GraphQL */ `
  query LimnSprintIterationItems($project: ID!, $field: String!, $after: String) {
    node(id: $project) {
      ... on ProjectV2 {
        items(first: ${ITEM_PAGE}, after: $after) {
          nodes {
            isArchived
            fieldValueByName(name: $field) { ... on ProjectV2ItemFieldIterationValue { iterationId } }
            content { ... on Issue { ${ISSUE_FIELDS} repository { nameWithOwner } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

/** One current-or-not iteration value seen on a scanned issue. */
export interface IterationSighting {
  /** `owner/name#number` — counted once per candidate. */
  issue: string;
  projectId: string;
  projectTitle: string;
  fieldId: string;
  fieldName: string;
  iterationId: string;
  title: string;
  /** GitHub's YYYY-MM-DD. */
  startDate: string;
  /** Days. */
  duration: number;
}

export interface PickedIteration {
  projectId: string;
  projectTitle: string;
  fieldName: string;
  iterationId: string;
  title: string;
  startsAt: Date;
  /** The day AFTER the last (exclusive, midnight UTC). */
  endsAt: Date;
  /** Distinct scanned issues in it. */
  count: number;
}

/** An iteration's [start, end) in ms, or null for a malformed date / duration. Pure. */
export function iterationSpan(startDate: string, duration: number): { startMs: number; endMs: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isInteger(duration) || duration <= 0) return null;
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(startMs)) return null;
  return { startMs, endMs: startMs + duration * DAY_MS };
}

/**
 * The CURRENT iteration to read: among the sightings whose [start, start + duration) holds today (UTC
 * day), the one seen on the most distinct issues; ties go to the earliest start, then the first seen.
 * Null when none is current. Exported for its test. Pure.
 */
export function pickIteration(sightings: readonly IterationSighting[], nowMs: number): PickedIteration | null {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const byKey = new Map<string, { s: IterationSighting; startMs: number; endMs: number; issues: Set<string>; order: number }>();
  for (const s of sightings) {
    const span = iterationSpan(s.startDate, s.duration);
    if (span == null || span.startMs > today || today >= span.endMs) continue;
    const key = `${s.projectId}\u0000${s.fieldId}\u0000${s.iterationId}`;
    const hit = byKey.get(key) ?? { s, ...span, issues: new Set<string>(), order: byKey.size };
    hit.issues.add(s.issue);
    byKey.set(key, hit);
  }
  let best: { s: IterationSighting; startMs: number; endMs: number; issues: Set<string>; order: number } | null = null;
  for (const c of byKey.values()) {
    if (
      best == null ||
      c.issues.size > best.issues.size ||
      (c.issues.size === best.issues.size && (c.startMs < best.startMs || (c.startMs === best.startMs && c.order < best.order)))
    )
      best = c;
  }
  if (best == null) return null;
  return {
    projectId: best.s.projectId,
    projectTitle: best.s.projectTitle,
    fieldName: best.s.fieldName,
    iterationId: best.s.iterationId,
    title: best.s.title,
    startsAt: new Date(best.startMs),
    endsAt: new Date(best.endMs),
    count: best.issues.size,
  };
}

const errorTypesOf = (errors: unknown): string[] =>
  Array.isArray(errors) ? errors.map((e) => String((e as { type?: unknown })?.type ?? '')) : [];

/** A GraphQL error list that says the token lacks a scope (GitHub's INSUFFICIENT_SCOPES, or a message
 *  naming `read:project`). Pure. */
export function isMissingScope(errors: unknown): boolean {
  if (errorTypesOf(errors).includes('INSUFFICIENT_SCOPES')) return true;
  return Array.isArray(errors) && errors.some((e) => /read:project/i.test(String((e as { message?: unknown })?.message ?? '')));
}

/**
 * One Projects call. Like `githubGraphql` (the budget pre-emption, a rate limit → 429, a refused token →
 * `unauthorized`), except that a GraphQL refusal GitHub THROWS (no data: a missing scope, FORBIDDEN,
 * NOT_FOUND, an HTTP 403 / 404) comes back as `errors`, so the caller can fall back to milestones and
 * keep the reason. Anything else is transient and fails the read (its last good list stays).
 */
export async function projectsGraphql<T>(
  gh: GithubCallAccess,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T | null; errors: unknown }> {
  if (isBudgetLow(gh.accountId)) throw new JiraFetchError('http', 429);
  let res: { data: T | null; errors?: unknown };
  try {
    res = await gh.graphql<T>(query, variables);
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited) {
      noteLimited(gh.accountId, rl.resumeAt);
      throw new JiraFetchError('http', 429);
    }
    const status = (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 401) throw new JiraFetchError('unauthorized', 401);
    const errors = (err as { errors?: unknown })?.errors;
    if (Array.isArray(errors) && errors.length > 0) return { data: null, errors };
    if (status === 403) return { data: null, errors: [{ type: 'FORBIDDEN' }] };
    if (status === 404) return { data: null, errors: [{ type: 'NOT_FOUND' }] };
    throw new JiraFetchError('network');
  }
  if (errorTypesOf(res.errors).includes('RATE_LIMITED')) {
    noteLimited(gh.accountId, null);
    throw new JiraFetchError('http', 429);
  }
  return { data: res.data ?? null, errors: res.errors };
}

export interface ScanData {
  repository?: {
    issues?: {
      nodes?: Array<{
        number?: number | null;
        projectItems?: {
          nodes?: Array<{
            project?: { id?: string | null; title?: string | null; closed?: boolean | null } | null;
            fieldValues?: {
              nodes?: Array<{
                iterationId?: string | null;
                title?: string | null;
                startDate?: string | null;
                duration?: number | null;
                field?: { id?: string | null; name?: string | null } | null;
              } | null> | null;
            } | null;
          } | null> | null;
        } | null;
      } | null> | null;
    } | null;
  } | null;
  rateLimit?: { remaining?: number | null; resetAt?: string | null } | null;
}

/** A scan answer → its iteration sightings (closed projects and malformed values dropped). Pure. */
export function sightingsOf(repo: string, data: ScanData | null): IterationSighting[] {
  const out: IterationSighting[] = [];
  for (const issue of data?.repository?.issues?.nodes ?? []) {
    if (issue == null || typeof issue.number !== 'number') continue;
    for (const item of issue.projectItems?.nodes ?? []) {
      const p = item?.project;
      if (p == null || typeof p.id !== 'string' || p.closed === true) continue;
      for (const v of item?.fieldValues?.nodes ?? []) {
        if (v == null || typeof v.iterationId !== 'string' || typeof v.startDate !== 'string' || typeof v.duration !== 'number') continue;
        const fieldId = v.field?.id;
        const fieldName = v.field?.name;
        if (typeof fieldId !== 'string' || typeof fieldName !== 'string' || fieldName.trim() === '') continue;
        out.push({
          issue: `${repo.toLowerCase()}#${issue.number}`,
          projectId: p.id,
          projectTitle: (p.title ?? '').trim().slice(0, 200),
          fieldId,
          fieldName,
          iterationId: v.iterationId,
          title: (v.title ?? '').trim().slice(0, 200),
          startDate: v.startDate,
          duration: v.duration,
        });
      }
    }
  }
  return out;
}

interface ItemsData {
  node?: {
    items?: {
      nodes?: Array<{
        isArchived?: boolean | null;
        fieldValueByName?: { iterationId?: string | null } | null;
        content?: (GqlIssue & { repository?: { nameWithOwner?: string | null } | null }) | null;
      } | null> | null;
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    } | null;
  } | null;
  rateLimit?: { remaining?: number | null; resetAt?: string | null } | null;
}

/** What the iteration path found: a list to store, or why it fell back (null = nothing current). */
type IterationOutcome =
  | { kind: 'list'; result: SprintListResult }
  | { kind: 'fallback'; access: GithubProjectsAccess | null };

async function readIteration(
  gh: GithubCallAccess,
  repos: ReadonlyArray<{ repo: string; owner: string; name: string }>,
  cut: boolean,
  nowMs: number,
): Promise<IterationOutcome> {
  // 1. THE SCAN: the most recently updated issues of each repo, with the iterations they sit in.
  const sightings: IterationSighting[] = [];
  for (const r of repos) {
    const { data, errors } = await projectsGraphql<ScanData>(gh, GITHUB_ITERATION_SCAN_QUERY, { owner: r.owner, name: r.name });
    noteGithubBudget(gh.accountId, data?.rateLimit);
    // The token cannot read Projects at all: every repo would say the same — stop, say why once.
    if (isMissingScope(errors)) return { kind: 'fallback', access: 'needs_scope' };
    // FORBIDDEN / NOT_FOUND (an SSO wall, a project this login cannot see): keep what did come back.
    sightings.push(...sightingsOf(r.repo, data));
  }
  const pick = pickIteration(sightings, nowMs);
  if (pick == null) return { kind: 'fallback', access: null };

  // 2. THE ITEMS of the picked project in that iteration — issues in THIS workspace's repos only.
  const inWorkspace = new Map(repos.map((r) => [r.repo.toLowerCase(), r.repo] as const));
  const tickets: SprintFetchedTicket[] = [];
  const seen = new Set<string>();
  const contributing = new Set<string>();
  let truncated = false;
  let after: string | null = null;
  let scanned = 0;
  for (;;) {
    const answer: { data: ItemsData | null; errors: unknown } = await projectsGraphql<ItemsData>(gh, GITHUB_ITERATION_ITEMS_QUERY, {
      project: pick.projectId,
      field: pick.fieldName,
      after,
    });
    const { data, errors } = answer;
    noteGithubBudget(gh.accountId, data?.rateLimit);
    const items: NonNullable<ItemsData['node']>['items'] = data?.node?.items;
    if (items == null) {
      // Refused after the scan saw it (a scope or SSO change between calls): milestones, silently.
      return { kind: 'fallback', access: isMissingScope(errors) ? 'needs_scope' : null };
    }
    for (const it of items.nodes ?? []) {
      scanned += 1;
      if (it == null || it.isArchived === true || it.fieldValueByName?.iterationId !== pick.iterationId) continue;
      const c = it.content;
      const repo = c?.repository?.nameWithOwner != null ? inWorkspace.get(c.repository.nameWithOwner.toLowerCase()) : undefined;
      if (c == null || repo == null) continue;
      if (tickets.length >= SPRINT_TICKETS_MAX) {
        truncated = true;
        break;
      }
      const t = toGithubSprintTicket(repo, c, pick.title);
      if (t == null || seen.has(t.key)) continue;
      seen.add(t.key);
      contributing.add(repo);
      tickets.push(t);
    }
    if (truncated) break;
    const next: string | null = items.pageInfo?.hasNextPage === true ? (items.pageInfo.endCursor ?? null) : null;
    if (next == null) break;
    if (scanned >= SPRINT_ITERATION_ITEMS_MAX) {
      truncated = true;
      break;
    }
    after = next;
  }
  // Nothing of this workspace's left in it (every item archived, moved, or in another repo): milestones.
  if (tickets.length === 0 && !truncated) return { kind: 'fallback', access: null };
  return {
    kind: 'list',
    result: {
      source: {
        kind: 'iteration',
        provider: 'github',
        name: pick.title,
        project: pick.projectTitle,
        field: pick.fieldName,
        startsOn: pick.startsAt.toISOString().slice(0, 10),
        endsOn: pick.endsAt.toISOString().slice(0, 10),
        repos: repos.filter((r) => contributing.has(r.repo)).map((r) => r.repo),
      },
      tickets,
      truncated: truncated || cut,
      statusOrder: githubStatusOrder(new Date().toISOString()),
      dates: { startsAt: pick.startsAt, endsAt: pick.endsAt },
    },
  };
}

export function makeGithubLister(now: () => number = Date.now): SprintLister {
  return async (a): Promise<SprintListResult> => {
    const gh = a.call.github;
    if (gh == null) throw new JiraFetchError('unauthorized');
    const repos = a.repos.map((r) => ({ full: r, parts: splitRepo(r) })).filter((r) => r.parts != null);
    if (repos.length === 0) throw new JiraFetchError('not_found');
    const cut = repos.length > SPRINT_GITHUB_REPOS_MAX;
    const read = repos.slice(0, SPRINT_GITHUB_REPOS_MAX);
    const nowMs = now();
    const iteration = await readIteration(
      gh,
      read.map((r) => ({ repo: r.full, owner: r.parts!.owner, name: r.parts!.name })),
      cut,
      nowMs,
    );
    if (iteration.kind === 'list') return iteration.result;
    const note = iteration.access != null ? { projectsAccess: iteration.access } : {};
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
    const pick = pickMilestone(byRepo, nowMs);
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
        source: { kind: 'milestone', provider: 'github', name: pick.title, dueOn: pick.dueOn, repos: inRepos, ...note },
        tickets: into.tickets,
        truncated: into.truncated || cut,
        statusOrder: githubStatusOrder(new Date().toISOString()),
        // A milestone has a due date and no start: the end only.
        dates: milestoneDates(pick.dueOn),
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
        ...note,
      },
      tickets: into.tickets,
      truncated: into.truncated || cut,
      statusOrder: githubStatusOrder(new Date().toISOString()),
    };
  };
}

export const listGithubMilestone: SprintLister = makeGithubLister();


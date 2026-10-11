import {
  linearSiteRoot,
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_TICKETS_MAX,
  type SprintStatusAutoOrder,
} from '@pierre-review/shared';
import { normalizePrefixKey } from '../detect.js';
import { JiraFetchError } from '../jira/fetch.js';
import { linearCategory, linearGraphql, linearRelationsSelection, toLinearTicket } from '../linear/client.js';
import type { SprintFetchedTicket, SprintListArgs, SprintListResult, SprintLister } from './types.js';

// LINEAR — THE SPRINT LIST (docs/TRACKERS.md § The sprint list read). Linear's sprint is the team's
// ACTIVE CYCLE. The teams are those whose keys were seen on this workspace's stored tickets.
//
//   • ONE cheap query lists the teams (cycles on? which cycle is active? their workflow states), then
//     ONE paged query per active cycle reads its issues — per team, so no single query nears Linear's
//     10,000-point cap (50 issues × (10 children + 20 labels + 10 inverse relations with their issue
//     and state) ≈ 3,600 points a page). The relations cap is 10 here (20 on the one-issue read)
//     to keep the page at 50.
//   • THE STATUS ORDER: the teams' workflow states — by category (triage/backlog/unstarted →
//     started → completed/canceled), then Linear's `position`; several teams concatenate in the
//     teams' order, deduped by name (docs/TRACKERS.md § The status order).
//   • No team with cycles switched on → the status fallback, `no_sprint_concept`; none active →
//     `none_active`. The fallback is the teams' unstarted + started issues updated in the window.
//   • Each issue folds through the SAME `toLinearTicket` the one-ticket reader uses. ⚠ An issue whose
//     URL is not under the workspace's Linear root is dropped (a key for another Linear workspace),
//     and a list that is ONLY such issues is the reader's `bad_url` — a settings problem.

const PAGE = 50;
const CHILD_CAP = 10;
const RELATIONS_CAP = 10;

const ISSUE_FIELDS = /* GraphQL */ `
  identifier
  title
  description
  url
  createdAt
  completedAt
  updatedAt
  state { id name type }
  assignee { id name displayName avatarUrl }
  project { name }
  parent { identifier title }
  labels(first: 20) { nodes { name } }
  children(first: ${CHILD_CAP}) {
    nodes { identifier title state { type } }
    pageInfo { hasNextPage }
  }
  ${linearRelationsSelection(RELATIONS_CAP)}
`;

export const LINEAR_TEAMS_QUERY = /* GraphQL */ `
  query LimnLinearSprintTeams($keys: [String!]!) {
    teams(filter: { key: { in: $keys } }, first: 50) {
      nodes { id key cyclesEnabled activeCycle { id name number } states(first: 50) { nodes { id name type position } } }
    }
  }
`;

export const LINEAR_CYCLE_ISSUES_QUERY = /* GraphQL */ `
  query LimnLinearCycleIssues($id: String!, $after: String) {
    cycle(id: $id) {
      issues(first: ${PAGE}, after: $after) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const LINEAR_FALLBACK_QUERY = /* GraphQL */ `
  query LimnLinearSprintFallback($keys: [String!]!, $from: DateTimeOrDuration!, $after: String) {
    issues(
      filter: { team: { key: { in: $keys } }, state: { type: { in: ["unstarted", "started"] } }, updatedAt: { gte: $from } }
      first: ${PAGE}
      after: $after
      orderBy: updatedAt
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type GqlIssue = Parameters<typeof toLinearTicket>[1] & {
  updatedAt?: string | null;
  parent?: { identifier?: string | null; title?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
};

interface IssuePage {
  nodes?: Array<GqlIssue | null> | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
}

export interface Team {
  id?: string | null;
  key?: string | null;
  cyclesEnabled?: boolean | null;
  activeCycle?: { id?: string | null; name?: string | null; number?: number | null } | null;
  states?: { nodes?: Array<{ id?: string | null; name?: string | null; type?: string | null; position?: number | null } | null> | null } | null;
}

const TYPE_RANK: Record<string, number> = { triage: 0, backlog: 0, unstarted: 0, started: 1, completed: 2, canceled: 2 };

/** The teams' workflow states as a status order: per team by category then `position`, teams
 *  concatenated in the given order, names deduped case-insensitively. null when no team has states.
 *  Pure; exported for its test. */
export function linearStatesOrder(teams: readonly Team[], readAt: string): SprintStatusAutoOrder | null {
  const statuses: SprintStatusAutoOrder['statuses'] = [];
  const names = new Set<string>();
  for (const t of teams) {
    const states = (t.states?.nodes ?? [])
      .filter((s): s is NonNullable<typeof s> => s != null && (s.name ?? '').trim() !== '')
      .map((s, i) => ({ s, i }))
      .sort(
        (a, b) =>
          (TYPE_RANK[(a.s.type ?? '').toLowerCase()] ?? 1) - (TYPE_RANK[(b.s.type ?? '').toLowerCase()] ?? 1) ||
          (a.s.position ?? 0) - (b.s.position ?? 0) ||
          a.i - b.i,
      );
    for (const { s } of states) {
      const name = (s.name ?? '').trim().slice(0, SPRINT_STATUS_NAME_MAX);
      if (names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      statuses.push({ id: typeof s.id === 'string' && s.id !== '' ? s.id : null, name, category: linearCategory(s.type) });
      if (statuses.length >= SPRINT_STATUS_ORDER_MAX) break;
    }
    if (statuses.length >= SPRINT_STATUS_ORDER_MAX) break;
  }
  return statuses.length > 0 ? { source: 'linear_states', statuses, readAt } : null;
}

const isoDate = (s: string | null | undefined): Date | null => {
  if (s == null) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** One issue node → the stored sprint ticket, or null when it is not this Linear workspace's. */
export function toLinearSprintTicket(issue: GqlIssue, apiRoot: string, sprintName: string | null): SprintFetchedTicket | null {
  const key = normalizePrefixKey(issue.identifier ?? '');
  if (key == null) return null;
  if (linearSiteRoot(issue.url) !== apiRoot) return null;
  const base = toLinearTicket(key, issue);
  const parentKey = normalizePrefixKey(issue.parent?.identifier ?? '');
  const labels = (issue.labels?.nodes ?? [])
    .map((l) => (l?.name ?? '').trim())
    .filter((n) => n !== '')
    .map((n) => n.slice(0, 100));
  return {
    ...base,
    projectKey: key.split('-')[0]!,
    epic: parentKey != null ? { key: parentKey, title: (issue.parent?.title ?? '').trim().slice(0, 300) || null } : null,
    components: labels,
    sprintName,
    issueUpdatedAt: isoDate(issue.updatedAt),
  };
}

async function readPages(
  a: SprintListArgs,
  query: string,
  vars: Record<string, unknown>,
  pick: (data: unknown) => IssuePage | null | undefined,
  sprintName: string | null,
  into: { tickets: SprintFetchedTicket[]; foreign: number; truncated: boolean },
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const { data } = await linearGraphql<unknown>(a.call, query, { ...vars, after });
    const page = pick(data);
    for (const n of page?.nodes ?? []) {
      if (n == null) continue;
      if (into.tickets.length >= SPRINT_TICKETS_MAX) {
        into.truncated = true;
        return;
      }
      const t = toLinearSprintTicket(n, a.call.apiRoot, sprintName);
      if (t == null) into.foreign += 1;
      else into.tickets.push(t);
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

function noneOurs(into: { tickets: SprintFetchedTicket[]; foreign: number }): boolean {
  return into.tickets.length === 0 && into.foreign > 0;
}

export const listLinearCycle: SprintLister = async (a): Promise<SprintListResult> => {
  const keys = a.projectKeys.filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k));
  if (keys.length === 0) throw new JiraFetchError('not_found');
  const { data } = await linearGraphql<{ teams?: { nodes?: Array<Team | null> | null } | null }>(a.call, LINEAR_TEAMS_QUERY, {
    keys,
  });
  const teams = (data?.teams?.nodes ?? []).filter((t): t is Team => t != null);
  const active = teams.filter((t) => t.cyclesEnabled === true && t.activeCycle?.id != null);
  const reason = teams.some((t) => t.cyclesEnabled === true) ? 'none_active' : 'no_sprint_concept';
  // The active-cycle teams first (their tickets are the page), then the rest.
  const statusOrder = linearStatesOrder([...active, ...teams.filter((t) => !active.includes(t))], new Date().toISOString());
  const into = { tickets: [] as SprintFetchedTicket[], foreign: 0, truncated: false };
  if (active.length > 0) {
    const names: string[] = [];
    for (const t of active) {
      const c = t.activeCycle!;
      const name = (c.name ?? '').trim() || `Cycle ${c.number ?? ''}`.trim();
      if (!names.includes(name)) names.push(name);
      await readPages(
        a,
        LINEAR_CYCLE_ISSUES_QUERY,
        { id: c.id },
        (d) => (d as { cycle?: { issues?: IssuePage | null } | null } | null)?.cycle?.issues,
        name,
        into,
      );
      if (into.truncated) break;
    }
    if (noneOurs(into)) throw new JiraFetchError('bad_url');
    if (into.tickets.length > 0) {
      return { source: { kind: 'cycle', provider: 'linear', names }, tickets: into.tickets, truncated: into.truncated, statusOrder };
    }
  }
  await readPages(
    a,
    LINEAR_FALLBACK_QUERY,
    { keys, from: new Date(a.fallbackWindow.fromMs).toISOString() },
    (d) => (d as { issues?: IssuePage | null } | null)?.issues,
    null,
    into,
  );
  if (noneOurs(into)) throw new JiraFetchError('bad_url');
  return {
    source: {
      kind: 'status_fallback',
      provider: 'linear',
      reason: active.length > 0 ? 'none_active' : reason,
      from: new Date(a.fallbackWindow.fromMs).toISOString(),
      to: new Date(a.fallbackWindow.toMs).toISOString(),
    },
    tickets: into.tickets,
    truncated: into.truncated,
    statusOrder,
  };
};

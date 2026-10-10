import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import { extractAcCandidates } from '../jira/candidates.js';
import { assigneeOf, isTicketKey, jiraAuthHeader, statusOf } from '../jira/client.js';
import { JiraFetchError, jiraGetJson } from '../jira/fetch.js';
import { fieldValueToText, jiraWikiToMarkdown } from '../jira/text.js';
import { ticketDateFields, trackerDate } from '../dates.js';
import type { SprintFetchedTicket, SprintListArgs, SprintListResult, SprintLister } from './types.js';

// JIRA — THE SPRINT LIST (docs/TRACKERS.md § The sprint list read).
//
//   • `GET /rest/api/3/search/jql` (the enhanced search; `nextPageToken` paging) through the ONE
//     outbound helper, `jiraGetJson` — never a bare fetch. A Server / Data Center site has no v3
//     search (404), so the same JQL is retried ONCE on `/rest/api/2/search` (`startAt` paging).
//   • JQL `project in (<keys>) AND sprint in openSprints()`, the keys being the projects seen on this
//     workspace's stored tickets. Jira answers 400 when the site has no sprint field (no Jira
//     Software) → the status fallback, `no_sprint_concept`; no issues → `none_active`.
//   • Each issue is read with `fields=*all&expand=names,schema` and folded by the SAME pieces the
//     one-ticket reader uses (candidates, status, assignee, the workspace's criteria field), so a
//     ticket reads the same here as on a pull request.

const PAGE = 100;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A project key safe to quote into JQL. */
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;

export function sprintJql(projectKeys: readonly string[]): string {
  return `${projectClause(projectKeys)} AND sprint in openSprints() ORDER BY rank`;
}

/**
 * To do + In progress tickets touched since `fromMs`. ⚠ A RELATIVE duration (`-NNNm`), never a date
 * literal: Jira reads a JQL date literal in the token owner's PROFILE time zone, so a UTC literal
 * moved the window by up to ±14 hours.
 */
export function fallbackJql(projectKeys: readonly string[], fromMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((nowMs - fromMs) / 60_000));
  return `${projectClause(projectKeys)} AND statusCategory in ("To Do","In Progress") AND updated >= -${minutes}m ORDER BY updated DESC`;
}

function projectClause(keys: readonly string[]): string {
  const safe = keys.filter((k) => PROJECT_KEY_RE.test(k));
  if (safe.length === 0) throw new JiraFetchError('not_found');
  return `project in (${safe.map((k) => `"${k}"`).join(',')})`;
}

// ---- the sprint field ----

const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const EPIC_LINK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-link';

function fieldIdsBySchema(schema: Record<string, unknown> | undefined, names: Record<string, unknown> | undefined) {
  let sprint: string | null = null;
  let epicLink: string | null = null;
  for (const [id, s] of Object.entries(schema ?? {})) {
    const custom = asRecord(s)?.custom;
    if (custom === SPRINT_SCHEMA && sprint == null) sprint = id;
    if (custom === EPIC_LINK_SCHEMA && epicLink == null) epicLink = id;
  }
  for (const [id, n] of Object.entries(names ?? {})) {
    if (sprint == null && n === 'Sprint') sprint = id;
    if (epicLink == null && n === 'Epic Link') epicLink = id;
  }
  return { sprint, epicLink };
}

/** A sprint field value → its sprints. Cloud sends objects; old Server sends `…Sprint@x[id=1,state=ACTIVE,name=S 1,…]`. */
export function sprintsOf(raw: unknown): Array<{ name: string; state: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; state: string }> = [];
  for (const v of raw) {
    const o = asRecord(v);
    if (o != null) {
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (name !== '') out.push({ name: name.slice(0, 200), state: String(o.state ?? '').toLowerCase() });
      continue;
    }
    if (typeof v === 'string') {
      const name = /[[,]name=([^,\]]*)/.exec(v)?.[1]?.trim() ?? '';
      const state = /[[,]state=([^,\]]*)/.exec(v)?.[1]?.trim().toLowerCase() ?? '';
      if (name !== '') out.push({ name: name.slice(0, 200), state });
    }
  }
  return out;
}

// ---- one issue ----

/** One search hit → the stored sprint ticket. Exported for its test. */
export function toJiraSprintTicket(
  raw: unknown,
  names: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | undefined,
  inSprint: boolean,
): SprintFetchedTicket | null {
  const o = asRecord(raw);
  const f = asRecord(o?.fields);
  const key = typeof o?.key === 'string' ? o.key : '';
  if (o == null || f == null || !isTicketKey(key)) return null;
  // `expand=names,schema` is top-level on the search answer; an issue may also carry its own.
  const n = asRecord(o.names) ?? names;
  const s = asRecord(o.schema) ?? schema;
  const it = asRecord(f.issuetype);
  const issueType = it && typeof it.id === 'string' && typeof it.name === 'string' ? { id: it.id, name: it.name } : null;
  const { candidates, omitted } = extractAcCandidates(f, n, s);
  const ids = fieldIdsBySchema(s, n);
  const active = ids.sprint != null ? sprintsOf(f[ids.sprint]).filter((x) => x.state === 'active') : [];
  const parent = asRecord(f.parent);
  const parentFields = asRecord(parent?.fields);
  const parentType = asRecord(parentFields?.issuetype);
  let epic: SprintFetchedTicket['epic'] = null;
  if (parent != null && typeof parent.key === 'string' && (parentType?.name === 'Epic' || parentType?.hierarchyLevel === 1)) {
    epic = { key: parent.key, title: typeof parentFields?.summary === 'string' ? parentFields.summary.slice(0, 300) : null };
  } else if (ids.epicLink != null && typeof f[ids.epicLink] === 'string' && isTicketKey(f[ids.epicLink] as string)) {
    epic = { key: f[ids.epicLink] as string, title: null };
  }
  const components = Array.isArray(f.components)
    ? f.components
        .map((c) => asRecord(c)?.name)
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim().slice(0, 100))
        .slice(0, 20)
    : null;
  const projectKey = typeof asRecord(f.project)?.key === 'string' ? (asRecord(f.project)!.key as string) : key.split('-')[0]!;
  const updated = trackerDate(f, 'updated');
  return {
    key,
    title: fieldValueToText(f.summary),
    description:
      typeof f.description === 'string' ? jiraWikiToMarkdown(fieldValueToText(f.description)) : fieldValueToText(f.description),
    issueType,
    status: statusOf(f.status),
    assignee: assigneeOf(f.assignee),
    candidates,
    omittedCandidates: omitted,
    ...ticketDateFields({ issueCreatedAt: trackerDate(f, 'created'), issueResolvedAt: trackerDate(f, 'resolutiondate') }),
    projectKey,
    epic,
    components,
    sprintName: inSprint ? (active[0]?.name ?? null) : null,
    issueUpdatedAt: updated ?? null,
  };
}

// ---- the search ----

interface SearchPage {
  issues: unknown[];
  names: Record<string, unknown> | undefined;
  schema: Record<string, unknown> | undefined;
  next: string | number | null;
}

async function searchPage(
  a: SprintListArgs,
  jql: string,
  cursor: string | number | null,
  v2: boolean,
): Promise<SearchPage> {
  const q = new URLSearchParams({ jql, fields: '*all', expand: 'names,schema', maxResults: String(PAGE) });
  if (v2) q.set('startAt', String(typeof cursor === 'number' ? cursor : 0));
  else if (typeof cursor === 'string') q.set('nextPageToken', cursor);
  const path = v2 ? '/rest/api/2/search' : '/rest/api/3/search/jql';
  const raw = asRecord(
    await jiraGetJson(
      `${a.call.apiRoot}${path}?${q.toString()}`,
      { authorization: jiraAuthHeader(a.call.credentials) },
      a.call.policy,
      a.call.transport,
    ),
  );
  const issues = Array.isArray(raw?.issues) ? (raw!.issues as unknown[]) : [];
  let next: string | number | null = null;
  if (v2) {
    const startAt = typeof raw?.startAt === 'number' ? raw.startAt : typeof cursor === 'number' ? cursor : 0;
    const total = typeof raw?.total === 'number' ? raw.total : 0;
    if (issues.length > 0 && startAt + issues.length < total) next = startAt + issues.length;
  } else if (typeof raw?.nextPageToken === 'string' && raw.nextPageToken !== '' && raw.isLast !== true) {
    next = raw.nextPageToken;
  }
  return { issues, names: asRecord(raw?.names), schema: asRecord(raw?.schema), next };
}

/** Every page of a JQL search up to the cap. `v2` is decided by the first page (404 → v2). */
async function search(
  a: SprintListArgs,
  jql: string,
  inSprint: boolean,
): Promise<{ tickets: SprintFetchedTicket[]; truncated: boolean; names: string[] }> {
  let v2 = false;
  let first: SearchPage;
  try {
    first = await searchPage(a, jql, null, false);
  } catch (err) {
    if (!(err instanceof JiraFetchError && err.code === 'not_found')) throw err;
    v2 = true;
    first = await searchPage(a, jql, null, true);
  }
  const tickets: SprintFetchedTicket[] = [];
  const sprintNames: string[] = [];
  let page: SearchPage = first;
  let truncated = false;
  let names = first.names;
  let schema = first.schema;
  for (;;) {
    names = page.names ?? names;
    schema = page.schema ?? schema;
    for (const raw of page.issues) {
      if (tickets.length >= SPRINT_TICKETS_MAX) {
        truncated = true;
        break;
      }
      const t = toJiraSprintTicket(raw, names, schema, inSprint);
      if (t == null) continue;
      tickets.push(t);
      if (inSprint) {
        const ids = fieldIdsBySchema(asRecord(asRecord(raw)?.schema) ?? schema, asRecord(asRecord(raw)?.names) ?? names);
        const f = asRecord(asRecord(raw)?.fields);
        if (ids.sprint != null && f != null) {
          for (const sp of sprintsOf(f[ids.sprint])) {
            if (sp.state === 'active' && !sprintNames.includes(sp.name)) sprintNames.push(sp.name);
          }
        }
      }
    }
    if (truncated) break;
    if (page.next == null) break;
    if (tickets.length >= SPRINT_TICKETS_MAX) {
      truncated = true;
      break;
    }
    page = await searchPage(a, jql, page.next, v2);
  }
  return { tickets, truncated, names: sprintNames };
}

export const listJiraSprint: SprintLister = async (a): Promise<SprintListResult> => {
  let reason: 'no_sprint_concept' | 'none_active' = 'none_active';
  try {
    const r = await search(a, sprintJql(a.projectKeys), true);
    if (r.tickets.length > 0) {
      return { source: { kind: 'sprint', provider: 'jira', names: r.names }, tickets: r.tickets, truncated: r.truncated };
    }
  } catch (err) {
    // 400: the site has no sprint field (no Jira Software), so `sprint in openSprints()` is invalid.
    if (!(err instanceof JiraFetchError && err.code === 'http' && err.status === 400)) throw err;
    reason = 'no_sprint_concept';
  }
  const r = await search(a, fallbackJql(a.projectKeys, a.fallbackWindow.fromMs, Date.now()), false);
  return {
    source: {
      kind: 'status_fallback',
      provider: 'jira',
      reason,
      from: new Date(a.fallbackWindow.fromMs).toISOString(),
      to: new Date(a.fallbackWindow.toMs).toISOString(),
    },
    tickets: r.tickets,
    truncated: r.truncated,
  };
};

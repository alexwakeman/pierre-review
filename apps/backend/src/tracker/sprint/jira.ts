import {
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_TICKETS_MAX,
  type JiraStatusCategory,
  type SprintStatusAutoOrder,
} from '@pierre-review/shared';
import { extractAcCandidates } from '../jira/candidates.js';
import { assigneeOf, isTicketKey, jiraAuthHeader, linksField, statusOf } from '../jira/client.js';
import { JiraFetchError, jiraGetJson } from '../jira/fetch.js';
import { fieldValueToText, jiraWikiToMarkdown } from '../jira/text.js';
import { ticketDateFields, trackerDate } from '../dates.js';
import { busiestSprintDates, sprintDate, type SprintFetchedTicket, type SprintListArgs, type SprintListDates, type SprintListResult, type SprintLister } from './types.js';

// JIRA — THE SPRINT LIST (docs/TRACKERS.md § The sprint list read).
//
//   • `GET /rest/api/3/search/jql` (the enhanced search; `nextPageToken` paging) through the ONE
//     outbound helper, `jiraGetJson` — never a bare fetch. A Server / Data Center site has no v3
//     search (404), so the same JQL is retried ONCE on `/rest/api/2/search` (`startAt` paging).
//   • JQL `project in (<keys>) AND sprint in openSprints()`, the keys being the projects seen on this
//     workspace's stored tickets. Jira answers 400 when the site has no sprint field (no Jira
//     Software) → the status fallback, `no_sprint_concept`; no issues → `none_active`.
//   • Each issue is read with `fields=*all&expand=names,schema` and folded by the SAME pieces the
//     one-ticket reader uses (candidates, status, assignee, blocking links, the workspace's criteria
//     field), so a ticket reads the same here as on a pull request.
//   • THE STATUS ORDER (docs/TRACKERS.md § The status order): the active sprint's board (`boardId`
//     on a Cloud sprint object, `rapidViewId=` in an old Server string) holding the most tickets →
//     `GET /rest/agile/1.0/board/{id}/configuration` (columns → status ids, in column order) +
//     `GET /rest/api/2/status` (id → name + category). Two calls per list read, which is itself
//     interval-gated. A failure here never fails the list: `statusOrder` is left undefined (the
//     stored order stands) and the code is reported. The status fallback has no board → null.

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

const boardIdOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export interface JiraSprintRef {
  name: string;
  state: string;
  boardId: number | null;
  /** The sprint's planned start / end (Cloud `startDate`/`endDate`; Server `startDate=…,endDate=…`,
   *  `<null>` when unset). */
  startsAt: Date | null;
  endsAt: Date | null;
}

/** A sprint field value → its sprints (with the board each belongs to and its dates). Cloud sends
 *  objects (with `boardId`); old Server sends `…Sprint@x[id=1,rapidViewId=2,state=ACTIVE,name=S 1,
 *  startDate=2015-04-08T12:00:00.000+02:00,endDate=<null>,…]`. */
export function sprintsOf(raw: unknown): JiraSprintRef[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraSprintRef[] = [];
  for (const v of raw) {
    const o = asRecord(v);
    if (o != null) {
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (name !== '') {
        out.push({
          name: name.slice(0, 200),
          state: String(o.state ?? '').toLowerCase(),
          boardId: boardIdOf(o.boardId ?? o.originBoardId),
          startsAt: sprintDate(o.startDate),
          endsAt: sprintDate(o.endDate),
        });
      }
      continue;
    }
    if (typeof v === 'string') {
      const field = (k: string): string => new RegExp(`[[,]${k}=([^,\\]]*)`).exec(v)?.[1]?.trim() ?? '';
      const name = field('name');
      if (name !== '') {
        out.push({
          name: name.slice(0, 200),
          state: field('state').toLowerCase(),
          boardId: boardIdOf(field('rapidViewId')),
          startsAt: sprintDate(field('startDate')),
          endsAt: sprintDate(field('endDate')),
        });
      }
    }
  }
  return out;
}

// ---- the board's column order ----

const STATUS_CATEGORY_KEYS: readonly string[] = ['new', 'indeterminate', 'done'];

/** A board configuration answer → its status ids in column order (deduped). Exported for its test. */
export function boardStatusIds(raw: unknown): string[] {
  const cols = asRecord(asRecord(raw)?.columnConfig)?.columns;
  if (!Array.isArray(cols)) return [];
  const out: string[] = [];
  for (const c of cols) {
    const statuses = asRecord(c)?.statuses;
    if (!Array.isArray(statuses)) continue;
    for (const st of statuses) {
      const id = asRecord(st)?.id;
      const s = typeof id === 'string' ? id.trim() : typeof id === 'number' ? String(id) : '';
      if (s !== '' && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** `GET /rest/api/2/status` → id → name + category. Exported for its test. */
export function statusCatalog(raw: unknown): Map<string, { name: string; category: JiraStatusCategory | null }> {
  const out = new Map<string, { name: string; category: JiraStatusCategory | null }>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    const o = asRecord(r);
    const id = typeof o?.id === 'string' ? o.id.trim() : typeof o?.id === 'number' ? String(o.id) : '';
    const name = typeof o?.name === 'string' ? o.name.trim() : '';
    if (id === '' || name === '') continue;
    const key = asRecord(o?.statusCategory)?.key;
    out.set(id, {
      name: name.slice(0, SPRINT_STATUS_NAME_MAX),
      category: typeof key === 'string' && STATUS_CATEGORY_KEYS.includes(key) ? (key as JiraStatusCategory) : null,
    });
  }
  return out;
}

/** The board's columns as a status order. Ids the catalog does not know are dropped; names deduped
 *  case-insensitively; capped. null when nothing maps. Pure. */
export function jiraBoardOrder(
  ids: readonly string[],
  catalog: ReadonlyMap<string, { name: string; category: JiraStatusCategory | null }>,
  readAt: string,
): SprintStatusAutoOrder | null {
  const statuses: SprintStatusAutoOrder['statuses'] = [];
  const names = new Set<string>();
  for (const id of ids) {
    const s = catalog.get(id);
    if (s == null || names.has(s.name.toLowerCase())) continue;
    names.add(s.name.toLowerCase());
    statuses.push({ id, name: s.name, category: s.category });
    if (statuses.length >= SPRINT_STATUS_ORDER_MAX) break;
  }
  return statuses.length > 0 ? { source: 'jira_board', statuses, readAt } : null;
}

/** Read one board's order (two calls through the one outbound helper). Throws `JiraFetchError`. */
export async function readJiraBoardOrder(a: SprintListArgs, boardId: number, nowMs: number): Promise<SprintStatusAutoOrder | null> {
  const headers = { authorization: jiraAuthHeader(a.call.credentials) };
  const config = await jiraGetJson(
    `${a.call.apiRoot}/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/configuration`,
    headers,
    a.call.policy,
    a.call.transport,
  );
  const ids = boardStatusIds(config);
  if (ids.length === 0) return null;
  const catalog = statusCatalog(await jiraGetJson(`${a.call.apiRoot}/rest/api/2/status`, headers, a.call.policy, a.call.transport));
  return jiraBoardOrder(ids, catalog, new Date(nowMs).toISOString());
}

// ---- one issue ----

/** One search hit → the stored sprint ticket. Exported for its test. */
export function toJiraSprintTicket(
  raw: unknown,
  names: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | undefined,
  inSprint: boolean,
  apiRoot = '',
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
    ...linksField(f, apiRoot),
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
): Promise<{ tickets: SprintFetchedTicket[]; truncated: boolean; names: string[]; boards: Map<number, number>; dates: SprintListDates | null }> {
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
  // board id → tickets in one of its ACTIVE sprints (the order is read off the busiest board).
  const boards = new Map<number, number>();
  // sprint name → tickets in it + its dates (the header shows the busiest sprint's).
  const sprints = new Map<string, { count: number; startsAt: Date | null; endsAt: Date | null }>();
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
      const t = toJiraSprintTicket(raw, names, schema, inSprint, a.call.apiRoot);
      if (t == null) continue;
      tickets.push(t);
      if (inSprint) {
        const ids = fieldIdsBySchema(asRecord(asRecord(raw)?.schema) ?? schema, asRecord(asRecord(raw)?.names) ?? names);
        const f = asRecord(asRecord(raw)?.fields);
        if (ids.sprint != null && f != null) {
          const ticketBoards = new Set<number>();
          for (const sp of sprintsOf(f[ids.sprint])) {
            if (sp.state !== 'active') continue;
            if (!sprintNames.includes(sp.name)) sprintNames.push(sp.name);
            if (sp.boardId != null) ticketBoards.add(sp.boardId);
            const seen = sprints.get(sp.name);
            if (seen == null) sprints.set(sp.name, { count: 1, startsAt: sp.startsAt, endsAt: sp.endsAt });
            else seen.count += 1;
          }
          for (const b of ticketBoards) boards.set(b, (boards.get(b) ?? 0) + 1);
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
  return { tickets, truncated, names: sprintNames, boards, dates: busiestSprintDates([...sprints.values()]) };
}

/** The busiest board (most tickets; ties → the lowest id, so the pick is stable). Pure. */
export function busiestBoard(boards: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  for (const [id, n] of boards) {
    if (best == null || n > (boards.get(best) ?? 0) || (n === boards.get(best) && id < best)) best = id;
  }
  return best;
}

export const listJiraSprint: SprintLister = async (a): Promise<SprintListResult> => {
  let reason: 'no_sprint_concept' | 'none_active' = 'none_active';
  try {
    const r = await search(a, sprintJql(a.projectKeys), true);
    if (r.tickets.length > 0) {
      const board = busiestBoard(r.boards);
      let statusOrder: SprintStatusAutoOrder | null | undefined = null;
      let statusOrderError: string | undefined;
      if (board != null) {
        try {
          statusOrder = await readJiraBoardOrder(a, board, Date.now());
        } catch (err) {
          // ⚠ Never fails the list: the stored order stands.
          statusOrder = undefined;
          statusOrderError = err instanceof JiraFetchError ? err.code : 'unknown';
        }
      }
      return {
        source: { kind: 'sprint', provider: 'jira', names: r.names },
        tickets: r.tickets,
        truncated: r.truncated,
        statusOrder,
        dates: r.dates,
        ...(statusOrderError != null ? { statusOrderError } : {}),
      };
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
    // No sprint, no board: the category fallback orders the page.
    statusOrder: null,
  };
};

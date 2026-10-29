import {
  isAutomationCommentName,
  notionId,
  TICKET_COMMENTS_KEPT,
  TICKET_LINK_BLOCKERS_MAX,
  TICKET_LINK_TITLE_MAX,
  type JiraStatusCategory,
  type NotionTrackerMapping,
  type TicketLinkBlocker,
} from '@pierre-review/shared';
import { extractAcceptanceCriteria } from '../ac.js';
import { ticketDateFields, trackerDate } from '../dates.js';
import { JiraFetchError } from '../jira/fetch.js';
import type { FetchedTicket, FetchedTicketComment, TrackerCall } from '../types.js';
import { fetchPageMarkdown, richTextMarkdown, richTextPlain, type NotionRichText } from './blocks.js';
import { notionRequest } from './client.js';
import { readNotionDatabase, statusOptionOrder } from './schema.js';

// NOTION — THE READER (docs/TRACKERS.md § Notion). One ticket = one page of the workspace's database:
//
//   1. FIND: `POST /v1/databases/{db}/query` filtered on the Unique ID property's NUMBER (the prefix
//      must be the database's own). One page or `not_found`.
//   2. PROPERTIES per the workspace's mapping (`TrackerCall.notion`): title, status (a `status`
//      property's group — To-do / In progress / Complete — from the cached schema, or a `select` with
//      a per-option category), assignee (people), type (select), criteria (rich text), blocked-by
//      (a relation; ≤ 10 linked pages read for their key, title and status).
//   3. BODY: the page's blocks → markdown (./blocks.ts, bounded).
//   4. COMMENTS: `GET /v1/comments?block_id=<page>` (paginated, ≤ 5 pages), the newest 20; each
//      author's name and kind from `GET /v1/users/{id}` (cached) — `type: 'bot'` is a bot. A refused
//      comment read (the integration lacks the "read comments" capability) leaves them UNKNOWN.
//
// Every call goes through ./client.ts (spacing, 429 Retry-After). Read-only: nothing here writes.

export const NOTION_COMMENT_PAGES_MAX = 5;
export const NOTION_BLOCKERS_READ_MAX = 10;
const USER_TTL_MS = 60 * 60_000;

export interface NotionPropValue {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  unique_id?: { prefix?: string | null; number?: number | null } | null;
  status?: { id?: string; name?: string } | null;
  select?: { id?: string; name?: string } | null;
  people?: Array<{ id?: string; name?: string | null; avatar_url?: string | null; type?: string; object?: string }>;
  relation?: Array<{ id?: string }>;
  has_more?: boolean;
  date?: { start?: string | null; end?: string | null } | null;
}

export interface NotionPage {
  object?: string;
  id?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { type?: string; database_id?: string } | null;
  properties?: Record<string, NotionPropValue>;
}

const httpsOnly = (u: string | null | undefined): string | null => (u != null && /^https:\/\//i.test(u) ? u : null);

/** The mapping a call carries; a Notion call without one is a settings problem. */
export function mappingOf(call: TrackerCall): NotionTrackerMapping {
  if (call.notion == null) throw new JiraFetchError('bad_url');
  return call.notion;
}

/** A page property by its STABLE id (the page keys properties by name). */
export function propById(page: NotionPage, id: string | null | undefined): NotionPropValue | null {
  if (id == null) return null;
  for (const v of Object.values(page.properties ?? {})) if (v?.id === id) return v;
  return null;
}

/** The page's title (its one `title` property). */
export function pageTitle(page: NotionPage): string {
  for (const v of Object.values(page.properties ?? {})) if (v?.type === 'title') return richTextPlain(v.title).trim();
  return '';
}

/** `ENG-123` from the page's Unique ID, or null. */
export function pageKey(page: NotionPage, m: NotionTrackerMapping): string | null {
  const u = propById(page, m.uniqueId.property.id)?.unique_id;
  const n = u?.number;
  if (n == null || !Number.isInteger(n) || n <= 0) return null;
  const prefix = (u?.prefix ?? m.uniqueId.prefix).trim();
  if (prefix === '') return null;
  return `${prefix}-${n}`.toUpperCase();
}

/** The status per the mapping. `groups` = the status property's option order with categories (from
 *  the schema); absent for a select mapping. Pure. */
export function pageStatus(
  page: NotionPage,
  m: NotionTrackerMapping,
  groups: ReadonlyArray<{ id: string | null; name: string; category: JiraStatusCategory }> | null,
): FetchedTicket['status'] {
  if (m.status == null) return null;
  const v = propById(page, m.status.property.id);
  if (m.status.type === 'status') {
    const name = (v?.status?.name ?? '').trim();
    if (name === '') return null;
    const g = groups?.find((o) => o.name === name);
    const id = v?.status?.id ?? g?.id ?? null;
    return { name, category: g?.category ?? null, ...(id != null ? { id: id.slice(0, 64) } : {}) };
  }
  const name = (v?.select?.name ?? '').trim();
  if (name === '') return null;
  const id = v?.select?.id ?? null;
  return { name, category: m.status.options[name] ?? 'new', ...(id != null ? { id: id.slice(0, 64) } : {}) };
}

/** A page's status alone (for a blocker): the status/select value's name and category. */
function statusGroups(db: Awaited<ReturnType<typeof readNotionDatabase>>, m: NotionTrackerMapping) {
  if (m.status?.type !== 'status') return null;
  const p = Object.values(db.properties ?? {}).find((x) => x?.id === m.status!.property.id);
  return p != null ? statusOptionOrder(p.status) : null;
}

/** The status groups for this mapping (cached schema read); null for a select mapping or on failure. */
export async function readStatusGroups(call: TrackerCall, m: NotionTrackerMapping) {
  if (m.status?.type !== 'status') return null;
  try {
    return statusGroups(await readNotionDatabase(call, m.databaseId), m);
  } catch {
    return null;
  }
}

/** Find a page by key. Throws `not_found` for a key that is not this database's. */
export async function findNotionPage(call: TrackerCall, key: string): Promise<NotionPage> {
  const m = mappingOf(call);
  const k = /^([A-Za-z][A-Za-z0-9_]{0,19})-(\d{1,9})$/.exec(key.trim());
  if (k == null || k[1]!.toUpperCase() !== m.uniqueId.prefix.toUpperCase()) throw new JiraFetchError('not_found');
  const res = await notionRequest<{ results?: NotionPage[] }>(call, 'POST', `/v1/databases/${m.databaseId}/query`, {
    filter: { property: m.uniqueId.property.id, unique_id: { equals: Number(k[2]) } },
    page_size: 1,
  });
  const page = (res.results ?? []).find((p) => p != null && p.archived !== true && p.in_trash !== true);
  if (page == null) throw new JiraFetchError('not_found');
  return page;
}

/** Whether a page belongs to the mapped database. */
export function isPageOfDatabase(page: NotionPage, m: NotionTrackerMapping): boolean {
  return page.parent?.type === 'database_id' && notionId(page.parent.database_id ?? '') === m.databaseId;
}

/** A pasted page link → that page's key, or `other` when it is another database's page. Throws
 *  `JiraFetchError` (not_found for a page the integration cannot see). */
export async function notionKeyOfPage(call: TrackerCall, pageId: string): Promise<{ key: string } | { other: true }> {
  const m = mappingOf(call);
  const page = await notionRequest<NotionPage>(call, 'GET', `/v1/pages/${encodeURIComponent(pageId)}`);
  if (page.archived === true || page.in_trash === true) throw new JiraFetchError('not_found');
  if (!isPageOfDatabase(page, m)) return { other: true };
  const key = pageKey(page, m);
  if (key == null) throw new JiraFetchError('not_found');
  return { key };
}

// ---- comments ----

const users = new Map<string, { at: number; name: string; isBot: boolean }>();

/** Test seam. */
export function __clearNotionUsers(): void {
  users.clear();
}

async function userOf(call: TrackerCall, id: string, now: number): Promise<{ name: string; isBot: boolean }> {
  const hit = users.get(id);
  if (hit != null && now - hit.at < USER_TTL_MS) return hit;
  try {
    const u = await notionRequest<{ name?: string | null; type?: string }>(call, 'GET', `/v1/users/${encodeURIComponent(id)}`);
    const v = { at: now, name: (u.name ?? '').trim().slice(0, 200), isBot: u.type === 'bot' };
    users.set(id, v);
    return v;
  } catch (err) {
    // A rate limit is the read's problem; anything else (no user-information capability) is "unknown person".
    if (err instanceof JiraFetchError && err.status === 429) throw err;
    return { name: '', isBot: false };
  }
}

interface RawComment {
  id?: string;
  created_time?: string;
  last_edited_time?: string;
  created_by?: { id?: string; object?: string } | null;
  rich_text?: NotionRichText[];
}

/** Raw comments (oldest first, as Notion pages them) → the newest TICKET_COMMENTS_KEPT. Pure apart
 *  from the author lookup it is handed. */
export async function toNotionComments(
  raw: readonly RawComment[],
  author: (id: string) => Promise<{ name: string; isBot: boolean }>,
): Promise<FetchedTicketComment[]> {
  const out: FetchedTicketComment[] = [];
  const newest = [...raw]
    .filter((c) => (c?.id ?? '') !== '' && c.created_time != null && !Number.isNaN(new Date(c.created_time).getTime()))
    .sort((a, b) => new Date(a.created_time!).getTime() - new Date(b.created_time!).getTime())
    .slice(-TICKET_COMMENTS_KEPT);
  for (const c of newest) {
    const authorId = c.created_by?.id ?? null;
    const who = authorId != null ? await author(authorId) : { name: '', isBot: false };
    const updated = c.last_edited_time != null ? new Date(c.last_edited_time) : null;
    out.push({
      id: c.id!,
      authorName: who.name,
      authorId,
      isBot: who.isBot || isAutomationCommentName(who.name),
      body: richTextMarkdown(c.rich_text),
      createdAt: new Date(c.created_time!),
      updatedAt: updated != null && !Number.isNaN(updated.getTime()) ? updated : null,
    });
  }
  return out;
}

/** The page's comments, or undefined when Notion would not give them (positive-answer rule). */
export async function fetchNotionComments(call: TrackerCall, pageId: string, now: number = Date.now()): Promise<FetchedTicketComment[] | undefined> {
  const raw: RawComment[] = [];
  let cursor: string | null = null;
  try {
    for (let i = 0; i < NOTION_COMMENT_PAGES_MAX; i += 1) {
      const q = new URLSearchParams({ block_id: pageId, page_size: '100' });
      if (cursor != null) q.set('start_cursor', cursor);
      const page: { results?: RawComment[]; has_more?: boolean; next_cursor?: string | null } = await notionRequest(
        call,
        'GET',
        `/v1/comments?${q.toString()}`,
      );
      raw.push(...(page.results ?? []));
      if (page.has_more !== true || page.next_cursor == null) {
        cursor = null;
        break;
      }
      cursor = page.next_cursor;
    }
  } catch (err) {
    if (err instanceof JiraFetchError && err.status === 429) throw err;
    return undefined;
  }
  // More pages than read: the newest are past the cut, so what was read is NOT the newest — unknown.
  if (cursor != null) return undefined;
  return toNotionComments(raw, (id) => userOf(call, id, now));
}

// ---- blockers ----

export async function readBlockers(
  call: TrackerCall,
  page: NotionPage,
  m: NotionTrackerMapping,
  groups: Parameters<typeof pageStatus>[2],
): Promise<TicketLinkBlocker[] | null> {
  if (m.blockedBy == null) return null;
  const ids = (propById(page, m.blockedBy.id)?.relation ?? [])
    .map((r) => r?.id ?? '')
    .filter((id) => id !== '')
    .slice(0, Math.min(NOTION_BLOCKERS_READ_MAX, TICKET_LINK_BLOCKERS_MAX));
  const out: TicketLinkBlocker[] = [];
  for (const id of ids) {
    let other: NotionPage;
    try {
      other = await notionRequest<NotionPage>(call, 'GET', `/v1/pages/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof JiraFetchError && err.status === 429) throw err;
      continue;
    }
    if (!isPageOfDatabase(other, m)) continue;
    const key = pageKey(other, m);
    if (key == null || out.some((b) => b.key === key)) continue;
    const title = pageTitle(other);
    const status = pageStatus(other, m, groups);
    out.push({
      key,
      title: title !== '' ? title.slice(0, TICKET_LINK_TITLE_MAX) : null,
      status: status?.name ?? null,
      category: status?.category ?? null,
      relation: 'blocked by',
      url: httpsOnly(other.url),
    });
  }
  return out;
}

// ---- the ticket ----

/** A page's PROPERTIES → the ticket (no body, comments or blockers). Pure. */
export function toNotionTicket(
  key: string,
  page: NotionPage,
  m: NotionTrackerMapping,
  groups: Parameters<typeof pageStatus>[2],
  body: string,
): FetchedTicket {
  const crit = m.criteria != null ? richTextMarkdown(propById(page, m.criteria.id)?.rich_text).trim() : '';
  let description = body;
  let candidates: FetchedTicket['candidates'] = [];
  if (crit !== '') {
    candidates = [{ id: 'notion:property', name: m.criteria!.name, text: crit, match: 'strong' }];
  } else {
    // No criteria property (or it is empty): the shared rule over the body — a task list, or an
    // "Acceptance criteria" section (Notion pages have no sub-issues here).
    const ac = extractAcceptanceCriteria(body, [], 0);
    description = ac.description;
    if (ac.criteria != null)
      candidates = [{ id: `notion:${ac.criteria.source}`, name: ac.criteria.name, text: ac.criteria.text, match: 'strong' }];
  }
  const person = m.assignee != null ? (propById(page, m.assignee.id)?.people ?? [])[0] : undefined;
  const personName = (person?.name ?? '').trim();
  const type = m.issueType != null ? (propById(page, m.issueType.id)?.select ?? null) : null;
  const typeName = (type?.name ?? '').trim();
  return {
    key,
    title: pageTitle(page),
    description,
    issueType: typeName !== '' ? { id: (type?.id ?? typeName).slice(0, 64), name: typeName } : null,
    status: pageStatus(page, m, groups),
    assignee: personName !== '' ? { name: personName, accountId: person?.id ?? null, avatarUrl: httpsOnly(person?.avatar_url) } : null,
    candidates,
    omittedCandidates: 0,
    url: httpsOnly(page.url),
    // Notion has no resolution date: the created instant is read, the resolved one never is.
    ...ticketDateFields({ issueCreatedAt: trackerDate(page as unknown as Record<string, unknown>, 'created_time'), issueResolvedAt: undefined }),
  };
}

/** Everything one page holds, read in full (body, comments, blockers). */
export async function readNotionPageTicket(call: TrackerCall, page: NotionPage, key: string): Promise<FetchedTicket> {
  const m = mappingOf(call);
  const groups = await readStatusGroups(call, m);
  const body = await fetchPageMarkdown(call, page.id!);
  const base = toNotionTicket(key, page, m, groups, body);
  const blockedBy = await readBlockers(call, page, m, groups);
  const comments = await fetchNotionComments(call, page.id!);
  return {
    ...base,
    blockedBy,
    ...(comments === undefined ? {} : { comments }),
  };
}

/** Read ONE ticket (`ENG-123`). Throws `JiraFetchError`. */
export async function fetchNotionTicket(call: TrackerCall, key: string): Promise<FetchedTicket> {
  const page = await findNotionPage(call, key);
  const found = pageKey(page, mappingOf(call));
  // The query matched the NUMBER; the prefix on the page must be the one asked for.
  if (found == null || found !== key.trim().toUpperCase()) throw new JiraFetchError('not_found');
  return readNotionPageTicket(call, page, found);
}

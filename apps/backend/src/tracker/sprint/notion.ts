import {
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_TICKETS_MAX,
  notionId,
  type JiraStatusCategory,
  type NotionTrackerMapping,
  type SprintStatusAutoOrder,
} from '@pierre-review/shared';
import { JiraFetchError } from '../jira/fetch.js';
import { fetchPageMarkdown } from '../notion/blocks.js';
import { notionRequest } from '../notion/client.js';
import { mappingOf, pageKey, pageTitle, propById, readBlockers, toNotionTicket, type NotionPage } from '../notion/reader.js';
import { readNotionDatabase, statusOptionOrder, type RawDatabase } from '../notion/schema.js';
import type { TrackerCall } from '../types.js';
import { busiestSprintDates, sprintDate, type SprintFetchedTicket, type SprintListDates, type SprintListResult, type SprintLister } from './types.js';

// NOTION — THE SPRINT LIST (docs/TRACKERS.md § Notion → The sprint list). The CURRENT sprint is the
// workspace's mapping (`NotionTrackerMapping.sprint`):
//
//   • relation — a Sprints database: its pages whose DATE RANGE holds today (start ≤ today ≤ end, a
//     range with no end is that one day). The tickets are the pages whose relation CONTAINS one of them
//     (≤ 5 current sprints). Names are the sprint pages' titles; dates the busiest sprint's range.
//   • select   — the option chosen in Settings; no dates.
//   • date     — each page's own date range holds today; the dates are the busiest range.
//   • none     — the status fallback, `no_sprint_concept`; a mapping with nothing current, `none_active`.
//     The fallback is the To-do + In-progress pages edited in the window.
//
// THE STATUS ORDER: the status property's options in GROUP order (To-do, In progress, Complete), or a
// select's options in Notion's order with the mapped categories — source `notion_status`. Read from
// the database schema (one call), which never fails the list (`statusOrder: undefined` on a failure).
//
// Each page's BODY is read (bounded, ./notion/blocks.ts) so the sprint's stories have their text, and
// its blockers (the mapped relation); comments are left to the per-ticket reader. Every call is spaced by ./notion/client.ts.

const PAGE = 100;
const CURRENT_SPRINTS_MAX = 5;
const DAY_MS = 86_400_000;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whether a date range holds `day` (YYYY-MM-DD compare on the date part; no end = the start day). Pure. */
export function rangeHolds(range: { start?: string | null; end?: string | null } | null | undefined, day: string): boolean {
  const start = (range?.start ?? '').slice(0, 10);
  if (start === '') return false;
  const end = (range?.end ?? '').slice(0, 10) || start;
  return start <= day && day <= end;
}

/** The automatic status order for this mapping. Pure. */
export function notionStatusOrder(db: RawDatabase, m: NotionTrackerMapping, readAt: string): SprintStatusAutoOrder | null {
  if (m.status == null) return null;
  const prop = Object.values(db.properties ?? {}).find((p) => p?.id === m.status!.property.id);
  if (prop == null) return null;
  let statuses: Array<{ id: string | null; name: string; category: JiraStatusCategory | null }>;
  if (m.status.type === 'status') statuses = statusOptionOrder(prop.status);
  else {
    const opts = m.status.options;
    const rank: Record<JiraStatusCategory, number> = { new: 0, indeterminate: 1, done: 2 };
    statuses = (prop.select?.options ?? [])
      .map((o, i) => ({ id: o.id ?? null, name: (o.name ?? '').trim(), category: opts[(o.name ?? '').trim()] ?? ('new' as JiraStatusCategory), i }))
      .filter((o) => o.name !== '')
      .sort((a, b) => rank[a.category] - rank[b.category] || a.i - b.i)
      .map(({ id, name, category }) => ({ id, name, category }));
  }
  const out = statuses.slice(0, SPRINT_STATUS_ORDER_MAX).map((s) => ({ ...s, name: s.name.slice(0, SPRINT_STATUS_NAME_MAX) }));
  return out.length > 0 ? { source: 'notion_status', statuses: out, readAt } : null;
}

/** The status-fallback filter: To-do + In-progress options edited since `fromIso`. Pure. */
export function fallbackFilter(m: NotionTrackerMapping, db: RawDatabase | null, fromIso: string): Record<string, unknown> {
  const edited = { timestamp: 'last_edited_time', last_edited_time: { on_or_after: fromIso } };
  if (m.status == null) return edited;
  let open: string[] = [];
  if (m.status.type === 'status') {
    const prop = Object.values(db?.properties ?? {}).find((p) => p?.id === m.status!.property.id);
    open = statusOptionOrder(prop?.status)
      .filter((o) => o.category !== 'done')
      .map((o) => o.name);
  } else {
    const opts = m.status.options;
    open = Object.keys(opts).filter((k) => opts[k] !== 'done');
  }
  if (open.length === 0) return edited;
  const key = m.status.type === 'status' ? 'status' : 'select';
  const or = open.slice(0, 90).map((name) => ({ property: m.status!.property.id, [key]: { equals: name } }));
  return { and: [edited, { or }] };
}

interface QueryPage {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function queryAll(
  call: TrackerCall,
  databaseId: string,
  filter: Record<string, unknown>,
  max: number,
): Promise<{ pages: NotionPage[]; truncated: boolean }> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: QueryPage = await notionRequest<QueryPage>(call, 'POST', `/v1/databases/${databaseId}/query`, {
      filter,
      page_size: PAGE,
      ...(cursor != null ? { start_cursor: cursor } : {}),
    });
    for (const p of res.results ?? []) {
      if (p == null || p.archived === true || p.in_trash === true) continue;
      if (pages.length >= max) return { pages, truncated: true };
      pages.push(p);
    }
    if (res.has_more !== true || res.next_cursor == null) return { pages, truncated: false };
    if (pages.length >= max) return { pages, truncated: true };
    cursor = res.next_cursor;
  }
}

/** The CURRENT sprints of a relation mapping: the Sprints database pages whose range holds today. */
async function currentSprintPages(
  call: TrackerCall,
  s: Extract<NonNullable<NotionTrackerMapping['sprint']>, { kind: 'relation' }>,
  day: string,
): Promise<Array<{ id: string; name: string; startsAt: Date | null; endsAt: Date | null }>> {
  const { pages } = await queryAll(
    call,
    s.sprintDatabaseId,
    { property: s.dateProperty.id, date: { on_or_before: day } },
    50,
  );
  const out: Array<{ id: string; name: string; startsAt: Date | null; endsAt: Date | null }> = [];
  for (const p of pages) {
    const range = propById(p, s.dateProperty.id)?.date ?? null;
    if (!rangeHolds(range, day) || p.id == null) continue;
    out.push({ id: p.id, name: pageTitle(p) || 'Sprint', startsAt: sprintDate(range?.start), endsAt: sprintDate(range?.end ?? range?.start) });
    if (out.length >= CURRENT_SPRINTS_MAX) break;
  }
  return out;
}

async function toSprintTickets(
  call: TrackerCall,
  m: NotionTrackerMapping,
  db: RawDatabase | null,
  pages: readonly NotionPage[],
  sprintNameOf: (p: NotionPage) => string | null,
): Promise<SprintFetchedTicket[]> {
  const prop = m.status?.type === 'status' ? Object.values(db?.properties ?? {}).find((p) => p?.id === m.status!.property.id) : undefined;
  const groups = prop != null ? statusOptionOrder(prop.status) : null;
  const out: SprintFetchedTicket[] = [];
  for (const p of pages) {
    const key = pageKey(p, m);
    if (key == null || p.id == null) continue;
    let body = '';
    try {
      body = await fetchPageMarkdown(call, p.id);
    } catch (err) {
      // A rate limit ends the list (the read records it); one unreadable body does not.
      if (err instanceof JiraFetchError && err.status === 429) throw err;
    }
    const t = toNotionTicket(key, p, m, groups, body);
    // The blocking links (≤ 10 page reads, only for a page that names any), so the sprint's "Blocked"
    // story issue works without a PR. A failure other than a rate limit leaves them unread.
    let blockedBy: SprintFetchedTicket['blockedBy'];
    try {
      blockedBy = await readBlockers(call, p, m, groups);
    } catch (err) {
      if (err instanceof JiraFetchError && err.status === 429) throw err;
    }
    const updated = p.last_edited_time != null ? new Date(p.last_edited_time) : null;
    out.push({
      ...t,
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      projectKey: key.split('-')[0]!,
      epic: null,
      components: null,
      sprintName: sprintNameOf(p),
      issueUpdatedAt: updated != null && !Number.isNaN(updated.getTime()) ? updated : null,
    });
  }
  return out;
}

export const listNotionSprint: SprintLister = async (a): Promise<SprintListResult> => {
  const m = mappingOf(a.call);
  const nowMs = a.fallbackWindow.toMs;
  const day = isoDay(nowMs);
  const readAt = new Date(nowMs).toISOString();
  let db: RawDatabase | null = null;
  let statusOrder: SprintStatusAutoOrder | null | undefined;
  let statusOrderError: string | undefined;
  try {
    db = await readNotionDatabase(a.call, m.databaseId, { fresh: true });
    statusOrder = notionStatusOrder(db, m, readAt);
  } catch (err) {
    if (err instanceof JiraFetchError && (err.status === 429 || err.code === 'unauthorized')) throw err;
    statusOrder = undefined;
    statusOrderError = err instanceof JiraFetchError ? err.code : 'unknown';
  }
  const extra = statusOrderError != null ? { statusOrderError } : {};

  const s = m.sprint;
  let reason: 'no_sprint_concept' | 'none_active' = s == null ? 'no_sprint_concept' : 'none_active';
  if (s != null) {
    let filter: Record<string, unknown> | null = null;
    let names: string[] = [];
    let ranges: Array<{ id: string; name: string; startsAt: Date | null; endsAt: Date | null }> = [];
    if (s.kind === 'relation') {
      ranges = await currentSprintPages(a.call, s, day);
      if (ranges.length > 0) {
        names = ranges.map((r) => r.name);
        filter =
          ranges.length === 1
            ? { property: s.property.id, relation: { contains: ranges[0]!.id } }
            : { or: ranges.map((r) => ({ property: s.property.id, relation: { contains: r.id } })) };
      }
    } else if (s.kind === 'select') {
      names = [s.current];
      filter = { property: s.property.id, select: { equals: s.current } };
    } else {
      // A page's own range: started on or before today, within the last 90 days (a range's END cannot
      // be filtered on; it is checked below).
      filter = {
        and: [
          { property: s.property.id, date: { on_or_before: day } },
          { property: s.property.id, date: { on_or_after: isoDay(nowMs - 90 * DAY_MS) } },
        ],
      };
    }
    if (filter != null) {
      const { pages: raw, truncated } = await queryAll(a.call, m.databaseId, filter, SPRINT_TICKETS_MAX);
      const pages = s.kind === 'date' ? raw.filter((p) => rangeHolds(propById(p, s.property.id)?.date ?? null, day)) : raw;
      if (pages.length > 0) {
        const sprintOf = (p: NotionPage): string | null => {
          if (s.kind === 'relation') {
            const ids = new Set((propById(p, s.property.id)?.relation ?? []).map((r) => notionId(r?.id ?? '')));
            return ranges.find((r) => ids.has(notionId(r.id)))?.name ?? names[0] ?? null;
          }
          return s.kind === 'select' ? s.current : null;
        };
        const tickets = await toSprintTickets(a.call, m, db, pages, sprintOf);
        let dates: SprintListDates | null = null;
        if (s.kind === 'relation') {
          dates = busiestSprintDates(
            ranges.map((r) => ({ count: tickets.filter((t) => t.sprintName === r.name).length, startsAt: r.startsAt, endsAt: r.endsAt })),
          );
        } else if (s.kind === 'date') {
          const counts = new Map<string, { count: number; startsAt: Date | null; endsAt: Date | null }>();
          for (const p of pages) {
            const r = propById(p, s.property.id)?.date ?? null;
            const k = `${r?.start ?? ''}|${r?.end ?? ''}`;
            const c = counts.get(k) ?? { count: 0, startsAt: sprintDate(r?.start), endsAt: sprintDate(r?.end ?? r?.start) };
            c.count += 1;
            counts.set(k, c);
          }
          dates = busiestSprintDates([...counts.values()]);
        }
        return {
          source: { kind: 'sprint', provider: 'notion', names },
          tickets,
          truncated,
          statusOrder,
          dates,
          ...extra,
        };
      }
    }
    reason = 'none_active';
  }

  // The STATUS FALLBACK: To-do + In-progress pages edited in the window.
  const fromIso = new Date(a.fallbackWindow.fromMs).toISOString();
  const { pages, truncated } = await queryAll(a.call, m.databaseId, fallbackFilter(m, db, fromIso), SPRINT_TICKETS_MAX);
  const tickets = await toSprintTickets(a.call, m, db, pages, () => null);
  return {
    source: {
      kind: 'status_fallback',
      provider: 'notion',
      reason,
      from: fromIso,
      to: new Date(a.fallbackWindow.toMs).toISOString(),
    },
    tickets,
    truncated,
    statusOrder,
    ...extra,
  };
};

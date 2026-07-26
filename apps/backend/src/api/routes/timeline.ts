import type { FastifyInstance } from 'fastify';
import type { EventType, PrStatus, ReviewState, TimelineQuery } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getTimeline, type TimelineFilters } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Local copies of the shared value constants. `@pierre-review/shared` is a
// types-only workspace package that is NOT shipped in the published tarball, so
// the backend must not import runtime values from it (only `import type`, which
// `verbatimModuleSyntax` erases). Keep these in sync with packages/shared.
const EVENT_TYPES: EventType[] = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'pr_reopened',
  'pr_ready_for_review',
  'review_submitted',
  'review_comment',
  'pr_comment',
  'commit_pushed',
];
const PR_STATUSES: PrStatus[] = ['draft', 'open', 'merged', 'closed'];
const REVIEW_FILTER_STATES: ReviewState[] = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
];

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

function parseTypes(raw: string | undefined): EventType[] | null {
  if (!raw) return null;
  const allowed = new Set<string>(EVENT_TYPES);
  const types = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.has(s)) as EventType[];
  return types.length > 0 ? types : null;
}

// Absent (undefined) → null = no status filter (show all). Present, even empty
// ("") → an explicit (possibly empty) set, so deselecting every status shows
// nothing rather than falling back to "all".
function parseStatuses(raw: string | undefined): PrStatus[] | null {
  if (raw === undefined) return null;
  const allowed = new Set<string>(PR_STATUSES);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.has(s)) as PrStatus[];
}

// Absent (undefined) → null = no review-verdict filter (show all). Present, even
// empty ("") → an explicit (possibly empty) set, so deselecting every verdict hides
// all review markers rather than falling back to "all". Mirrors parseStatuses.
function parseReviewStates(raw: string | undefined): ReviewState[] | null {
  if (raw === undefined) return null;
  const allowed = new Set<string>(REVIEW_FILTER_STATES);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.has(s)) as ReviewState[];
}

function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

// ---- Window clamp ----
// `from`/`to` are free-form client dates, and getTimeline's cost scales with the span: it
// loads every matching PR and event in the range. `?from=1970-01-01&to=2100-01-01` therefore
// asked for the account's ENTIRE retained dataset in one JSON body — a cheap way for one
// authenticated request to exhaust the heap of a process that, in cloud, serves every tenant.
//
// Nothing legitimate needs a wide window: the SPA's widest preset is 90 days, and the server
// only retains `config.retentionDays` (default 180) of history anyway, so anything beyond
// that is asking for rows that cannot exist. The clamp is silent and generous rather than a
// 400, because a stale bookmark with an old `from=` should still render a board.
//
// Belt-and-braces: db/queries.ts additionally caps the ROW COUNT and reports `truncated`,
// because a legitimately-sized window can still be huge for a tenant watching 100 busy repos.
function clampWindow(from: Date, to: Date, now: Date, maxSpanDays: number): { from: Date; to: Date } {
  // A reversed range would produce an empty board with no explanation — normalise it.
  let start = from;
  let end = to;
  if (start.getTime() > end.getTime()) [start, end] = [end, start];
  // Never look further ahead than "now" (+1 day of slack for clock skew / timezones).
  const maxEnd = now.getTime() + DAY_MS;
  if (end.getTime() > maxEnd) end = new Date(maxEnd);
  // Never look further back than the retention horizon — there is no data there.
  const earliest = end.getTime() - maxSpanDays * DAY_MS;
  if (start.getTime() < earliest) start = new Date(earliest);
  return { from: start, to: end };
}

export async function timelineRoutes(app: FastifyInstance): Promise<void> {
  // The widest span a request may ask for: the retention horizon (there is nothing older
  // to return), with a floor so a deployment that disables retention (RETENTION_DAYS=0)
  // still gets a bound rather than an unbounded one.
  const maxSpanDays = config.retentionDays > 0 ? config.retentionDays : 365;

  app.get('/api/timeline', async (req) => {
    const q = req.query as TimelineQuery;
    const now = new Date();
    const window = clampWindow(
      parseDate(q.from, new Date(now.getTime() - 14 * DAY_MS)),
      parseDate(q.to, now),
      now,
      maxSpanDays,
    );
    const filters: TimelineFilters = {
      accountId: accountIdOf(req),
      from: window.from,
      to: window.to,
      repoIds: parseIntList(q.repoIds),
      prIds: parseIntList(q.prIds),
      userIds: parseIntList(q.userIds),
      types: parseTypes(q.types),
      statuses: parseStatuses(q.statuses),
      reviewStates: parseReviewStates(q.reviewStates),
      excludeBots: q.excludeBots === 'true',
      allowBotIds: parseIntList(q.allowBotIds),
      excludeStale: q.excludeStale === 'true',
    };
    return getTimeline(filters);
  });
}

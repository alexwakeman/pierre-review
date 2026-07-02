import type { FastifyInstance } from 'fastify';
import type { EventType, PrStatus, ReviewState, TimelineQuery } from '@pierre-review/shared';
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

export async function timelineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/timeline', async (req) => {
    const q = req.query as TimelineQuery;
    const now = new Date();
    const filters: TimelineFilters = {
      accountId: accountIdOf(req),
      from: parseDate(q.from, new Date(now.getTime() - 14 * DAY_MS)),
      to: parseDate(q.to, now),
      repoIds: parseIntList(q.repoIds),
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

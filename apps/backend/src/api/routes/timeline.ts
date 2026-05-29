import type { FastifyInstance } from 'fastify';
import {
  EVENT_TYPES,
  type EventType,
  type TimelineQuery,
} from '@gh-team-monitor/shared';
import { getTimeline, type TimelineFilters } from '../../db/queries.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
      from: parseDate(q.from, new Date(now.getTime() - 14 * DAY_MS)),
      to: parseDate(q.to, now),
      repoIds: parseIntList(q.repoIds),
      userIds: parseIntList(q.userIds),
      types: parseTypes(q.types),
      excludeBots: q.excludeBots !== 'false',
    };
    return getTimeline(filters);
  });
}

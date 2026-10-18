import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  storyDocsResultFromStored,
  type StoryDocsAlignmentResult,
  type StoryDocsAlignmentRun,
  type StoryDocsAlignmentStatus,
  type StoryDocsCriteriaSource,
  type StoryDocsCriterion,
  type StoryDocsShortlistEntry,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { storyDocsStaleReasons, type StoryDocsHashes } from './fingerprint.js';

// THE STORY DOCS CHECKS' STORAGE (`story_docs_alignments`, migration 0121 / pg 0108). ONE ROW PER RUN.
// Every read and write is scoped by accountId (and, for a story's runs, the workspace); an id from
// another account reads as null and writes nothing. Portable terminals only.

/* eslint-disable @typescript-eslint/no-explicit-any */
const t = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyDocsAlignments;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

export interface StoryDocsRow {
  id: number;
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string | null;
  status: StoryDocsAlignmentStatus;
  fingerprint: string;
  storyHash: string;
  criteriaHash: string;
  libraryHash: string;
  version: number;
  criteriaSource: StoryDocsCriteriaSource;
  criteriaJson: StoryDocsCriterion[] | null;
  shortlistJson: StoryDocsShortlistEntry[] | null;
  resultJson: StoryDocsAlignmentResult | null;
  error: string | null;
  shortlistModel: string | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface Telemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
}

export interface QueueStoryDocsArgs extends StoryDocsHashes {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string | null;
  fingerprint: string;
  version: number;
  criteriaSource: StoryDocsCriteriaSource;
  criteria: StoryDocsCriterion[];
}

export async function insertQueuedStoryDocs(ctx: Ctx, a: QueueStoryDocsArgs): Promise<number> {
  const d = t(ctx);
  const rows = (await ctx.db
    .insert(d)
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.ident,
      ticketKey: a.ticketKey,
      status: 'queued',
      fingerprint: a.fingerprint,
      storyHash: a.storyHash,
      criteriaHash: a.criteriaHash,
      libraryHash: a.libraryHash,
      version: a.version,
      criteriaSource: a.criteriaSource,
      criteriaJson: a.criteria,
      createdAt: new Date(),
    })
    .returning({ id: d.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

async function update(ctx: Ctx, accountId: number, id: number, set: Record<string, unknown>): Promise<void> {
  const d = t(ctx);
  await ctx.db
    .update(d)
    .set(set)
    .where(and(eq(d.id, id), eq(d.accountId, accountId)))
    .execute();
}

const tel = (x: Telemetry = {}) => ({
  costUsd: x.costUsd ?? null,
  inputTokens: x.inputTokens ?? null,
  outputTokens: x.outputTokens ?? null,
  numTurns: x.numTurns ?? null,
});

/** The inputs were re-resolved at start (a click checks what is there NOW): store them with the step. */
export async function markShortlisting(
  ctx: Ctx,
  accountId: number,
  id: number,
  live: StoryDocsHashes & { fingerprint: string; criteriaSource: StoryDocsCriteriaSource; criteria: StoryDocsCriterion[]; model: string },
): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'shortlisting',
    startedAt: new Date(),
    fingerprint: live.fingerprint,
    storyHash: live.storyHash,
    criteriaHash: live.criteriaHash,
    libraryHash: live.libraryHash,
    criteriaSource: live.criteriaSource,
    criteriaJson: live.criteria,
    shortlistModel: live.model,
  });
}

export async function markReading(
  ctx: Ctx,
  accountId: number,
  id: number,
  shortlist: StoryDocsShortlistEntry[],
  model: string,
  t0: Telemetry,
): Promise<void> {
  await update(ctx, accountId, id, { status: 'reading', shortlistJson: shortlist, model, ...tel(t0) });
}

export async function saveStoryDocsSuccess(
  ctx: Ctx,
  accountId: number,
  id: number,
  r: { result: StoryDocsAlignmentResult; criteria: StoryDocsCriterion[] | null },
  t0: Telemetry,
): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'succeeded',
    resultJson: r.result,
    shortlistJson: r.result.shortlist,
    ...(r.criteria != null ? { criteriaJson: r.criteria } : {}),
    error: null,
    completedAt: new Date(),
    ...tel(t0),
  });
}

export async function markStoryDocsFailed(ctx: Ctx, accountId: number, id: number, error: string, t0?: Telemetry): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'failed',
    error: error.slice(0, 500),
    completedAt: new Date(),
    ...(t0 != null ? tel(t0) : {}),
  });
}

export const RESTART_ERROR = 'Stopped when Limn restarted. Run it again.';

export async function reconcileOrphanedStoryDocs(ctx: Ctx): Promise<number> {
  const d = t(ctx);
  const changed = (await ctx.db
    .update(d)
    .set({ status: 'failed', error: RESTART_ERROR, completedAt: new Date() })
    .where(inArray(d.status, ['queued', 'shortlisting', 'reading']))
    .returning({ id: d.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

// ---- reads ----

export async function getStoryDocsRow(ctx: Ctx, accountId: number, id: number): Promise<StoryDocsRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.id, id), eq(d.accountId, accountId)))
    .limit(1)
    .execute()) as StoryDocsRow[];
  return rows[0] ?? null;
}

/** The newest run of one story in one workspace (any status), or null. */
export async function latestStoryDocsRun(ctx: Ctx, accountId: number, workspaceId: number, ident: string): Promise<StoryDocsRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.workspaceId, workspaceId), eq(d.ident, ident)))
    .orderBy(desc(d.id))
    .limit(1)
    .execute()) as StoryDocsRow[];
  return rows[0] ?? null;
}

export async function latestSucceededStoryDocsRun(
  ctx: Ctx,
  accountId: number,
  workspaceId: number,
  ident: string,
): Promise<StoryDocsRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.workspaceId, workspaceId), eq(d.ident, ident), eq(d.status, 'succeeded')))
    .orderBy(desc(d.id))
    .limit(1)
    .execute()) as StoryDocsRow[];
  return rows[0] ?? null;
}

/** Runs this account started since `sinceMs` (every row is a click, so every row counts). */
export async function countStoryDocsRunsSince(ctx: Ctx, accountId: number, sinceMs: number): Promise<number> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select({ id: d.id })
    .from(d)
    .where(and(eq(d.accountId, accountId), gte(d.createdAt, new Date(sinceMs))))
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

// ---- the wire ----

const iso = (v: Date | number | null | undefined): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

const IN_FLIGHT: readonly string[] = ['queued', 'shortlisting', 'reading'];

/** A row → the wire run. `live` null ⇒ the live inputs could not be read: report it current. */
export function toStoryDocsRun(row: StoryDocsRow, live: StoryDocsHashes | null): StoryDocsAlignmentRun {
  const inFlight = IN_FLIGHT.includes(row.status);
  const staleBecause = inFlight || live == null ? [] : storyDocsStaleReasons(row, live);
  const result = row.status === 'succeeded' ? storyDocsResultFromStored(row.resultJson) : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ident: row.ident,
    ticketKey: row.ticketKey,
    status: row.status,
    error: row.status === 'failed' ? (row.error ?? 'The check did not finish.') : null,
    current: staleBecause.length === 0,
    staleBecause,
    criteriaSource: row.criteriaSource,
    criteria: Array.isArray(row.criteriaJson) ? row.criteriaJson : [],
    result,
    costUsd: row.costUsd,
    createdAt: iso(row.createdAt)!,
    finishedAt: iso(row.completedAt),
  };
}

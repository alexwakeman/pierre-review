import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import type {
  ClaudeReviewTicket,
  ClaudeTicketAlignment,
  TicketAssessment,
  TicketAutoPostRecord,
  TicketAutoPostWire,
  TicketReview,
  TicketReviewItem,
  TicketReviewMember,
  TicketReviewPrState,
  TicketReviewRefusal,
  TicketReviewStatus,
  TicketReviewTrigger,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { storyMatchKey } from '../claude-review/ticket.js';
import { readCardsAt, toWireCard } from './cards.js';
import type { FingerprintMember } from './fingerprint.js';

// THE TICKET REVIEW PERSISTENCE LAYER — reads and writes `ticket_reviews`, `ticket_review_members`
// and `ticket_review_items` (schema.sqlite.ts § Ticket review) through ctx.db + ctx.schema, like
// claude-review/persist.ts. Every read predicates on accountId; an id-addressed getter answers
// null for another account's id (→ 404). The currency fold itself is pure and lives in
// ./fingerprint.ts; this module only loads its inputs.

/* eslint-disable @typescript-eslint/no-explicit-any */
function tables(ctx: AgentContext): { tr: any; trm: any; tri: any; prs: any; repos: any } {
  const s = ctx.schema as any;
  return {
    tr: s.ticketReviews,
    trm: s.ticketReviewMembers,
    tri: s.ticketReviewItems,
    prs: s.pullRequests,
    repos: s.repos,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();
const isoReq = (d: unknown): string => iso(d) ?? new Date(0).toISOString();
const asDate = (d: unknown): Date | null =>
  d instanceof Date ? d : d == null ? null : new Date(d as string | number);

const REFUSALS: readonly TicketReviewRefusal[] = ['too_many_prs', 'no_members', 'no_ticket', 'peer_unreadable'];
const ALIGNMENTS: readonly ClaudeTicketAlignment[] = [
  'aligned',
  'partly_aligned',
  'not_aligned',
  'unclear',
  'not_checked',
];
const asAlignment = (v: unknown): ClaudeTicketAlignment | null =>
  typeof v === 'string' && (ALIGNMENTS as readonly string[]).includes(v) ? (v as ClaudeTicketAlignment) : null;

// ---- row shapes ----

export interface TicketReviewRow {
  id: number;
  accountId: number;
  workspaceId: number;
  ticketIdent: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketSnapshot: ClaudeReviewTicket | null;
  ticketHash: string | null;
  fingerprint: string | null;
  prCount: number | null;
  originPrId: number | null;
  trigger: TicketReviewTrigger;
  status: TicketReviewStatus;
  model: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  error: string | null;
  refused: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  alignment: string | null;
  summary: string | null;
  assessment: TicketAssessment | null;
  // What auto-posting did with this run (migration 0087 / pg 0074). Absent on older reads.
  autoPost?: TicketAutoPostRecord | null;
}

/** The stored auto-post record → the wire. null for anything malformed. */
export function ticketAutoPostWireOf(v: unknown): TicketAutoPostWire | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Partial<TicketAutoPostRecord>;
  if (typeof r.status !== 'string' || typeof r.at !== 'string') return null;
  const nr = Array.isArray(r.notRequested) ? r.notRequested : [];
  return {
    status: r.status,
    at: r.at,
    reason: r.reason ?? null,
    error: r.error ?? null,
    postedCount: (Array.isArray(r.postedItemIds) ? r.postedItemIds.length : 0) + nr.filter((n) => n.commentId != null && !n.carried).length,
    notRequested: nr
      .filter((n) => n.commentId != null && n.postedAt != null)
      .map((n) => ({ index: n.index, prId: n.prId, postedAt: n.postedAt!, carried: n.carried === true })),
  };
}

export interface TicketMemberRow {
  id: number;
  ticketReviewId: number;
  accountId: number;
  prId: number;
  repoId: number;
  headSha: string;
  prState: TicketReviewPrState;
  checkedOut: boolean;
}

export interface TicketItemRow {
  id: number;
  ticketReviewId: number;
  accountId: number;
  ref: string;
  status: TicketReviewItem['status'];
  title: string;
  body: string;
  ownerPrId: number | null;
  path: string | null;
  line: number | null;
  postedPrId: number | null;
  postedCommentId: string | null;
  postedAt: Date | null;
  // Posted by auto-posting (migration 0087 / pg 0074).
  postedAuto?: boolean | null;
  priorItemId: number | null;
  createdAt: Date;
}

// ---- writes ----

export interface QueueTicketReviewArgs {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  // Known at queue time for a pasted story; a Jira ticket's is read again at prepare time.
  ticket: ClaudeReviewTicket | null;
  originPrId: number | null;
  trigger: TicketReviewTrigger;
  model: string;
}

/** Insert a queued run. Members are written once the run is prepared. */
export async function insertQueuedTicketReview(
  ctx: AgentContext,
  a: QueueTicketReviewArgs,
): Promise<number> {
  const { tr } = tables(ctx);
  const rows = (await ctx.db
    .insert(tr)
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ticketIdent: a.ident,
      ticketKey: a.ticketKey,
      ticketTitle: a.ticketTitle,
      ticketSnapshot: a.ticket,
      originPrId: a.originPrId,
      trigger: a.trigger,
      status: 'queued',
      model: a.model,
    })
    .returning({ id: tr.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

export interface PreparedMember extends FingerprintMember {
  repoId: number;
  checkedOut: boolean;
}

/**
 * The run is prepared: store the story as judged, its hash, the fingerprint and the exact member
 * set (replacing any earlier write for this run), and mark it running. One transaction, so a run is
 * never running with half its members.
 */
export async function markTicketReviewRunning(
  ctx: AgentContext,
  accountId: number,
  id: number,
  p: {
    ticket: ClaudeReviewTicket;
    ticketHash: string;
    fingerprint: string;
    prCount: number;
    members: readonly PreparedMember[];
  },
): Promise<void> {
  const { tr, trm } = tables(ctx);
  await ctx.runTransaction(async (tx) => {
    await tx
      .update(tr)
      .set({
        status: 'running',
        ticketSnapshot: p.ticket,
        ticketTitle: p.ticket.title,
        ticketKey: p.ticket.key ?? null,
        ticketHash: p.ticketHash,
        fingerprint: p.fingerprint,
        prCount: p.prCount,
        startedAt: new Date(),
      })
      .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
      .execute();
    await tx
      .delete(trm)
      .where(and(eq(trm.ticketReviewId, id), eq(trm.accountId, accountId)))
      .execute();
    for (const m of p.members) {
      await tx
        .insert(trm)
        .values({
          ticketReviewId: id,
          accountId,
          prId: m.prId,
          repoId: m.repoId,
          headSha: m.headSha,
          prState: m.state,
          checkedOut: m.checkedOut,
        })
        .execute();
    }
  });
}

/** Update the checkout flags once worktrees are prepared (false = could not be checked out). */
export async function setTicketMemberCheckouts(
  ctx: AgentContext,
  accountId: number,
  id: number,
  checkedOut: ReadonlyMap<number, boolean>,
): Promise<void> {
  const { trm } = tables(ctx);
  for (const [prId, ok] of checkedOut) {
    await ctx.db
      .update(trm)
      .set({ checkedOut: ok })
      .where(and(eq(trm.ticketReviewId, id), eq(trm.accountId, accountId), eq(trm.prId, prId)))
      .execute();
  }
}

/**
 * The server declined to run. Stored as `failed` with the reason (never the model's); the
 * fingerprint and hash are kept when known, so the sweeper does not re-try the same inputs.
 */
export async function markTicketReviewRefused(
  ctx: AgentContext,
  accountId: number,
  id: number,
  r: {
    reason: TicketReviewRefusal;
    prCount?: number | null;
    ticketHash?: string | null;
    fingerprint?: string | null;
    // Spend before the refusal (the card pre-pass runs before the checkouts are judged).
    costUsd?: number | null;
  },
): Promise<void> {
  const { tr } = tables(ctx);
  await ctx.db
    .update(tr)
    .set({
      status: 'failed',
      refused: r.reason,
      prCount: r.prCount ?? null,
      ticketHash: r.ticketHash ?? null,
      fingerprint: r.fingerprint ?? null,
      completedAt: new Date(),
      ...(r.costUsd != null ? { costUsd: r.costUsd } : {}),
    })
    .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
    .execute();
  if (r.costUsd != null) {
    await recordTicketReviewUsage(ctx, accountId, await getTicketReviewRow(ctx, accountId, id), { costUsd: r.costUsd });
  }
}

export interface TicketItemWrite {
  ref: string;
  status: TicketReviewItem['status'];
  title: string;
  body: string;
  ownerPrId: number | null;
  path: string | null;
  line: number | null;
}

export interface TicketReviewSuccess {
  alignment: ClaudeTicketAlignment;
  summary: string | null;
  assessment: TicketAssessment;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  items: readonly TicketItemWrite[];
}

/** The key that makes two items "the same item" across runs: kind + folded text (storyMatchKey). */
export function ticketItemMatchKey(i: { ref: string; title: string }): string {
  return storyMatchKey({ title: i.title, story: { index: 0, ref: i.ref } })!;
}

/**
 * Store a succeeded run: the assessment, then one item row each. An item that matches one of the
 * PREVIOUS succeeded run of the same ticket links to it (`prior_item_id`) and INHERITS its posting,
 * so a re-raise is never posted twice.
 */
export async function saveTicketReviewSuccess(
  ctx: AgentContext,
  accountId: number,
  id: number,
  data: TicketReviewSuccess,
): Promise<void> {
  const { tr, tri } = tables(ctx);
  const run = await getTicketReviewRow(ctx, accountId, id);
  if (run == null) return;
  const prior = await getLatestSucceededRow(ctx, accountId, run.ticketIdent, id);
  const priorItems = prior != null ? await readItems(ctx, accountId, [prior.id]) : [];
  const byKey = new Map<string, TicketItemRow>();
  for (const p of priorItems) {
    const k = ticketItemMatchKey(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  await ctx.runTransaction(async (tx) => {
    await tx
      .update(tr)
      .set({
        status: 'succeeded',
        alignment: data.alignment,
        summary: data.summary,
        assessment: data.assessment,
        costUsd: data.costUsd,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        numTurns: data.numTurns,
        completedAt: new Date(),
      })
      .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
      .execute();
    const used = new Set<number>();
    for (const it of data.items) {
      const match = byKey.get(ticketItemMatchKey(it));
      const prev = match != null && !used.has(match.id) ? match : null;
      if (prev != null) used.add(prev.id);
      await tx
        .insert(tri)
        .values({
          ticketReviewId: id,
          accountId,
          ref: it.ref,
          status: it.status,
          title: it.title,
          body: it.body,
          ownerPrId: it.ownerPrId,
          path: it.path,
          line: it.line,
          priorItemId: prev?.id ?? null,
          postedPrId: prev?.postedCommentId != null ? prev.postedPrId : null,
          postedCommentId: prev?.postedCommentId ?? null,
          postedAt: prev?.postedCommentId != null ? prev.postedAt : null,
          postedAuto: prev?.postedCommentId != null && prev.postedAuto === true ? true : null,
        })
        .execute();
    }
  });
  await recordTicketReviewUsage(ctx, accountId, run, data);
}

type Telemetry = { costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null; numTurns?: number | null };

/** The run's spend into the AI-usage ledger — on success, failure and cancel alike (it was billed). */
async function recordTicketReviewUsage(
  ctx: AgentContext,
  accountId: number,
  run: Pick<TicketReviewRow, 'model' | 'originPrId'> | null,
  t: Telemetry,
): Promise<void> {
  if (run == null || t.costUsd == null || !Number.isFinite(t.costUsd) || t.costUsd <= 0) return;
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'agent',
      feature: 'ticket_review',
      model: run.model,
      costUsd: t.costUsd,
      inputTokens: t.inputTokens ?? null,
      outputTokens: t.outputTokens ?? null,
      prId: run.originPrId,
    })
    .catch(() => {});
}

/**
 * A run that failed. `retryable` (a thrown error — a network, git or database failure) CLEARS the
 * fingerprint: the sweeper skips a newer attempt on identical inputs, which is right for a run that
 * finished without an answer (it would only stop the same way again, and bill again) and wrong for
 * one that never got that far.
 */
export async function markTicketReviewFailed(
  ctx: AgentContext,
  accountId: number,
  id: number,
  error: string,
  telemetry: Telemetry = {},
  opts: { retryable?: boolean } = {},
): Promise<void> {
  const { tr } = tables(ctx);
  await ctx.db
    .update(tr)
    .set({
      status: 'failed',
      error,
      costUsd: telemetry.costUsd ?? null,
      inputTokens: telemetry.inputTokens ?? null,
      outputTokens: telemetry.outputTokens ?? null,
      numTurns: telemetry.numTurns ?? null,
      completedAt: new Date(),
      ...(opts.retryable ? { fingerprint: null } : {}),
    })
    .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
    .execute();
  await recordTicketReviewUsage(ctx, accountId, await getTicketReviewRow(ctx, accountId, id), telemetry);
}

export async function markTicketReviewCancelled(
  ctx: AgentContext,
  accountId: number,
  id: number,
  telemetry: Telemetry = {},
): Promise<void> {
  const { tr } = tables(ctx);
  await ctx.db
    .update(tr)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      ...(telemetry.costUsd != null ? { costUsd: telemetry.costUsd } : {}),
      ...(telemetry.inputTokens != null ? { inputTokens: telemetry.inputTokens } : {}),
      ...(telemetry.outputTokens != null ? { outputTokens: telemetry.outputTokens } : {}),
      ...(telemetry.numTurns != null ? { numTurns: telemetry.numTurns } : {}),
    })
    .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
    .execute();
  await recordTicketReviewUsage(ctx, accountId, await getTicketReviewRow(ctx, accountId, id), telemetry);
}

/**
 * Boot: no job survives a restart, so queued/running rows are failed. Returns how many. The
 * fingerprint is CLEARED, so the sweeper may run the same inputs again — a restart says nothing
 * about them.
 */
export async function reconcileOrphanedTicketReviews(ctx: AgentContext): Promise<number> {
  const { tr } = tables(ctx);
  const changed = (await ctx.db
    .update(tr)
    .set({ status: 'failed', error: 'interrupted by restart', fingerprint: null, completedAt: new Date() })
    .where(inArray(tr.status, ['queued', 'running']))
    .returning({ id: tr.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

/**
 * Record one item's GitHub comment. Compare-and-set: only an item not yet posted (its own posting
 * or an inherited one) is written. Returns false when it was already posted or is not this
 * account's.
 */
export async function markTicketItemPosted(
  ctx: AgentContext,
  accountId: number,
  itemId: number,
  p: { prId: number; commentId: string; postedAt?: Date; auto?: boolean },
): Promise<boolean> {
  const { tri } = tables(ctx);
  const rows = (await ctx.db
    .update(tri)
    .set({
      postedPrId: p.prId,
      postedCommentId: p.commentId,
      postedAt: p.postedAt ?? new Date(),
      ...(p.auto === true ? { postedAuto: true } : {}),
    })
    .where(and(eq(tri.id, itemId), eq(tri.accountId, accountId), isNull(tri.postedCommentId)))
    .returning({ id: tri.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

// ---- reads ----

export async function getTicketReviewRow(
  ctx: AgentContext,
  accountId: number,
  id: number,
): Promise<TicketReviewRow | null> {
  const { tr } = tables(ctx);
  const rows = (await ctx.db
    .select()
    .from(tr)
    .where(and(eq(tr.id, id), eq(tr.accountId, accountId)))
    .limit(1)
    .execute()) as TicketReviewRow[];
  return rows[0] ?? null;
}

/** The newest SUCCEEDED run of a ticket, optionally older than `beforeId`. */
async function getLatestSucceededRow(
  ctx: AgentContext,
  accountId: number,
  ident: string,
  beforeId?: number,
): Promise<TicketReviewRow | null> {
  const { tr } = tables(ctx);
  const preds = [eq(tr.accountId, accountId), eq(tr.ticketIdent, ident), eq(tr.status, 'succeeded')];
  // Ids grow with creation, and `created_at` has one-second resolution in SQLite.
  if (beforeId != null) preds.push(lt(tr.id, beforeId));
  const rows = (await ctx.db
    .select()
    .from(tr)
    .where(and(...preds))
    .orderBy(desc(tr.id))
    .limit(1)
    .execute()) as TicketReviewRow[];
  return rows[0] ?? null;
}

async function readMembers(
  ctx: AgentContext,
  accountId: number,
  runIds: readonly number[],
): Promise<TicketMemberRow[]> {
  if (runIds.length === 0) return [];
  const { trm } = tables(ctx);
  return (await ctx.db
    .select()
    .from(trm)
    .where(and(eq(trm.accountId, accountId), inArray(trm.ticketReviewId, [...new Set(runIds)])))
    .orderBy(asc(trm.prId))
    .execute()) as TicketMemberRow[];
}

async function readItems(
  ctx: AgentContext,
  accountId: number,
  runIds: readonly number[],
): Promise<TicketItemRow[]> {
  if (runIds.length === 0) return [];
  const { tri } = tables(ctx);
  return (await ctx.db
    .select()
    .from(tri)
    .where(and(eq(tri.accountId, accountId), inArray(tri.ticketReviewId, [...new Set(runIds)])))
    .orderBy(asc(tri.id))
    .execute()) as TicketItemRow[];
}

/** Members with their display fields (repo 'owner/name', number, title), this account only. */
async function displayMembers(
  ctx: AgentContext,
  accountId: number,
  rows: readonly TicketMemberRow[],
): Promise<Map<number, TicketReviewMember[]>> {
  const out = new Map<number, TicketReviewMember[]>();
  if (rows.length === 0) return out;
  const { prs, repos } = tables(ctx);
  const prIds = [...new Set(rows.map((r) => r.prId))];
  const info = (await ctx.db
    .select({
      id: prs.id,
      number: prs.number,
      title: prs.title,
      headSha: prs.headSha,
      owner: repos.owner,
      name: repos.name,
    })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.accountId, accountId), inArray(prs.id, prIds)))
    .execute()) as Array<{ id: number; number: number; title: string; headSha: string | null; owner: string; name: string }>;
  const byPr = new Map(info.map((i) => [i.id, i]));
  // Each member's card at its CURRENT synced head (cards.ts currency) — not the head the run read.
  const cards = await readCardsAt(
    ctx,
    accountId,
    info.map((i) => ({ prId: i.id, headSha: i.headSha ?? '' })),
  );
  for (const r of rows) {
    const i = byPr.get(r.prId);
    const list = out.get(r.ticketReviewId) ?? [];
    list.push({
      prId: r.prId,
      repoId: r.repoId,
      repo: i ? `${i.owner}/${i.name}` : '',
      number: i?.number ?? 0,
      title: i?.title ?? null,
      headSha: r.headSha,
      state: r.prState,
      checkedOut: r.checkedOut,
      card: cards.has(r.prId) ? toWireCard(cards.get(r.prId)!) : null,
    });
    out.set(r.ticketReviewId, list);
  }
  return out;
}

export function toItem(r: TicketItemRow, runCreatedAt: Date | null): TicketReviewItem {
  const postedAt = asDate(r.postedAt);
  return {
    id: r.id,
    ticketReviewId: r.ticketReviewId,
    ref: r.ref,
    status: r.status,
    title: r.title,
    body: r.body,
    ownerPrId: r.ownerPrId,
    path: r.path,
    line: r.line,
    priorItemId: r.priorItemId,
    posted:
      r.postedCommentId != null && r.postedPrId != null && postedAt != null
        ? {
            prId: r.postedPrId,
            commentId: r.postedCommentId,
            postedAt: postedAt.toISOString(),
            // Inherited from an earlier run: posted before this run existed.
            carried: r.priorItemId != null && runCreatedAt != null && postedAt.getTime() < runCreatedAt.getTime(),
            ...(r.postedAuto === true ? { auto: true } : {}),
          }
        : null,
  };
}

function toWire(
  r: TicketReviewRow,
  members: TicketReviewMember[],
  items: readonly TicketItemRow[],
): TicketReview {
  const created = asDate(r.createdAt);
  return {
    id: r.id,
    ident: r.ticketIdent,
    ticketKey: r.ticketKey,
    ticketTitle: r.ticketTitle,
    ticket: r.ticketSnapshot ?? null,
    workspaceId: r.workspaceId,
    originPrId: r.originPrId,
    trigger: r.trigger,
    status: r.status,
    model: r.model,
    costUsd: r.costUsd,
    error: r.error,
    refused:
      r.refused != null && (REFUSALS as readonly string[]).includes(r.refused)
        ? { reason: r.refused as TicketReviewRefusal, prCount: r.prCount }
        : null,
    createdAt: isoReq(r.createdAt),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    alignment: asAlignment(r.alignment),
    summary: r.summary,
    assessment: r.status === 'succeeded' ? (r.assessment ?? null) : null,
    members,
    items: items.map((i) => toItem(i, created)),
    autoPost: ticketAutoPostWireOf(r.autoPost),
  };
}

async function hydrate(
  ctx: AgentContext,
  accountId: number,
  rows: readonly TicketReviewRow[],
): Promise<TicketReview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [memberRows, itemRows] = await Promise.all([
    readMembers(ctx, accountId, ids),
    readItems(ctx, accountId, ids),
  ]);
  const members = await displayMembers(ctx, accountId, memberRows);
  return rows.map((r) =>
    toWire(
      r,
      members.get(r.id) ?? [],
      itemRows.filter((i) => i.ticketReviewId === r.id),
    ),
  );
}

/** One run in full; null when it is not this account's (→ 404). */
export async function getTicketReviewById(
  ctx: AgentContext,
  accountId: number,
  id: number,
): Promise<TicketReview | null> {
  const row = await getTicketReviewRow(ctx, accountId, id);
  if (row == null) return null;
  return (await hydrate(ctx, accountId, [row]))[0] ?? null;
}

/** The newest run of a ticket (any status), in full; null when never run. */
export async function getLatestTicketReview(
  ctx: AgentContext,
  accountId: number,
  ident: string,
): Promise<TicketReview | null> {
  const { tr } = tables(ctx);
  const rows = (await ctx.db
    .select()
    .from(tr)
    .where(and(eq(tr.accountId, accountId), eq(tr.ticketIdent, ident)))
    .orderBy(desc(tr.id))
    .limit(1)
    .execute()) as TicketReviewRow[];
  return (await hydrate(ctx, accountId, rows))[0] ?? null;
}

/**
 * The idents of every ticket this PR has been reviewed on — as a member of any run, or as the PR
 * that started one (a refused run has no members) — newest first.
 */
export async function getTicketIdentsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<string[]> {
  const { tr, trm } = tables(ctx);
  const viaMembers = (await ctx.db
    .select({ ident: tr.ticketIdent, createdAt: tr.createdAt, id: tr.id })
    .from(trm)
    .innerJoin(tr, and(eq(tr.id, trm.ticketReviewId), eq(tr.accountId, trm.accountId)))
    .where(and(eq(trm.accountId, accountId), eq(trm.prId, prId)))
    .execute()) as Array<{ ident: string; createdAt: Date; id: number }>;
  const viaOrigin = (await ctx.db
    .select({ ident: tr.ticketIdent, createdAt: tr.createdAt, id: tr.id })
    .from(tr)
    .where(and(eq(tr.accountId, accountId), eq(tr.originPrId, prId)))
    .execute()) as Array<{ ident: string; createdAt: Date; id: number }>;
  const all = [...viaMembers, ...viaOrigin].sort((a, b) => b.id - a.id);
  return [...new Set(all.map((r) => r.ident))];
}

/** The latest run (any status) of each ticket this PR has been reviewed on, newest first. */
export async function listLatestTicketReviewsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<TicketReview[]> {
  const idents = await getTicketIdentsForPr(ctx, accountId, prId);
  if (idents.length === 0) return [];
  const latest = await latestRowsByIdent(ctx, accountId, idents, null);
  const rows = idents.map((i) => latest.get(i)).filter((r): r is TicketReviewRow => r != null);
  return hydrate(ctx, accountId, rows);
}

/** Newest row per ident (optionally of the given statuses), one query. */
async function latestRowsByIdent(
  ctx: AgentContext,
  accountId: number,
  idents: readonly string[],
  statuses: readonly TicketReviewStatus[] | null,
): Promise<Map<string, TicketReviewRow>> {
  const out = new Map<string, TicketReviewRow>();
  const uniq = [...new Set(idents)];
  if (uniq.length === 0) return out;
  const { tr } = tables(ctx);
  const preds = [eq(tr.accountId, accountId), inArray(tr.ticketIdent, uniq)];
  if (statuses != null) preds.push(inArray(tr.status, [...statuses]));
  const rows = (await ctx.db
    .select()
    .from(tr)
    .where(and(...preds))
    .orderBy(desc(tr.id))
    .execute()) as TicketReviewRow[];
  for (const r of rows) if (!out.has(r.ticketIdent)) out.set(r.ticketIdent, r);
  return out;
}

/** What `deriveTicketReviewState` needs per ident, minus the live half. */
export interface TicketStateInputs {
  latest: {
    id: number;
    fingerprint: string | null;
    ticketHash: string | null;
    alignment: ClaudeTicketAlignment | null;
    assessment: TicketAssessment | null;
    completedAt: Date | null;
    members: FingerprintMember[];
  } | null;
  runningRunId: number | null;
  // The newest run of any status (a refused or failed attempt after the last success included):
  // the sweeper compares its fingerprint so it does not re-try identical inputs.
  latestAttempt: { id: number; status: TicketReviewStatus; fingerprint: string | null; refused: string | null } | null;
}

/** Batched: the latest succeeded run (+ members), the in-flight run and the newest attempt, per ident. */
export async function getTicketStateInputs(
  ctx: AgentContext,
  accountId: number,
  idents: readonly string[],
): Promise<Map<string, TicketStateInputs>> {
  const out = new Map<string, TicketStateInputs>();
  const [succeeded, live, any] = await Promise.all([
    latestRowsByIdent(ctx, accountId, idents, ['succeeded']),
    latestRowsByIdent(ctx, accountId, idents, ['queued', 'running']),
    latestRowsByIdent(ctx, accountId, idents, null),
  ]);
  const memberRows = await readMembers(ctx, accountId, [...succeeded.values()].map((r) => r.id));
  for (const ident of new Set(idents)) {
    const s = succeeded.get(ident);
    const run = live.get(ident);
    const a = any.get(ident);
    out.set(ident, {
      latest:
        s != null
          ? {
              id: s.id,
              fingerprint: s.fingerprint,
              ticketHash: s.ticketHash,
              alignment: asAlignment(s.alignment),
              assessment: s.assessment ?? null,
              completedAt: asDate(s.completedAt),
              members: memberRows
                .filter((m) => m.ticketReviewId === s.id)
                .map((m) => ({ prId: m.prId, headSha: m.headSha, state: m.prState })),
            }
          : null,
      runningRunId: run?.id ?? null,
      latestAttempt:
        a != null ? { id: a.id, status: a.status, fingerprint: a.fingerprint, refused: a.refused } : null,
    });
  }
  return out;
}

export interface OwnedTicketItem {
  ticketReviewId: number;
  ident: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  item: TicketReviewItem;
}

/**
 * AI Fix's ticket half: the unmet / partly met items THIS PR owns (`owner_pr_id`), from the LATEST
 * succeeded run of each ticket only — an older run's items are superseded. A MANUAL review-seeded
 * fix may include them; an auto fix never does (the caller's rule).
 */
export async function getOwnedTicketItemsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<OwnedTicketItem[]> {
  const { tr, tri } = tables(ctx);
  const owned = (await ctx.db
    .select({ runId: tri.ticketReviewId, ident: tr.ticketIdent })
    .from(tri)
    .innerJoin(tr, and(eq(tr.id, tri.ticketReviewId), eq(tr.accountId, tri.accountId)))
    .where(and(eq(tri.accountId, accountId), eq(tri.ownerPrId, prId), eq(tr.status, 'succeeded')))
    .execute()) as Array<{ runId: number; ident: string }>;
  if (owned.length === 0) return [];
  const latest = await latestRowsByIdent(ctx, accountId, owned.map((o) => o.ident), ['succeeded']);
  const runs = [...latest.values()].filter((r) => owned.some((o) => o.runId === r.id));
  if (runs.length === 0) return [];
  const items = await readItems(ctx, accountId, runs.map((r) => r.id));
  const out: OwnedTicketItem[] = [];
  for (const r of runs) {
    for (const i of items) {
      if (i.ticketReviewId !== r.id || i.ownerPrId !== prId) continue;
      out.push({
        ticketReviewId: r.id,
        ident: r.ticketIdent,
        ticketKey: r.ticketKey,
        ticketTitle: r.ticketTitle,
        item: toItem(i, asDate(r.createdAt)),
      });
    }
  }
  return out;
}

/** One item with its run and that run's members — the Post route's input. null when not this account's. */
export async function getTicketItemPostContext(
  ctx: AgentContext,
  accountId: number,
  runId: number,
  itemId: number,
): Promise<{ run: TicketReview; item: TicketReviewItem } | null> {
  const run = await getTicketReviewById(ctx, accountId, runId);
  if (run == null) return null;
  const item = run.items.find((i) => i.id === itemId);
  return item != null ? { run, item } : null;
}

/**
 * Automatic ticket reviews (trigger 'auto' or 'cascade') a workspace started since `dayStartMs` —
 * the TICKET_REVIEW_DAILY_CAP counter. Manual runs never count.
 */
export async function countAutoTicketReviewsSince(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  dayStartMs: number,
): Promise<number> {
  const { tr } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: tr.id })
    .from(tr)
    .where(
      and(
        eq(tr.accountId, accountId),
        eq(tr.workspaceId, workspaceId),
        inArray(tr.trigger, ['auto', 'cascade']),
        gte(tr.createdAt, new Date(dayStartMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

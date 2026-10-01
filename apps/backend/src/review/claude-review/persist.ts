import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReview,
  ClaudeReviewFollowUp,
  ClaudeReviewFollowUpRecord,
  ClaudeReviewListItem,
  ClaudeReviewModel,
  ClaudeReviewPrState,
  ClaudeReviewScope,
  ClaudeReviewSummary,
  ClaudeReviewTicket,
  ClaudeReviewTrigger,
  ClaudeReviewVerdict,
  ClaudeTicketAssessment,
  ReviewMode,
  ReviewRouteReason,
} from '@pierre-review/shared';
import type { ReviewFinding } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';
import {
  isFollowUpEligible,
  resolveFindingBody,
  type PriorFindingForFollowUp,
  type PriorReviewForFollowUp,
} from './follow-up.js';

// The Claude Review persistence layer. It reads + writes the claudeReviews /
// claudeReviewFindings tables via ctx.db + ctx.schema (review/agent-context.ts). Only the
// FEATURE-only reads live here; the cross-surface reads (getClaudeReviewFeedItems /
// getUnactionedClaudeReviews / listClaudeReviewsByRepo) live in db/queries.ts.

// ctx.schema is typed loosely (Record<string, any>) — this module addresses tables by name and
// casts result rows, so it compiles identically against either dialect's schema.
/* eslint-disable @typescript-eslint/no-explicit-any */
function tables(ctx: AgentContext): { cr: any; crf: any; prs: any; repos: any } {
  const s = ctx.schema as any;
  return { cr: s.claudeReviews, crf: s.claudeReviewFindings, prs: s.pullRequests, repos: s.repos };
}

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();
const isoReq = (d: unknown): string =>
  d instanceof Date ? d.toISOString() : new Date(d as string | number).toISOString();

// GitHub anchors a file in the PR "Files changed" diff by the SHA-256 of its path.
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

interface FindingRow {
  id: number;
  reviewId: number;
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  editedBody: string | null;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
  fileInDiff: boolean;
  included: boolean;
  postedAt: Date | null;
  githubCommentId: string | null;
  postedCommentKind: 'inline' | 'pr_comment' | null;
  createdAt: Date;
  // Soft reference to the previous-review finding this one re-raises (migration 0070).
  priorFindingId?: number | null;
}

interface ReviewRow {
  id: number;
  prId: number;
  headSha: string;
  status: ClaudeReview['status'];
  model: ClaudeReviewModel;
  scope: ClaudeReviewScope | null;
  reviewMode: ReviewMode | null;
  routeReason: ReviewRouteReason | null;
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  userBody: string | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  diffBytes: number | null;
  diffCapped: boolean | null;
  error: string | null;
  excludedFiles: string[] | null;
  postedReviewId: string | null;
  postedAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
  ticket?: ClaudeReviewTicket | null;
  ticketAssessment?: ClaudeTicketAssessment | null;
  followUp?: ClaudeReviewFollowUpRecord | null;
  // Absent on a host older than core migration 0071 — reads as 'manual'.
  trigger?: string | null;
}

function mapFinding(r: FindingRow): ClaudeFinding {
  return {
    id: r.id,
    reviewId: r.reviewId,
    path: r.path,
    line: r.line,
    side: r.side,
    diffAnchorId: diffAnchorId(r.path),
    severity: r.severity,
    title: r.title,
    body: r.body,
    editedBody: r.editedBody,
    suggestion: r.suggestion,
    diffHunk: r.diffHunk,
    anchored: r.anchored,
    fileInDiff: r.fileInDiff,
    included: r.included,
    postedAt: iso(r.postedAt),
    githubCommentId: r.githubCommentId,
    postedCommentKind: r.postedCommentKind,
    createdAt: isoReq(r.createdAt),
    priorFindingId: r.priorFindingId ?? null,
  };
}

// The stored follow-up + each item's DERIVED `reraisedFindingId` (the first of this run's
// findings whose priorFindingId points at the item's earlier finding).
function mapFollowUp(
  fu: ClaudeReviewFollowUpRecord | null | undefined,
  findings: FindingRow[],
): ClaudeReviewFollowUp | null {
  if (!fu) return null;
  const firstByPrior = new Map<number, number>();
  for (const f of findings) {
    if (f.priorFindingId != null && !firstByPrior.has(f.priorFindingId)) {
      firstByPrior.set(f.priorFindingId, f.id);
    }
  }
  return {
    ...fu,
    items: (fu.items ?? []).map((it) => ({
      ...it,
      reraisedFindingId: firstByPrior.get(it.priorFindingId) ?? null,
    })),
  };
}

function mapReview(r: ReviewRow, findings: FindingRow[]): ClaudeReview {
  return {
    id: r.id,
    prId: r.prId,
    headSha: r.headSha,
    status: r.status,
    model: r.model,
    scope: r.scope,
    reviewMode: r.reviewMode,
    routeReason: r.routeReason,
    summary: r.summary,
    verdict: r.verdict,
    userBody: r.userBody,
    userVerdict: r.userVerdict,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    numTurns: r.numTurns,
    diffBytes: r.diffBytes,
    diffCapped: r.diffCapped,
    error: r.error,
    excludedFiles: r.excludedFiles ?? [],
    postedReviewId: r.postedReviewId,
    postedAt: iso(r.postedAt),
    createdAt: isoReq(r.createdAt),
    finishedAt: iso(r.finishedAt),
    findings: findings.map(mapFinding),
    ticket: r.ticket ?? null,
    ticketAssessment: r.ticketAssessment ?? null,
    followUp: mapFollowUp(r.followUp, findings),
    trigger: r.trigger === 'auto' ? 'auto' : 'manual',
  };
}

const summaryOf = (r: ReviewRow): ClaudeReviewSummary => ({
  id: r.id,
  headSha: r.headSha,
  status: r.status,
  model: r.model,
  scope: r.scope,
  reviewMode: r.reviewMode,
  verdict: r.verdict,
  userVerdict: r.userVerdict,
  costUsd: r.costUsd,
  postedAt: iso(r.postedAt),
  createdAt: isoReq(r.createdAt),
  finishedAt: iso(r.finishedAt),
  trigger: r.trigger === 'auto' ? 'auto' : 'manual',
});

// ---- Reads (account-scoped via the join up to repos.accountId — IDOR guard) ----

export async function getClaudeReviewById(
  ctx: AgentContext,
  reviewId: number,
  accountId: number,
): Promise<ClaudeReview | null> {
  const { cr, crf, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({ review: cr })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.id, reviewId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ review: ReviewRow }>;
  const row = rows[0]?.review ?? null;
  if (!row) return null;
  const findings = (await ctx.db
    .select()
    .from(crf)
    .where(eq(crf.reviewId, reviewId))
    .orderBy(asc(crf.id))
    .execute()) as FindingRow[];
  return mapReview(row, findings);
}

export async function getLatestClaudeReview(
  ctx: AgentContext,
  prId: number,
  accountId: number,
): Promise<ClaudeReview | null> {
  const { cr, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.prId, prId), eq(repos.accountId, accountId)))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  const row = rows[0] ?? null;
  if (!row) return null;
  return getClaudeReviewById(ctx, row.id, accountId);
}

export async function listClaudeReviewHistory(
  ctx: AgentContext,
  prId: number,
  accountId: number,
): Promise<ClaudeReviewSummary[]> {
  const { cr, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({ review: cr })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.prId, prId), eq(repos.accountId, accountId)))
    .orderBy(desc(cr.id))
    .execute()) as Array<{ review: ReviewRow }>;
  return rows.map(({ review }) => summaryOf(review));
}

// The window that scopes the cross-PR list (mirrors the core backfill default of 90d).
const LIST_WINDOW_DAYS = Number.parseInt(process.env.PRO_REVIEW_LIST_WINDOW_DAYS ?? '', 10) || 90;

export async function listAllClaudeReviews(
  ctx: AgentContext,
  accountId: number,
): Promise<ClaudeReviewListItem[]> {
  const { cr, prs, repos } = tables(ctx);
  const cutoff = new Date(Date.now() - LIST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // sqlite timestamps are unix SECONDS; pg is a Date. Bind the dialect-appropriate value.
  const tsBound = ctx.isPg ? cutoff : Math.floor(cutoff.getTime() / 1000);
  const rows = (await ctx.db
    .select({
      reviewId: cr.id,
      prId: cr.prId,
      owner: repos.owner,
      name: repos.name,
      prNumber: prs.number,
      prTitle: prs.title,
      prState: prs.state,
      summary: cr.summary,
      verdict: cr.verdict,
      headSha: cr.headSha,
      status: cr.status,
      createdAt: cr.createdAt,
      finishedAt: cr.finishedAt,
    })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        eq(cr.status, 'succeeded'),
        or(
          eq(prs.state, 'open'),
          gte(sql`coalesce(${prs.mergedAt}, ${prs.closedAt}, ${prs.openedAt})`, tsBound),
        ),
      ),
    )
    .orderBy(desc(cr.finishedAt), desc(cr.createdAt))
    .execute()) as Array<{
    reviewId: number;
    prId: number;
    owner: string;
    name: string;
    prNumber: number;
    prTitle: string;
    prState: ClaudeReviewListItem['prState'];
    summary: string | null;
    verdict: ClaudeReviewVerdict | null;
    headSha: string;
    status: ClaudeReview['status'];
    createdAt: Date;
    finishedAt: Date | null;
  }>;

  const seen = new Set<number>();
  const items: ClaudeReviewListItem[] = [];
  for (const r of rows) {
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    items.push({
      reviewId: r.reviewId,
      prId: r.prId,
      repoFullName: `${r.owner}/${r.name}`,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prState: r.prState,
      summary: r.summary,
      verdict: r.verdict,
      headSha: r.headSha,
      status: r.status,
      createdAt: isoReq(r.createdAt),
      finishedAt: iso(r.finishedAt),
    });
  }
  return items;
}

/**
 * The LATEST run per PR for a batch of PR ids — the Open PRs table's "Claude review" column, ONE
 * query for the whole list. Account-scoped through `repos.accountId` (a foreign or unknown id is
 * simply absent). `headMoved` compares the run's head with the PR's SYNCED head; an unknown synced
 * head is never "moved". DB-only: no GitHub call, no model.
 */
export async function getLatestReviewStates(
  ctx: AgentContext,
  prIds: readonly number[],
  accountId: number,
): Promise<ClaudeReviewPrState[]> {
  if (prIds.length === 0) return [];
  const { cr, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({
      reviewId: cr.id,
      prId: cr.prId,
      status: cr.status,
      verdict: cr.verdict,
      headSha: cr.headSha,
      finishedAt: cr.finishedAt,
      ticket: cr.ticket,
      prHeadSha: prs.headSha,
      trigger: cr.trigger,
    })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(inArray(cr.prId, [...prIds]), eq(repos.accountId, accountId)))
    .orderBy(desc(cr.id))
    .execute()) as Array<{
    reviewId: number;
    prId: number;
    status: ClaudeReview['status'];
    verdict: ClaudeReviewVerdict | null;
    headSha: string;
    finishedAt: Date | null;
    ticket: ClaudeReviewTicket | null;
    prHeadSha: string | null;
    trigger: string | null;
  }>;
  const out: ClaudeReviewPrState[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.prId)) continue; // newest first — the first row per PR is its latest run
    seen.add(r.prId);
    out.push({
      prId: r.prId,
      reviewId: r.reviewId,
      status: r.status,
      verdict: r.verdict,
      reviewedHeadSha: r.headSha,
      finishedAt: iso(r.finishedAt),
      ticket: r.ticket ?? null,
      headMoved: r.prHeadSha != null && r.prHeadSha !== r.headSha,
      trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    });
  }
  return out;
}

// ---- Post contexts (repo/PR coordinates for the GitHub posting seam) ----

export interface ReviewPostContext {
  reviewHeadSha: string;
  owner: string;
  name: string;
  prNumber: number;
  userBody: string | null;
}

export async function getReviewPostContext(
  ctx: AgentContext,
  reviewId: number,
  accountId: number,
): Promise<ReviewPostContext | null> {
  const { cr, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({
      headSha: cr.headSha,
      userBody: cr.userBody,
      owner: repos.owner,
      name: repos.name,
      prNumber: prs.number,
    })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.id, reviewId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    headSha: string;
    userBody: string | null;
    owner: string;
    name: string;
    prNumber: number;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    reviewHeadSha: row.headSha,
    userBody: row.userBody,
    owner: row.owner,
    name: row.name,
    prNumber: row.prNumber,
  };
}

export interface FindingPostContext {
  finding: FindingRow;
  reviewHeadSha: string;
  owner: string;
  name: string;
  prNumber: number;
}

export async function getFindingPostContext(
  ctx: AgentContext,
  findingId: number,
  accountId: number,
): Promise<FindingPostContext | null> {
  const { cr, crf, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({
      finding: crf,
      reviewHeadSha: cr.headSha,
      owner: repos.owner,
      name: repos.name,
      prNumber: prs.number,
    })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(crf.id, findingId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    finding: FindingRow;
    reviewHeadSha: string;
    owner: string;
    name: string;
    prNumber: number;
  }>;
  const row = rows[0];
  if (!row) return null;
  return { finding: row.finding, reviewHeadSha: row.reviewHeadSha, owner: row.owner, name: row.name, prNumber: row.prNumber };
}

// PR coordinates needed to run a review.
export interface ReviewPrContext {
  prId: number;
  owner: string;
  name: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  baseRefName: string | null;
  headSha: string | null;
}

export async function getReviewPrContext(
  ctx: AgentContext,
  prId: number,
  accountId: number,
): Promise<ReviewPrContext | null> {
  const { prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({
      prId: prs.id,
      owner: repos.owner,
      name: repos.name,
      number: prs.number,
      title: prs.title,
      body: prs.body,
      baseRefName: prs.baseRefName,
      headSha: prs.headSha,
    })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    prId: number;
    owner: string;
    name: string;
    number: number;
    title: string;
    body: string | null;
    baseRefName: string | null;
    headSha: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    prId: row.prId,
    owner: row.owner,
    name: row.name,
    repoFullName: `${row.owner}/${row.name}`,
    number: row.number,
    title: row.title,
    body: row.body,
    baseRefName: row.baseRefName,
    headSha: row.headSha,
  };
}

// ---- The previous review, for the follow-up ----

/**
 * The PREVIOUS review a new run follows up on, with its eligible findings — or null.
 *
 * The previous review is the newest SUCCEEDED run for the same PR (account-scoped through the
 * repos join — the getLatestClaudeReview IDOR pattern) with an id below the current run's, that
 * actually READ code: `review_mode IS NULL OR review_mode <> 'skip'`. ⚠ The NULL arm is
 * load-bearing — pre-routing rows have no mode, and a bare `<>` drops NULL rows in SQL.
 *
 * Its findings are kept when eligible (`isFollowUpEligible`: not ignored — or posted — and not
 * praise), with the body the user saw. CARRY-FORWARD re-loads two kinds of OLDER finding named by
 * that run's follow-up items — the ids come only from our own stored JSON and are re-scoped to this
 * PR + account by the query — and marks them `carried`, so nothing drops out of the chain:
 *   - every 'not_checked' item (never shown to the model, or not reported on), when eligible;
 *   - every still-open item (not / partly addressed) that no ELIGIBLE finding of that run raises
 *     again, when the earlier finding was POSTED. That is the re-raise follow-up.ts saved left out
 *     because the comment was already on the same commit (`isAlreadyOnThisCommit`) — the reader
 *     never ignored it — or one the reader ignored while the original stays on the pull request,
 *     which is exactly `isFollowUpEligible`'s "posted counts whatever the tick says now".
 *
 * Every finding carries the head of the review that RAISED it (`cr.headSha` via the join), because
 * "has the code moved since?" is asked per finding, never against the previous review's head.
 */
export async function loadPriorReviewForFollowUp(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
): Promise<PriorReviewForFollowUp | null> {
  const { cr, crf, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha, followUp: cr.followUp })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(
      and(
        eq(cr.prId, prId),
        eq(repos.accountId, accountId),
        eq(cr.status, 'succeeded'),
        lt(cr.id, beforeReviewId),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{
    id: number;
    headSha: string;
    followUp: ClaudeReviewFollowUpRecord | null;
  }>;
  const row = rows[0];
  if (!row) return null;

  const toPrior = (f: FindingRow, headSha: string, carried: boolean): PriorFindingForFollowUp => ({
    id: f.id,
    headSha,
    path: f.path,
    line: f.line,
    side: f.side,
    severity: f.severity,
    title: f.title,
    body: resolveFindingBody(f),
    suggestion: f.suggestion,
    diffHunk: f.diffHunk,
    anchored: f.anchored,
    fileInDiff: f.fileInDiff,
    posted: f.postedAt != null,
    carried,
  });

  const own = (await ctx.db
    .select()
    .from(crf)
    .where(eq(crf.reviewId, row.id))
    .orderBy(asc(crf.id))
    .execute()) as FindingRow[];
  const eligibleOwn = own.filter(isFollowUpEligible);
  const findings: PriorFindingForFollowUp[] = eligibleOwn.map((f) => toPrior(f, row.headSha, false));

  const seen = new Set(own.map((f) => f.id));
  // An earlier finding an eligible finding of that run already raises again is followed up
  // THROUGH that re-raise, never twice.
  const reraisedByEligible = new Set(
    eligibleOwn.map((f) => f.priorFindingId).filter((id): id is number => id != null),
  );
  const notChecked = new Set<number>();
  const openPostedOnly = new Set<number>();
  for (const it of row.followUp?.items ?? []) {
    if (!Number.isInteger(it.priorFindingId) || seen.has(it.priorFindingId)) continue;
    if (it.status === 'not_checked') notChecked.add(it.priorFindingId);
    else if (
      (it.status === 'not_addressed' || it.status === 'partly_addressed') &&
      !reraisedByEligible.has(it.priorFindingId)
    ) {
      openPostedOnly.add(it.priorFindingId);
    }
  }
  const carriedIds = [...new Set([...notChecked, ...openPostedOnly])];
  if (carriedIds.length > 0) {
    const carriedRows = (await ctx.db
      .select({ finding: crf, headSha: cr.headSha })
      .from(crf)
      .innerJoin(cr, eq(cr.id, crf.reviewId))
      .innerJoin(prs, eq(prs.id, cr.prId))
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(
        and(inArray(crf.id, carriedIds), eq(cr.prId, prId), eq(repos.accountId, accountId)),
      )
      .orderBy(asc(crf.id))
      .execute()) as Array<{ finding: FindingRow; headSha: string }>;
    for (const { finding, headSha } of carriedRows) {
      if (seen.has(finding.id) || !isFollowUpEligible(finding)) continue;
      // A still-open item is carried only when its comment is ON the pull request.
      if (!notChecked.has(finding.id) && finding.postedAt == null) continue;
      seen.add(finding.id);
      findings.push(toPrior(finding, headSha, true));
    }
  }
  return { reviewId: row.id, headSha: row.headSha, findings };
}

// ---- Writers ----

// The ticket is stored at QUEUE time (not on success), so a failed or cancelled run still
// prefills the SPA's panel for the re-run.
export async function insertQueuedReview(
  ctx: AgentContext,
  prId: number,
  headSha: string,
  model: ClaudeReviewModel,
  accountId: number,
  ticket: ClaudeReviewTicket | null = null,
  // TRAILING: who started it. 'auto' = the per-workspace sweeper (auto.ts). A label only: core's
  // My Turn read keeps an auto run exactly like a manual one, and the chip says "Auto review".
  trigger: ClaudeReviewTrigger = 'manual',
): Promise<number> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .insert(cr)
    .values({ accountId, prId, headSha, status: 'queued', model, ticket, trigger })
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

export async function markReviewRunning(ctx: AgentContext, id: number): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db.update(cr).set({ status: 'running' }).where(eq(cr.id, id)).execute();
}

export async function markReviewRouted(
  ctx: AgentContext,
  id: number,
  reviewMode: ReviewMode,
  routeReason: ReviewRouteReason,
): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db.update(cr).set({ reviewMode, routeReason }).where(eq(cr.id, id)).execute();
}

export interface ReviewSuccessData {
  scope: ClaudeReviewScope | null;
  summary: string;
  verdict: ClaudeReviewVerdict;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  numTurns: number | null;
  diffBytes?: number | null;
  diffCapped?: boolean | null;
  excludedFiles: string[];
  // `priorFindingId` set on a finding that re-raises a still-open earlier one; `included: false`
  // only on a re-raise of a comment already posted on this commit (absent ⇒ included).
  findings: Array<ReviewFinding & { priorFindingId?: number | null; included?: boolean }>;
  followUp?: ClaudeReviewFollowUpRecord | null;
  ticketAssessment?: ClaudeTicketAssessment | null;
}

export async function saveReviewSuccess(
  ctx: AgentContext,
  id: number,
  data: ReviewSuccessData,
): Promise<void> {
  const { cr, crf } = tables(ctx);
  await ctx.runTransaction(async (tx) => {
    await tx
      .update(cr)
      .set({
        status: 'succeeded',
        scope: data.scope,
        summary: data.summary,
        verdict: data.verdict,
        costUsd: data.costUsd,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheReadTokens: data.cacheReadTokens ?? null,
        cacheCreationTokens: data.cacheCreationTokens ?? null,
        numTurns: data.numTurns,
        diffBytes: data.diffBytes ?? null,
        diffCapped: data.diffCapped ?? null,
        excludedFiles: data.excludedFiles,
        followUp: data.followUp ?? null,
        ticketAssessment: data.ticketAssessment ?? null,
        finishedAt: new Date(),
      })
      .where(eq(cr.id, id))
      .execute();
    for (const f of data.findings) {
      await tx
        .insert(crf)
        .values({
          reviewId: id,
          path: f.path,
          line: f.line,
          side: f.side,
          severity: f.severity,
          title: f.title,
          body: f.body,
          suggestion: f.suggestion,
          diffHunk: f.diffHunk,
          anchored: f.anchored,
          fileInDiff: f.fileInDiff,
          // Findings are INCLUDED by default (the UI is opt-OUT); the column default is
          // false for back-compat, so set it here. The one exception arrives as `included:
          // false`: a re-raise of a comment already posted on this same commit (follow-up.ts
          // `isAlreadyOnThisCommit`), so Post review does not put it on GitHub twice.
          included: f.included ?? true,
          priorFindingId: f.priorFindingId ?? null,
        })
        .execute();
    }
  });
  await recordReviewUsage(ctx, id, data.costUsd, data.inputTokens, data.outputTokens).catch(() => {});
}

export interface ReviewFailTelemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  numTurns?: number | null;
  diffBytes?: number | null;
  diffCapped?: boolean | null;
  scope?: ClaudeReviewScope | null;
  excludedFiles?: string[];
}

export async function markReviewFailed(
  ctx: AgentContext,
  id: number,
  error: string,
  telemetry: ReviewFailTelemetry = {},
): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db
    .update(cr)
    .set({
      status: 'failed',
      error: error.slice(0, 4000),
      costUsd: telemetry.costUsd ?? null,
      inputTokens: telemetry.inputTokens ?? null,
      outputTokens: telemetry.outputTokens ?? null,
      cacheReadTokens: telemetry.cacheReadTokens ?? null,
      cacheCreationTokens: telemetry.cacheCreationTokens ?? null,
      numTurns: telemetry.numTurns ?? null,
      diffBytes: telemetry.diffBytes ?? null,
      diffCapped: telemetry.diffCapped ?? null,
      scope: telemetry.scope ?? null,
      excludedFiles: telemetry.excludedFiles ?? null,
      finishedAt: new Date(),
    })
    .where(eq(cr.id, id))
    .execute();
  await recordReviewUsage(ctx, id, telemetry.costUsd, telemetry.inputTokens, telemetry.outputTokens).catch(() => {});
}

export async function markReviewCancelled(ctx: AgentContext, id: number): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db
    .update(cr)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(eq(cr.id, id))
    .execute();
}

export async function updateReviewDraft(
  ctx: AgentContext,
  id: number,
  fields: { userBody?: string; userVerdict?: ClaudeReviewVerdict },
): Promise<boolean> {
  const set = {
    ...(fields.userBody !== undefined ? { userBody: fields.userBody } : {}),
    ...(fields.userVerdict !== undefined ? { userVerdict: fields.userVerdict } : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const { cr } = tables(ctx);
  const changed = (await ctx.db
    .update(cr)
    .set(set)
    .where(eq(cr.id, id))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return changed.length > 0;
}

export async function updateFinding(
  ctx: AgentContext,
  findingId: number,
  fields: { included?: boolean; editedBody?: string },
): Promise<boolean> {
  const set = {
    ...(fields.included !== undefined ? { included: fields.included } : {}),
    ...(fields.editedBody !== undefined
      ? { editedBody: fields.editedBody === '' ? null : fields.editedBody }
      : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const { crf } = tables(ctx);
  const changed = (await ctx.db
    .update(crf)
    .set(set)
    .where(eq(crf.id, findingId))
    .returning({ id: crf.id })
    .execute()) as Array<{ id: number }>;
  return changed.length > 0;
}

export async function markReviewPosted(
  ctx: AgentContext,
  id: number,
  postedReviewId: string,
  inlineFindingIds: number[],
  prComments: { findingId: number; commentId: string }[] = [],
): Promise<void> {
  const { cr, crf } = tables(ctx);
  const now = new Date();
  await ctx.runTransaction(async (tx) => {
    await tx.update(cr).set({ postedReviewId, postedAt: now }).where(eq(cr.id, id)).execute();
    if (inlineFindingIds.length > 0) {
      await tx
        .update(crf)
        .set({ postedAt: now, postedCommentKind: 'inline' })
        .where(inArray(crf.id, inlineFindingIds))
        .execute();
    }
    for (const pc of prComments) {
      await tx
        .update(crf)
        .set({ postedAt: now, githubCommentId: pc.commentId, postedCommentKind: 'pr_comment' })
        .where(eq(crf.id, pc.findingId))
        .execute();
    }
  });
}

export async function markFindingPosted(
  ctx: AgentContext,
  findingId: number,
  githubCommentId: string,
  kind: 'inline' | 'pr_comment' = 'inline',
): Promise<void> {
  const { crf } = tables(ctx);
  await ctx.db
    .update(crf)
    .set({ postedAt: new Date(), githubCommentId, postedCommentKind: kind })
    .where(eq(crf.id, findingId))
    .execute();
}

// On startup, heal runs left mid-flight by a crash/restart.
export async function reconcileOrphanedReviews(ctx: AgentContext): Promise<number> {
  const { cr } = tables(ctx);
  const changed = (await ctx.db
    .update(cr)
    .set({ status: 'failed', error: 'interrupted by restart', finishedAt: new Date() })
    .where(inArray(cr.status, ['queued', 'running']))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

// Record a run's cost on the shared AI-usage ledger (agent seam). Reads accountId/model/prId
// back off the row. Best-effort — a $0 / non-billing run records nothing.
async function recordReviewUsage(
  ctx: AgentContext,
  id: number,
  costUsd: number | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): Promise<void> {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return;
  const { cr } = tables(ctx);
  const row = (
    (await ctx.db
      .select({ accountId: cr.accountId, model: cr.model, prId: cr.prId })
      .from(cr)
      .where(eq(cr.id, id))
      .limit(1)
      .execute()) as Array<{ accountId: number; model: string; prId: number }>
  )[0];
  if (!row) return;
  await ctx.recordAiUsage({
    accountId: row.accountId,
    seam: 'agent',
    feature: 'claude_review',
    model: row.model,
    costUsd,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    prId: row.prId,
  });
}

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  ClaudeFinding,
  ClaudeFindingLens,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFindingStory,
  ClaudeReview,
  ClaudeReviewFollowUp,
  ClaudeReviewFollowUpRecord,
  ClaudeReviewHeadState,
  ClaudeReviewListItem,
  ClaudeReviewModel,
  ClaudeReviewPrState,
  ClaudeReviewScope,
  ClaudeReviewStateSummary,
  ClaudeReviewSummary,
  ClaudeReviewTicket,
  ClaudeReviewTrigger,
  ClaudeReviewVerdict,
  ClaudeCiFailure,
  ClaudeCiFailuresRecord,
  ClaudeAutoPostRecord,
  ClaudeAutoPostWire,
  ClaudeThreadAssessment,
  ClaudeTicketAssessment,
  ReviewMode,
  ReviewRouteReason,
  StoredPrFile,
} from '@pierre-review/shared';
import { CLAUDE_FINDING_LENSES, threadAssessmentCounts } from '@pierre-review/shared';
import { storedList, stripStoredStoryLead } from '@pierre-review/shared';
import type { ClaudeSettledFinding, FindingAutoResolveRecord, FindingPushbackRecord } from '@pierre-review/shared';
import type { ReviewFinding } from '../../pro/contract.js';
import { ticketEntriesOf } from './ticket.js';
import { findFindingThread, type ThreadComment } from './finding-thread.js';
import {
  acceptedReplyFindings,
  unjudgedReplyCandidateIds,
  type AcceptedItemLike,
  type SettledFinding,
} from './settled-by-reply.js';
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
  // The specialist lens (migration 0075 / pg 0062). Free text in the column; narrowed on read.
  lens?: string | null;
  // A story finding's origin (migration 0079 / pg 0066): both set or both null.
  storyIndex?: number | null;
  storyRef?: string | null;
  // Posted by auto-posting (migration 0087 / pg 0074).
  postedAuto?: boolean | null;
  // Auto resolve's record on this finding's thread (migration 0091 / pg 0078).
  autoResolve?: FindingAutoResolveRecord | null;
  // The one pushback reply on this finding's thread (migration 0092 / pg 0079).
  pushback?: FindingPushbackRecord | null;
}

// A story finding's origin off its row; null unless BOTH columns hold a value.
export function storyOf(r: Pick<FindingRow, 'storyIndex' | 'storyRef'>): ClaudeFindingStory | null {
  return r.storyIndex != null && Number.isInteger(r.storyIndex) && r.storyIndex >= 0 && r.storyRef
    ? { index: r.storyIndex, ref: r.storyRef }
    : null;
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
  // One object on runs from before several tickets; an array since (`storedList` reads both).
  ticket?: ClaudeReviewTicket | ClaudeReviewTicket[] | null;
  ticketAssessment?: ClaudeTicketAssessment | ClaudeTicketAssessment[] | null;
  followUp?: ClaudeReviewFollowUpRecord | null;
  // Absent on a host older than core migration 0071 — reads as 'manual'.
  trigger?: string | null;
  // Other reviewers' open threads, judged (migration 0076 / pg 0063). null on older rows.
  threadAssessments?: ClaudeThreadAssessment[] | null;
  commentsThrough?: Date | null;
  // The head's CI + each failing check, diagnosed (migration 0077 / pg 0064). null on older rows.
  ciFailures?: ClaudeCiFailuresRecord | null;
  // What auto-posting did with this run (migration 0087 / pg 0074). null on every other row.
  autoPost?: ClaudeAutoPostRecord | null;
}

/** The stored auto-post record → the wire (ids dropped). null for anything malformed. */
export function autoPostWireOf(v: unknown): ClaudeAutoPostWire | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Partial<ClaudeAutoPostRecord>;
  if (typeof r.status !== 'string' || typeof r.at !== 'string') return null;
  return {
    status: r.status,
    at: r.at,
    reason: r.reason ?? null,
    error: r.error ?? null,
    postedCount: Array.isArray(r.postedFindingIds) ? r.postedFindingIds.length : 0,
    ...(r.reason === 'already_posted'
      ? { alreadyPostedCount: Array.isArray(r.alreadyPostedFindingIds) ? r.alreadyPostedFindingIds.length : 0 }
      : {}),
    ...(r.verdict != null && typeof r.verdict === 'object' ? { verdict: r.verdict } : {}),
  };
}

// A stored CI record, or null for an older row / anything malformed (never a guessed shape).
export function ciRecordOf(v: unknown): ClaudeCiFailuresRecord | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Partial<ClaudeCiFailuresRecord>;
  if (!Array.isArray(r.failures) || typeof r.state !== 'string') return null;
  return {
    state: r.state,
    checkCount: typeof r.checkCount === 'number' ? r.checkCount : 0,
    failures: r.failures,
  };
}

/**
 * Whether a stored finding is SHOWN. Praise is no longer a finding (new runs cannot submit one), and
 * an older run's stored praise rows are hidden on every read the SPA, the chat, posting and the
 * counts go through — never deleted. ⚠ Not applied to `ownPostedCommentsForPrs`: a praise comment
 * already on GitHub is still Limn's own comment.
 */
export function isShownFinding(f: { severity: ClaudeFindingSeverity }): boolean {
  return f.severity !== 'praise';
}

type IncludedFacts = { included?: boolean | null; postedAt?: unknown; priorFindingId?: number | null };

/**
 * The server's own left-out re-raise: `included: false` stored on a RE-RAISE (a `priorFindingId`)
 * of a comment already posted on this same commit (follow-up.ts `isAlreadyOnThisCommit`, written
 * below) — an issue still OPEN, just not posted twice.
 */
export function isAlreadyPostedReraise(f: IncludedFacts): boolean {
  return f.included === false && f.postedAt == null && f.priorFindingId != null;
}

/**
 * `included = false` is TWO facts, and only one is a READER'S IGNORE — every reader of the flag
 * meaning "the reader ignored it" goes through this, never a bare `included === false`.
 */
export function isReaderIgnoredFinding(f: IncludedFacts): boolean {
  return f.included === false && !isAlreadyPostedReraise(f);
}

function mapFinding(r: FindingRow, threadIds?: ReadonlyMap<number, number>): ClaudeFinding {
  return {
    id: r.id,
    reviewId: r.reviewId,
    path: r.path,
    line: r.line,
    side: r.side,
    diffAnchorId: diffAnchorId(r.path),
    severity: r.severity,
    title: r.title,
    // A story finding stored before its lead moved to post time began with that lead, which only
    // repeated the title on screen (shared `stripStoredStoryLead`).
    body: stripStoredStoryLead(r.body, storyOf(r)),
    editedBody: r.editedBody,
    suggestion: r.suggestion,
    diffHunk: r.diffHunk,
    anchored: r.anchored,
    fileInDiff: r.fileInDiff,
    included: r.included,
    postedAt: iso(r.postedAt),
    githubCommentId: r.githubCommentId,
    postedCommentKind: r.postedCommentKind,
    postedAuto: r.postedAuto === true && r.postedAt != null,
    createdAt: isoReq(r.createdAt),
    priorFindingId: r.priorFindingId ?? null,
    lens: asLens(r.lens),
    story: storyOf(r),
    autoResolve: r.autoResolve ?? null,
    // COMPUTED ON READ, never stored: a posted INLINE finding's comment is a synced review comment
    // (`review_comments.database_id`), whose thread is the Changes tab's jump target. A finding
    // posted inside a review before its comment id was read back matches by its root comment
    // (`postedFindingThreadIds`).
    threadId: r.postedCommentKind === 'inline' ? (threadIds?.get(r.id) ?? null) : null,
  };
}

// A stored lens outside today's list reads as a general finding, never a made-up label.
function asLens(v: string | null | undefined): ClaudeFindingLens | null {
  return v != null && (CLAUDE_FINDING_LENSES as readonly string[]).includes(v)
    ? (v as ClaudeFindingLens)
    : null;
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

function mapReview(
  r: ReviewRow,
  findings: FindingRow[],
  head: ClaudeReviewHeadState | null = null,
  threadIds?: ReadonlyMap<number, number>,
): ClaudeReview {
  const tickets = ticketEntriesOf(r.ticket, r.ticketAssessment);
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
    findings: findings.map((f) => mapFinding(f, threadIds)),
    tickets,
    ticket: tickets[0]?.ticket ?? null,
    ticketAssessment: tickets[0]?.assessment ?? null,
    head,
    followUp: mapFollowUp(r.followUp, findings),
    trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    // null = this run did not assess threads (older row, skip, not succeeded) — never [].
    threadAssessments: Array.isArray(r.threadAssessments) ? r.threadAssessments : null,
    threadAssessmentCounts: Array.isArray(r.threadAssessments)
      ? threadAssessmentCounts(r.threadAssessments)
      : null,
    // null = this run did not look at CI (older row, skip, not succeeded, checks unreadable).
    ...ciWireOf(r.ciFailures),
    autoPost: autoPostWireOf(r.autoPost),
  };
}

function ciWireOf(v: unknown): Pick<ClaudeReview, 'ciFailures' | 'ciState'> {
  const rec = ciRecordOf(v);
  return rec
    ? { ciFailures: rec.failures, ciState: { state: rec.state, checkCount: rec.checkCount } }
    : { ciFailures: null, ciState: null };
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
    .select({ review: cr, prHeadSha: prs.headSha })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.id, reviewId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ review: ReviewRow; prHeadSha: string | null }>;
  const row = rows[0]?.review ?? null;
  if (!row) return null;
  const findings = ((await ctx.db
    .select()
    .from(crf)
    .where(eq(crf.reviewId, reviewId))
    .orderBy(asc(crf.id))
    .execute()) as FindingRow[]).filter(isShownFinding);
  const head = await reviewHeadState(ctx, row.prId, row.headSha, rows[0]!.prHeadSha);
  const threadIds = await postedFindingThreadIds(ctx, row.prId, accountId, findings);
  const review = mapReview(row, findings, head, threadIds);
  if (review.followUp) review.followUp = await withThreadState(ctx, row.prId, review.followUp);
  if (row.status === 'succeeded') review.settledEarlier = await settledEarlierFor(ctx, row.prId, accountId, row.id, review.followUp ?? null);
  return review;
}

/**
 * DERIVED on read: the findings an EARLIER review settled by accepting a reply, which therefore
 * left this run's follow-up (`ClaudeReview.settledEarlier`). The same loader the run uses
 * (`loadSettledByReplyFindings`), so the pane and the prompt name the same findings. DB-only, no
 * model call. An id this run's own follow-up still lists is left out (it shows there).
 */
async function settledEarlierFor(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  reviewId: number,
  fu: ClaudeReviewFollowUp | null,
): Promise<ClaudeSettledFinding[]> {
  const settled = await loadSettledByReplyFindings(ctx, prId, accountId, reviewId);
  const listed = new Set((fu?.items ?? []).map((it) => it.priorFindingId));
  return settled
    .filter((f) => !listed.has(f.id) && f.severity !== 'praise')
    .map((f) => ({
      priorFindingId: f.id,
      path: f.path,
      line: f.line ?? null,
      ...(f.side ? { side: f.side } : {}),
      ...(f.severity ? { severity: f.severity } : {}),
      title: f.title,
      acceptKind: f.acceptKind ?? null,
      reply: f.replyAuthor !== 'unknown' || f.reply !== '' ? { author: f.replyAuthor, excerpt: f.reply } : null,
      acceptedInReviewId: f.acceptedInReviewId ?? null,
    }));
}

/**
 * DERIVED on read, for follow-up items whose thread was found at run time (`threadFindingId`): is
 * the thread resolved NOW, and what auto resolve / the pushback did on it (both are recorded on the
 * thread's OWNER finding row, which may belong to an older run). Scoped to this PR, which the
 * caller already ownership-checked.
 */
async function withThreadState(
  ctx: AgentContext,
  prId: number,
  fu: ClaudeReviewFollowUp,
): Promise<ClaudeReviewFollowUp> {
  const ownerIds = [...new Set(fu.items.map((it) => it.threadFindingId).filter((x): x is number => x != null))];
  const threadIds = [...new Set(fu.items.map((it) => it.threadId).filter((x): x is number => x != null))];
  if (ownerIds.length === 0 && threadIds.length === 0) return fu;
  const { cr, crf } = tables(ctx);
  const rt = (ctx.schema as any).reviewThreads;
  const [owners, threads] = await Promise.all([
    ownerIds.length === 0
      ? Promise.resolve([] as Array<{ id: number; autoResolve: FindingAutoResolveRecord | null; pushback: FindingPushbackRecord | null }>)
      : (ctx.db
          .select({ id: crf.id, autoResolve: crf.autoResolve, pushback: crf.pushback })
          .from(crf)
          .innerJoin(cr, eq(cr.id, crf.reviewId))
          .where(and(inArray(crf.id, ownerIds), eq(cr.prId, prId)))
          .execute() as Promise<Array<{ id: number; autoResolve: FindingAutoResolveRecord | null; pushback: FindingPushbackRecord | null }>>),
    threadIds.length === 0
      ? Promise.resolve([] as Array<{ id: number; isResolved: boolean }>)
      : (ctx.db
          .select({ id: rt.id, isResolved: rt.isResolved })
          .from(rt)
          .where(and(inArray(rt.id, threadIds), eq(rt.prId, prId)))
          .execute() as Promise<Array<{ id: number; isResolved: boolean }>>),
  ]);
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const resolvedById = new Map(threads.map((t) => [t.id, !!t.isResolved]));
  return {
    ...fu,
    items: fu.items.map((it) => {
      if (it.threadFindingId == null && it.threadId == null) return it;
      const o = it.threadFindingId != null ? ownerById.get(it.threadFindingId) : undefined;
      return {
        ...it,
        threadResolved: it.threadId != null ? (resolvedById.get(it.threadId) ?? null) : null,
        autoResolve: o?.autoResolve ?? null,
        pushback: o?.pushback ?? null,
      };
    }),
  };
}

/**
 * Finding id → local review-thread id, for this run's POSTED INLINE findings. Scoped to the
 * review's own PR (already ownership-checked by the caller), so a comment can only resolve to a
 * thread on that PR. By the stored GitHub comment id first; a finding with none (posted inside a
 * review before the comment ids were read back) — or whose id is not synced — falls back to the
 * ONE shared matcher (`findFindingThread`: the root comment is the account's own, on the same file,
 * carries Limn's marker and starts with the finding's text). That fallback reads the PR's threads
 * only when some posted inline finding is still unmatched. Nothing matching = no entry (the finding
 * keeps its path/line link).
 */
async function postedFindingThreadIds(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  findings: FindingRow[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const posted = findings.filter((f) => f.postedCommentKind === 'inline' && f.postedAt != null);
  if (posted.length === 0) return out;
  const { reviewThreads: rt, reviewComments: rc, users, accounts } = ctx.schema as any;
  const ids = [...new Set(posted.map((f) => f.githubCommentId).filter((x): x is string => x != null))];
  const taken = new Set<number>();
  if (ids.length > 0) {
    const rows = (await ctx.db
      .select({ databaseId: rc.databaseId, threadId: rt.id })
      .from(rc)
      .innerJoin(rt, eq(rt.id, rc.threadId))
      .where(and(eq(rt.prId, prId), inArray(rc.databaseId, ids)))
      .execute()) as Array<{ databaseId: string | null; threadId: number }>;
    const byComment = new Map<string, number>();
    for (const r of rows) if (r.databaseId != null) byComment.set(r.databaseId, r.threadId);
    for (const f of posted) {
      const t = f.githubCommentId != null ? byComment.get(f.githubCommentId) : undefined;
      if (t != null && !taken.has(t)) {
        out.set(f.id, t);
        taken.add(t);
      }
    }
  }
  const rest = posted.filter((f) => !out.has(f.id));
  if (rest.length === 0) return out;
  const paths = [...new Set(rest.map((f) => f.path))];
  const threads = (await ctx.db
    .select({ id: rt.id, path: rt.path })
    .from(rt)
    .where(and(eq(rt.prId, prId), inArray(rt.path, paths)))
    .execute()) as Array<{ id: number; path: string }>;
  if (threads.length === 0) return out;
  const commentRows = (await ctx.db
    .select({
      threadId: rc.threadId,
      databaseId: rc.databaseId,
      body: rc.body,
      authorLogin: users.githubLogin,
      createdAt: rc.createdAt,
    })
    .from(rc)
    .leftJoin(users, eq(users.id, rc.authorId))
    .where(inArray(rc.threadId, threads.map((t) => t.id)))
    .execute()) as Array<Omit<ThreadComment, 'createdAt'> & { createdAt: Date | null }>;
  const comments: ThreadComment[] = commentRows.map((c) => ({ ...c, createdAt: c.createdAt?.getTime?.() ?? 0 }));
  const login = (
    (await ctx.db
      .select({ login: accounts.githubLogin })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .execute()) as Array<{ login: string | null }>
  )[0]?.login ?? null;
  for (const f of rest) {
    const t = findFindingThread(f, threads, comments, login, taken);
    if (t) {
      out.set(f.id, t.id);
      taken.add(t.id);
    }
  }
  return out;
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

/**
 * The id of the PR's newest SUCCEEDED run, or null when none succeeded. What AI Fix builds from: a
 * failed (or still running) latest run must not hide an older finished one.
 */
export async function getLatestSucceededReviewId(
  ctx: AgentContext,
  prId: number,
  accountId: number,
): Promise<number | null> {
  const { cr, prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(cr.prId, prId), eq(repos.accountId, accountId), eq(cr.status, 'succeeded')))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
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
  // TRAILING: the AI Fix manager's in-memory claim (`isFixRunning`). When given, each state also
  // carries `fix` ('running' / 'ready') from ONE batched ai_fixes read. Absent ⇒ no `fix` field.
  fixRunning?: (prId: number) => boolean,
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
    ticket: ClaudeReviewTicket | ClaudeReviewTicket[] | null;
    prHeadSha: string | null;
    trigger: string | null;
  }>;
  const out: ClaudeReviewPrState[] = [];
  const latestByPr = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    if (latestByPr.has(r.prId)) continue; // newest first — the first row per PR is its latest run
    latestByPr.set(r.prId, r);
    out.push({
      prId: r.prId,
      reviewId: r.reviewId,
      status: r.status,
      verdict: r.verdict,
      reviewedHeadSha: r.headSha,
      finishedAt: iso(r.finishedAt),
      ticket: storedList(r.ticket)[0] ?? null,
      tickets: storedList(r.ticket),
      headMoved: r.prHeadSha != null && r.prHeadSha !== r.headSha,
      currentHeadSha: r.prHeadSha ?? null,
      trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    });
  }
  await foldStateSummaries(ctx, out, latestByPr);
  if (fixRunning) await foldFixStates(ctx, out, latestByPr, accountId, fixRunning);
  return out;
}

/**
 * The Open PRs strip's AI Fix pill, for the listed PRs in ONE read of `ai_fixes`: `'running'` while
 * the fixer holds a queued / running fix for the PR (the manager's claim is the authority — a row
 * left `running` by a crash is not), else `'ready'` when a SUCCEEDED fix with a non-empty patch,
 * never pushed, was built on the PR's CURRENT synced head. Mutates `states` in place.
 */
async function foldFixStates(
  ctx: AgentContext,
  states: ClaudeReviewPrState[],
  latestByPr: Map<number, { prHeadSha: string | null }>,
  accountId: number,
  fixRunning: (prId: number) => boolean,
): Promise<void> {
  if (states.length === 0) return;
  const af = (ctx.schema as any).aiFixes;
  const rows = (await ctx.db
    .select({ prId: af.prId, status: af.status, baseSha: af.baseSha, patch: af.patch, pushedAt: af.pushedAt })
    .from(af)
    .where(
      and(
        eq(af.accountId, accountId),
        inArray(
          af.prId,
          states.map((s) => s.prId),
        ),
      ),
    )
    .execute()) as Array<{ prId: number; status: string; baseSha: string; patch: string | null; pushedAt: unknown }>;
  const running = new Set<number>();
  const ready = new Set<number>();
  for (const r of rows) {
    if ((r.status === 'queued' || r.status === 'running') && fixRunning(r.prId)) running.add(r.prId);
    const head = latestByPr.get(r.prId)?.prHeadSha ?? null;
    if (
      r.status === 'succeeded' &&
      r.pushedAt == null &&
      (r.patch ?? '').trim() !== '' &&
      head != null &&
      r.baseSha === head
    )
      ready.add(r.prId);
  }
  for (const s of states) {
    if (running.has(s.prId)) s.fix = 'running';
    else if (ready.has(s.prId)) s.fix = 'ready';
  }
}

/**
 * The Open PRs strip's figures for the latest runs: severity / lens / posted counts, story
 * alignments, follow-up statuses and the outdated commit count. A FIXED number of batched reads
 * (findings, the run's JSON columns, the moved PRs' commits) whatever the list length — never one
 * per PR. Mutates `states` in place. A run that did not succeed gets no `summary`.
 */
async function foldStateSummaries(
  ctx: AgentContext,
  states: ClaudeReviewPrState[],
  latestByPr: Map<number, { reviewId: number; prHeadSha: string | null; headSha: string; ticket: unknown }>,
): Promise<void> {
  const { cr, crf } = tables(ctx);
  const done = states.filter((s) => s.status === 'succeeded' && s.reviewId != null);
  const doneIds = done.map((s) => s.reviewId as number);

  // 1. Every finding of the finished runs — the columns the fold needs, nothing else.
  const findings = doneIds.length
    ? ((await ctx.db
        .select({
          reviewId: crf.reviewId,
          severity: crf.severity,
          lens: crf.lens,
          postedAt: crf.postedAt,
          included: crf.included,
          priorFindingId: crf.priorFindingId,
        })
        .from(crf)
        .where(inArray(crf.reviewId, doneIds))
        .execute()) as Array<{
        reviewId: number;
        severity: ClaudeFindingSeverity;
        lens: string | null;
        postedAt: unknown;
        included: boolean | null;
        priorFindingId: number | null;
      }>)
    : [];

  // 2. The finished runs' stored assessments (JSON) — read for the LATEST runs only, never history.
  const extras = doneIds.length
    ? ((await ctx.db
        .select({
          id: cr.id,
          ticketAssessment: cr.ticketAssessment,
          followUp: cr.followUp,
          postedAt: cr.postedAt,
          threadAssessments: cr.threadAssessments,
          ciFailures: cr.ciFailures,
        })
        .from(cr)
        .where(inArray(cr.id, doneIds))
        .execute()) as Array<{
        id: number;
        ticketAssessment: ClaudeTicketAssessment | ClaudeTicketAssessment[] | null;
        followUp: ClaudeReviewFollowUpRecord | null;
        postedAt: unknown;
        threadAssessments: ClaudeThreadAssessment[] | null;
        ciFailures: unknown;
      }>)
    : [];
  const extrasById = new Map(extras.map((e) => [e.id, e]));

  const findingsById = new Map<number, typeof findings>();
  for (const f of findings) {
    const list = findingsById.get(f.reviewId) ?? [];
    list.push(f);
    findingsById.set(f.reviewId, list);
  }

  for (const s of done) {
    const id = s.reviewId as number;
    const counts: Record<ClaudeFindingSeverity, number> = { blocker: 0, warning: 0, nit: 0, question: 0, praise: 0 };
    const lenses: ClaudeReviewStateSummary['lenses'] = {};
    let postedFindings = 0;
    let ignoredCount = 0;
    for (const f of findingsById.get(id) ?? []) {
      // Stored praise (older runs) is hidden: no count, no lens, no posted figure. `praise` stays 0.
      if (!isShownFinding(f)) continue;
      // A READER'S ignore leaves the pills and the posted total; the card says "N ignored"
      // instead. ⚠ The server's own left-out re-raise (`included: false` with a prior) is NOT an
      // ignore: the issue is still open and its comment is already on GitHub at this commit, so it
      // counts in the pills AND as posted.
      if (isReaderIgnoredFinding(f)) {
        ignoredCount += 1;
        continue;
      }
      if (f.severity in counts) counts[f.severity] += 1;
      const lens = (CLAUDE_FINDING_LENSES as string[]).includes(f.lens ?? '') ? (f.lens as ClaudeFindingLens) : null;
      if (lens) lenses[lens] = (lenses[lens] ?? 0) + 1;
      if (f.postedAt != null || isAlreadyPostedReraise(f)) postedFindings += 1;
    }
    const extra = extrasById.get(id);
    const latest = latestByPr.get(s.prId);
    const tickets = ticketEntriesOf(
      (latest?.ticket ?? null) as ClaudeReviewTicket | ClaudeReviewTicket[] | null,
      extra?.ticketAssessment ?? null,
    ).map((e) => ({
      key: e.ticket.key ?? null,
      title: e.ticket.title ?? null,
      alignment: e.assessment?.alignment ?? null,
    }));
    let followUp: ClaudeReviewStateSummary['followUp'] = null;
    // Praise is hidden everywhere, so an earlier praise item never counts in "Earlier: …".
    const items = extra?.followUp?.items?.filter((it) => it.severity !== 'praise');
    if (Array.isArray(items) && items.length > 0) {
      followUp = {
        addressed: 0,
        partly_addressed: 0,
        not_addressed: 0,
        no_longer_applies: 0,
        reply_accepted: 0,
        reply_disputed: 0,
        not_checked: 0,
      };
      for (const it of items) if (it.status in followUp) followUp[it.status] += 1;
    }
    const summary: ClaudeReviewStateSummary = {
      findings: counts,
      lenses,
      postedFindings,
      ignoredCount,
      reviewPosted: extra?.postedAt != null,
      tickets,
      followUp,
    };
    // null = the run did not assess threads (an older row): no figure, never zeros.
    if (Array.isArray(extra?.threadAssessments)) {
      summary.threadAssessments = threadAssessmentCounts(extra.threadAssessments);
    }
    // null = the run did not look at CI: no figure, never zeros.
    const ci = ciRecordOf(extra?.ciFailures);
    if (ci) {
      summary.ci = {
        failing: ci.failures.length,
        diagnosed: ci.failures.filter((f) => f.status === 'diagnosed').length,
      };
    }
    s.summary = summary;
  }

  // 3. The outdated count, for every moved PR — ONE commits read for all of them.
  const moved = states.filter((s) => s.headMoved && s.reviewedHeadSha != null);
  const c = (ctx.schema as any).commits;
  if (moved.length === 0 || !c) return;
  const commitRows = (await ctx.db
    .select({ prId: c.prId, sha: c.sha, committedAt: c.committedAt, headline: c.messageHeadline })
    .from(c)
    .where(inArray(c.prId, moved.map((s) => s.prId)))
    .execute()) as Array<SyncedCommitRow & { prId: number }>;
  const commitsByPr = new Map<number, SyncedCommitRow[]>();
  for (const r of commitRows) {
    const list = commitsByPr.get(r.prId) ?? [];
    list.push(r);
    commitsByPr.set(r.prId, list);
  }
  for (const s of moved) {
    const head = latestByPr.get(s.prId)?.prHeadSha;
    if (!head) continue;
    s.commitsSince = countCommitsSince(commitsByPr.get(s.prId) ?? [], s.reviewedHeadSha as string, head);
  }
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
  // A hidden (praise) finding is not addressable: it 404s exactly like a missing one.
  if (!row || !isShownFinding(row.finding)) return null;
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

/** A ticket peer of the reviewed PR, as a deep review's "Related PRs" block needs it. */
export interface ReviewPeerContext {
  prId: number;
  owner: string;
  name: string;
  repoFullName: string;
  number: number;
  title: string;
  headSha: string;
  state: 'open' | 'merged';
  // The synced changed-file paths (the `files` column, capped at 100 by sync); [] when not synced.
  files: string[];
}

/**
 * The given PRs as ticket peers, account-scoped: open or merged with a head to check out (a closed,
 * unmerged PR is no longer part of the ticket — the ticket review drops it the same way). Rows
 * another account owns are simply absent. Order is NOT meaningful; the caller ranks.
 */
export async function getReviewPeerContexts(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<ReviewPeerContext[]> {
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return [];
  const { prs, repos } = tables(ctx);
  const rows = (await ctx.db
    .select({
      prId: prs.id,
      owner: repos.owner,
      name: repos.name,
      number: prs.number,
      title: prs.title,
      headSha: prs.headSha,
      state: prs.state,
      files: prs.files,
    })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(inArray(prs.id, ids), eq(repos.accountId, accountId)))
    .execute()) as Array<{
    prId: number;
    owner: string;
    name: string;
    number: number;
    title: string;
    headSha: string | null;
    state: string;
    files: StoredPrFile[] | null;
  }>;
  const out: ReviewPeerContext[] = [];
  for (const r of rows) {
    if ((r.state !== 'open' && r.state !== 'merged') || !r.headSha) continue;
    out.push({
      prId: r.prId,
      owner: r.owner,
      name: r.name,
      repoFullName: `${r.owner}/${r.name}`,
      number: r.number,
      title: r.title,
      headSha: r.headSha,
      state: r.state,
      files: Array.isArray(r.files)
        ? r.files.map((f) => f?.path).filter((x): x is string => typeof x === 'string' && x !== '')
        : [],
    });
  }
  return out;
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
 * Its findings are kept when eligible (`isFollowUpEligible`: POSTED to GitHub and not praise),
 * and not SETTLED BY A REPLY (`settledIds`, settled-by-reply.ts — an earlier review accepted a
 * person's reply on its thread),
 * with the body the user saw. A finding that was ignored, left unposted or only copied never enters
 * the follow-up — not the prompt, not the stored record, not the counts. CARRY-FORWARD re-loads two kinds of OLDER finding named by
 * that run's follow-up items — the ids come only from our own stored JSON and are re-scoped to this
 * PR + account by the query — and marks them `carried`, so nothing drops out of the chain:
 *   - every 'not_checked' item (never shown to the model, or not reported on), when eligible;
 *   - every still-open item (not / partly addressed) that no ELIGIBLE (posted) finding of that
 *     run raises again, when the earlier finding is itself eligible. That keeps a posted comment in
 *     the chain when its re-raise was never posted — the re-raise follow-up.ts saved left out
 *     because the comment was already on the same commit (`isAlreadyOnThisCommit`), or one the
 *     reader simply did not post — so it is followed up against the comment that IS on the PR.
 *
 * Every finding carries the head of the review that RAISED it (`cr.headSha` via the join), because
 * "has the code moved since?" is asked per finding, never against the previous review's head.
 */
export async function loadPriorReviewForFollowUp(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
  // TRAILING: earlier findings SETTLED BY A REPLY (`loadSettledByReplyFindings`) — left out of the
  // follow-up entirely, own and carried alike. Absent ⇒ none.
  settledIds: ReadonlySet<number> = new Set(),
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
  const openNotReraised = new Map<number, NonNullable<PriorFindingForFollowUp['priorStatus']>>();
  for (const it of row.followUp?.items ?? []) {
    if (!Number.isInteger(it.priorFindingId) || seen.has(it.priorFindingId)) continue;
    if (it.status === 'not_checked') notChecked.add(it.priorFindingId);
    else if (
      (it.status === 'not_addressed' || it.status === 'partly_addressed' || it.status === 'reply_disputed') &&
      !reraisedByEligible.has(it.priorFindingId)
    ) {
      // Kept with the answer that run gave: on a same-head re-run it stands (follow-up.ts).
      openNotReraised.set(it.priorFindingId, { status: it.status, explanation: it.explanation ?? null });
    }
  }
  const carriedIds = [...new Set([...notChecked, ...openNotReraised.keys()])];
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
      // The ONE rule (posted, not praise) applies to carried findings exactly as to own ones.
      if (seen.has(finding.id) || !isFollowUpEligible(finding)) continue;
      seen.add(finding.id);
      findings.push({ ...toPrior(finding, headSha, true), priorStatus: openNotReraised.get(finding.id) ?? null });
    }
  }
  // ⚠ Filtered AFTER the carry bookkeeping above, so a settled finding still counts as "seen" and
  // a re-raise of it still marks it followed-through — it is simply never asked about.
  return {
    reviewId: row.id,
    headSha: row.headSha,
    findings: settledIds.size > 0 ? findings.filter((f) => !settledIds.has(f.id)) : findings,
  };
}

// ---- Earlier findings settled by a reply (settled-by-reply.ts) ----

type EarlierFindingRow = Pick<FindingRow, 'id' | 'postedAt' | 'severity'> & {
  priorFindingId: number | null;
  storyRef: string | null;
};

/** Every earlier succeeded run of this PR (id below `beforeReviewId`): its findings + follow-up. */
async function loadEarlierRuns(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
): Promise<{
  findings: EarlierFindingRow[];
  items: AcceptedItemLike[];
}> {
  const { cr, crf, prs, repos } = tables(ctx);
  const scope = and(
    eq(cr.prId, prId),
    eq(repos.accountId, accountId),
    eq(cr.status, 'succeeded'),
    lt(cr.id, beforeReviewId),
  );
  const [rows, followUpRows] = await Promise.all([
    // Only what eligibility and the chain need — this runs on every review read.
    ctx.db
      .select({
        id: crf.id,
        priorFindingId: crf.priorFindingId,
        postedAt: crf.postedAt,
        severity: crf.severity,
        storyRef: crf.storyRef,
      })
      .from(crf)
      .innerJoin(cr, eq(cr.id, crf.reviewId))
      .innerJoin(prs, eq(prs.id, cr.prId))
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(scope)
      .orderBy(asc(crf.id))
      .execute() as Promise<EarlierFindingRow[]>,
    ctx.db
      .select({ id: cr.id, followUp: cr.followUp })
      .from(cr)
      .innerJoin(prs, eq(prs.id, cr.prId))
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(scope)
      .orderBy(asc(cr.id))
      .execute() as Promise<Array<{ id: number; followUp: ClaudeReviewFollowUpRecord | null }>>,
  ]);
  return {
    findings: rows,
    // Oldest run first; each item tagged with the run whose follow-up it is.
    items: followUpRows.flatMap((r) => (r.followUp?.items ?? []).map((it) => ({ ...it, reviewId: r.id }))),
  };
}

/**
 * Every posted finding of an EARLIER succeeded review of this PR (id below `beforeReviewId`) that a
 * review SETTLED by accepting a person's reply on its thread (follow-up status 'reply_accepted') —
 * the pure rule is settled-by-reply.ts `acceptedReplyFindings`. Account-scoped through the repos
 * join (a foreign PR reads as none). EVERY earlier review, not only the previous one: a settled
 * finding leaves the follow-up chain, so a later run would otherwise never hear of it again and
 * could raise it as new.
 * ⚠ The retired "resolved after a reply ⇒ settled on sight" rule is GONE: such a thread is judged
 * (settled-by-reply.ts header). Read by the run (manager.ts) AND by the review read
 * (`ClaudeReview.settledEarlier`).
 */
export async function loadSettledByReplyFindings(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
): Promise<SettledFinding[]> {
  const { findings, items } = await loadEarlierRuns(ctx, prId, accountId, beforeReviewId);
  const eligible = new Set(findings.filter(isFollowUpEligible).map((f) => f.id));
  if (eligible.size === 0) return [];
  return acceptedReplyFindings(items, eligible);
}

/**
 * BACKWARD COMPATIBILITY for the retired settle-on-sight rule: earlier posted findings that left
 * the follow-up chain without a closing status (settled-by-reply.ts `unjudgedReplyCandidateIds`),
 * loaded as CARRIED follow-up findings (each with the head of the review that raised it). The
 * manager attaches their threads and keeps only the ones RESOLVED WITH A REPLY, so they are judged
 * once like any other; the rest are dropped. `exclude` = what this run's follow-up already holds,
 * plus the settled ones. Account-scoped like the loaders above.
 */
export async function loadUnjudgedReplyFindings(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
  exclude: ReadonlySet<number>,
): Promise<PriorFindingForFollowUp[]> {
  const { cr, crf, prs, repos } = tables(ctx);
  const { findings, items } = await loadEarlierRuns(ctx, prId, accountId, beforeReviewId);
  const ids = unjudgedReplyCandidateIds(
    findings.map((f) => ({ id: f.id, priorFindingId: f.priorFindingId ?? null, eligible: isFollowUpEligible(f) })),
    items,
    exclude,
  );
  if (ids.length === 0) return [];
  const rows = (await ctx.db
    .select({ finding: crf, headSha: cr.headSha })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .innerJoin(prs, eq(prs.id, cr.prId))
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(inArray(crf.id, ids), eq(cr.prId, prId), eq(repos.accountId, accountId)))
    .orderBy(asc(crf.id))
    .execute()) as Array<{ finding: FindingRow; headSha: string }>;
  return rows.map(({ finding: f, headSha }) => ({
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
    carried: true,
    priorStatus: null,
  }));
}

// ---- Writers ----

// ⚠ LEGACY `tickets`. Runs from before the ticket review stored their stories here at QUEUE time.
// Stories left the PR review (review/ticket-review/), so no live caller passes any and a new run's
// `ticket` is NULL; the parameter stays only so tests can seed the history rows the SPA still
// renders in the old layout. Stored as an ARRAY (null when none).
export async function insertQueuedReview(
  ctx: AgentContext,
  prId: number,
  headSha: string,
  model: ClaudeReviewModel,
  accountId: number,
  tickets: readonly ClaudeReviewTicket[] = [],
  // TRAILING: who started it. 'auto' = the per-workspace sweeper (auto.ts). A label only: core's
  // My Turn read keeps an auto run exactly like a manual one, and the chip says "Auto review".
  trigger: ClaudeReviewTrigger = 'manual',
): Promise<number> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .insert(cr)
    .values({
      accountId,
      prId,
      headSha,
      status: 'queued',
      model,
      ticket: tickets.length > 0 ? [...tickets] : null,
      trigger,
    })
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
  // (No story assessment: stories left the PR review, so `ticket_assessment` and the findings'
  // story_* columns stay NULL on every new run. Old rows keep theirs as read-only history.)
  // Other reviewers' open threads, judged. null/absent ⇒ none assessed (stored NULL).
  threadAssessments?: ClaudeThreadAssessment[] | null;
  // The head's CI and each failing check, diagnosed. null/absent ⇒ CI not looked at (stored NULL).
  ciFailures?: ClaudeCiFailuresRecord | null;
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
        threadAssessments: data.threadAssessments ?? null,
        ciFailures: data.ciFailures ?? null,
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
          lens: f.lens ?? null,
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
  // `inlineComments`: the GitHub comment id read back for each inline finding (post-seam.ts). A
  // finding with none is still stamped posted, with a NULL id (the read falls back to the thread's
  // root comment); an id for a finding outside `inlineFindingIds` is ignored.
  opts: { auto?: boolean; inlineComments?: { findingId: number; commentId: string }[] } = {},
): Promise<void> {
  const { cr, crf } = tables(ctx);
  const now = new Date();
  // Only an auto post writes the flag; a person's post leaves it NULL.
  const auto = opts.auto === true ? { postedAuto: true } : {};
  const inline = new Set(inlineFindingIds);
  const commentIds = new Map<number, string>();
  for (const c of opts.inlineComments ?? []) if (inline.has(c.findingId)) commentIds.set(c.findingId, c.commentId);
  await ctx.runTransaction(async (tx) => {
    await tx.update(cr).set({ postedReviewId, postedAt: now }).where(eq(cr.id, id)).execute();
    const bare = inlineFindingIds.filter((fid) => !commentIds.has(fid));
    if (bare.length > 0) {
      await tx
        .update(crf)
        .set({ postedAt: now, postedCommentKind: 'inline', ...auto })
        .where(inArray(crf.id, bare))
        .execute();
    }
    for (const [findingId, commentId] of commentIds) {
      await tx
        .update(crf)
        .set({ postedAt: now, githubCommentId: commentId, postedCommentKind: 'inline', ...auto })
        .where(eq(crf.id, findingId))
        .execute();
    }
    for (const pc of prComments) {
      await tx
        .update(crf)
        .set({ postedAt: now, githubCommentId: pc.commentId, postedCommentKind: 'pr_comment', ...auto })
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
  opts: { auto?: boolean } = {},
): Promise<void> {
  const { crf } = tables(ctx);
  await ctx.db
    .update(crf)
    .set({
      postedAt: new Date(),
      githubCommentId,
      postedCommentKind: kind,
      ...(opts.auto === true ? { postedAuto: true } : {}),
    })
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

// ---- Outdated: the reviewed commit against the PR's synced head ----

export interface SyncedCommitRow {
  sha: string;
  committedAt: Date | number;
  headline: string | null;
}

/**
 * The pure half of `reviewHeadState` (also folded per PR by the batched Open PRs states read):
 * how many of a PR's synced commits are newer than the reviewed one. null when either commit is
 * not synced, or the history looks rewritten (a newer copy with the reviewed commit's headline).
 */
export function countCommitsSince(
  rows: readonly SyncedCommitRow[],
  reviewedSha: string,
  currentHeadSha: string,
): number | null {
  const ms = (v: Date | number): number => (v instanceof Date ? v.getTime() : Number(v));
  const reviewed = rows.find((r) => r.sha === reviewedSha);
  const head = rows.find((r) => r.sha === currentHeadSha);
  if (!reviewed || !head) return null;
  const at = ms(reviewed.committedAt);
  const newer = rows.filter((r) => r.sha !== reviewedSha && ms(r.committedAt) > at);
  // Sync never prunes commits a force-push dropped, so a rebase or amend leaves the reviewed
  // commit's own rewritten copy among the "newer" rows (same headline, later time). Counting
  // those would call a rewrite "N newer commits"; say only that the branch changed (null).
  const rewritten = reviewed.headline != null && newer.some((r) => r.headline === reviewed.headline);
  return rewritten ? null : newer.length;
}

/**
 * Is the review behind the PR's head? DB-only. `commitsSince` counts the PR's synced commits newer
 * than the reviewed one (by commit time); null when the reviewed commit is not among them, or when
 * it looks rewritten (a newer copy with its headline) — never a guess. null overall when the PR's head is unknown.
 */
export async function reviewHeadState(
  ctx: AgentContext,
  prId: number,
  reviewedSha: string,
  currentHeadSha: string | null,
): Promise<ClaudeReviewHeadState | null> {
  if (!currentHeadSha) return null;
  if (currentHeadSha === reviewedSha) {
    return { currentHeadSha, outdated: false, commitsSince: 0 };
  }
  const c = (ctx.schema as any).commits;
  let commitsSince: number | null = null;
  if (c) {
    const rows = (await ctx.db
      .select({ sha: c.sha, committedAt: c.committedAt, headline: c.messageHeadline })
      .from(c)
      .where(eq(c.prId, prId))
      .execute()) as Array<{ sha: string; committedAt: Date | number; headline: string | null }>;
    commitsSince = countCommitsSince(rows, reviewedSha, currentHeadSha);
  }
  return { currentHeadSha, outdated: true, commitsSince };
}

// ---- Auto re-review helpers ----

/** Is there ANY run (any status) of this PR at `headSha`? One run per head. */
export async function hasReviewAtHead(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  headSha: string,
): Promise<boolean> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/**
 * Is the auto re-review keyed (headSha, commentsAtMs) already SETTLED? Any run of this PR at the
 * head settles a moved head (one run per head). For new comments on an unchanged head
 * (`commentsAtMs` set) a run at the head settles it only when it covered that comment: its
 * `comments_through` (else its start, `created_at`) is at or after it. The sweeper's candidate read
 * (db/queries.ts `getAutoReviewCandidates`) applies the same rule; this is the re-check a waiting
 * item makes before its row is written.
 */
export async function isAutoReReviewSettled(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  headSha: string,
  commentsAtMs: number | null,
): Promise<boolean> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select({ createdAt: cr.createdAt, commentsThrough: cr.commentsThrough })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha)))
    .execute()) as Array<{ createdAt: Date; commentsThrough: Date | null }>;
  if (rows.length === 0) return false;
  if (commentsAtMs == null) return true;
  return rows.some((r) => (r.commentsThrough ?? r.createdAt).getTime() >= commentsAtMs);
}

/** Record the newest qualifying review comment the run saw (the comment half of the re-review key). */
export async function markReviewCommentsSeen(
  ctx: AgentContext,
  id: number,
  commentsThrough: Date | null,
): Promise<void> {
  if (!commentsThrough) return;
  const { cr } = tables(ctx);
  await ctx.db.update(cr).set({ commentsThrough }).where(eq(cr.id, id)).execute();
}

/**
 * The previous SUCCEEDED run (non-skip, id below this one) — what a same-head run carries forward:
 * its head, its thread assessments and its CI diagnoses. null when none. (Its stories are no longer
 * read: the PR review stopped judging them.)
 */
export async function loadPriorRunForCarry(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  beforeReviewId: number,
): Promise<{
  headSha: string;
  threadAssessments: ClaudeThreadAssessment[] | null;
  ciFailures: ClaudeCiFailure[] | null;
} | null> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select({
      headSha: cr.headSha,
      threadAssessments: cr.threadAssessments,
      ciFailures: cr.ciFailures,
    })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        lt(cr.id, beforeReviewId),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{
    headSha: string;
    threadAssessments: ClaudeThreadAssessment[] | null;
    ciFailures: ClaudeCiFailuresRecord | null;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    headSha: r.headSha,
    threadAssessments: Array.isArray(r.threadAssessments) ? r.threadAssessments : null,
    ciFailures: ciRecordOf(r.ciFailures)?.failures ?? null,
  };
}

// AUTO-POSTING — after an AUTO Claude review SUCCEEDS, post its findings to GitHub without a click
// (CORE, free, local-only like every agentic feature). docs/CLAUDE-REVIEW.md § Auto-posting.
//
// THE RULE, in order (the first that fails decides):
//   0. the workspace holding the PR's repo has auto-posting ON (`workspaces.auto_post_enabled`,
//      migration 0087 / pg 0074 — OFF for every workspace until switched on). Off ⇒ nothing is
//      recorded at all;
//   1. WHICH PRs (`autoPostEligibility`, pure): open (never merged or closed), not a draft, not
//      bot-authored (the workspace's bot union), and under scope 'mine' the PR is the reader's own or
//      the reader is — or was — a requested reviewer (a `review_requests` row OR a 'requested' row
//      in `review_request_events`: GitHub REMOVES the request the moment any review lands, our own
//      COMMENT review included, so the outstanding row alone would make every re-run ineligible);
//   2. WHICH FINDINGS (`selectFindingsToPost`, pure): the enabled severities only (praise never;
//      legacy story findings never — stories are the ticket review's), INCLUDED (an ignored finding
//      never posts) and not posted, and NOT ALREADY ON GITHUB FROM AN EARLIER RUN — neither through
//      the follow-up chain (`prior_finding_id`, walked back) nor by fingerprint (same path, title
//      `similarTitles` — the settled-by-reply identity). An earlier run whose auto-post was cut off
//      mid-flight (`status: 'posting'`) counts its findings as POSSIBLY POSTED: never retried;
//   3. nothing left ⇒ `skipped` / `nothing_new`, no GitHub call;
//   4. the LIVE PR is still open, not a draft, at the reviewed head (a moved head ⇒ `failed`);
//   5. THE CLAIM — a compare-and-set of `claude_reviews.auto_post` from NULL to `status: 'posting'`
//      BEFORE any write, so a second call (or a restart) can never post the same run twice;
//   6. blockers / warnings / nits → ONE GitHub review, event ALWAYS 'COMMENT' (never APPROVE or
//      REQUEST_CHANGES), body = the summary's first sentence + `AUTO_POST_FOOTER`; questions → one
//      PR-level comment each. Every body ends with the footer, then the hidden
//      `<!-- pierre:claude-review` marker, so `isLimnPostedComment` knows them and they never
//      re-trigger an auto review;
//   7. stamp what GitHub took (`markReviewPosted` / `markFindingPosted` with `auto`), settle the
//      record (posted / partial / failed + the first error), then `settlePrAfterWrite`.
//
// ⚠ ONCE GITHUB 201s THERE IS NO RETRY, EVER. A failure is RECORDED (the Claude Review tab prints
// "Couldn't post automatically: …" and keeps the Post button), never swallowed and never retried.
// ⚠ Manual runs are never auto-posted: a review you start yourself keeps the Post button.
// ⚠ Never throws: auto-posting failing must never touch the review.
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  AUTO_POST_FOOTER,
  type AutoPostKinds,
  type AutoPostScope,
  type AutoPostSkipReason,
  type ClaudeAutoPostRecord,
  type ClaudeFinding,
  type ClaudeFindingSeverity,
  type ClaudeReview,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { PostReviewFinding } from '../../pro/contract.js';
import { readWorkspaceAutoPostForPr } from './auto-settings.js';
import { similarTitles } from './settled-by-reply.js';
import { prAuthorIsAccount } from '../../coding/ai-fix/auto-fix.js';
import {
  getClaudeReviewById,
  getReviewPostContext,
  markFindingPosted,
  markReviewPosted,
} from './persist.js';
import { resolveFindingBody } from './follow-up.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- pure rules ----

export interface AutoPostPrFacts {
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  authorIsBot: boolean;
  authorIsMe: boolean;
  requestedOfMe: boolean;
}

/** May auto-posting write on this PR? null = yes; else why not. */
export function autoPostEligibility(f: AutoPostPrFacts, scope: AutoPostScope): AutoPostSkipReason | null {
  if (f.state !== 'open') return 'not_open';
  if (f.isDraft) return 'draft';
  if (f.authorIsBot) return 'bot_author';
  if (scope === 'mine' && !f.authorIsMe && !f.requestedOfMe) return 'not_yours';
  return null;
}

/** Which kind toggle governs a finding of this severity (praise: none, never posted). */
export function kindOfSeverity(sev: ClaudeFindingSeverity): keyof AutoPostKinds | null {
  switch (sev) {
    case 'blocker':
      return 'blockers';
    case 'warning':
      return 'warnings';
    case 'nit':
      return 'nits';
    case 'question':
      return 'questions';
    default:
      return null;
  }
}

/** An earlier finding of the same PR, as the dedupe reads it. */
export interface EarlierFinding {
  id: number;
  path: string;
  title: string;
  priorFindingId: number | null;
  // On GitHub (postedAt set), or possibly so (its run's auto-post was cut off mid-flight).
  onGithub: boolean;
}

/**
 * Is this finding already on GitHub from an earlier run? Through the follow-up chain (its
 * `priorFindingId`, walked back) or by fingerprint (same path, similar title).
 */
export function alreadyOnGithub(
  f: Pick<ClaudeFinding, 'path' | 'title' | 'priorFindingId'>,
  earlier: readonly EarlierFinding[],
): boolean {
  const byId = new Map(earlier.map((e) => [e.id, e]));
  let next = f.priorFindingId ?? null;
  for (let hops = 0; next != null && hops < 100; hops += 1) {
    const e = byId.get(next);
    if (!e) break;
    if (e.onGithub) return true;
    next = e.priorFindingId;
  }
  return earlier.some((e) => e.onGithub && e.path === f.path && similarTitles(e.title, f.title));
}

/** The findings this run would post, split into the ONE review's comments and the questions. */
export function selectFindingsToPost(
  findings: readonly ClaudeFinding[],
  kinds: AutoPostKinds,
  earlier: readonly EarlierFinding[],
): { review: ClaudeFinding[]; questions: ClaudeFinding[] } {
  const review: ClaudeFinding[] = [];
  const questions: ClaudeFinding[] = [];
  for (const f of findings) {
    const kind = kindOfSeverity(f.severity);
    if (kind == null || !kinds[kind]) continue;
    // A legacy story finding is the ticket review's business now.
    if (f.story != null) continue;
    // Ignored never posts; posted is done.
    if (!f.included || f.postedAt != null) continue;
    if (alreadyOnGithub(f, earlier)) continue;
    (kind === 'questions' ? questions : review).push(f);
  }
  return { review, questions };
}

/** The review body's lead: the summary's first plain sentence, else a count. */
export function autoReviewBodyLead(summary: string | null, commentCount: number): string {
  for (const raw of (summary ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || /^([-*+]|\d+[.)])\s/.test(line) || line.startsWith('#')) continue;
    return line.length > 400 ? `${line.slice(0, 399)}…` : line;
  }
  return commentCount === 1 ? 'One comment from Claude.' : `${commentCount} comments from Claude.`;
}

/** The posted body of an auto review: the lead, then the footer (the seam appends the marker). */
export function autoReviewBody(summary: string | null, commentCount: number): string {
  return `${autoReviewBodyLead(summary, commentCount)}\n\n${AUTO_POST_FOOTER}`;
}

// ---- I/O ----

export interface LivePr {
  headSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
}

/** The pieces that touch the outside world, so a test can replace them. */
export interface AutoPostDeps {
  livePr(owner: string, name: string, prNumber: number): Promise<LivePr>;
  settle(a: { accountId: number; prId: number; log: AgentContext['log'] }): Promise<{ visible: boolean }>;
  isAutomation(accountId: number, workspaceId: number, userId: number | null): Promise<boolean>;
  accountUserId(accountId: number): Promise<number | null>;
}

export const defaultAutoPostDeps: AutoPostDeps = {
  async livePr(owner, name, prNumber) {
    const { ghRestGet } = await import('../../github/client.js');
    const p = await ghRestGet<{ head: { sha: string }; state: 'open' | 'closed'; draft?: boolean; merged?: boolean; merged_at?: string | null }>(
      `/repos/${owner}/${name}/pulls/${prNumber}`,
    );
    return { headSha: p.head.sha, state: p.state, draft: p.draft === true, merged: p.merged === true || p.merged_at != null };
  },
  async settle(a) {
    const { settlePrAfterWrite } = await import('../../sync/resync-after-write.js');
    return settlePrAfterWrite(a);
  },
  async isAutomation(accountId, workspaceId, userId) {
    const { isWorkspaceAutomationUser } = await import('../../db/queries.js');
    return isWorkspaceAutomationUser(accountId, workspaceId, userId);
  },
  async accountUserId(accountId) {
    const { getAccountUserId } = await import('../../auth/account.js');
    return getAccountUserId(accountId);
  },
};

/** The synced facts `autoPostEligibility` reads. null = not this account's PR. */
export async function readAutoPostPrFacts(
  ctx: AgentContext,
  deps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId'>,
  accountId: number,
  workspaceId: number,
  prId: number,
): Promise<AutoPostPrFacts | null> {
  const t = s(ctx);
  const rows = (await ctx.db
    .select({ state: t.pullRequests.state, isDraft: t.pullRequests.isDraft, authorId: t.pullRequests.authorId })
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.id, prId), eq(t.pullRequests.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ state: AutoPostPrFacts['state']; isDraft: boolean | null; authorId: number | null }>;
  const pr = rows[0];
  if (!pr) return null;
  const [authorIsBot, authorIsMe, me] = await Promise.all([
    deps.isAutomation(accountId, workspaceId, pr.authorId),
    prAuthorIsAccount(ctx, accountId, prId),
    deps.accountUserId(accountId),
  ]);
  let requestedOfMe = false;
  if (me != null) {
    const [open, history] = await Promise.all([
      ctx.db
        .select({ id: t.reviewRequests.id })
        .from(t.reviewRequests)
        .where(and(eq(t.reviewRequests.prId, prId), eq(t.reviewRequests.userId, me)))
        .limit(1)
        .execute() as Promise<unknown[]>,
      ctx.db
        .select({ id: t.reviewRequestEvents.id })
        .from(t.reviewRequestEvents)
        .where(
          and(
            eq(t.reviewRequestEvents.prId, prId),
            eq(t.reviewRequestEvents.kind, 'requested'),
            eq(t.reviewRequestEvents.reviewerUserId, me),
          ),
        )
        .limit(1)
        .execute() as Promise<unknown[]>,
    ]);
    requestedOfMe = open.length > 0 || history.length > 0;
  }
  return { state: pr.state, isDraft: pr.isDraft === true, authorIsBot, authorIsMe, requestedOfMe };
}

/** Every earlier run's findings of this PR (account-scoped), as the dedupe reads them. */
export async function loadEarlierFindings(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  beforeReviewId: number,
): Promise<EarlierFinding[]> {
  const t = s(ctx);
  const cr = t.claudeReviews;
  const crf = t.claudeReviewFindings;
  const runs = (await ctx.db
    .select({ id: cr.id, autoPost: cr.autoPost })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), lt(cr.id, beforeReviewId)))
    .orderBy(desc(cr.id))
    .execute()) as Array<{ id: number; autoPost: ClaudeAutoPostRecord | null }>;
  if (runs.length === 0) return [];
  // A run whose auto-post never settled: everything it tried may be on GitHub.
  const maybePosted = new Set<number>();
  for (const r of runs) {
    if (r.autoPost?.status === 'posting') for (const id of r.autoPost.findingIds ?? []) maybePosted.add(id);
  }
  const rows = (await ctx.db
    .select({ id: crf.id, path: crf.path, title: crf.title, priorFindingId: crf.priorFindingId, postedAt: crf.postedAt })
    .from(crf)
    .where(inArray(crf.reviewId, runs.map((r) => r.id)))
    .execute()) as Array<{ id: number; path: string; title: string; priorFindingId: number | null; postedAt: unknown }>;
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    priorFindingId: r.priorFindingId ?? null,
    onGithub: r.postedAt != null || maybePosted.has(r.id),
  }));
}

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Claim the run (NULL → record). false = it was already claimed. */
async function claimRun(ctx: AgentContext, reviewId: number, rec: ClaudeAutoPostRecord): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .update(cr)
    .set({ autoPost: rec })
    .where(and(eq(cr.id, reviewId), isNull(cr.autoPost)))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function writeRecord(ctx: AgentContext, reviewId: number, rec: ClaudeAutoPostRecord): Promise<void> {
  const cr = s(ctx).claudeReviews;
  await ctx.db.update(cr).set({ autoPost: rec }).where(eq(cr.id, reviewId)).execute();
}

const toPostFinding = (f: ClaudeFinding): PostReviewFinding => ({
  id: f.id,
  path: f.path,
  line: f.line,
  side: f.side,
  anchored: f.anchored,
  fileInDiff: f.fileInDiff,
  body: resolveFindingBody(f),
  suggestion: f.suggestion,
  storyLead: null,
  footer: AUTO_POST_FOOTER,
});

/** What happened, for the caller and the tests. */
export type AutoPostOutcome =
  | { kind: 'off' }
  | { kind: 'not_found' }
  | { kind: 'already_claimed' }
  | { kind: 'skipped'; reason: AutoPostSkipReason }
  | { kind: 'done'; record: ClaudeAutoPostRecord };

/**
 * Auto-post ONE succeeded auto run. Called by the manager on success of an auto run only. Never
 * throws.
 */
export async function maybeAutoPostReview(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewId: number },
  deps: AutoPostDeps = defaultAutoPostDeps,
): Promise<AutoPostOutcome> {
  try {
    return await autoPostReview(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`auto post review ${a.reviewId}: ${errText(err)}`);
    return { kind: 'not_found' };
  }
}

async function autoPostReview(
  ctx: AgentContext,
  { accountId, prId, reviewId }: { accountId: number; prId: number; reviewId: number },
  deps: AutoPostDeps,
): Promise<AutoPostOutcome> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.enabled) return { kind: 'off' };
  const review: ClaudeReview | null = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.prId !== prId || review.status !== 'succeeded') return { kind: 'not_found' };
  // AUTO runs only — a review a person started keeps the Post button.
  if (review.trigger !== 'auto') return { kind: 'off' };
  if (review.autoPost != null) return { kind: 'already_claimed' };

  const skip = async (reason: AutoPostSkipReason): Promise<AutoPostOutcome> => {
    const rec: ClaudeAutoPostRecord = {
      status: 'skipped',
      at: nowIso(),
      reason,
      error: null,
      findingIds: [],
      postedFindingIds: [],
      githubReviewId: null,
    };
    return (await claimRun(ctx, reviewId, rec)) ? { kind: 'skipped', reason } : { kind: 'already_claimed' };
  };

  const facts = await readAutoPostPrFacts(ctx, deps, accountId, ws.workspaceId, prId);
  if (!facts) return { kind: 'not_found' };
  const notEligible = autoPostEligibility(facts, ws.settings.scope);
  if (notEligible) return skip(notEligible);

  const earlier = await loadEarlierFindings(ctx, accountId, prId, reviewId);
  const picked = selectFindingsToPost(review.findings, ws.settings.kinds, earlier);
  const all = [...picked.review, ...picked.questions];
  if (all.length === 0) return skip('nothing_new');

  const pctx = await getReviewPostContext(ctx, reviewId, accountId);
  if (!pctx) return { kind: 'not_found' };

  // The LIVE PR: GitHub may know it merged, closed, went back to draft or moved since the sync.
  const live = await deps.livePr(pctx.owner, pctx.name, pctx.prNumber);
  if (live.merged || live.state !== 'open') return skip('not_open');
  if (live.draft) return skip('draft');

  const record: ClaudeAutoPostRecord = {
    status: 'posting',
    at: nowIso(),
    reason: null,
    error: null,
    findingIds: all.map((f) => f.id),
    postedFindingIds: [],
    githubReviewId: null,
  };
  if (live.headSha !== pctx.reviewHeadSha) {
    const rec = { ...record, status: 'failed' as const, findingIds: [], error: 'The PR changed since this review.' };
    return (await claimRun(ctx, reviewId, rec)) ? { kind: 'done', record: rec } : { kind: 'already_claimed' };
  }
  // ⚠ THE CLAIM, BEFORE ANY WRITE.
  if (!(await claimRun(ctx, reviewId, record))) return { kind: 'already_claimed' };

  const posted = new Set<number>();
  const errors: string[] = [];
  let headMoved = false;

  if (picked.review.length > 0) {
    try {
      const outcome = await ctx.review.postReview({
        owner: pctx.owner,
        name: pctx.name,
        prNumber: pctx.prNumber,
        reviewHeadSha: pctx.reviewHeadSha,
        body: autoReviewBody(review.summary, picked.review.length),
        // ⚠ ALWAYS COMMENT: an automatic post never approves and never requests changes.
        verdict: 'COMMENT',
        includedFindings: picked.review.map(toPostFinding),
        dryRun: false,
      });
      if (outcome.headMoved) {
        headMoved = true;
        errors.push('The PR changed since this review.');
      } else if ('postedReviewId' in outcome) {
        // GitHub has 201'd: from here nothing may throw or retry.
        record.githubReviewId = outcome.postedReviewId;
        for (const id of outcome.inlineFindingIds) posted.add(id);
        for (const pc of outcome.prComments) posted.add(pc.findingId);
        await markReviewPosted(ctx, reviewId, outcome.postedReviewId, outcome.inlineFindingIds, outcome.prComments, {
          auto: true,
        }).catch((err) => ctx.log.warn(`auto post review ${reviewId}: could not record the post: ${errText(err)}`));
        if (picked.review.some((f) => !posted.has(f.id))) errors.push('Some comments could not be posted.');
      }
    } catch (err) {
      errors.push(errText(err));
    }
  }

  for (const q of picked.questions) {
    if (headMoved) break;
    try {
      const outcome = await ctx.review.postFinding({
        owner: pctx.owner,
        name: pctx.name,
        prNumber: pctx.prNumber,
        reviewHeadSha: pctx.reviewHeadSha,
        finding: toPostFinding(q),
        prLevel: true,
      });
      if (outcome.headMoved) {
        headMoved = true;
        errors.push('The PR changed since this review.');
        break;
      }
      posted.add(q.id);
      await markFindingPosted(ctx, q.id, outcome.commentId, outcome.postedCommentKind, { auto: true }).catch((err) =>
        ctx.log.warn(`auto post finding ${q.id}: could not record the post: ${errText(err)}`),
      );
    } catch (err) {
      errors.push(errText(err));
    }
  }

  const final: ClaudeAutoPostRecord = {
    ...record,
    status: posted.size === 0 ? 'failed' : errors.length > 0 ? 'partial' : 'posted',
    at: nowIso(),
    error: errors[0] ?? null,
    postedFindingIds: [...posted],
  };
  await writeRecord(ctx, reviewId, final).catch((err) =>
    ctx.log.warn(`auto post review ${reviewId}: could not record the result: ${errText(err)}`),
  );
  if (posted.size > 0) {
    await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return { kind: 'done', record: final };
}

/** How long a `posting` record holds the manual Post buttons shut (a crash must not lock them for good). */
export const AUTO_POST_LOCK_MS = 10 * 60 * 1000;

/**
 * Is auto-posting writing this run to GitHub right now? The manual Post routes answer 409 while it
 * is, so a click cannot race the automatic post onto the same lines.
 */
export async function isAutoPostingNow(ctx: AgentContext, reviewId: number, nowMs: number = Date.now()): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ autoPost: cr.autoPost })
    .from(cr)
    .where(eq(cr.id, reviewId))
    .limit(1)
    .execute()) as Array<{ autoPost: ClaudeAutoPostRecord | null }>;
  const rec = rows[0]?.autoPost;
  return rec?.status === 'posting' && nowMs - Date.parse(rec.at) < AUTO_POST_LOCK_MS;
}

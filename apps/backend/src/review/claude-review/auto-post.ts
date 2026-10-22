// AUTO-POSTING — after an AUTO Claude review SUCCEEDS, post its findings to GitHub without a click
// (CORE, free, local-only like every agentic feature). docs/CLAUDE-REVIEW.md § Auto-posting.
//
// THE RULE, in order (the first that fails decides):
//   0. the workspace holding the PR's repo has auto-posting ON (`workspaces.auto_post_enabled`,
//      migration 0087 / pg 0074 — OFF for every workspace until switched on). Off ⇒ nothing is
//      recorded at all;
//   1. WHICH PRs (`autoPostEligibility`, pure): open (never merged or closed), not a draft, not
//      bot-authored (the workspace's bot union), and under scope 'mine' the PR is the reader's own,
//      or the reader is — or was — a requested reviewer (a `review_requests` row OR a 'requested' row
//      in `review_request_events`: GitHub REMOVES the request the moment any review lands, our own
//      COMMENT review included, so the outstanding row alone would make every re-run ineligible), or
//      the reader has reviewed or commented on it (any synced review, review comment or PR comment
//      they wrote);
//   2. WHICH FINDINGS (`selectFindingsToPost`, pure): the enabled severities only (praise never;
//      legacy story findings never — stories are the ticket review's), INCLUDED (an ignored finding
//      never posts) and not posted, and NOT ALREADY ON GITHUB FROM AN EARLIER RUN — neither through
//      the follow-up chain (`prior_finding_id`, walked back) nor by fingerprint (same path, title
//      `similarTitles` — the settled-by-reply identity). An earlier run whose auto-post was cut off
//      mid-flight (`status: 'posting'`) counts its findings as POSSIBLY POSTED: never retried;
//   3. THE VERDICT (`autoVerdictFor` + `verdictGate`, only with `autoVerdict` on): stricter than
//      Claude — any blocker ⇒ REQUEST_CHANGES; APPROVE only when Claude approved AND there is no
//      blocker and no warning (included, non-story findings of the run); else COMMENT. A non-COMMENT
//      verdict is SENT only when the PR is not the reader's own (GitHub refuses self-approval) and
//      the reader has no STANDING verdict, read LIVE from GitHub (the synced table can lag): their
//      latest DECISIVE review (a COMMENTED reply never supersedes one; DISMISSED stands for nothing),
//      and an APPROVE only when the workspace allows auto-approve at the PR's IMPACT
//      level (`approveImpact`; the blast-radius level from the shared resolver, unknown = high).
//      Otherwise the event is COMMENT and the record says why. ⚠ Limn's OWN earlier AUTOMATIC
//      REQUEST_CHANGES (an earlier run's `auto_post.githubReviewId` — never the marker: a manual Post
//      is the reader's own) is not the reader's: an APPROVE goes out over it;
//   3b. THE LIFT: a run with NO blocker (whatever the auto-verdict switch says now) while Limn's own
//      automatic REQUEST_CHANGES still stands withdraws it — superseded by this run's APPROVE, else
//      DISMISSED (`LIFT_BLOCK_MESSAGE`) after the post, inside the same claim, once, recorded as
//      `liftedBlock`, settled. A DB pre-check keeps the live read off ordinary runs. ⚠ Only when no
//      blocker BEHIND the block is unjudged: none left 'not_checked' in this run's follow-up
//      (`unsettledEarlierBlockers`) and none of the blocking run's own blockers that never reached
//      GitHub (`loadUnpostedBlockersOfBlock` — never followed up, so never judged). Otherwise no
//      dismissal, and an APPROVE over the block is held as 'already_requested';
//   4. nothing to post and nothing but COMMENT to send ⇒ `skipped` — `already_posted` (with the
//      ids) when the dedupe alone emptied it, else `nothing_new` — no GitHub write;
//   5. the LIVE PR is still open, not a draft, at the reviewed head (a moved head ⇒ `failed`);
//   6. THE CLAIM — a compare-and-set of `claude_reviews.auto_post` from NULL to `status: 'posting'`
//      BEFORE any write, so a second call (or a restart) can never post the same run twice;
//   7. every finding — questions included — goes in ONE GitHub review whose event is the verdict
//      (COMMENT unless step 3 says otherwise); the seam (`post-seam.ts`) puts each one inline on
//      its line, else on its file's first change with a note, else as a PR comment. Body = the
//      summary's first sentence + `AUTO_POST_FOOTER`. Every body ends with the footer, then the
//      hidden `<!-- pierre:claude-review` marker, so `isLimnPostedComment` knows them and they
//      never re-trigger an auto review;
//   8. stamp what GitHub took (`markReviewPosted` with `auto`), settle the record (posted / partial
//      / failed + the first error), then `settlePrAfterWrite`;
//   9. AUTO RESOLVE (`./auto-resolve.ts`, only with `autoResolve` on) runs after, on its own rules,
//      then AUTO PUSHBACK (`./auto-pushback.ts`: one reply per thread, ever, on a disputed reply).
//
// ⚠ ONCE GITHUB 201s THERE IS NO RETRY, EVER. A failure is RECORDED (the Claude Review tab prints
// "Couldn't post automatically: …" and keeps the Post button), never swallowed and never retried.
// ⚠ Manual runs are never auto-posted: a review you start yourself keeps the Post button.
// ⚠ Never throws: auto-posting failing must never touch the review.
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  AUTO_POST_FOOTER,
  type AutoApproveImpact,
  type AutoPostKinds,
  type AutoPostScope,
  type AutoPostSkipReason,
  type AutoVerdictEvent,
  type ClaudeAutoPostRecord,
  type ClaudeAutoVerdictRecord,
  type ClaudeFinding,
  type ClaudeFindingSeverity,
  type ClaudeReview,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { AutoResolveDeps } from './auto-resolve.js';
import type { PostReviewFinding } from '../../pro/contract.js';
import { readWorkspaceAutoPostForPr } from './auto-settings.js';
import { similarTitles } from './settled-by-reply.js';
import { prAuthorIsAccount } from '../../coding/ai-fix/auto-fix.js';
import {
  getClaudeReviewById,
  getReviewPostContext,
  isAlreadyPostedReraise,
  isReaderIgnoredFinding,
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
  // The reader wrote a review, a review comment or a PR comment on it (synced rows).
  participatedByMe?: boolean;
}

/** May auto-posting write on this PR? null = yes; else why not. */
export function autoPostEligibility(f: AutoPostPrFacts, scope: AutoPostScope): AutoPostSkipReason | null {
  if (f.state !== 'open') return 'not_open';
  if (f.isDraft) return 'draft';
  if (f.authorIsBot) return 'bot_author';
  if (scope === 'mine' && !f.authorIsMe && !f.requestedOfMe && f.participatedByMe !== true) return 'not_yours';
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

/**
 * The findings this run would post — every kind, questions included, in the ONE review — and the
 * ones the dedupe alone left out (an earlier run, or a person, already put them on GitHub).
 */
export function selectFindingsToPost(
  findings: readonly ClaudeFinding[],
  kinds: AutoPostKinds,
  earlier: readonly EarlierFinding[],
): { toPost: ClaudeFinding[]; alreadyPosted: ClaudeFinding[] } {
  const toPost: ClaudeFinding[] = [];
  const alreadyPosted: ClaudeFinding[] = [];
  for (const f of findings) {
    const kind = kindOfSeverity(f.severity);
    if (kind == null || !kinds[kind]) continue;
    // A legacy story finding is the ticket review's business now.
    if (f.story != null) continue;
    // The server's own left-out re-raise of a comment already on GitHub at this commit is a
    // dedupe, not an ignore (persist.ts `isAlreadyPostedReraise`).
    if (isAlreadyPostedReraise(f)) {
      alreadyPosted.push(f);
      continue;
    }
    // Ignored never posts.
    if (!f.included) continue;
    if (f.postedAt != null || f.earlierPost != null || alreadyOnGithub(f, earlier)) {
      alreadyPosted.push(f);
      continue;
    }
    toPost.push(f);
  }
  return { toPost, alreadyPosted };
}

/**
 * The verdict an auto post wants — Claude's, made STRICTER. Counts the run's non-story findings
 * a reader did not ignore (whatever the kind toggles say): any blocker ⇒ REQUEST_CHANGES; APPROVE only when
 * Claude approved and there is no warning either; everything else ⇒ COMMENT.
 */
export function autoVerdictFor(
  claudeVerdict: ClaudeReview['verdict'],
  findings: readonly (Pick<ClaudeFinding, 'severity' | 'included' | 'story'> &
    Partial<Pick<ClaudeFinding, 'postedAt' | 'priorFindingId'>>)[],
): AutoVerdictEvent {
  // ⚠ Everything except a READER'S ignore counts — a re-raise the server left out because its
  // comment is already on this commit is still an open issue (persist.ts `isReaderIgnoredFinding`).
  const counted = findings.filter((f) => f.story == null && !isReaderIgnoredFinding(f));
  if (counted.some((f) => f.severity === 'blocker')) return 'REQUEST_CHANGES';
  if (claudeVerdict === 'APPROVE' && !counted.some((f) => f.severity === 'warning')) return 'APPROVE';
  return 'COMMENT';
}

/**
 * The reader's STANDING verdict on the PR, as read live: their latest DECISIVE review (a COMMENTED
 * review never supersedes an APPROVED / CHANGES_REQUESTED on GitHub, and every thread reply is a
 * COMMENTED review), none (a latest DISMISSED has no standing), or unreadable.
 * 'LIMN_AUTO_CHANGES_REQUESTED' = the standing review is Limn's OWN earlier AUTOMATIC request for
 * changes — matched by a stored `auto_post.githubReviewId`, never by marker or body (a manual Post
 * carries the same marker and is the reader's own judgement).
 */
export type OwnLatestReview = 'none' | 'APPROVED' | 'CHANGES_REQUESTED' | 'LIMN_AUTO_CHANGES_REQUESTED' | 'unreadable';

/** A PR's impact level as the auto-approve gate reads it: null (the resolver drew nothing) → 'unknown'. */
export type ImpactLevel = 'high' | 'medium' | 'low' | 'unknown';

/** May an automatic APPROVE go out at this impact level? ⚠ 'unknown' is judged as HIGH. */
export function impactAllowsApprove(level: ImpactLevel, allowed: AutoApproveImpact): boolean {
  return allowed[level === 'unknown' ? 'high' : level];
}

/** Is the wanted verdict sent? Only off the reader's own PR, at an impact level the workspace allows
 *  to be approved (APPROVE only), and over no standing verdict of theirs. Limn's OWN earlier automatic
 *  request for changes is not theirs: an APPROVE goes out over it (and supersedes it on GitHub); a
 *  second REQUEST_CHANGES is held as 'already_requested'. */
export function verdictGate(
  wanted: AutoVerdictEvent,
  g: { authorIsMe: boolean; ownLatest: OwnLatestReview; impact?: { level: ImpactLevel; allowed: AutoApproveImpact } },
): ClaudeAutoVerdictRecord {
  if (wanted === 'COMMENT') return { wanted, submitted: 'COMMENT', heldReason: null };
  if (g.authorIsMe) return { wanted, submitted: 'COMMENT', heldReason: 'own_pr' };
  if (wanted === 'APPROVE' && g.impact != null) {
    const impact = g.impact.level;
    if (!impactAllowsApprove(impact, g.impact.allowed)) return { wanted, submitted: 'COMMENT', heldReason: 'impact', impact };
    const v = verdictGate(wanted, { authorIsMe: g.authorIsMe, ownLatest: g.ownLatest });
    return { ...v, impact };
  }
  if (g.ownLatest === 'unreadable') return { wanted, submitted: 'COMMENT', heldReason: 'reviews_unreadable' };
  if (g.ownLatest === 'LIMN_AUTO_CHANGES_REQUESTED') {
    return wanted === 'APPROVE'
      ? { wanted, submitted: wanted, heldReason: null }
      : { wanted, submitted: 'COMMENT', heldReason: 'already_requested' };
  }
  if (g.ownLatest !== 'none') return { wanted, submitted: 'COMMENT', heldReason: 'prior_review' };
  return { wanted, submitted: wanted, heldReason: null };
}

/** One review in a live GitHub list (oldest first). `id` is GitHub's numeric review id. */
export interface LiveReview {
  id?: string | number | null;
  login: string | null;
  state: string;
}

/**
 * The reader's standing verdict in a live GitHub list (oldest first): the latest of their DECISIVE
 * reviews — COMMENTED and PENDING are skipped, because neither supersedes a standing APPROVED or
 * CHANGES_REQUESTED on GitHub; a latest DISMISSED stands for nothing. `limnAutoBlockIds` = the ids of
 * Limn's own earlier AUTOMATIC REQUEST_CHANGES reviews on this PR (`loadLimnAutoBlockIds`).
 */
export function ownStandingReview(
  reviews: readonly LiveReview[],
  login: string | null,
  limnAutoBlockIds: ReadonlySet<string> = new Set(),
): { state: OwnLatestReview; reviewId: string | null } {
  if (!login) return { state: 'unreadable', reviewId: null };
  const me = login.toLowerCase();
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const r = reviews[i]!;
    if (r.login == null || r.login.toLowerCase() !== me) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    const reviewId = r.id != null ? String(r.id) : null;
    switch (r.state) {
      case 'DISMISSED':
        return { state: 'none', reviewId: null };
      case 'APPROVED':
        return { state: 'APPROVED', reviewId };
      case 'CHANGES_REQUESTED':
        return {
          state: reviewId != null && limnAutoBlockIds.has(reviewId) ? 'LIMN_AUTO_CHANGES_REQUESTED' : 'CHANGES_REQUESTED',
          reviewId,
        };
      default:
        return { state: 'unreadable', reviewId: null };
    }
  }
  return { state: 'none', reviewId: null };
}

/** The reader's standing verdict alone (`ownStandingReview` with no Limn ids). */
export function ownLatestReview(reviews: readonly LiveReview[], login: string | null): OwnLatestReview {
  return ownStandingReview(reviews, login).state;
}

/** GitHub's timeline message when Limn dismisses its own automatic request for changes. */
export const LIFT_BLOCK_MESSAGE = "Claude's blocking findings are fixed.";

/** The review body's lead: the summary's first plain sentence, else a count. */
export function autoReviewBodyLead(summary: string | null, commentCount: number): string {
  for (const raw of (summary ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || /^([-*+]|\d+[.)])\s/.test(line) || line.startsWith('#')) continue;
    return line.length > 400 ? `${line.slice(0, 399)}…` : line;
  }
  if (commentCount === 0) return 'Reviewed by Claude.';
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
  // The account's own GitHub login (the reviewer whose standing verdict the gate reads).
  accountLogin(accountId: number): Promise<string | null>;
  // EVERY review on the PR, LIVE from GitHub, oldest first.
  liveReviews(owner: string, name: string, prNumber: number): Promise<LiveReview[]>;
  // Dismiss ONE review (Limn's own automatic request for changes). Never throws on a refusal: GitHub's
  // words come back. Optional so an older test fake reads as "cannot dismiss".
  dismissReview?(
    accountId: number,
    owner: string,
    name: string,
    prNumber: number,
    reviewId: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  // The PR's blast-radius level through the shared resolver + the account's config (null = none
  // drawn). Optional so a test fake without it reads as unknown.
  impactLevel?(accountId: number, prId: number): Promise<'high' | 'medium' | 'low' | null>;
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
  async accountLogin(accountId) {
    const { accountGithubLogin } = await import('../../db/review-threads-for-review.js');
    return accountGithubLogin(accountId);
  },
  async impactLevel(accountId, prId) {
    const { getPrImpactLevel } = await import('../../db/blast-radius-query.js');
    return getPrImpactLevel(accountId, prId);
  },
  async liveReviews(owner, name, prNumber) {
    const { ghRestGet } = await import('../../github/client.js');
    const out: LiveReview[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const rows = await ghRestGet<Array<{ id: number; user: { login: string } | null; state: string }>>(
        `/repos/${owner}/${name}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      );
      for (const r of rows) out.push({ id: r.id, login: r.user?.login ?? null, state: r.state });
      if (rows.length < 100) return out;
    }
    // More than 1,000 reviews: the latest one may be beyond what was read — never guess.
    throw new Error('Too many reviews to read.');
  },
  async dismissReview(accountId, owner, name, prNumber, reviewId, message) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { dismissPrReview } = await import('../../github/mutations.js');
    const token = await getAccessToken(accountId);
    const res = await dismissPrReview(token, owner, name, prNumber, Number(reviewId), message);
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  },
};

/**
 * The GitHub ids of Limn's own earlier AUTOMATIC REQUEST_CHANGES reviews on this PR (account-scoped):
 * every earlier run whose auto-post landed a review that was SENT as REQUEST_CHANGES. A review the
 * reader posted with the Post button is never here — that is their own judgement.
 */
export async function loadLimnAutoBlockIds(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  beforeReviewId: number,
): Promise<Set<string>> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ autoPost: cr.autoPost })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), lt(cr.id, beforeReviewId)))
    .execute()) as Array<{ autoPost: ClaudeAutoPostRecord | null }>;
  const ids = new Set<string>();
  for (const r of rows) {
    const a = r.autoPost;
    if (a?.githubReviewId != null && a.verdict?.submitted === 'REQUEST_CHANGES') ids.add(String(a.githubReviewId));
  }
  return ids;
}

// The follow-up statuses that SETTLE an earlier finding. Anything else is still open or unjudged.
const SETTLED_FOLLOW_UP = new Set(['addressed', 'no_longer_applies', 'reply_accepted']);

/**
 * The earlier BLOCKERS this run's follow-up left unsettled that `autoVerdictFor` cannot see: an
 * open one is raised again as one of this run's findings (and counted there, or ignored by the
 * reader), so what is left is a blocker the run did NOT judge — 'not_checked' (over the cap, never
 * reported, carried) — or an open one with no re-raise. Returns their earlier finding ids.
 * ⚠ A run with any of these may not say "Claude's blocking findings are fixed."
 */
export function unsettledEarlierBlockers(
  review: Pick<ClaudeReview, 'findings'> & { followUp?: { items: ReadonlyArray<{ priorFindingId: number; severity: ClaudeFindingSeverity; status: string }> } | null },
): number[] {
  const reraised = new Set<number>();
  for (const f of review.findings) if (f.priorFindingId != null) reraised.add(f.priorFindingId);
  const out: number[] = [];
  for (const it of review.followUp?.items ?? []) {
    if (it.severity !== 'blocker' || SETTLED_FOLLOW_UP.has(it.status)) continue;
    if (reraised.has(it.priorFindingId)) continue;
    out.push(it.priorFindingId);
  }
  return out;
}

/**
 * The blockers of the run that SET Limn's block (the run whose `auto_post.githubReviewId` is
 * `githubReviewId`) that never reached GitHub — not posted by that run, nor by any earlier one
 * (follow-up chain or path + title). Only a POSTED finding is followed up, so nothing ever judges
 * these: while one exists, the block may not be lifted. Returns their finding ids.
 */
export async function loadUnpostedBlockersOfBlock(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  githubReviewId: string,
  earlier: readonly EarlierFinding[],
): Promise<number[]> {
  const t = s(ctx);
  const cr = t.claudeReviews;
  const crf = t.claudeReviewFindings;
  const runs = (await ctx.db
    .select({ id: cr.id, autoPost: cr.autoPost })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId)))
    .execute()) as Array<{ id: number; autoPost: ClaudeAutoPostRecord | null }>;
  const blockRun = runs.find((r) => r.autoPost?.githubReviewId != null && String(r.autoPost.githubReviewId) === githubReviewId);
  // No such run: the caller only passes ids `loadLimnAutoBlockIds` read, so this is a race — hold.
  if (!blockRun) return [-1];
  const rows = (await ctx.db
    .select({
      id: crf.id,
      path: crf.path,
      title: crf.title,
      severity: crf.severity,
      included: crf.included,
      postedAt: crf.postedAt,
      priorFindingId: crf.priorFindingId,
      storyRef: crf.storyRef,
    })
    .from(crf)
    .where(eq(crf.reviewId, blockRun.id))
    .execute()) as Array<{
    id: number;
    path: string;
    title: string;
    severity: ClaudeFindingSeverity;
    included: boolean | null;
    postedAt: unknown;
    priorFindingId: number | null;
    storyRef: string | null;
  }>;
  const onGithub = new Map(earlier.map((e) => [e.id, e.onGithub]));
  return rows
    .filter(
      (f) =>
        f.severity === 'blocker' &&
        f.storyRef == null &&
        !isReaderIgnoredFinding(f) &&
        f.postedAt == null &&
        onGithub.get(f.id) !== true &&
        !alreadyOnGithub(f, earlier),
    )
    .map((f) => f.id);
}

/** Stamp the local review row dismissed (GitHub has accepted the dismissal; a sync reconciles anyway). */
async function stampReviewDismissed(ctx: AgentContext, prId: number, githubReviewId: string): Promise<void> {
  const rv = s(ctx).reviews;
  await ctx.db
    .update(rv)
    .set({ state: 'dismissed' })
    .where(and(eq(rv.prId, prId), eq(rv.databaseId, githubReviewId)))
    .execute();
}

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
  let participatedByMe = false;
  if (me != null && !authorIsMe && !requestedOfMe) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const by = (tbl: any) =>
      ctx.db
        .select({ id: tbl.id })
        .from(tbl)
        .where(and(eq(tbl.prId, prId), eq(tbl.authorId, me)))
        .limit(1)
        .execute() as Promise<unknown[]>;
    const hits = await Promise.all([by(t.reviews), by(t.reviewComments), by(t.prComments)]);
    participatedByMe = hits.some((h) => h.length > 0);
  }
  return { state: pr.state, isDraft: pr.isDraft === true, authorIsBot, authorIsMe, requestedOfMe, participatedByMe };
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
  resolveDeps?: AutoResolveDeps,
): Promise<AutoPostOutcome> {
  let out: AutoPostOutcome;
  try {
    out = await autoPostReview(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`auto post review ${a.reviewId}: ${errText(err)}`);
    out = { kind: 'not_found' };
  }
  // AUTO RESOLVE rides the same switch-board and runs whatever the post did (a run with nothing new
  // to post is exactly the one whose follow-up found the earlier comments fixed). Never throws.
  try {
    const { maybeAutoResolveFindings } = await import('./auto-resolve.js');
    await maybeAutoResolveFindings(ctx, a, deps, resolveDeps);
  } catch (err) {
    ctx.log.warn(`auto resolve review ${a.reviewId}: ${errText(err)}`);
  }
  // AUTO PUSHBACK (./auto-pushback.ts): one reply per thread, ever, where this run disagreed with a
  // person's reply on Limn's own finding. Rides the auto-post switch alone. Never throws.
  try {
    const { maybeAutoPushback } = await import('./auto-pushback.js');
    await maybeAutoPushback(ctx, a, deps, resolveDeps);
  } catch (err) {
    ctx.log.warn(`auto pushback review ${a.reviewId}: ${errText(err)}`);
  }
  return out;
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

  let verdict: ClaudeAutoVerdictRecord | null = null;
  const withVerdict = (): Partial<ClaudeAutoPostRecord> => (verdict != null ? { verdict } : {});
  const skip = async (reason: AutoPostSkipReason, alreadyPostedFindingIds?: number[]): Promise<AutoPostOutcome> => {
    const rec: ClaudeAutoPostRecord = {
      status: 'skipped',
      at: nowIso(),
      reason,
      error: null,
      findingIds: [],
      postedFindingIds: [],
      githubReviewId: null,
      ...(alreadyPostedFindingIds != null ? { alreadyPostedFindingIds } : {}),
      ...withVerdict(),
    };
    return (await claimRun(ctx, reviewId, rec)) ? { kind: 'skipped', reason } : { kind: 'already_claimed' };
  };

  const facts = await readAutoPostPrFacts(ctx, deps, accountId, ws.workspaceId, prId);
  if (!facts) return { kind: 'not_found' };
  const notEligible = autoPostEligibility(facts, ws.settings.scope);
  if (notEligible) return skip(notEligible);

  const earlier = await loadEarlierFindings(ctx, accountId, prId, reviewId);
  const picked = selectFindingsToPost(review.findings, ws.settings.kinds, earlier);
  const nothingReason = (): [AutoPostSkipReason, number[] | undefined] =>
    picked.alreadyPosted.length > 0 ? ['already_posted', picked.alreadyPosted.map((f) => f.id)] : ['nothing_new', undefined];
  const wanted: AutoVerdictEvent | null = ws.settings.autoVerdict ? autoVerdictFor(review.verdict, review.findings) : null;
  if (wanted != null && wanted === 'COMMENT') verdict = verdictGate('COMMENT', { authorIsMe: facts.authorIsMe, ownLatest: 'none' });
  // LIFTING LIMN'S OWN BLOCK: a run with NO blocker (whatever the auto-verdict switch says now) may
  // withdraw an earlier AUTOMATIC request for changes of Limn's that still stands. A DB pre-check
  // first, so an ordinary run costs no extra GitHub read.
  const noBlocker = autoVerdictFor(review.verdict, review.findings) !== 'REQUEST_CHANGES';
  // ⚠ "No blocker" from this run's OWN findings is not enough to lift: an earlier blocker the run
  // did not judge (a 'not_checked' follow-up) is still open as far as anyone knows.
  const unjudgedBlockers = unsettledEarlierBlockers(review);
  // (Read for a REQUEST_CHANGES too: the gate must tell Limn's own standing block from a person's.)
  const limnBlockIds = !facts.authorIsMe ? await loadLimnAutoBlockIds(ctx, accountId, prId, reviewId) : new Set<string>();
  const mayLift = noBlocker && unjudgedBlockers.length === 0 && limnBlockIds.size > 0;
  if (picked.toPost.length === 0 && (wanted == null || wanted === 'COMMENT') && !mayLift) return skip(...nothingReason());

  const pctx = await getReviewPostContext(ctx, reviewId, accountId);
  if (!pctx) return { kind: 'not_found' };

  // The LIVE PR: GitHub may know it merged, closed, went back to draft or moved since the sync.
  const live = await deps.livePr(pctx.owner, pctx.name, pctx.prNumber);
  if (live.merged || live.state !== 'open') return skip('not_open');
  if (live.draft) return skip('draft');

  // The verdict gate reads the reader's own reviews LIVE: a stale synced row must never let an
  // automatic APPROVE overwrite a person's REQUEST_CHANGES.
  const wantsVerdict = wanted != null && wanted !== 'COMMENT';
  // THE IMPACT GATE (APPROVE only): read before the live reviews, so a held approve costs no
  // GitHub call. A failed read is 'unknown', which is held as if high — never guessed down.
  let impact: { level: ImpactLevel; allowed: AutoApproveImpact } | undefined;
  if (wanted === 'APPROVE' && !facts.authorIsMe) {
    let level: ImpactLevel = 'unknown';
    try {
      level = (await deps.impactLevel?.(accountId, prId)) ?? 'unknown';
    } catch (err) {
      ctx.log.warn(`auto post review ${reviewId}: could not read the PR's impact: ${errText(err)}`);
    }
    impact = { level, allowed: ws.settings.approveImpact };
  }
  const impactHeld = impact != null && !impactAllowsApprove(impact.level, impact.allowed);
  let standing: { state: OwnLatestReview; reviewId: string | null } = { state: 'unreadable', reviewId: null };
  if (!facts.authorIsMe && ((wantsVerdict && !impactHeld) || mayLift)) {
    try {
      const [login, reviews] = await Promise.all([
        deps.accountLogin(accountId),
        deps.liveReviews(pctx.owner, pctx.name, pctx.prNumber),
      ]);
      standing = ownStandingReview(reviews, login, limnBlockIds);
    } catch (err) {
      ctx.log.warn(`auto post review ${reviewId}: could not read the PR's reviews: ${errText(err)}`);
    }
  }
  // Limn's own block stands: every blocker behind it must be JUDGED settled before it is lifted —
  // none left unjudged in this run's follow-up, and none of the blocking run's own blockers that
  // never reached GitHub (only a posted finding is ever followed up, so nothing would judge it).
  let blockersRemain = unjudgedBlockers.length > 0;
  if (!blockersRemain && noBlocker && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' && standing.reviewId != null) {
    try {
      blockersRemain = (await loadUnpostedBlockersOfBlock(ctx, accountId, prId, standing.reviewId, earlier)).length > 0;
    } catch (err) {
      ctx.log.warn(`auto post review ${reviewId}: could not read the blocking run's findings: ${errText(err)}`);
      blockersRemain = true;
    }
  }
  if (wanted != null && wanted !== 'COMMENT') {
    verdict = verdictGate(wanted, { authorIsMe: facts.authorIsMe, ownLatest: standing.state, ...(impact ? { impact } : {}) });
    // An APPROVE over Limn's own block is a lift too: held while a blocker behind it is unjudged.
    if (verdict.submitted === 'APPROVE' && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' && blockersRemain) {
      verdict = { ...verdict, submitted: 'COMMENT', heldReason: 'already_requested' };
    }
  }
  // Limn's own automatic request for changes still stands, this run has no blocker and none behind
  // the block is left unjudged: lift it — superseded by the APPROVE this run sends, else dismissed.
  const liftId = noBlocker && !blockersRemain && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' ? standing.reviewId : null;
  if (picked.toPost.length === 0 && (verdict?.submitted ?? 'COMMENT') === 'COMMENT' && liftId == null) {
    return skip(...nothingReason());
  }
  const event: AutoVerdictEvent = verdict?.submitted ?? 'COMMENT';
  // Nothing but the lift to do: no review is sent at all.
  const sendsReview = picked.toPost.length > 0 || event !== 'COMMENT';

  const record: ClaudeAutoPostRecord = {
    status: 'posting',
    at: nowIso(),
    reason: null,
    error: null,
    findingIds: picked.toPost.map((f) => f.id),
    postedFindingIds: [],
    githubReviewId: null,
    ...withVerdict(),
  };
  if (live.headSha !== pctx.reviewHeadSha) {
    const rec = { ...record, status: 'failed' as const, findingIds: [], error: 'The PR changed since this review.' };
    return (await claimRun(ctx, reviewId, rec)) ? { kind: 'done', record: rec } : { kind: 'already_claimed' };
  }
  // ⚠ THE CLAIM, BEFORE ANY WRITE.
  if (!(await claimRun(ctx, reviewId, record))) return { kind: 'already_claimed' };

  const posted = new Set<number>();
  const errors: string[] = [];

  const submit = (ev: AutoVerdictEvent) =>
    ctx.review.postReview({
      owner: pctx.owner,
      name: pctx.name,
      prNumber: pctx.prNumber,
      reviewHeadSha: pctx.reviewHeadSha,
      body: autoReviewBody(review.summary, picked.toPost.length),
      // COMMENT unless auto verdict is on AND its gate let the verdict through.
      verdict: ev,
      // Questions ride the same review: the seam anchors each inline, else falls back.
      includedFindings: picked.toPost.map(toPostFinding),
      dryRun: false,
    });

  // Did the review half go wrong outright (thrown, or the head moved)? Then nothing more is written.
  let reviewFailed = false;
  let refusedBare = false;
  if (sendsReview) {
    try {
      let outcome;
      try {
        outcome = await submit(event);
      } catch (err) {
        // ⚠ THE ONE RETRY: GitHub REFUSED the verdict (a 4xx on the review POST — branch rules,
        // permissions). A refused POST created nothing (the seam posts PR-level comments only after
        // the review lands), so sending the same review once more as a COMMENT cannot double-post.
        // Never on a COMMENT, never on an ambiguous failure (5xx, network, rate limit), never twice.
        if (event === 'COMMENT' || !isVerdictRefusal(err)) throw err;
        verdict = { ...(verdict as ClaudeAutoVerdictRecord), submitted: 'COMMENT', heldReason: 'refused', refusedError: errText(err).slice(0, 300) };
        record.verdict = verdict;
        // A bare verdict with no comments behind it: nothing is left to post. GitHub created
        // nothing, so a lift may still go ahead.
        if (picked.toPost.length === 0) {
          refusedBare = true;
          throw err;
        }
        ctx.log.warn(`auto post review ${reviewId}: GitHub refused ${event}; posting the comments alone`);
        outcome = await submit('COMMENT');
      }
      if (outcome.headMoved) {
        reviewFailed = true;
        errors.push('The PR changed since this review.');
      } else if ('postedReviewId' in outcome) {
        // GitHub has 201'd: from here nothing may throw or retry.
        record.githubReviewId = outcome.postedReviewId;
        for (const id of outcome.inlineFindingIds) posted.add(id);
        for (const pc of outcome.prComments) posted.add(pc.findingId);
        await markReviewPosted(ctx, reviewId, outcome.postedReviewId, outcome.inlineFindingIds, outcome.prComments, {
          auto: true,
          inlineComments: outcome.inlineComments,
        }).catch((err) => ctx.log.warn(`auto post review ${reviewId}: could not record the post: ${errText(err)}`));
        if (picked.toPost.some((f) => !posted.has(f.id))) errors.push('Some comments could not be posted.');
      }
    } catch (err) {
      reviewFailed = !refusedBare;
      errors.push(errText(err));
    }
  }

  const landed = record.githubReviewId != null;
  // THE LIFT, inside the same claim, once: an APPROVE that landed supersedes Limn's own block on
  // GitHub; otherwise it is DISMISSED. Never retried; a refusal is recorded in GitHub's words.
  let dismissed = false;
  if (liftId != null && !reviewFailed) {
    if (landed && verdict?.submitted === 'APPROVE') {
      record.liftedBlock = { reviewId: liftId, how: 'superseded', error: null };
    } else {
      let res: { ok: true } | { ok: false; message: string };
      try {
        res = deps.dismissReview
          ? await deps.dismissReview(accountId, pctx.owner, pctx.name, pctx.prNumber, liftId, LIFT_BLOCK_MESSAGE)
          : { ok: false, message: 'Dismissing is not available.' };
      } catch (err) {
        res = { ok: false, message: errText(err) };
      }
      if (res.ok) {
        dismissed = true;
        record.liftedBlock = { reviewId: liftId, how: 'dismissed', error: null };
        await stampReviewDismissed(ctx, prId, liftId).catch((err) =>
          ctx.log.warn(`auto post review ${reviewId}: could not stamp the dismissal: ${errText(err)}`),
        );
      } else {
        record.liftedBlock = { reviewId: liftId, how: 'dismiss_failed', error: res.message.slice(0, 300) };
      }
    }
  }

  // A run whose only write was the lift: posted when it took, failed (GitHub's words) when not.
  const liftOnly = !sendsReview;
  const final: ClaudeAutoPostRecord = {
    ...record,
    status: liftOnly
      ? dismissed
        ? 'posted'
        : 'failed'
      : !landed
        ? 'failed'
        : errors.length > 0
          ? 'partial'
          : 'posted',
    at: nowIso(),
    error: liftOnly ? (dismissed ? null : (record.liftedBlock?.error ?? null)) : (errors[0] ?? null),
    postedFindingIds: [...posted],
  };
  await writeRecord(ctx, reviewId, final).catch((err) =>
    ctx.log.warn(`auto post review ${reviewId}: could not record the result: ${errText(err)}`),
  );
  if (landed || dismissed) {
    await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return { kind: 'done', record: final };
}

/**
 * Did GitHub turn the review POST down outright (so nothing was created)? A 4xx other than a rate
 * limit. 5xx, network errors and rate limits are ambiguous or transient — never retried.
 */
export function isVerdictRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  // ⚠ GitHub's 422 "An internal error occurred" is NOT a refusal: it has come back for a review it
  // went on to publish. Ambiguous, so never retried.
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && /internal error/i.test(message)) return false;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 && status !== 401;
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

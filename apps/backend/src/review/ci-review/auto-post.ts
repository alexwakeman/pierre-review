// CI AUTO-POSTING — after an AUTO CI review SUCCEEDS, post why CI is red to the PR as ONE PR-level
// comment, without a click (CORE, free, local-only like every agentic feature). The sibling of the
// PR review's claude-review/auto-post.ts, and it follows the same rules. docs/CLAUDE-REVIEW.md
// § Auto-posting.
//
// THE RULE, in order (the first that fails decides):
//   0. the workspace holding the PR's repo has auto-posting ON and its `ciFailures` kind on
//      (default on, inside auto-posting, which is itself OFF until switched on). Off ⇒ nothing is
//      recorded at all;
//   1. the run is an AUTO run that SUCCEEDED (a CI check you started yourself is never posted) and
//      has never been claimed;
//   2. WHICH PRs — claude-review/auto-post.ts `autoPostEligibility`, the one rule: open, not a draft,
//      not bot-authored (CI review only runs on human PRs anyway), and under scope 'mine' yours;
//   3. WHICH ITEMS (`selectCiItemsToPost`, pure): diagnosed, Claude's confidence ABOVE
//      CI_AUTO_POST_MIN_CONFIDENCE (a missing confidence never posts). Flaky / infrastructure
//      causes post too, labelled as such. Nothing left ⇒ `skipped` / `nothing_new`;
//   4. ONCE PER (PR, head, failing check set): an earlier run of this PR at the SAME head with the
//      SAME `failing_key` that claimed a post (posting / posted / partial / failed) ⇒ `skipped` /
//      `already_posted`. A changed failing set is a new key and posts again;
//   5. the LIVE PR is still open, not a draft, at the run's head (a moved head ⇒ `failed`);
//   6. THE CLAIM — compare-and-set of `ci_reviews.auto_post` from NULL to `status: 'posting'` BEFORE
//      the GitHub write, so a second call (or a restart) can never post the same run twice;
//   7. ONE PR comment: the items, then `AUTO_POST_FOOTER`, then the hidden `<!-- pierre:claude-review`
//      marker, so `isLimnPostedComment` knows it and it never re-triggers an auto review;
//   8. settle the record (posted / failed + the error), then `settlePrAfterWrite`.
//
// ⚠ NEVER RETRIED. A failure is recorded and shown, never swallowed and never retried; a run cut
// off mid-post stays `posting` and blocks its (head, failing set) for good — it may be on GitHub.
// ⚠ Never throws: posting failing must never touch the CI review.
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import {
  AUTO_POST_FOOTER,
  type AutoPostSkipReason,
  type CiAutoPostRecord,
  type CiReviewItem,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readWorkspaceAutoPostForPr } from '../claude-review/auto-settings.js';
import {
  autoPostEligibility,
  defaultAutoPostDeps,
  readAutoPostPrFacts,
  type AutoPostDeps,
} from '../claude-review/auto-post.js';
import { getCiPrContext, getCiReviewById, getCiReviewRow } from './persist.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A cause posts only when Claude is MORE sure than this (0-100). */
export const CI_AUTO_POST_MIN_CONFIDENCE = 50;
/** The hidden marker on the comment (the `pierre:claude-review` prefix is what `isLimnPostedComment` reads). */
export const CI_COMMENT_MARKER = '<!-- pierre:claude-review-ci v=1 -->';
// The comment's per-item clips (the stored fields are already clipped; these keep one comment short).
const EXPLANATION_CHARS = 600;
const SUGGESTION_CHARS = 400;

// Earlier records that mean "this (head, failing set) was — or may have been — posted".
const CLAIMED: ReadonlySet<string> = new Set(['posting', 'posted', 'partial', 'failed']);

// ---- pure ----

/** The items one comment carries: diagnosed, confidence above the floor, in run order. */
export function selectCiItemsToPost(items: readonly CiReviewItem[]): CiReviewItem[] {
  return items.filter(
    (i) =>
      i.status === 'diagnosed' &&
      i.cause != null &&
      typeof i.confidence === 'number' &&
      i.confidence > CI_AUTO_POST_MIN_CONFIDENCE,
  );
}

/**
 * Text from a check name or the model (which read an untrusted log) made safe for OUR comment: no
 * @-mention pings, no HTML comment (a forged marker), one line where one line is asked for.
 */
export function safeCommentText(t: string, oneLine = false): string {
  let out = t.replace(/<!--/g, '&lt;!--').replace(/@(?=[A-Za-z0-9_-])/g, '@​');
  if (oneLine) out = out.replace(/\s+/g, ' ').trim();
  return out;
}

const clip = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
const codeSpan = (t: string): string => `\`${safeCommentText(t, true).replace(/`/g, "'")}\``;

/** The comment body: a lead line, one block per item, the footer, then the hidden marker. */
export function ciCommentBody(items: readonly CiReviewItem[], headSha: string): string {
  const lines: string[] = [];
  const n = items.length;
  lines.push(`**Why CI failed** on ${headSha.slice(0, 7)} (${n === 1 ? 'one check' : `${n} checks`}):`);
  lines.push('');
  for (const it of items) {
    const head = [codeSpan(it.checkName)];
    if (it.step) head.push(`step ${codeSpan(it.step)}`);
    lines.push(`- ${head.join(' · ')}: ${safeCommentText(it.cause ?? '', true)}`);
    if (it.category === 'flaky_or_infra') lines.push('  Likely flaky or an infrastructure problem, not this change.');
    if (it.explanation) lines.push(`  ${safeCommentText(clip(it.explanation, EXPLANATION_CHARS), true)}`);
    if (it.path) lines.push(`  File: ${codeSpan(it.line != null ? `${it.path}:${it.line}` : it.path)}`);
    if (it.suggestion) lines.push(`  Fix: ${safeCommentText(clip(it.suggestion, SUGGESTION_CHARS), true)}`);
    if (typeof it.confidence === 'number') lines.push(`  Confidence: ${it.confidence}%`);
  }
  lines.push('');
  lines.push(AUTO_POST_FOOTER);
  lines.push('');
  lines.push(CI_COMMENT_MARKER);
  return lines.join('\n');
}

// ---- I/O ----

export interface CiAutoPostDeps extends Pick<AutoPostDeps, 'livePr' | 'settle' | 'isAutomation' | 'accountUserId'> {
  /** Post ONE PR-level comment as the reader; returns GitHub's comment id. Throws on a GitHub error. */
  postComment(owner: string, name: string, prNumber: number, body: string): Promise<{ commentId: string }>;
}

export const defaultCiAutoPostDeps: CiAutoPostDeps = {
  livePr: defaultAutoPostDeps.livePr,
  settle: defaultAutoPostDeps.settle,
  isAutomation: defaultAutoPostDeps.isAutomation,
  accountUserId: defaultAutoPostDeps.accountUserId,
  async postComment(owner, name, prNumber, body) {
    const { submitGithubIssueComment } = await import('../post-review.js');
    return submitGithubIssueComment({ owner, name, prNumber, body });
  },
};

/** Has an earlier run of this PR at this head and failing set claimed a post? */
async function earlierClaimed(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  runId: number,
  headSha: string,
  failingKey: string | null,
): Promise<boolean> {
  if (failingKey == null) return false;
  const cr = s(ctx).ciReviews;
  const rows = (await ctx.db
    .select({ autoPost: cr.autoPost })
    .from(cr)
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(cr.prId, prId),
        eq(cr.headSha, headSha),
        eq(cr.failingKey, failingKey),
        lt(cr.id, runId),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{ autoPost: CiAutoPostRecord | null }>;
  return rows.some((r) => r.autoPost != null && CLAIMED.has(r.autoPost.status));
}

/** Claim the run (NULL → record). false = it was already claimed. */
async function claimRun(ctx: AgentContext, accountId: number, runId: number, rec: CiAutoPostRecord): Promise<boolean> {
  const cr = s(ctx).ciReviews;
  const rows = (await ctx.db
    .update(cr)
    .set({ autoPost: rec })
    .where(and(eq(cr.id, runId), eq(cr.accountId, accountId), isNull(cr.autoPost)))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function writeRecord(ctx: AgentContext, accountId: number, runId: number, rec: CiAutoPostRecord): Promise<void> {
  const cr = s(ctx).ciReviews;
  await ctx.db
    .update(cr)
    .set({ autoPost: rec })
    .where(and(eq(cr.id, runId), eq(cr.accountId, accountId)))
    .execute();
}

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export type CiAutoPostOutcome =
  | { kind: 'off' }
  | { kind: 'not_found' }
  | { kind: 'already_claimed' }
  | { kind: 'skipped'; reason: AutoPostSkipReason }
  | { kind: 'done'; record: CiAutoPostRecord };

/** Auto-post ONE finished CI run. Called by the manager when an auto run ends. Never throws. */
export async function maybeAutoPostCiReview(
  ctx: AgentContext,
  a: { accountId: number; prId: number; runId: number },
  deps: CiAutoPostDeps = defaultCiAutoPostDeps,
): Promise<CiAutoPostOutcome> {
  try {
    return await autoPostCiReview(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`ci auto post ${a.runId}: ${errText(err)}`);
    return { kind: 'not_found' };
  }
}

async function autoPostCiReview(
  ctx: AgentContext,
  { accountId, prId, runId }: { accountId: number; prId: number; runId: number },
  deps: CiAutoPostDeps,
): Promise<CiAutoPostOutcome> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.enabled || !ws.settings.kinds.ciFailures) return { kind: 'off' };
  const row = await getCiReviewRow(ctx, accountId, runId);
  if (!row || row.prId !== prId || row.status !== 'succeeded') return { kind: 'not_found' };
  // AUTO runs only — a check a person started is theirs to share.
  if (row.trigger !== 'auto') return { kind: 'off' };
  if (row.autoPost != null) return { kind: 'already_claimed' };

  const base: CiAutoPostRecord = {
    status: 'posting',
    at: nowIso(),
    reason: null,
    error: null,
    headSha: row.headSha,
    failingKey: row.failingKey,
    itemIds: [],
    commentId: null,
  };
  const skip = async (reason: AutoPostSkipReason): Promise<CiAutoPostOutcome> => {
    const rec: CiAutoPostRecord = { ...base, status: 'skipped', reason };
    return (await claimRun(ctx, accountId, runId, rec)) ? { kind: 'skipped', reason } : { kind: 'already_claimed' };
  };

  const facts = await readAutoPostPrFacts(ctx, deps, accountId, ws.workspaceId, prId);
  if (!facts) return { kind: 'not_found' };
  const notEligible = autoPostEligibility(facts, ws.settings.scope);
  if (notEligible) return skip(notEligible);

  const run = await getCiReviewById(ctx, accountId, runId);
  if (!run) return { kind: 'not_found' };
  const picked = selectCiItemsToPost(run.items);
  if (picked.length === 0) return skip('nothing_new');
  if (await earlierClaimed(ctx, accountId, prId, runId, row.headSha, row.failingKey)) return skip('already_posted');

  const pr = await getCiPrContext(ctx, accountId, prId);
  if (!pr) return { kind: 'not_found' };
  // The LIVE PR: GitHub may know it merged, closed, went back to draft or moved since the sync.
  const live = await deps.livePr(pr.owner, pr.name, pr.number);
  if (live.merged || live.state !== 'open') return skip('not_open');
  if (live.draft) return skip('draft');
  const record: CiAutoPostRecord = { ...base, itemIds: picked.map((i) => i.id) };
  if (live.headSha !== row.headSha) {
    const rec: CiAutoPostRecord = { ...record, status: 'failed', itemIds: [], error: 'The PR changed since this check.' };
    return (await claimRun(ctx, accountId, runId, rec)) ? { kind: 'done', record: rec } : { kind: 'already_claimed' };
  }
  // ⚠ THE CLAIM, BEFORE THE WRITE.
  if (!(await claimRun(ctx, accountId, runId, record))) return { kind: 'already_claimed' };

  let final: CiAutoPostRecord;
  try {
    const { commentId } = await deps.postComment(pr.owner, pr.name, pr.number, ciCommentBody(picked, row.headSha));
    // GitHub has 201'd: from here nothing may throw or retry.
    final = { ...record, status: 'posted', at: nowIso(), commentId };
  } catch (err) {
    final = { ...record, status: 'failed', at: nowIso(), error: errText(err) };
  }
  await writeRecord(ctx, accountId, runId, final).catch((err) =>
    ctx.log.warn(`ci auto post ${runId}: could not record the result: ${errText(err)}`),
  );
  if (final.status === 'posted') {
    await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return { kind: 'done', record: final };
}

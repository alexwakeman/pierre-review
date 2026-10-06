// POSTING ONE TICKET-REVIEW ITEM TO GITHUB — shared by the manual Post route (routes.ts) and
// auto-posting (./auto-post.ts), so both take the SAME claim, run the SAME "already posted?" check
// and build the SAME comment. The route maps each outcome to its HTTP status; auto-posting records it.
//
// ⚠ THE CLAIM COMES FIRST and the item is re-read INSIDE it: a check made before the claim can be
// answered by a request that has since posted and released it. A click and an auto post of the same
// item therefore cannot both reach GitHub — the loser gets `already_posted`.
// ⚠ Once GitHub 201s nothing here fails or retries: the stamp and the settle are best-effort.
import { and, eq } from 'drizzle-orm';
import { storyOneLine, type TicketReviewItem } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getReviewPrContext } from '../claude-review/persist.js';
import { buildAnchorIndex, fetchPrDiff, isFindingAnchored, stripNoiseFromDiff } from '../post-review.js';
import { isNoiseFile } from '../prepare.js';
import { settlePrAfterWrite } from '../../sync/resync-after-write.js';
import { getTicketItemPostContext, getTicketStateInputs, markTicketItemPosted } from './persist.js';
import { statusWords } from './prompts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Items being posted right now, by id — the synchronous claim that keeps two posts (two clicks, or
// a click and an auto post) from both passing the "already posted?" check.
const posting = new Set<number>();

/** Is this item being posted right now? (The route answers 409 AlreadyPosted.) */
export function isItemBeingPosted(itemId: number): boolean {
  return posting.has(itemId);
}

/**
 * Has this item, or any earlier item it re-raises (`prior_item_id`, followed back), reached GitHub?
 * A re-raise inherits the posting when its run is saved; this also covers an older item posted
 * AFTER that.
 */
export async function postedInChain(ctx: AgentContext, accountId: number, priorItemId: number | null): Promise<boolean> {
  const tri = s(ctx).ticketReviewItems;
  let next = priorItemId;
  for (let hops = 0; next != null && hops < 50; hops += 1) {
    const rows = (await ctx.db
      .select({ priorItemId: tri.priorItemId, postedCommentId: tri.postedCommentId })
      .from(tri)
      .where(and(eq(tri.id, next), eq(tri.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ priorItemId: number | null; postedCommentId: string | null }>;
    const row = rows[0];
    if (!row) return false;
    if (row.postedCommentId != null) return true;
    next = row.priorItemId;
  }
  return false;
}

export type PostTicketItemOutcome =
  | { kind: 'not_found'; message: string }
  | { kind: 'superseded' }
  | { kind: 'already_posted' }
  | { kind: 'not_a_member' }
  | { kind: 'github_error'; message: string }
  | { kind: 'head_moved' }
  | { kind: 'posted'; item: TicketReviewItem; visible: boolean; commentId: string; prId: number };

/**
 * Post a story comment (an item, or auto-posting's "Not asked for" entry) on one PR, at the head
 * the run judged. Anchored inline when its path/line is in the PR's diff, else a PR-level comment.
 * Throws on a GitHub error; `{ headMoved: true }` when the PR moved since.
 */
export async function postStoryComment(
  ctx: AgentContext,
  pr: { owner: string; name: string; number: number },
  a: { id: number; headSha: string; path: string; line: number | null; body: string; lead: string; footer?: string | null },
): Promise<{ headMoved: true } | { headMoved?: false; commentId: string }> {
  let anchored = false;
  let fileInDiff = false;
  if (a.path) {
    try {
      const { diff } = stripNoiseFromDiff(await fetchPrDiff(pr.owner, pr.name, pr.number), isNoiseFile);
      const index = buildAnchorIndex(diff);
      fileInDiff = index.has(a.path);
      anchored = a.line != null && isFindingAnchored(index, a.path, a.line, 'RIGHT');
    } catch {
      /* postFinding re-reads the diff itself when not anchored */
    }
  }
  const outcome = await ctx.review.postFinding({
    owner: pr.owner,
    name: pr.name,
    prNumber: pr.number,
    // The head this run judged: a PR pushed since gets headMoved, so a stale verdict is never posted.
    reviewHeadSha: a.headSha,
    finding: {
      id: a.id,
      path: a.path,
      line: a.path ? a.line : null,
      side: 'RIGHT',
      anchored,
      fileInDiff,
      body: a.body,
      suggestion: null,
      // Carries the finding marker `<!-- pierre:claude-review-finding v=1 -->`, so
      // `isLimnPostedComment` never lets it trigger an auto PR review.
      storyLead: a.lead,
      footer: a.footer ?? null,
    },
  });
  if (outcome.headMoved) return { headMoved: true };
  return { commentId: outcome.commentId };
}

/**
 * Post ONE item of a run. `targetPrId` null = the item's owner PR, else the viewed PR (the route);
 * auto-posting always passes the owner. Never throws.
 */
export async function postTicketItem(
  ctx: AgentContext,
  a: {
    accountId: number;
    runId: number;
    itemId: number;
    viewedPrId: number | null;
    auto?: boolean;
    footer?: string | null;
  },
): Promise<PostTicketItemOutcome> {
  if (posting.has(a.itemId)) return { kind: 'already_posted' };
  posting.add(a.itemId);
  try {
    return await postInsideClaim(ctx, a);
  } catch (err) {
    return { kind: 'github_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    posting.delete(a.itemId);
  }
}

async function postInsideClaim(
  ctx: AgentContext,
  a: { accountId: number; runId: number; itemId: number; viewedPrId: number | null; auto?: boolean; footer?: string | null },
): Promise<PostTicketItemOutcome> {
  const { accountId, runId, itemId } = a;
  // Re-read INSIDE the claim: this is the read the "already posted?" check trusts.
  const pctx = await getTicketItemPostContext(ctx, accountId, runId, itemId);
  if (!pctx) return { kind: 'not_found', message: 'Item not found' };
  const { run, item } = pctx;
  // Only the ticket's LATEST check speaks for it: posting an older run's item could repeat what
  // the newer run's copy already posted.
  const latest = (await getTicketStateInputs(ctx, accountId, [run.ident])).get(run.ident)?.latest;
  if (run.status !== 'succeeded' || latest?.id !== run.id) return { kind: 'superseded' };
  if (item.posted != null || (await postedInChain(ctx, accountId, item.priorItemId))) return { kind: 'already_posted' };
  const targetPrId = item.ownerPrId ?? a.viewedPrId;
  if (targetPrId == null) return { kind: 'not_a_member' };
  const member = run.members.find((m) => m.prId === targetPrId);
  if (!member) return { kind: 'not_a_member' };
  const pr = await getReviewPrContext(ctx, targetPrId, accountId);
  if (!pr) return { kind: 'not_found', message: `PR ${targetPrId} not found` };
  const name = run.ticketKey ?? 'Story';
  const lead = `${name} · ${item.ref} (${statusWords(item.status)}): ${storyOneLine(item.title)}`;
  const path = item.ownerPrId === targetPrId && item.path ? item.path : '';
  let outcome;
  try {
    outcome = await postStoryComment(ctx, pr, {
      id: item.id,
      headSha: member.headSha,
      path,
      line: path ? item.line : null,
      body: item.body,
      lead,
      footer: a.footer ?? null,
    });
  } catch (err) {
    return { kind: 'github_error', message: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.headMoved) return { kind: 'head_moved' };
  // GitHub has 201'd: from here nothing may fail.
  await markTicketItemPosted(ctx, accountId, item.id, {
    prId: targetPrId,
    commentId: outcome.commentId,
    auto: a.auto === true,
  }).catch(() => false);
  let visible = false;
  try {
    visible = (await settlePrAfterWrite({ accountId, prId: targetPrId, log: ctx.log })).visible;
  } catch {
    visible = false;
  }
  const fresh = await getTicketItemPostContext(ctx, accountId, runId, itemId).catch(() => null);
  return {
    kind: 'posted',
    item: fresh?.item ?? {
      ...item,
      posted: {
        prId: targetPrId,
        commentId: outcome.commentId,
        postedAt: new Date().toISOString(),
        carried: false,
        ...(a.auto === true ? { auto: true } : {}),
      },
    },
    visible,
    commentId: outcome.commentId,
    prId: targetPrId,
  };
}

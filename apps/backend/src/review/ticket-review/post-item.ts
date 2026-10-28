// POSTING A TICKET REVIEW'S STORY GAPS TO GITHUB — ONE PR-LEVEL COMMENT per (run, target PR), shared
// by the manual "Post N gaps to …" route (routes.ts) and auto-posting (./auto-post.ts), so both take
// the SAME claim, run the SAME "already posted?" check and build the SAME comment. The route maps
// each outcome to its HTTP status; auto-posting records it. docs/CLAUDE-REVIEW.md § Ticket review.
//
// The comment collates every not-yet-posted gap of the run whose target is that PR (the item's owner
// PR, else the PR the reader is looking at), plus — auto-posting only, when that kind is on — the
// "Not asked for" entries done in that PR, under their own heading. A later check posts a NEW
// collated comment listing only the gaps not yet posted; nothing is ever edited.
//
// ⚠ THE CLAIM COMES FIRST and the run is re-read INSIDE it: a check made before the claim can be
// answered by a request that has since posted and released it. Two clicks, or a click and an auto
// post, therefore cannot both reach GitHub — the loser gets `already_posted`. The claim is keyed by
// (run, target PR) AND holds every item id it may post.
// ⚠ "Never twice" is still PER ITEM (the posted_* columns): after GitHub 201s, EVERY item in the
// comment is stamped with the one comment id. From there nothing fails or retries: the stamps and
// the settle are best-effort.
import { and, eq } from 'drizzle-orm';
import {
  STORY_MISSING_HEADING,
  criterionTextOnly,
  storyOneLine,
  type TicketReview,
  type TicketReviewItem,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getReviewPrContext } from '../claude-review/persist.js';
import { settlePrAfterWrite } from '../../sync/resync-after-write.js';
import { getTicketReviewById, getTicketStateInputs, markTicketItemPosted } from './persist.js';
import { statusWords } from './prompts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Items being posted right now, by id, and the (run, target PR) comments being posted — the
// synchronous claim that keeps two posts from both passing the "already posted?" check.
const posting = new Set<number>();
const postingComments = new Set<string>();

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

/** The target an item posts on: its owner PR, else the PR the reader is looking at. */
export function storyGapTarget(item: Pick<TicketReviewItem, 'ownerPrId'>, viewedPrId: number | null): number | null {
  return item.ownerPrId ?? viewedPrId;
}

// ---- the body (pure) ----

export const STORY_GAPS_BUDGET = 60_000;

/** A model-written string made safe for our comment: no HTML comment (a forged marker). */
const noMarker = (t: string): string => t.replace(/<!--/g, '&lt;!--');

export interface StoryGapEntry {
  ref: string;
  status: TicketReviewItem['status'];
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}
export interface StoryNotAskedEntry {
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}

function placeLine(path: string | null, line: number | null): string | null {
  if (path == null || path.trim() === '') return null;
  return `\`${(line != null ? `${path}:${line}` : path).replace(/`/g, "'")}\``;
}

function block(head: string, path: string | null, line: number | null, body: string): string {
  const parts = [head];
  const where = placeLine(path, line);
  if (where) parts.push(where);
  if (body.trim() !== '') parts.push(noMarker(body.trim()));
  return parts.join('\n');
}

/**
 * The collated comment: a lead line, one block per gap, then the "Not asked for" entries under their
 * own heading. Built under STORY_GAPS_BUDGET; what does not fit is COUNTED and left unposted (only the
 * entries returned in `gaps` / `notAsked` are in the comment). The seam appends the footer + marker.
 */
export function storyGapsCommentBody(
  a: { ticketName: string; headSha: string; gaps: readonly StoryGapEntry[]; notAsked: readonly StoryNotAskedEntry[]; budget?: number },
): { body: string; gaps: number; notAsked: number } {
  const budget = a.budget ?? STORY_GAPS_BUDGET;
  const counts: string[] = [];
  if (a.gaps.length > 0) counts.push(`${a.gaps.length} ${a.gaps.length === 1 ? 'gap' : 'gaps'}`);
  if (a.notAsked.length > 0) counts.push(`${a.notAsked.length} not asked for`);
  const lead = `**${noMarker(a.ticketName)} story check** on ${a.headSha.slice(0, 7)}: ${counts.join(', ')}.`;
  const out: string[] = [lead];
  let used = lead.length + 400;
  // Criteria ("**AC3 · Not met:** …", the ticket's own numbering), then the missing items under their
  // own heading, each led by its title (their 'M1'… ref is internal, never shown). The caller hands the
  // gaps in that order (`criteriaFirst`), so the first `gaps` entries are exactly the ones posted.
  let gaps = 0;
  let missingHeading = false;
  for (const g of a.gaps) {
    const missing = g.status === 'missing';
    const head = missing
      ? `**${noMarker(storyOneLine(g.title))}**`
      : `**${noMarker(g.ref)} · ${statusWords(g.status)[0]!.toUpperCase()}${statusWords(g.status).slice(1)}:** ${noMarker(storyOneLine(criterionTextOnly(g.title)))}`;
    const b = block(head, g.path, g.line, g.body);
    const heading = missing && !missingHeading ? `#### ${STORY_MISSING_HEADING}` : null;
    const extra = heading != null ? heading.length + 2 : 0;
    if (gaps > 0 && used + b.length + extra + 2 > budget) break;
    if (heading != null) {
      out.push(heading);
      missingHeading = true;
    }
    out.push(b);
    used += b.length + extra + 2;
    gaps += 1;
  }
  let notAsked = 0;
  if (gaps === a.gaps.length && a.notAsked.length > 0) {
    const heading = '#### Not asked for';
    const blocks: string[] = [];
    for (const n of a.notAsked) {
      const b = block(`**${noMarker(storyOneLine(n.title))}**`, n.path, n.line, n.body);
      if (gaps + notAsked > 0 && used + heading.length + b.length + 4 > budget) break;
      blocks.push(b);
      used += b.length + 2;
      notAsked += 1;
    }
    if (blocks.length > 0) out.push(heading, ...blocks);
  }
  const left = a.gaps.length - gaps + (a.notAsked.length - notAsked);
  if (left > 0) out.push(`${left} more did not fit in this comment.`);
  return { body: out.join('\n\n'), gaps, notAsked };
}

/** Criteria gaps before missing items, each group in its own order (the comment's layout). */
export function criteriaFirst<T extends { status: TicketReviewItem['status'] }>(gaps: readonly T[]): T[] {
  return [...gaps.filter((g) => g.status !== 'missing'), ...gaps.filter((g) => g.status === 'missing')];
}

// ---- posting ----

export type PostStoryGapsOutcome =
  | { kind: 'not_found'; message: string }
  | { kind: 'superseded' }
  | { kind: 'already_posted' }
  | { kind: 'not_a_member' }
  | { kind: 'github_error'; message: string }
  | { kind: 'head_moved' }
  | {
      kind: 'posted';
      // The items the comment carried (each stamped with `commentId`), and how many "Not asked for"
      // entries rode along (the first `notAskedPosted` of those passed in).
      postedItemIds: number[];
      notAskedPosted: number;
      items: TicketReviewItem[];
      visible: boolean;
      commentId: string;
      prId: number;
    };

/**
 * Post ONE collated comment of a run's story gaps on `targetPrId`. `viewedPrId` = the PR the reader
 * is looking at (an item with no owner targets it); auto-posting passes null (owners only) and its
 * own `itemIds` + `notAsked`. Never throws.
 */
export async function postStoryGapsComment(
  ctx: AgentContext,
  a: {
    accountId: number;
    runId: number;
    targetPrId: number;
    viewedPrId: number | null;
    itemIds?: readonly number[];
    notAsked?: readonly StoryNotAskedEntry[];
    auto?: boolean;
    footer?: string | null;
  },
): Promise<PostStoryGapsOutcome> {
  const key = `${a.runId}:${a.targetPrId}`;
  if (postingComments.has(key)) return { kind: 'already_posted' };
  postingComments.add(key);
  const held: number[] = [];
  try {
    return await postInsideClaim(ctx, a, held);
  } catch (err) {
    return { kind: 'github_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    postingComments.delete(key);
    for (const id of held) posting.delete(id);
  }
}

/**
 * The gaps a post would carry now: target this PR, not posted (nor any earlier raise), not in flight.
 * ⚠ Each item is CLAIMED (`posting` + `held`) in the same synchronous step as its in-flight check,
 * BEFORE any await: two posts under different (run, target PR) keys can both select an un-owned gap
 * (it targets whichever PR each reader is viewing), and a claim taken after the await let both carry
 * it. An item dropped by the chain check is released at once; the rest on exit (the caller).
 */
async function selectGaps(
  ctx: AgentContext,
  accountId: number,
  run: TicketReview,
  targetPrId: number,
  viewedPrId: number | null,
  only: ReadonlySet<number> | null,
  held: number[],
): Promise<TicketReviewItem[]> {
  const out: TicketReviewItem[] = [];
  for (const item of run.items) {
    if (only != null && !only.has(item.id)) continue;
    if (storyGapTarget(item, viewedPrId) !== targetPrId) continue;
    if (item.posted != null || posting.has(item.id)) continue;
    posting.add(item.id);
    held.push(item.id);
    if (await postedInChain(ctx, accountId, item.priorItemId)) {
      posting.delete(item.id);
      held.splice(held.indexOf(item.id), 1);
      continue;
    }
    out.push(item);
  }
  return out;
}

async function postInsideClaim(
  ctx: AgentContext,
  a: {
    accountId: number;
    runId: number;
    targetPrId: number;
    viewedPrId: number | null;
    itemIds?: readonly number[];
    notAsked?: readonly StoryNotAskedEntry[];
    auto?: boolean;
    footer?: string | null;
  },
  held: number[],
): Promise<PostStoryGapsOutcome> {
  const { accountId, runId, targetPrId } = a;
  // Re-read INSIDE the claim: this is the read the "already posted?" check trusts.
  const run = await getTicketReviewById(ctx, accountId, runId);
  if (!run) return { kind: 'not_found', message: 'Story check not found' };
  // Only the ticket's LATEST check speaks for it: posting an older run's items could repeat what the
  // newer run's copies already posted.
  const latest = (await getTicketStateInputs(ctx, accountId, [run.ident])).get(run.ident)?.latest;
  if (run.status !== 'succeeded' || latest?.id !== run.id) return { kind: 'superseded' };
  const member = run.members.find((m) => m.prId === targetPrId);
  if (!member) return { kind: 'not_a_member' };
  // Claims each gap it selects (released by the caller on exit).
  const gaps = criteriaFirst(
    await selectGaps(ctx, accountId, run, targetPrId, a.viewedPrId, a.itemIds ? new Set(a.itemIds) : null, held),
  );
  const notAsked = a.notAsked ?? [];
  if (gaps.length === 0 && notAsked.length === 0) return { kind: 'already_posted' };
  const pr = await getReviewPrContext(ctx, targetPrId, accountId);
  if (!pr) return { kind: 'not_found', message: `PR ${targetPrId} not found` };

  const built = storyGapsCommentBody({
    ticketName: run.ticketKey ?? 'Story',
    headSha: member.headSha,
    // A file reference only where the gap belongs in THIS PR.
    gaps: gaps.map((g) => ({
      ref: g.ref,
      status: g.status,
      title: g.title,
      body: g.body,
      path: g.ownerPrId === targetPrId ? g.path : null,
      line: g.ownerPrId === targetPrId ? g.line : null,
    })),
    notAsked,
  });
  const included = gaps.slice(0, built.gaps);

  let outcome;
  try {
    outcome = await ctx.review.postFinding({
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      // The head this run judged: a PR pushed since gets headMoved, so a stale verdict is never posted.
      reviewHeadSha: member.headSha,
      // ONE PR-level comment, never inline.
      prLevel: true,
      finding: {
        id: included[0]?.id ?? -1,
        path: '',
        line: null,
        side: 'RIGHT',
        anchored: false,
        fileInDiff: false,
        body: built.body,
        suggestion: null,
        storyLead: null,
        // The seam appends the footer and the finding marker `<!-- pierre:claude-review-finding v=1 -->`,
        // so `isLimnPostedComment` never lets it trigger an auto PR review.
        footer: a.footer ?? null,
      },
    });
  } catch (err) {
    return { kind: 'github_error', message: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.headMoved) return { kind: 'head_moved' };
  // GitHub has 201'd: from here nothing may fail. EVERY item in the comment carries its id.
  const commentId = outcome.commentId;
  for (const g of included) {
    await markTicketItemPosted(ctx, accountId, g.id, { prId: targetPrId, commentId, auto: a.auto === true }).catch(() => false);
  }
  let visible = false;
  try {
    visible = (await settlePrAfterWrite({ accountId, prId: targetPrId, log: ctx.log })).visible;
  } catch {
    visible = false;
  }
  const fresh = await getTicketReviewById(ctx, accountId, runId).catch(() => null);
  const ids = new Set(included.map((g) => g.id));
  const now = new Date().toISOString();
  const items =
    fresh?.items.filter((i) => ids.has(i.id)) ??
    included.map((g) => ({
      ...g,
      posted: { prId: targetPrId, commentId, postedAt: now, carried: false, ...(a.auto === true ? { auto: true } : {}) },
    }));
  return {
    kind: 'posted',
    postedItemIds: included.map((g) => g.id),
    notAskedPosted: built.notAsked,
    items,
    visible,
    commentId,
    prId: targetPrId,
  };
}

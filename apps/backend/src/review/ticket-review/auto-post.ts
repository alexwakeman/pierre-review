// AUTO-POSTING A TICKET REVIEW — after a SUCCEEDED, AUTOMATIC ticket review (trigger 'auto' or
// 'cascade'; never a click), post its story gaps to GitHub without a click. docs/CLAUDE-REVIEW.md
// § Auto-posting. The PR-review half is ../claude-review/auto-post.ts; the rules match it.
//
//   • WHERE: ONLY on the member PR the ticket review names as the most likely owner
//     (`ticket_review_items.owner_pr_id`, Claude's `expectedIn` member — the same target as the manual
//     Post button). An item with NO owner PR is not posted anywhere. A "Not asked for" item posts on
//     the member that did it (`prId`), and not at all without one.
//   • WHICH: the target PR's WORKSPACE decides — auto-posting on there, its kinds (`storyGaps` for
//     unmet / partly met criteria and missing pieces, `notAskedFor` for the rest), and its WHICH-PRs
//     scope; the target must be open, not a draft, not bot-authored (`autoPostEligibility`, the PR
//     review's rule) and still at the head the run judged.
//   • NEVER TWICE: an item already posted (its own posting, an inherited one, or any earlier item it
//     re-raises — `postedInChain`), or whose match key (`ticketItemMatchKey`) was posted by ANY
//     earlier run of the ticket, is not posted again. "Not asked for" items have no row, so their
//     postings live on the run's record (`ticket_reviews.auto_post.notRequested`, keyed by PR +
//     folded title) and an earlier run's entry is CARRIED, never re-posted. A run cut off mid-post
//     (`status: 'posting'`) counts everything it tried as possibly posted.
//   • THE CLAIM: a compare-and-set of `ticket_reviews.auto_post` from NULL BEFORE any GitHub write;
//     each item then goes through `postTicketItem`, the manual route's own claim + re-read.
//   • Only the ticket's LATEST succeeded run posts (`not_latest` otherwise).
// ⚠ Once GitHub 201s there is no retry; failures are recorded and shown in Story check
// ("Couldn't post automatically: …") with the Post button still there. Never throws.
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  AUTO_POST_FOOTER,
  storyOneLine,
  type AutoPostSkipReason,
  type TicketAutoPostNotRequested,
  type TicketAutoPostRecord,
  type TicketReview,
  type WorkspaceAutoPostSettings,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getReviewPrContext } from '../claude-review/persist.js';
import { readWorkspaceAutoPostForPr } from '../claude-review/auto-settings.js';
import {
  autoPostEligibility,
  defaultAutoPostDeps,
  readAutoPostPrFacts,
  type AutoPostDeps,
} from '../claude-review/auto-post.js';
import { getTicketReviewById, getTicketStateInputs, ticketItemMatchKey } from './persist.js';
import { postStoryComment, postTicketItem, postedInChain } from './post-item.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const nowIso = (): string => new Date().toISOString();

/** A "Not asked for" item's identity across runs: the PR it is on + its folded title. */
export function notRequestedKey(prId: number, title: string): string {
  return `${prId}|${title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** What every EARLIER run of this ticket already put on GitHub (or may have). */
export async function loadEarlierTicketPostings(
  ctx: AgentContext,
  accountId: number,
  ident: string,
  beforeRunId: number,
): Promise<{ itemKeys: Set<string>; notRequested: Map<string, TicketAutoPostNotRequested> }> {
  const t = s(ctx);
  const runs = (await ctx.db
    .select({ id: t.ticketReviews.id, autoPost: t.ticketReviews.autoPost })
    .from(t.ticketReviews)
    .where(
      and(
        eq(t.ticketReviews.accountId, accountId),
        eq(t.ticketReviews.ticketIdent, ident),
        lt(t.ticketReviews.id, beforeRunId),
      ),
    )
    .execute()) as Array<{ id: number; autoPost: TicketAutoPostRecord | null }>;
  const itemKeys = new Set<string>();
  const notRequested = new Map<string, TicketAutoPostNotRequested>();
  if (runs.length === 0) return { itemKeys, notRequested };
  const maybePosted = new Set<number>();
  for (const r of runs) {
    const rec = r.autoPost;
    if (rec == null) continue;
    const unsettled = rec.status === 'posting';
    if (unsettled) for (const id of rec.itemIds ?? []) maybePosted.add(id);
    for (const n of rec.notRequested ?? []) {
      if (n.commentId != null || unsettled) if (!notRequested.has(n.key)) notRequested.set(n.key, n);
    }
  }
  const items = (await ctx.db
    .select({ id: t.ticketReviewItems.id, ref: t.ticketReviewItems.ref, title: t.ticketReviewItems.title, posted: t.ticketReviewItems.postedCommentId })
    .from(t.ticketReviewItems)
    .where(and(eq(t.ticketReviewItems.accountId, accountId), inArray(t.ticketReviewItems.ticketReviewId, runs.map((r) => r.id))))
    .execute()) as Array<{ id: number; ref: string; title: string; posted: string | null }>;
  for (const i of items) if (i.posted != null || maybePosted.has(i.id)) itemKeys.add(ticketItemMatchKey(i));
  return { itemKeys, notRequested };
}

async function claimRun(ctx: AgentContext, runId: number, rec: TicketAutoPostRecord): Promise<boolean> {
  const tr = s(ctx).ticketReviews;
  const rows = (await ctx.db
    .update(tr)
    .set({ autoPost: rec })
    .where(and(eq(tr.id, runId), isNull(tr.autoPost)))
    .returning({ id: tr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function writeRecord(ctx: AgentContext, runId: number, rec: TicketAutoPostRecord): Promise<void> {
  const tr = s(ctx).ticketReviews;
  await ctx.db.update(tr).set({ autoPost: rec }).where(eq(tr.id, runId)).execute();
}

export type TicketAutoPostOutcome =
  | { kind: 'off' }
  | { kind: 'not_found' }
  | { kind: 'already_claimed' }
  | { kind: 'skipped'; reason: AutoPostSkipReason }
  | { kind: 'done'; record: TicketAutoPostRecord };

/** Auto-post ONE succeeded automatic ticket review. Never throws. */
export async function maybeAutoPostTicketReview(
  ctx: AgentContext,
  a: { accountId: number; runId: number },
  deps: AutoPostDeps = defaultAutoPostDeps,
): Promise<TicketAutoPostOutcome> {
  try {
    return await autoPostTicket(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`auto post ticket review ${a.runId}: ${errText(err)}`);
    return { kind: 'not_found' };
  }
}

interface Target {
  settings: WorkspaceAutoPostSettings;
  // null = may post here; else why not.
  blocked: AutoPostSkipReason | null;
}

async function autoPostTicket(
  ctx: AgentContext,
  { accountId, runId }: { accountId: number; runId: number },
  deps: AutoPostDeps,
): Promise<TicketAutoPostOutcome> {
  const run: TicketReview | null = await getTicketReviewById(ctx, accountId, runId);
  if (!run || run.status !== 'succeeded') return { kind: 'not_found' };
  // AUTOMATIC runs only ('auto' / 'cascade'); a check started by a click keeps the Post buttons.
  if (run.trigger === 'manual') return { kind: 'off' };
  if (run.autoPost != null) return { kind: 'already_claimed' };

  // Each member PR's own workspace decides whether anything may be posted on it.
  const targets = new Map<number, Target | null>();
  const targetFor = async (prId: number): Promise<Target | null> => {
    if (targets.has(prId)) return targets.get(prId)!;
    let t: Target | null = null;
    const member = run.members.find((m) => m.prId === prId);
    const ws = member ? await readWorkspaceAutoPostForPr(ctx, accountId, prId) : null;
    if (ws && ws.settings.enabled) {
      const facts = await readAutoPostPrFacts(ctx, deps, accountId, ws.workspaceId, prId);
      t = { settings: ws.settings, blocked: facts ? autoPostEligibility(facts, ws.settings.scope) : 'not_open' };
    }
    targets.set(prId, t);
    return t;
  };
  let anyOn = false;
  for (const m of run.members) if ((await targetFor(m.prId)) != null) anyOn = true;
  if (!anyOn) return { kind: 'off' };

  const skip = async (reason: AutoPostSkipReason): Promise<TicketAutoPostOutcome> => {
    const rec: TicketAutoPostRecord = { status: 'skipped', at: nowIso(), reason, error: null, itemIds: [], postedItemIds: [], notRequested: [] };
    return (await claimRun(ctx, runId, rec)) ? { kind: 'skipped', reason } : { kind: 'already_claimed' };
  };

  const latest = (await getTicketStateInputs(ctx, accountId, [run.ident])).get(run.ident)?.latest;
  if (latest?.id !== run.id) return skip('not_latest');

  const earlier = await loadEarlierTicketPostings(ctx, accountId, run.ident, run.id);

  // ---- story gaps (item rows) ----
  const itemIds: number[] = [];
  let ownerless = 0;
  for (const item of run.items) {
    if (item.ownerPrId == null) {
      ownerless += 1;
      continue;
    }
    const t = await targetFor(item.ownerPrId);
    if (!t || t.blocked != null || !t.settings.kinds.storyGaps) continue;
    if (item.posted != null || earlier.itemKeys.has(ticketItemMatchKey(item))) continue;
    if (await postedInChain(ctx, accountId, item.priorItemId)) continue;
    itemIds.push(item.id);
  }

  // ---- "Not asked for" (no item rows) ----
  const notRequested: TicketAutoPostNotRequested[] = [];
  const toPostNr: Array<{ entry: TicketAutoPostNotRequested; title: string; body: string; path: string; line: number | null }> = [];
  (run.assessment?.notRequested ?? []).forEach((g, index) => {
    if (g.prId == null) return;
    const key = notRequestedKey(g.prId, g.title);
    const prev = earlier.notRequested.get(key);
    if (prev) {
      // Already on GitHub from an earlier run: carried onto this run's record, never re-posted.
      notRequested.push({ index, key, prId: prev.prId, commentId: prev.commentId, postedAt: prev.postedAt, carried: true });
      return;
    }
    toPostNr.push({
      entry: { index, key, prId: g.prId, commentId: null, postedAt: null, carried: false },
      title: g.title,
      body: g.explanation ?? '',
      path: g.path ?? '',
      line: g.line,
    });
  });
  const nrToPost: typeof toPostNr = [];
  for (const n of toPostNr) {
    const t = await targetFor(n.entry.prId);
    if (t && t.blocked == null && t.settings.kinds.notAskedFor) nrToPost.push(n);
  }

  if (itemIds.length === 0 && nrToPost.length === 0) {
    if (notRequested.length > 0) {
      // Nothing new, but keep the carried postings on the newest run so Story check can show them.
      const rec: TicketAutoPostRecord = { status: 'skipped', at: nowIso(), reason: 'nothing_new', error: null, itemIds: [], postedItemIds: [], notRequested };
      return (await claimRun(ctx, runId, rec)) ? { kind: 'skipped', reason: 'nothing_new' } : { kind: 'already_claimed' };
    }
    return skip(ownerless > 0 && run.items.length === ownerless ? 'no_owner' : 'nothing_new');
  }

  // The LIVE state of every PR about to be written on.
  const livePrs = new Map<number, { owner: string; name: string; number: number } | null>();
  const liveOk = async (prId: number): Promise<boolean> => {
    if (livePrs.has(prId)) return livePrs.get(prId) != null;
    const pr = await getReviewPrContext(ctx, prId, accountId);
    let ok = pr != null;
    if (pr) {
      try {
        const live = await deps.livePr(pr.owner, pr.name, pr.number);
        ok = live.state === 'open' && !live.merged && !live.draft;
      } catch {
        ok = false;
      }
    }
    livePrs.set(prId, ok && pr ? { owner: pr.owner, name: pr.name, number: pr.number } : null);
    return ok;
  };
  const ownerOf = new Map(run.items.map((i) => [i.id, i.ownerPrId]));
  const liveItems: number[] = [];
  for (const id of itemIds) if (await liveOk(ownerOf.get(id)!)) liveItems.push(id);
  const liveNr: typeof nrToPost = [];
  for (const n of nrToPost) if (await liveOk(n.entry.prId)) liveNr.push(n);
  if (liveItems.length === 0 && liveNr.length === 0) return skip('not_open');

  const record: TicketAutoPostRecord = {
    status: 'posting',
    at: nowIso(),
    reason: null,
    error: null,
    itemIds: liveItems,
    postedItemIds: [],
    notRequested: [...notRequested, ...liveNr.map((n) => n.entry)],
  };
  // ⚠ THE CLAIM, BEFORE ANY WRITE.
  if (!(await claimRun(ctx, runId, record))) return { kind: 'already_claimed' };

  const errors: string[] = [];
  const posted: number[] = [];
  for (const itemId of liveItems) {
    const out = await postTicketItem(ctx, { accountId, runId, itemId, viewedPrId: null, auto: true, footer: AUTO_POST_FOOTER });
    if (out.kind === 'posted') posted.push(itemId);
    else if (out.kind === 'github_error') errors.push(out.message);
    else if (out.kind === 'head_moved') errors.push('A PR changed since the story check.');
    else if (out.kind === 'superseded') errors.push('A newer story check replaced this one.');
    // already_posted: someone (a click) got there first — nothing to do.
  }
  const settleIds = new Set<number>();
  const name = run.ticketKey ?? 'Story';
  for (const n of liveNr) {
    const pr = livePrs.get(n.entry.prId)!;
    const member = run.members.find((m) => m.prId === n.entry.prId)!;
    try {
      const out = await postStoryComment(ctx, pr, {
        id: -(n.entry.index + 1),
        headSha: member.headSha,
        path: n.path,
        line: n.line,
        body: n.body,
        lead: `${name} · Not asked for: ${storyOneLine(n.title)}`,
        footer: AUTO_POST_FOOTER,
      });
      if (out.headMoved) {
        errors.push('A PR changed since the story check.');
        continue;
      }
      n.entry.commentId = out.commentId;
      n.entry.postedAt = nowIso();
      settleIds.add(n.entry.prId);
    } catch (err) {
      errors.push(errText(err));
    }
  }
  const nrPosted = liveNr.filter((n) => n.entry.commentId != null).length;
  const any = posted.length + nrPosted > 0;
  const final: TicketAutoPostRecord = {
    ...record,
    status: !any ? 'failed' : errors.length > 0 ? 'partial' : 'posted',
    at: nowIso(),
    error: errors[0] ?? null,
    postedItemIds: posted,
    // Only the entries that are on GitHub (or carried); a failed one is not a posting.
    notRequested: [...notRequested, ...liveNr.filter((n) => n.entry.commentId != null).map((n) => n.entry)],
  };
  await writeRecord(ctx, runId, final).catch((err) =>
    ctx.log.warn(`auto post ticket review ${runId}: could not record the result: ${errText(err)}`),
  );
  // Items settle inside postTicketItem; the "Not asked for" comments settle here.
  for (const prId of settleIds) await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  return { kind: 'done', record: final };
}

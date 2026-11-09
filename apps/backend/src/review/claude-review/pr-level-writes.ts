// PR-LEVEL FINDINGS ON GITHUB — the writes for a Limn finding that was posted as a PR COMMENT (it
// could not be placed on a line), so GitHub gives it no thread to reply on or resolve.
// docs/CLAUDE-REVIEW.md § Replies to Limn's findings → PR-level findings.
//
// TWO WRITES, each a NEW PR comment that links the finding comment and carries the hidden
// `pierre:claude-review-followup on=<finding comment id> act=…` marker (finding-replies.ts), so ANY
// Limn sees it was said:
//   • CLOSE ('ack') — the follow-up judged it addressed / no longer applies, or ACCEPTED a person's
//     reply: ONE short acknowledgement ("Addressed in abc1234: <how>", or Limn's one-sentence answer
//     to the reply), THEN the finding comment is HIDDEN as RESOLVED (`minimizeComment`), GitHub's
//     nearest thing to resolving a thread. Recorded on the owner row's `auto_resolve` (the same
//     record, the same switches as auto resolve: auto-resolve.ts calls this).
//   • STILL OPEN ('still_open') — not / partly addressed, or a DISPUTED reply: ONE
//     "**Still open:** <reason>" comment. ⚠ AT MOST ONCE PER FINDING, EVER: recorded on the owner
//     row's `pushback` (auto-pushback.ts for a disputed reply on an auto run, still-open.ts for a
//     posted review, manual-reply.ts for "Post reply" / "Post still open"), and any Limn's
//     `act=still_open` marker on the PR counts too.
// "Mark resolved" (manual-reply.ts): the hide alone, on the reader's press.
//
// ⚠ CLAIM BEFORE EVERY WRITE (compare-and-set from NULL), NEVER RETRIED by an automatic run: a
// failure is recorded and shown. Only the reader's own findings (`ownOnly`): never a teammate's.
// ⚠ Never throws from the `maybe…` entry points.
import { and, eq, isNull } from 'drizzle-orm';
import {
  STILL_OPEN_LEAD,
  stillOpenReasonText,
  type FindingAutoResolveRecord,
  type FindingPushbackRecord,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  isClearReplyRefusal,
  issueCommentUrl,
  loadPrConversationRows,
  prLevelFollowUpMarker,
  prLevelHasAck,
  prLevelHasStillOpen,
  prRefOf,
  pushbackMayBePosted,
  resolveReplyMayBePosted,
  type PrRef,
  type ThreadOwnerRow,
} from './finding-replies.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sch = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** " ([the finding](url))", or nothing without a link. */
function findingLink(url: string | null): string {
  return url ? ` ([the finding](${url}))` : '';
}

/** "**Still open:** <reason> ([the finding](…))", the footer, the marker. Pure. */
export function prLevelStillOpenBody(
  reason: string | null,
  findingCommentId: string | null,
  findingUrl: string | null,
  footer: string,
): string {
  const text = stillOpenReasonText(reason) || 'This is not addressed yet.';
  const foot = footer.trim() !== '' ? `\n\n${footer}` : '';
  return `${STILL_OPEN_LEAD} ${text}${findingLink(findingUrl)}${foot}\n\n${prLevelFollowUpMarker(findingCommentId, 'still_open')}`;
}

/** The acknowledgement before the finding comment is hidden: the lead, the link, the footer, the marker. Pure. */
export function prLevelAckBody(
  lead: string,
  findingCommentId: string | null,
  findingUrl: string | null,
  footer: string,
): string {
  const text = stillOpenReasonText(lead) || 'Thanks, that settles it.';
  const foot = footer.trim() !== '' ? `\n\n${footer}` : '';
  return `${text}${findingLink(findingUrl)}${foot}\n\n${prLevelFollowUpMarker(findingCommentId, 'ack')}`;
}

/** The pieces that touch GitHub, so a test can replace them. */
export interface PrLevelDeps {
  // ONE new PR comment. `how`: an automatic run ('auto') or the reader's press ('reader_pressed').
  comment(accountId: number, pr: PrRef & { id: number }, body: string, how: 'auto' | 'reader_pressed'): Promise<{ commentId: string | null }>;
  // Hide the finding comment as RESOLVED. `nodeId` when it is synced, else read by its numeric id.
  minimize(accountId: number, pr: PrRef & { id: number }, finding: { commentId: string; nodeId: string | null }, how: 'auto' | 'reader_pressed'): Promise<void>;
}

export const defaultPrLevelDeps: PrLevelDeps = {
  async comment(accountId, pr, body, how) {
    const [{ getAccessToken }, { addIssueComment }, ledger] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
      import('../../db/limn-actions.js'),
    ]);
    const origin = ledger.orReader(await ledger.limnOriginForPr(accountId, pr.id, how));
    const c = await addIssueComment(await getAccessToken(accountId), pr.owner, pr.name, pr.number, body, origin);
    return { commentId: c.databaseId != null ? String(c.databaseId) : null };
  },
  async minimize(accountId, pr, finding, how) {
    const [{ getAccessToken }, { minimizeIssueComment }, ledger] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
      import('../../db/limn-actions.js'),
    ]);
    const origin = ledger.orReader(await ledger.limnOriginForPr(accountId, pr.id, how));
    const target = finding.nodeId ? { nodeId: finding.nodeId } : { owner: pr.owner, name: pr.name, databaseId: finding.commentId };
    await minimizeIssueComment(await getAccessToken(accountId), target, origin);
  },
};

// A test replaces the GitHub half for every caller at once (auto resolve, pushback, still-open, the
// tab's buttons).
let override: PrLevelDeps | null = null;
export function _setPrLevelDepsForTest(d: PrLevelDeps | null): void {
  override = d;
}
const activeDeps = (): PrLevelDeps => override ?? defaultPrLevelDeps;

/** The finding comment's node id, when it is synced. */
async function findingNodeId(ctx: AgentContext, prId: number, commentId: string): Promise<string | null> {
  const pc = sch(ctx).prComments;
  const rows = (await ctx.db
    .select({ nodeId: pc.githubNodeId })
    .from(pc)
    .where(and(eq(pc.prId, prId), eq(pc.databaseId, commentId)))
    .limit(1)
    .execute()) as Array<{ nodeId: string | null }>;
  return rows[0]?.nodeId ?? null;
}

export type PrLevelWriteResult =
  | { kind: 'skipped'; why: 'already' | 'no_comment' | 'no_pr' | 'lost_claim' }
  | { kind: 'done'; status: 'posted' | 'resolved' | 'failed'; commentId: string | null; error: string | null };

interface Common {
  accountId: number;
  prId: number;
  reviewId: number;
  owner: ThreadOwnerRow;
  footer: string;
  how: 'auto' | 'reader_pressed';
  // The reader's press may re-claim a record GitHub CLEARLY refused (`refused: true`); a run never does.
  manual?: boolean;
}

/** Recorded with the row's `crf.id` scoped claim: NULL → value (or, by hand, a refused record → value). */
async function claim(
  ctx: AgentContext,
  owner: ThreadOwnerRow,
  col: 'pushback' | 'autoResolve',
  value: FindingPushbackRecord | FindingAutoResolveRecord,
  manual: boolean,
): Promise<boolean> {
  const crf = sch(ctx).claudeReviewFindings;
  const prior = col === 'pushback' ? owner.pushback : owner.autoResolve;
  const reclaim = manual && prior != null && prior.status === 'failed' && prior.refused === true;
  if (prior != null && !reclaim) return false;
  const where = prior == null ? and(eq(crf.id, owner.id), isNull(crf[col])) : eq(crf.id, owner.id);
  const rows = (await ctx.db.update(crf).set({ [col]: value }).where(where).returning({ id: crf.id }).execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function record(ctx: AgentContext, ownerId: number, set: Record<string, unknown>): Promise<void> {
  const crf = sch(ctx).claudeReviewFindings;
  await ctx.db
    .update(crf)
    .set(set)
    .where(eq(crf.id, ownerId))
    .execute()
    .catch((err: unknown) => ctx.log.warn(`pr-level finding ${ownerId}: could not record the result: ${errText(err)}`));
}

/**
 * "**Still open:** <reason>" — ONE PR comment per finding, EVER (the owner's `pushback` record, and
 * any Limn's `act=still_open` marker on the PR). Never throws.
 */
export async function postPrLevelStillOpen(
  ctx: AgentContext,
  a: Common & { reason: string | null },
  deps: PrLevelDeps = activeDeps(),
): Promise<PrLevelWriteResult> {
  try {
    const commentId = a.owner.githubCommentId;
    if (!commentId) return { kind: 'skipped', why: 'no_comment' };
    if (pushbackMayBePosted(a.owner.pushback) && !(a.manual && a.owner.pushback?.refused === true)) return { kind: 'skipped', why: 'already' };
    const [pr, rows] = await Promise.all([prRefOf(ctx, a.accountId, a.prId), loadPrConversationRows(ctx, a.prId)]);
    if (!pr) return { kind: 'skipped', why: 'no_pr' };
    if (prLevelHasStillOpen(rows, commentId)) return { kind: 'skipped', why: 'already' };
    const rec: FindingPushbackRecord = {
      status: 'posting',
      at: nowIso(),
      byReviewId: a.reviewId,
      commentId: null,
      error: null,
      ...(a.manual ? { manual: true } : {}),
    };
    // ⚠ THE CLAIM, BEFORE THE WRITE.
    if (!(await claim(ctx, a.owner, 'pushback', rec, a.manual === true))) return { kind: 'skipped', why: 'lost_claim' };
    try {
      const { commentId: posted } = await deps.comment(
        a.accountId,
        { ...pr, id: a.prId },
        prLevelStillOpenBody(a.reason, commentId, issueCommentUrl(pr, commentId), a.footer),
        a.how,
      );
      await record(ctx, a.owner.id, { pushback: { ...rec, status: 'posted', at: nowIso(), commentId: posted } });
      return { kind: 'done', status: 'posted', commentId: posted, error: null };
    } catch (err) {
      await record(ctx, a.owner.id, {
        pushback: { ...rec, status: 'failed', at: nowIso(), error: errText(err), refused: isClearReplyRefusal(err) },
      });
      return { kind: 'done', status: 'failed', commentId: null, error: errText(err) };
    }
  } catch (err) {
    ctx.log.warn(`pr-level still open finding ${a.owner.id}: ${errText(err)}`);
    return { kind: 'done', status: 'failed', commentId: null, error: errText(err) };
  }
}

/**
 * CLOSE a PR-level finding: the acknowledgement (unless `lead` is null: "Mark resolved", the hide
 * alone), then hide the finding comment as RESOLVED. ONE per finding, on the owner's `auto_resolve`
 * record. Never throws.
 */
export async function closePrLevelFinding(
  ctx: AgentContext,
  a: Common & {
    lead: string | null;
    outcome: FindingAutoResolveRecord['outcome'];
    acceptKind?: FindingAutoResolveRecord['acceptKind'];
    headSha: string;
    why?: FindingAutoResolveRecord['why'];
  },
  deps: PrLevelDeps = activeDeps(),
): Promise<PrLevelWriteResult> {
  try {
    const commentId = a.owner.githubCommentId;
    if (!commentId) return { kind: 'skipped', why: 'no_comment' };
    if (resolveReplyMayBePosted(a.owner.autoResolve) && !(a.manual && a.owner.autoResolve?.refused === true)) {
      return { kind: 'skipped', why: 'already' };
    }
    const [pr, rows, nodeId] = await Promise.all([
      prRefOf(ctx, a.accountId, a.prId),
      loadPrConversationRows(ctx, a.prId),
      findingNodeId(ctx, a.prId, commentId),
    ]);
    if (!pr) return { kind: 'skipped', why: 'no_pr' };
    if (a.lead != null && prLevelHasAck(rows, commentId)) return { kind: 'skipped', why: 'already' };
    const rec: FindingAutoResolveRecord = {
      status: 'resolving',
      at: nowIso(),
      outcome: a.outcome,
      ...(a.outcome === 'reply_accepted' ? { acceptKind: a.acceptKind ?? null } : {}),
      byReviewId: a.reviewId,
      headSha: a.headSha,
      replyCommentId: null,
      error: null,
      ...(a.manual ? { manual: true } : {}),
      ...(a.why ? { why: a.why } : {}),
    };
    // ⚠ THE CLAIM, BEFORE ANY WRITE.
    if (!(await claim(ctx, a.owner, 'autoResolve', rec, a.manual === true))) return { kind: 'skipped', why: 'lost_claim' };
    const target = { ...pr, id: a.prId };
    let final: FindingAutoResolveRecord = rec;
    if (a.lead != null) {
      try {
        const { commentId: posted } = await deps.comment(a.accountId, target, prLevelAckBody(a.lead, commentId, issueCommentUrl(pr, commentId), a.footer), a.how);
        final = { ...final, replyCommentId: posted };
      } catch (err) {
        final = { ...final, status: 'failed', at: nowIso(), error: errText(err), refused: isClearReplyRefusal(err) };
        await record(ctx, a.owner.id, { autoResolve: final });
        return { kind: 'done', status: 'failed', commentId: null, error: final.error };
      }
    }
    // The acknowledgement is on GitHub (or there is none): now hide the finding comment.
    let resolvedAt: Date | null = null;
    try {
      await deps.minimize(a.accountId, target, { commentId, nodeId }, a.how);
      resolvedAt = new Date();
      final = { ...final, status: 'resolved', at: nowIso(), minimized: true };
    } catch (err) {
      // Nothing was hidden; with no acknowledgement either, nothing landed at all.
      final = {
        ...final,
        status: 'failed',
        at: nowIso(),
        error: errText(err),
        ...(a.lead == null ? { refused: isClearReplyRefusal(err) } : {}),
      };
    }
    await record(ctx, a.owner.id, { autoResolve: final, ...(resolvedAt ? { autoResolvedAt: resolvedAt } : {}) });
    return {
      kind: 'done',
      status: final.status === 'resolved' ? 'resolved' : final.replyCommentId != null ? 'posted' : 'failed',
      commentId: final.replyCommentId,
      error: final.error,
    };
  } catch (err) {
    ctx.log.warn(`pr-level close finding ${a.owner.id}: ${errText(err)}`);
    return { kind: 'done', status: 'failed', commentId: null, error: errText(err) };
  }
}

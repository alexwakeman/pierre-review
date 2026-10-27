// FOLLOW-UP ON THE PREVIOUS REVIEW (Pro) — the pure half: which earlier findings are sent to the
// model, how its report is reconciled, and how a still-open finding is raised again.
//
// ⚠ WHICH FINDINGS ENTER IT: `isFollowUpEligible` — every POSTED one, and every one NOT POSTED YET
// that the reader has not ignored (still waiting to be posted). A previous review with none yields
// no plan, and the run is an ordinary review with no follow-up section. Every other finding of the
// previous review is NAMED on the stored record with a reason (`leftOut`), never silently dropped.
//
// ⚠ NEVER INVENT "ADDRESSED". Every earlier finding we sent gets EXACTLY ONE status: the model's
// first report for its ref, or 'not_checked' when it said nothing. A finding over the cap was never
// shown to the model and is 'not_checked' too. The next review CARRIES every 'not_checked' item
// forward (persist.ts `loadPriorReviewForFollowUp`), so nothing silently drops out of the chain.
//
// ⚠ "HAS THE CODE MOVED?" IS ASKED PER FINDING, against the head of the review that RAISED it
// (`findingHeadMoved`). A carried finding was raised at an older head than the previous review's,
// so the plan-level `headMoved` (previous review vs now) is the wrong question for it: it would
// tell the model "nothing changed" and copy a stale line + suggestion onto the re-raise.
//
// ⚠ ONLY NEW COMMITS MAY CHANGE A STATUS. When this run's head is the previous review's head (a
// comment-only re-run, or "Run anyway" on the same commit), nothing in the code has moved, so the
// status is decided in CODE, not by the model (`plan.locked`, applied in `reconcileFollowUp`): a
// finding the previous review raised at this head is still 'not_addressed', and a carried item keeps
// the status the previous run gave it. The findings are still SHOWN (so the model links its re-raise
// by `priorRef` instead of repeating the comment as a new, included finding); only the answer is
// fixed. Items stored this way carry `statusCarried: true`.
//
// The earlier findings' text was written by an earlier model run over the same attacker-influenced
// pull request, so prompts.ts fences it with the run's nonce like every other untrusted block.
//
// ⚠ REPLIES ON THE FINDING'S THREAD (finding-replies.ts). A finding whose GitHub thread has a
// person's reply carries it (`thread.replies`), and only such a finding may get one of the two
// REPLY statuses: 'reply_accepted' (with `acceptKind` 'not_valid' | 'deferred' and a one-sentence
// acknowledgement) or 'reply_disputed' (with a short pushback). Enforced in CODE in
// `reconcileFollowUp`: a reply status on a finding with no replies is treated as unreported, and a
// 'deferred' acceptance of a BLOCKER becomes 'reply_disputed' with a templated pushback (a blocker
// is fixed in this PR). A reply status may override a same-head lock — a reply is new evidence even
// when the code has not moved. 'reply_disputed' is OPEN (raised again like 'not_addressed');
// 'reply_accepted' is settled from then on (persist.ts `loadSettledByReplyFindings`).
// ⚠ A RESOLVED thread with a reply is judged the SAME way (it is no longer settled on sight): the
// prompt says it was resolved and by whom, it is selected last, and auto-pushback.ts never posts on
// it (a manual "Post reply" still may).
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpItemRecord,
  ClaudeFollowUpLeftOutReason,
  ClaudeFollowUpLeftOutRecord,
  ClaudeFollowUpStatus,
} from '@pierre-review/shared';
import type { ReviewFinding, ReviewFollowUpReport } from '../../platform/contract.js';
import { RESPONSE_CHARS, judgeableReplies, replyExcerpt, type FindingReply } from './reply-text.js';

// ---- caps (the prompt block's budget) ----
export const PRIOR_FINDINGS_MAX = 40;
export const PRIOR_BLOCK_CHARS = 24_000;
export const PRIOR_TITLE_CHARS = 300;
export const PRIOR_BODY_CHARS = 2_000;
export const PRIOR_HUNK_CHARS = 1_200;
export const PRIOR_SUGGESTION_CHARS = 800;
// Per-file patch clamp handed to fetchCompareDiff, and the whole "changes since" block's budget.
export const SINCE_PATCH_CHARS = 8_000;
export const SINCE_DIFF_CHARS = 30_000;
// Clip applied to the model's per-item explanation before it is stored.
export const FOLLOW_UP_EXPLANATION_CHARS = 1_000;

/** One earlier finding, as loaded for the follow-up (body already resolved). */
export interface PriorFindingForFollowUp {
  id: number;
  // The head of the review that RAISED it. For the previous review's own findings that is the
  // previous review's head; a CARRIED finding keeps its own, older one. Every "has the code moved
  // since?" question about this finding is asked against THIS sha, never the previous review's.
  headSha: string;
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  severity: ClaudeFindingSeverity;
  title: string;
  // The body the user saw: `editedBody` when it is non-blank, else Claude's `body`.
  body: string;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
  fileInDiff: boolean;
  // It was posted to GitHub (postedAt set). false ⇒ a finding still waiting to be posted (included,
  // never ignored). Kept on the record (`priorPosted`), marked in the prompt, and read by
  // `isAlreadyOnThisCommit` (an unposted one is never "already on this commit").
  posted: boolean;
  // true ⇒ from an OLDER review: it was 'not_checked' last time, or it is still open and posted
  // but its reminder was left out of the review (see persist.ts), and is carried forward.
  carried: boolean;
  // A CARRIED, still-open item: the status the previous run gave it (and that run's explanation).
  // Absent for a 'not_checked' carry and for the previous review's own findings.
  priorStatus?: { status: ClaudeFollowUpStatus; explanation: string | null } | null;
  // Its GitHub thread (finding-replies.ts), attached before selection. `replies` = the people's
  // replies after the root (never automation, never Limn's own). Absent ⇒ no thread was found.
  thread?: {
    threadId: number;
    threadFindingId: number;
    replies: FindingReply[];
    // Limn already posted its one pushback there.
    pushedBack: boolean;
    // The thread is RESOLVED on GitHub (synced), and by whom when the sync recorded it. A resolved
    // thread with a reply is JUDGED like an open one (no longer settled on sight); it only goes
    // last in the selection order (`selectPriorFindings`) and gets no automatic pushback.
    isResolved?: boolean;
    resolvedBy?: string | null;
  } | null;
}

/** Does this earlier finding have a person's reply to judge? */
export function hasReplies(f: Pick<PriorFindingForFollowUp, 'thread'>): boolean {
  return judgeableReplies(f.thread?.replies).length > 0;
}

/**
 * Was this earlier finding's thread RESOLVED on GitHub after a person replied? Such a finding is
 * judged on its reply like an open thread (it used to be settled on sight — settled-by-reply.ts).
 * A thread resolved with NO reply is not this: it is followed up on the code as before.
 */
export function isResolvedWithReplies(f: Pick<PriorFindingForFollowUp, 'thread'>): boolean {
  return f.thread?.isResolved === true && hasReplies(f);
}

export interface PriorReviewForFollowUp {
  reviewId: number;
  headSha: string;
  findings: PriorFindingForFollowUp[];
  // The previous review's OWN findings NOT followed up, each with why (persist.ts). Stored on the
  // record as `leftOut` so nothing drops out silently. Absent ⇒ none.
  leftOut?: ClaudeFollowUpLeftOutRecord[];
}

export interface FollowUpPlan {
  priorReviewId: number;
  priorHeadSha: string;
  // This run's head.
  headSha: string;
  // The PREVIOUS REVIEW's head differs from this run's. Drives the "changes since" compare only;
  // a carried finding may be older still, so per-finding questions go through `findingHeadMoved`.
  headMoved: boolean;
  // What the model is shown, in P order.
  sent: Array<{ ref: string; finding: PriorFindingForFollowUp }>;
  // Over the count / size cap — never shown; recorded 'not_checked' (or its locked status).
  omitted: PriorFindingForFollowUp[];
  // Finding id → the status decided in CODE because the head has not moved since the previous
  // review (see the header). Empty whenever the head moved.
  locked: Map<number, { status: ClaudeFollowUpStatus; explanation: string | null }>;
}

/** The templated explanation of a status the code decided because nothing has moved. */
export const UNCHANGED_HEAD_EXPLANATION = 'The code has not changed since this was raised.';

/**
 * A finding that was POSTED to GitHub (and is not praise, not a legacy story finding). The rule for
 * everything that needs a comment ON the pull request — its thread, a reply to judge, a settlement
 * (settled-by-reply.ts, persist.ts `loadSettledByReplyFindings` / `loadUnjudgedReplyFindings`).
 * `postedAt` is the signal because it is the one column BOTH posting paths stamp: the
 * single-comment route (`markFindingPosted`, which also stores a `githubCommentId`) and Post review
 * (`markReviewPosted`, whose inline comments ride the GitHub review and get their id only from a
 * best-effort read-back, so it may be NULL).
 *
 * ⚠ A LEGACY STORY FINDING IS NEVER FOLLOWED UP. "Is this acceptance criterion met?" left the PR
 * review for the ticket review (review/ticket-review/), which judges it across every PR on the
 * ticket; asking the PR review again would put a single-PR story verdict back on a new run. The
 * posted comment stays on GitHub, and the ticket review is told about it.
 */
export function isPostedForFollowUp(f: {
  postedAt: unknown;
  severity: ClaudeFindingSeverity;
  // A legacy STORY finding's origin columns (migration 0079 / pg 0066). Optional so a caller with
  // no story columns reads as an ordinary finding.
  storyRef?: string | null;
}): boolean {
  return f.postedAt != null && f.severity !== 'praise' && !f.storyRef;
}

/**
 * The follow-up's eligibility rule — THE ONE selection point every consumer goes through (the
 * previous review's own findings AND every carried one, persist.ts `loadPriorReviewForFollowUp`).
 *
 * A finding is followed up while it is still part of what Limn says about the pull request:
 *   - it was POSTED (`isPostedForFollowUp`), whatever the `included` tick says now: an
 *     ignored-after-posting comment is still on the pull request; or
 *   - it is NOT POSTED YET, still INCLUDED (`included === true`: the reader has not ignored it, so
 *     it is still waiting to be posted) and does NOT repeat an earlier comment that IS on GitHub
 *     (`repeatsPosted`: its `priorFindingId` names a posted finding — that comment is followed up
 *     instead, carried, exactly as before, so a same-commit re-run never re-raises it as a new,
 *     included finding and posts it twice). ⚠ Leaving it out LOST it (2026-10-27): a same-head re-run
 *     that did not happen to find the point again dropped it from the newest run — the one the pane
 *     shows and Post review sends — with nothing saying so. Followed up, it is locked
 *     'not_addressed' on the same head and raised again, INCLUDED (it was never posted, so
 *     `isAlreadyOnThisCommit` does not apply).
 * Left out, and NAMED on the stored record with a reason (`followUpLeftOutReason`): a finding the
 * reader IGNORED before it was posted, an unposted repeat of a comment already on GitHub (the
 * server's own left-out re-raise, or one the reader ticked — followed up through that comment
 * instead), a legacy story finding. Praise is never
 * followed up (nothing to address) and is not named either: it is no longer a shown finding.
 * ⚠ `included` must be SELECTED by the caller: absent reads as "not included", so a row without the
 * column falls back to the posted-only rule.
 */
export function isFollowUpEligible(f: {
  postedAt: unknown;
  severity: ClaudeFindingSeverity;
  storyRef?: string | null;
  included?: boolean | null;
  // Its `priorFindingId` names a finding that WAS posted (the caller looks it up). Absent ⇒ no.
  repeatsPosted?: boolean;
}): boolean {
  if (isPostedForFollowUp(f)) return true;
  return f.postedAt == null && f.included === true && !f.repeatsPosted && f.severity !== 'praise' && !f.storyRef;
}

/** Why a previous review's finding was NOT sent to the follow-up. null ⇒ it is eligible, or praise. */
export function followUpLeftOutReason(f: {
  postedAt: unknown;
  severity: ClaudeFindingSeverity;
  storyRef?: string | null;
  included?: boolean | null;
  repeatsPosted?: boolean;
}): ClaudeFollowUpLeftOutReason | null {
  if (f.severity === 'praise' || isFollowUpEligible(f)) return null;
  if (f.storyRef) return 'story';
  // Never posted: a repeat of a comment that IS on GitHub (the server's own left-out re-raise —
  // persist.ts `isAlreadyPostedReraise` — or one the reader ticked or ignored), else the reader's
  // ignore.
  return f.repeatsPosted ? 'already_posted' : 'ignored';
}

/** The body the user saw and would have posted — the same rule as routes.ts `resolvedBody`. */
export function resolveFindingBody(f: { body: string; editedBody: string | null }): string {
  return f.editedBody && f.editedBody.trim() ? f.editedBody : f.body;
}

const SEVERITY_RANK: Record<ClaudeFindingSeverity, number> = {
  blocker: 0,
  warning: 1,
  question: 2,
  nit: 3,
  praise: 4,
};

const bySeverityThenId = (a: PriorFindingForFollowUp, b: PriorFindingForFollowUp): number =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id - b.id;

/** What one finding costs in the prompt block (the same clips prompts.ts applies). */
function promptSize(f: PriorFindingForFollowUp): number {
  return (
    Math.min(f.title.length, PRIOR_TITLE_CHARS) +
    Math.min(f.body.length, PRIOR_BODY_CHARS) +
    Math.min(f.diffHunk?.length ?? 0, PRIOR_HUNK_CHARS) +
    Math.min(f.suggestion?.length ?? 0, PRIOR_SUGGESTION_CHARS) +
    (f.thread?.replies ?? []).reduce((n, r) => n + r.body.length + r.author.length + 40, 0) +
    200
  );
}

/**
 * Choose what the model is shown. The previous review's OWN findings come first (blocker,
 * warning, question, nit, then id), then the carried ones in the same order. Refs P1.. are handed
 * out while fewer than PRIOR_FINDINGS_MAX are sent and the running size stays within
 * PRIOR_BLOCK_CHARS; at the first one that does not fit, it and everything after it is omitted.
 * ⚠ A finding whose thread was RESOLVED after a reply (`isResolvedWithReplies`) goes LAST (own,
 * then carried, same order inside): someone closed it, and its replies (up to 5 × 1,500
 * characters) must not crowd an open finding out of the cap. One that does not fit is
 * 'not_checked' and carried, like any other.
 */
export function selectPriorFindings(prior: PriorReviewForFollowUp, headSha: string): FollowUpPlan {
  const live = prior.findings.filter((f) => !isResolvedWithReplies(f));
  const closedByReply = prior.findings.filter(isResolvedWithReplies);
  const own = live.filter((f) => !f.carried).sort(bySeverityThenId);
  const carried = live.filter((f) => f.carried).sort(bySeverityThenId);
  const ordered = [
    ...own,
    ...carried,
    ...closedByReply.filter((f) => !f.carried).sort(bySeverityThenId),
    ...closedByReply.filter((f) => f.carried).sort(bySeverityThenId),
  ];
  const sent: FollowUpPlan['sent'] = [];
  const omitted: PriorFindingForFollowUp[] = [];
  let size = 0;
  let full = false;
  for (const f of ordered) {
    const cost = promptSize(f);
    if (!full && sent.length < PRIOR_FINDINGS_MAX && size + cost <= PRIOR_BLOCK_CHARS) {
      size += cost;
      sent.push({ ref: `P${sent.length + 1}`, finding: f });
    } else {
      full = true;
      omitted.push(f);
    }
  }
  // ⚠ SAME HEAD ⇒ the code decides. The previous review's own findings were raised at this very
  // head, so nothing can have addressed them; a carried open item keeps the previous run's answer
  // (given at this head). A carried 'not_checked' item was never judged, so the model still is.
  const locked: FollowUpPlan['locked'] = new Map();
  if (prior.headSha === headSha) {
    for (const f of ordered) {
      if (!f.carried && !findingHeadMoved({ headSha }, f)) {
        locked.set(f.id, { status: 'not_addressed', explanation: UNCHANGED_HEAD_EXPLANATION });
      } else if (f.carried && f.priorStatus) {
        // A carried pushback locks as plain "not addressed": its reply text is not carried, and a
        // reply status is only ever Claude's answer about the replies in front of it.
        locked.set(
          f.id,
          f.priorStatus.status === 'reply_disputed'
            ? { status: 'not_addressed', explanation: f.priorStatus.explanation }
            : { ...f.priorStatus },
        );
      }
    }
  }
  return {
    priorReviewId: prior.reviewId,
    priorHeadSha: prior.headSha,
    headSha,
    headMoved: prior.headSha !== headSha,
    sent,
    omitted,
    locked,
  };
}

/**
 * Whether the code has moved since THIS finding was raised: its own review's head against this
 * run's. ⚠ Never `plan.headMoved` — a carried finding was raised at an older head than the previous
 * review's, so "the previous review is on this head" says nothing about it.
 */
export function findingHeadMoved(
  plan: Pick<FollowUpPlan, 'headSha'>,
  f: Pick<PriorFindingForFollowUp, 'headSha'>,
): boolean {
  return f.headSha !== plan.headSha;
}

const REPORTABLE: ReadonlySet<ClaudeFollowUpStatus> = new Set([
  'addressed',
  'partly_addressed',
  'not_addressed',
  'no_longer_applies',
  'reply_accepted',
  'reply_disputed',
]);

export const isReplyStatus = (s: ClaudeFollowUpStatus): boolean => s === 'reply_accepted' || s === 'reply_disputed';

// Templated texts, used when Claude gave none (or the server overruled it).
export const ACCEPT_NOT_VALID_TEXT = 'Thanks for explaining. That makes sense.';
export const ACCEPT_DEFERRED_TEXT = 'Thanks. Handling this in a follow-up works.';
export const DISPUTE_TEXT = 'Thanks for the reply. I still think this needs changing in this pull request.';
export const BLOCKER_DEFERRAL_TEXT =
  'Thanks for the reply. This one is a blocker, so it should be fixed in this pull request rather than later.';

function clipResponse(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > RESPONSE_CHARS ? `${t.slice(0, RESPONSE_CHARS)}…` : t;
}

/**
 * THE SERVER GATE over a reply status (the model is never trusted with it). null ⇒ treat as
 * unreported: the finding has no reply to judge, or an acceptance named no valid kind.
 *   - 'reply_accepted' + 'deferred' on a BLOCKER ⇒ 'reply_disputed' with BLOCKER_DEFERRAL_TEXT;
 *   - 'reply_accepted' + 'not_valid' is accepted at any severity;
 *   - the posted text is Claude's, clipped, else a templated one.
 */
export function judgeReplyReport(
  f: Pick<PriorFindingForFollowUp, 'severity' | 'thread'>,
  r: Pick<ReviewFollowUpReport, 'status' | 'acceptKind' | 'reply'>,
): Pick<ClaudeFollowUpItemRecord, 'status' | 'acceptKind' | 'response' | 'reply' | 'deferralRefused'> | null {
  if (!isReplyStatus(r.status) || !hasReplies(f)) return null;
  const people = judgeableReplies(f.thread!.replies);
  const last = people[people.length - 1]!;
  const reply = replyExcerpt(last);
  const text = clipResponse(r.reply);
  if (r.status === 'reply_accepted') {
    const kind = r.acceptKind === 'not_valid' || r.acceptKind === 'deferred' ? r.acceptKind : null;
    if (kind == null) return null;
    if (kind === 'deferred' && f.severity === 'blocker') {
      return { status: 'reply_disputed', acceptKind: null, response: BLOCKER_DEFERRAL_TEXT, reply, deferralRefused: true };
    }
    return {
      status: 'reply_accepted',
      acceptKind: kind,
      response: text ?? (kind === 'deferred' ? ACCEPT_DEFERRED_TEXT : ACCEPT_NOT_VALID_TEXT),
      reply,
    };
  }
  return { status: 'reply_disputed', acceptKind: null, response: text ?? DISPUTE_TEXT, reply };
}

function clipExplanation(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > FOLLOW_UP_EXPLANATION_CHARS ? `${t.slice(0, FOLLOW_UP_EXPLANATION_CHARS)}…` : t;
}

function recordFor(
  plan: FollowUpPlan,
  f: PriorFindingForFollowUp,
  ref: string | null,
  sent: boolean,
  status: ClaudeFollowUpStatus,
  explanation: string | null,
  statusCarried = false,
  extra: Partial<ClaudeFollowUpItemRecord> = {},
): ClaudeFollowUpItemRecord {
  return {
    ...extra,
    ref,
    priorFindingId: f.id,
    sent,
    carried: f.carried,
    status,
    explanation,
    path: f.path,
    line: f.line,
    side: f.side,
    severity: f.severity,
    title: f.title,
    headMoved: findingHeadMoved(plan, f),
    priorPosted: f.posted,
    ...(statusCarried ? { statusCarried: true } : {}),
    ...(f.thread ? { threadId: f.thread.threadId, threadFindingId: f.thread.threadFindingId } : {}),
  };
}

/**
 * The same-head lock for one finding — EXCEPT a thread RESOLVED after a reply that no run has judged
 * yet (no carried status). Its question is the reply, not the code: the lock would call it
 * 'not_addressed' (raised again, counted in the verdict) without anyone reading the reply. Unjudged,
 * it stays 'not_checked' and is carried to the next run instead. Only when NOTHING was reported: a
 * reply status is judged as usual, and a code status is still overruled by the lock.
 */
function lockFor(
  locked: FollowUpPlan['locked'],
  f: PriorFindingForFollowUp,
): { status: ClaudeFollowUpStatus; explanation: string | null } | undefined {
  const lock = locked.get(f.id);
  if (lock && !f.priorStatus && isResolvedWithReplies(f)) return undefined;
  return lock;
}

/**
 * Reconcile the model's follow-up report against what was sent. Unknown refs are dropped; a
 * duplicate ref keeps its FIRST report; a sent ref never reported is 'not_checked' (`sent:true`);
 * an omitted finding is 'not_checked' (`sent:false`, `ref:null`). Output: sent order, then omitted.
 * `reported` undefined (an older host, or the model left it out) ⇒ every item 'not_checked'.
 */
export function reconcileFollowUp(
  plan: FollowUpPlan,
  reported: ReadonlyArray<ReviewFollowUpReport> | undefined,
): ClaudeFollowUpItemRecord[] {
  const known = new Set(plan.sent.map((s) => s.ref));
  const byRef = new Map<string, { status: ClaudeFollowUpStatus; explanation: string | null; raw: ReviewFollowUpReport }>();
  for (const r of reported ?? []) {
    if (!r || typeof r.ref !== 'string') continue;
    const ref = r.ref.trim().toUpperCase();
    if (!known.has(ref) || byRef.has(ref)) continue;
    if (!REPORTABLE.has(r.status)) continue;
    byRef.set(ref, { status: r.status, explanation: clipExplanation(r.explanation), raw: r });
  }
  const locked = plan.locked ?? new Map();
  const out: ClaudeFollowUpItemRecord[] = [];
  for (const { ref, finding } of plan.sent) {
    let hit = byRef.get(ref);
    // (`hit` is re-read below: a reply status that fails the gate is cleared first.)
    const lockIfReported = locked.get(finding.id);
    // ⚠ THE REPLY GATE (in code): a reply status is Claude's answer about the replies shown, so it
    // stands only on a finding that had some, and may override a same-head lock.
    if (hit && isReplyStatus(hit.status)) {
      const judged = judgeReplyReport(finding, hit.raw);
      if (judged) {
        out.push(
          recordFor(plan, finding, ref, true, judged.status, hit.explanation, false, {
            ...(judged.acceptKind ? { acceptKind: judged.acceptKind } : {}),
            response: judged.response ?? null,
            reply: judged.reply ?? null,
            ...(judged.deferralRefused ? { deferralRefused: true } : {}),
          }),
        );
        continue;
      }
      hit = undefined;
    }
    const lock = hit ? lockIfReported : lockFor(locked, finding);
    if (lock) {
      // The code decides; Claude's words are kept only when it agreed.
      const explanation = hit && hit.status === lock.status && hit.explanation ? hit.explanation : lock.explanation;
      out.push(recordFor(plan, finding, ref, true, lock.status, explanation, true));
      continue;
    }
    out.push(
      hit
        ? recordFor(plan, finding, ref, true, hit.status, hit.explanation)
        : recordFor(plan, finding, ref, true, 'not_checked', null),
    );
  }
  for (const finding of plan.omitted) {
    const lock = lockFor(locked, finding);
    out.push(
      lock
        ? recordFor(plan, finding, null, false, lock.status, lock.explanation, true)
        : recordFor(plan, finding, null, false, 'not_checked', null),
    );
  }
  return out;
}

export type LinkedFinding = ReviewFinding & {
  priorFindingId: number | null;
  // Set to false ONLY for a re-raise of a comment already posted on this same commit (below).
  // Absent ⇒ the writer's default (included).
  included?: boolean;
};

// A pushback ('reply_disputed') is open exactly like 'not_addressed': raised again, counted in the
// auto verdict at its severity.
const REOPEN: ReadonlySet<ClaudeFollowUpStatus> = new Set(['not_addressed', 'partly_addressed', 'reply_disputed']);

/**
 * Drop this run's findings that repeat an earlier finding this SAME run accepted a reply on: one
 * whose `priorRef` names it, or (unlinked) the same path with a similar title. Later runs drop them
 * through the settled list (persist.ts `loadSettledByReplyFindings`).
 */
export function dropAcceptedReraises<F extends { path: string; title: string; priorRef?: string | null; priorFindingId?: number | null }>(
  findings: readonly F[],
  items: ReadonlyArray<ClaudeFollowUpItemRecord>,
  similar: (a: string, b: string) => boolean,
): { kept: F[]; dropped: F[] } {
  const accepted = items.filter((it) => it.status === 'reply_accepted');
  if (accepted.length === 0) return { kept: [...findings], dropped: [] };
  const refs = new Set(accepted.map((it) => it.ref).filter((r): r is string => r != null));
  const kept: F[] = [];
  const dropped: F[] = [];
  for (const f of findings) {
    const ref = typeof f.priorRef === 'string' ? f.priorRef.trim().toUpperCase() : '';
    const repeats =
      f.priorFindingId == null &&
      ((ref !== '' && refs.has(ref)) || accepted.some((it) => it.path === f.path && similar(it.title, f.title)));
    (repeats ? dropped : kept).push(f);
  }
  return { kept, dropped };
}

/**
 * A re-raise of this earlier finding would repeat a comment ALREADY ON THIS COMMIT: it was posted,
 * and the code has not moved since it was raised. Posting it again puts the same comment on the
 * same lines of the same commit a second time, so such a re-raise is saved LEFT OUT (the reader
 * can still include it). On a moved head the reminder is the point, and it stays included.
 */
export function isAlreadyOnThisCommit(
  plan: Pick<FollowUpPlan, 'headSha'>,
  prior: Pick<PriorFindingForFollowUp, 'headSha' | 'posted'>,
): boolean {
  return prior.posted && !findingHeadMoved(plan, prior);
}

/**
 * Link each re-raised finding to the earlier finding it repeats, and make sure EVERY
 * not-addressed / partly-addressed earlier finding is raised again:
 *   - a finding's `priorRef` links only when the ref is known AND its item is not_addressed or
 *     partly_addressed, and only the FIRST finding per ref links; otherwise `priorFindingId` null;
 *   - an open item nothing raised again gets a SYNTHESIZED finding (prior severity, title, side,
 *     path; a templated first sentence, Claude's explanation, then the earlier body).
 *     When the code has NOT moved since THAT finding was raised the earlier anchor, hunk and
 *     suggestion still describe the same code and are copied; when it moved the line is dropped
 *     (posting re-anchors to the file's first change) rather than asserting a line from an older
 *     head. ⚠ "Moved" is PER FINDING (`findingHeadMoved`): a carried finding was raised at an older
 *     head than the previous review's, and copying its line onto a same-head re-run would offer an
 *     applyable suggestion on whatever code sits at that line now;
 *   - a re-raise (linked or synthesized) of a comment already posted on this commit is saved with
 *     `included: false` (`isAlreadyOnThisCommit`).
 * (Story findings had their own arm here. Stories left the PR review, and a legacy story finding is
 * never in a plan — `isFollowUpEligible` — so there is nothing left for it to link.)
 * Output order: the model's findings, then the synthesized re-raises.
 */
export function linkReraisedFindings(
  plan: FollowUpPlan,
  items: ReadonlyArray<ClaudeFollowUpItemRecord>,
  findings: ReadonlyArray<ReviewFinding>,
  changedFiles: ReadonlySet<string>,
): LinkedFinding[] {
  const openByRef = new Map<string, ClaudeFollowUpItemRecord>();
  for (const it of items) if (it.ref && REOPEN.has(it.status)) openByRef.set(it.ref, it);
  const priorById = new Map<number, PriorFindingForFollowUp>([
    ...plan.sent.map((s) => [s.finding.id, s.finding] as const),
    ...plan.omitted.map((f) => [f.id, f] as const),
  ]);
  const leftOut = (prior: PriorFindingForFollowUp | undefined): { included?: false } =>
    prior && isAlreadyOnThisCommit(plan, prior) ? { included: false } : {};

  const linkedPriorIds = new Set<number>();
  const linkedRefs = new Set<string>();
  const out: LinkedFinding[] = [];
  for (const f of findings) {
    const ref = typeof f.priorRef === 'string' ? f.priorRef.trim().toUpperCase() : '';
    const item = ref ? openByRef.get(ref) : undefined;
    if (item && !linkedRefs.has(ref)) {
      linkedRefs.add(ref);
      linkedPriorIds.add(item.priorFindingId);
      out.push({ ...f, priorFindingId: item.priorFindingId, ...leftOut(priorById.get(item.priorFindingId)) });
      continue;
    }
    out.push({ ...f, priorFindingId: null });
  }
  for (const it of items) {
    if (!REOPEN.has(it.status)) continue;
    if (linkedPriorIds.has(it.priorFindingId)) continue;
    if (!it.ref && !it.statusCarried) continue;
    const prior = priorById.get(it.priorFindingId);
    if (!prior) continue;
    const where = prior.carried ? 'an earlier review' : 'the last review';
    const lead =
      it.status === 'partly_addressed'
        ? `Raised in ${where} and only partly addressed.`
        : it.status === 'reply_disputed'
          ? `Raised in ${where}; the reply on GitHub did not settle it.`
          : `Raised in ${where} and not addressed yet.`;
    const body = `${lead}${it.explanation ? ` ${it.explanation}` : ''}\n\n${prior.body}`;
    out.push({
      path: prior.path,
      side: prior.side,
      severity: prior.severity,
      title: prior.title,
      body,
      ...(findingHeadMoved(plan, prior)
        ? {
            line: null,
            anchored: false,
            diffHunk: null,
            suggestion: null,
            fileInDiff: changedFiles.has(prior.path),
          }
        : {
            line: prior.line,
            anchored: prior.anchored,
            diffHunk: prior.diffHunk,
            suggestion: prior.suggestion,
            fileInDiff: prior.fileInDiff,
          }),
      priorRef: it.ref,
      priorFindingId: prior.id,
      ...leftOut(prior),
    });
  }
  return out;
}

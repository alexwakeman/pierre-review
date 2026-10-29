// THE REPLIES PASS — the pure half (docs/CLAUDE-REVIEW.md § The replies pass). A person replied on
// the GitHub thread of one of Limn's own posted findings, and nothing has judged that reply yet. A
// full review would judge it, but only at the next run; this pass judges JUST the replies, cheaply,
// on the same head. The I/O half is replies-check.ts.
//
// WHAT IT READS: the findings the NEXT full review would follow up (persist.ts
// `loadPriorReviewForFollowUp` over the latest full review: its own eligible findings + the carried
// ones, minus the settled), each with its thread (finding-replies.ts `attachFindingThreads`). A
// finding is SENT when a judgeable reply on it (a person's, not automation, not Limn-marked —
// `judgeableReplies`) is newer than its latest judgement (`judgedThroughFor`).
//
// WHAT IT STORES: a `claude_reviews` row with `kind = 'replies'`, no findings, and a follow-up record
// whose items are shaped EXACTLY like a review's (`reconcileReplies` → `ClaudeFollowUpItemRecord`), so
// every reader of follow-up items (settled-by-reply, the "Previous review" rows, the thread cards, the
// Open PRs "Earlier:" counts, auto resolve, auto pushback, the manual "Post reply") reads it with no
// special case. The gate is the review's: `judgeReplyReport` (a deferred blocker is disputed, etc.).
//
// THE OUTCOME (`repliesVerdict`): after the pass, the PR's open findings at the current head are the
// latest full review's counted findings, minus the ones a reply settled. A disputed blocker wants
// REQUEST_CHANGES; no blocker and no warning left — and nothing the workspace's `approveLeftovers`
// forbids, and no pair half standing in the way (`repliesDissent`) — once a reply settled something,
// wants APPROVE; anything else changes nothing (null). Why it is not an approval: `repliesNotApproved`.
import type {
  ApproveLeftovers,
  AutoVerdictEvent,
  ClaudeFindingSeverity,
  ClaudeFollowUpItemRecord,
  ClaudeFollowUpStatus,
  ClaudeNotApproved,
} from '@pierre-review/shared';
import { leftoverAllowed, openFindingsReason } from './auto-verdict.js';
import { judgeReplyReport, type PriorFindingForFollowUp } from './follow-up.js';
import { judgeableReplies } from './reply-text.js';

// ---- caps ----
/** At most this many threads in one pass (the rest wait for the next pass or review). */
export const REPLIES_PASS_MAX_THREADS = 20;
/** The fenced block's character budget (replies + the finding + the code around its line). */
export const REPLIES_PASS_BLOCK_CHARS = 48_000;
/** Lines of code shown on each side of the finding's line, at the CURRENT head. */
export const REPLIES_PASS_CODE_CONTEXT_LINES = 15;
export const REPLIES_PASS_CODE_CHARS = 4_000;
export const REPLIES_PASS_TITLE_CHARS = 300;
export const REPLIES_PASS_BODY_CHARS = 2_000;
/** AUTOMATIC passes per PR in any rolling 24 hours (counted in the DB). A click never counts. */
export const REPLIES_PASS_AUTO_DAILY_CAP = 5;

// ---- overlay: a later pass's answer is the newer one ----

/**
 * A full review's follow-up items with LATER passes' items folded over them, by `priorFindingId`
 * (the newer judgement wins; a `not_checked` item never overrides — it is not a judgement). An item
 * for a finding the base does not list is appended. `newer` is oldest first. Pure.
 */
export function overlayFollowUpItems<T extends { priorFindingId: number; status: ClaudeFollowUpStatus | string }>(
  base: readonly T[],
  newer: readonly T[],
): T[] {
  if (newer.length === 0) return [...base];
  const out = [...base];
  const at = new Map<number, number>();
  out.forEach((it, i) => {
    if (!at.has(it.priorFindingId)) at.set(it.priorFindingId, i);
  });
  for (const it of newer) {
    if (it.status === 'not_checked') continue;
    const i = at.get(it.priorFindingId);
    if (i == null) {
      at.set(it.priorFindingId, out.length);
      out.push(it);
    } else {
      out[i] = it;
    }
  }
  return out;
}

// ---- which replies wait for a judgement ----

/** A run that may have judged a finding's replies: the latest full review, or a later pass. */
export interface JudgingRun {
  createdAtMs: number;
  // The newest comment the run saw (`claude_reviews.comments_through`); null ⇒ its start.
  commentsThroughMs: number | null;
  // A pass's items (null for the full review, which saw every followed-up thread).
  items?: ReadonlyArray<{ priorFindingId: number; status: string }> | null;
}

const seenThrough = (r: JudgingRun): number => Math.max(r.createdAtMs, r.commentsThroughMs ?? 0);
const isJudgement = (s: string): boolean => s === 'reply_accepted' || s === 'reply_disputed';

/**
 * How far each finding's replies have been judged: the latest full review saw every thread it
 * followed up (its start, or the newest comment it recorded); a later pass covers the findings it
 * JUDGED (a reply status — `not_checked` is not a judgement). Pure.
 */
export function judgedThroughFor(
  full: JudgingRun,
  passes: readonly JudgingRun[],
  // A CLAUDE + CODEX PAIR: each half followed up ONLY its own provider's findings, so a finding's
  // base is the half whose chain listed it (`baseRuns`, by finding id), never the later half's.
  // A finding absent from the map takes `full`.
  baseRuns?: ReadonlyMap<number, JudgingRun>,
): (findingId: number) => number {
  const fullBase = seenThrough(full);
  const baseOf = (id: number): number => {
    const r = baseRuns?.get(id);
    return r ? seenThrough(r) : fullBase;
  };
  const byId = new Map<number, number>();
  for (const p of passes) {
    const t = seenThrough(p);
    for (const it of p.items ?? []) {
      if (!isJudgement(it.status)) continue;
      byId.set(it.priorFindingId, Math.max(byId.get(it.priorFindingId) ?? 0, t));
    }
  }
  return (id) => Math.max(baseOf(id), byId.get(id) ?? 0);
}

/** The newest judgeable reply's time on a finding's thread (ms), or null. */
export function newestJudgeableReplyMs(f: Pick<PriorFindingForFollowUp, 'thread'>): number | null {
  let best: number | null = null;
  for (const r of judgeableReplies(f.thread?.replies)) {
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

/** The findings with a person's reply that no run has judged yet. Pure. */
export function unjudgedReplyFindings(
  findings: readonly PriorFindingForFollowUp[],
  judgedThrough: (findingId: number) => number,
): PriorFindingForFollowUp[] {
  return findings.filter((f) => {
    const t = newestJudgeableReplyMs(f);
    return t != null && t > judgedThrough(f.id);
  });
}

// ---- the plan ----

/** The code around a finding's line at the CURRENT head (read from the checkout), or null. */
export interface CodeAround {
  startLine: number;
  text: string;
}

export interface RepliesPlan {
  headSha: string;
  sent: Array<{ ref: string; finding: PriorFindingForFollowUp; code: CodeAround | null }>;
  // Over the cap: never shown; recorded 'not_checked' (`sent: false`).
  omitted: PriorFindingForFollowUp[];
}

const SEVERITY_RANK: Record<ClaudeFindingSeverity, number> = { blocker: 0, warning: 1, question: 2, nit: 3, praise: 4 };

function cost(f: PriorFindingForFollowUp, code: CodeAround | null): number {
  return (
    Math.min(f.title.length, REPLIES_PASS_TITLE_CHARS) +
    Math.min(f.body.length, REPLIES_PASS_BODY_CHARS) +
    Math.min(code?.text.length ?? 0, REPLIES_PASS_CODE_CHARS) +
    (f.thread?.replies ?? []).reduce((n, r) => n + r.body.length + r.author.length + 40, 0) +
    200
  );
}

/** Choose what is sent: blockers first (then warning, question, nit, id), within the caps. Pure. */
export function planRepliesPass(
  findings: readonly PriorFindingForFollowUp[],
  headSha: string,
  codeById: ReadonlyMap<number, CodeAround> = new Map(),
): RepliesPlan {
  const ordered = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id - b.id);
  const sent: RepliesPlan['sent'] = [];
  const omitted: PriorFindingForFollowUp[] = [];
  let size = 0;
  for (const f of ordered) {
    const code = codeById.get(f.id) ?? null;
    const c = cost(f, code);
    if (omitted.length === 0 && sent.length < REPLIES_PASS_MAX_THREADS && size + c <= REPLIES_PASS_BLOCK_CHARS) {
      size += c;
      sent.push({ ref: `T${sent.length + 1}`, finding: f, code });
    } else {
      omitted.push(f);
    }
  }
  return { headSha, sent, omitted };
}

/** Every string that sits inside a fence (the nonce-collision scan's input). */
export function repliesPlanTexts(plan: RepliesPlan): string[] {
  const out: string[] = [];
  for (const { finding: f, code } of plan.sent) {
    out.push(f.path, f.title, f.body);
    if (code) out.push(code.text);
    for (const r of f.thread?.replies ?? []) out.push(r.author, r.body);
  }
  return out;
}

// ---- the reconcile (the review's gate, `judgeReplyReport`) ----

/** One reported thread, as the result tool hands it back (unvalidated). */
export interface RepliesReport {
  ref?: unknown;
  status?: unknown;
  acceptKind?: unknown;
  reply?: unknown;
  explanation?: unknown;
}

const clip = (s: unknown, max: number): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

function itemFor(
  plan: RepliesPlan,
  f: PriorFindingForFollowUp,
  ref: string | null,
  sent: boolean,
  status: ClaudeFollowUpStatus,
  explanation: string | null,
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
    headMoved: f.headSha !== plan.headSha,
    priorPosted: f.posted,
    ...(f.thread ? { threadId: f.thread.threadId, threadFindingId: f.thread.threadFindingId } : {}),
  };
}

/**
 * The model's report → follow-up items. Unknown refs and malformed entries are dropped, the first
 * report per ref wins, and every status goes through THE REVIEW'S GATE (`judgeReplyReport`): a reply
 * status on a thread with no judgeable reply, or an acceptance with no valid kind, is `not_checked`; a
 * `deferred` acceptance of a BLOCKER is disputed with the templated pushback. Output: sent (T order),
 * then the omitted ones. Pure.
 */
export function reconcileReplies(plan: RepliesPlan, reported: ReadonlyArray<RepliesReport> | null | undefined): ClaudeFollowUpItemRecord[] {
  const byRef = new Map<string, RepliesReport>();
  const known = new Set(plan.sent.map((s) => s.ref));
  for (const r of reported ?? []) {
    if (!r || typeof r.ref !== 'string') continue;
    const ref = r.ref.trim().toUpperCase();
    if (!known.has(ref) || byRef.has(ref)) continue;
    byRef.set(ref, r);
  }
  const out: ClaudeFollowUpItemRecord[] = [];
  for (const { ref, finding } of plan.sent) {
    const r = byRef.get(ref);
    const explanation = clip(r?.explanation, 1_000);
    const status = r?.status === 'reply_accepted' || r?.status === 'reply_disputed' ? r.status : null;
    const judged = status
      ? judgeReplyReport(finding, {
          status,
          acceptKind: r?.acceptKind === 'not_valid' || r?.acceptKind === 'deferred' ? r.acceptKind : null,
          reply: typeof r?.reply === 'string' ? r.reply : null,
        })
      : null;
    if (!judged) {
      out.push(itemFor(plan, finding, ref, true, 'not_checked', explanation));
      continue;
    }
    out.push(
      itemFor(plan, finding, ref, true, judged.status, explanation, {
        ...(judged.acceptKind ? { acceptKind: judged.acceptKind } : {}),
        response: judged.response ?? null,
        reply: judged.reply ?? null,
        ...(judged.deferralRefused ? { deferralRefused: true } : {}),
      }),
    );
  }
  for (const f of plan.omitted) out.push(itemFor(plan, f, null, false, 'not_checked', null));
  return out;
}

// ---- the outcome ----

/** A full review's finding as the outcome reads it. */
export interface OutcomeFinding {
  id: number;
  severity: ClaudeFindingSeverity;
  title: string;
  priorFindingId: number | null;
  // A legacy story finding (never counted), and the reader's ignore (never counted either — the
  // server's own `included: false` re-raise of a comment already on this commit STILL counts).
  story?: unknown;
  readerIgnored?: boolean;
}

/**
 * Is this finding settled by an accepted reply? Its own id, or any ancestor along `priorFindingId`
 * (a re-raise of a settled comment is settled too). `priorOf` maps an earlier finding's id to its own
 * `priorFindingId`. Cycle-guarded. Pure.
 */
export function isSettledFinding(
  f: Pick<OutcomeFinding, 'id' | 'priorFindingId'>,
  settled: ReadonlySet<number>,
  priorOf: (id: number) => number | null | undefined,
): boolean {
  if (settled.has(f.id)) return true;
  const seen = new Set<number>([f.id]);
  let next = f.priorFindingId;
  for (let hop = 0; next != null && hop < 100 && !seen.has(next); hop += 1) {
    if (settled.has(next)) return true;
    seen.add(next);
    next = priorOf(next) ?? null;
  }
  return false;
}

/** The latest full review's findings still OPEN after the replies: counted, and not settled. Pure. */
export function openFindingsAfterReplies(
  findings: readonly OutcomeFinding[],
  settled: ReadonlySet<number>,
  priorOf: (id: number) => number | null | undefined,
): OutcomeFinding[] {
  return findings.filter(
    (f) => f.severity !== 'praise' && f.story == null && !f.readerIgnored && !isSettledFinding(f, settled, priorOf),
  );
}

export interface RepliesVerdictInput {
  open: readonly Pick<OutcomeFinding, 'severity' | 'title'>[];
  // Earlier blockers the full review left unjudged (auto-post.ts `unsettledEarlierBlockers`): still
  // open as far as anyone knows.
  unjudgedEarlierBlockers: number;
  // This pass's own judgements.
  items: readonly Pick<ClaudeFollowUpItemRecord, 'status' | 'severity' | 'title'>[];
  // What may stay open on an approve (`WorkspaceAutoPostSettings.approveLeftovers`; absent = the
  // default, nits and questions).
  leftovers?: ApproveLeftovers;
  // A half of a Claude + Codex review that holds the approval whatever the replies say
  // (auto-verdict.ts `repliesDissent`, by the workspace's strictness). Absent/null = none.
  dissent?: ClaudeNotApproved | null;
}

/**
 * What the replies point to (null ⇒ the outcome does not change):
 *   • a blocker this pass DISPUTED ⇒ REQUEST_CHANGES (it stays open at its severity);
 *   • otherwise, when this pass ACCEPTED a reply and no blocker (nor an unjudged earlier one) and no
 *     warning is left open — nor a nit / question `leftovers` forbids, nor a pair half's dissent ⇒
 *     APPROVE;
 *   • otherwise null — nothing posts just to say nothing changed. Pure.
 */
export function repliesVerdict(i: RepliesVerdictInput): AutoVerdictEvent | null {
  if (i.items.some((it) => it.status === 'reply_disputed' && it.severity === 'blocker')) return 'REQUEST_CHANGES';
  const accepted = i.items.some((it) => it.status === 'reply_accepted');
  if (!accepted) return null;
  if (i.unjudgedEarlierBlockers > 0) return null;
  if (i.open.some((f) => f.severity === 'blocker' || f.severity === 'warning')) return null;
  if (i.open.some((f) => !leftoverAllowed(f.severity, i.leftovers ?? 'nits_questions'))) return null;
  if (i.dissent != null) return null;
  return 'APPROVE';
}

/**
 * WHY THE REPLIES' OUTCOME IS NOT AN APPROVAL (null when it is one, or when the replies changed
 * nothing — no reply accepted and no blocker disputed). `held` = the old rule (no blocker, no
 * warning) WOULD have approved, and the workspace's leftovers rule or a pair half held it: only
 * then may an automatic pass tell GitHub. Pure.
 */
export function repliesNotApproved(i: RepliesVerdictInput): { reason: ClaudeNotApproved; held: boolean } | null {
  const disputed = i.items.some((it) => it.status === 'reply_disputed' && it.severity === 'blocker');
  const accepted = i.items.some((it) => it.status === 'reply_accepted');
  if (!disputed && !accepted) return null;
  const severe = openFindingsReason(i.open, 'severe');
  if (severe != null) return { reason: severe, held: false };
  if (disputed) return { reason: { heldReason: 'open_findings', text: 'Not approved: a blocker is still open.' }, held: false };
  if (i.unjudgedEarlierBlockers > 0) {
    return { reason: { heldReason: 'open_findings', text: 'Not approved: an earlier blocker is not checked yet.' }, held: false };
  }
  const leftover = openFindingsReason(i.open, 'leftovers', i.leftovers ?? 'nits_questions');
  if (leftover != null) return { reason: leftover, held: true };
  if (i.dissent != null) return { reason: i.dissent, held: true };
  return null;
}

/** The disputed blocker the REQUEST_CHANGES body names (the first), or null. */
export function disputedBlockerTitle(items: readonly Pick<ClaudeFollowUpItemRecord, 'status' | 'severity' | 'title'>[]): string | null {
  return items.find((it) => it.status === 'reply_disputed' && it.severity === 'blocker')?.title ?? null;
}

/** The posted review's body (before the footer and Limn's marker). Plain English, short. */
export function repliesReviewBody(verdict: 'APPROVE' | 'REQUEST_CHANGES', blockerTitle: string | null): string {
  if (verdict === 'APPROVE') return 'Replies checked: the remaining points are settled.';
  const t = (blockerTitle ?? '').replace(/\s+/g, ' ').trim();
  const name = t.length > 120 ? `${t.slice(0, 119)}…` : t;
  return name ? `Replies checked: “${name}” is still a blocker.` : 'Replies checked: a blocker is still open.';
}

/** The run's stored summary: what the pass found, templated from the server-checked statuses. */
export function repliesSummary(items: readonly Pick<ClaudeFollowUpItemRecord, 'status'>[]): string {
  const accepted = items.filter((i) => i.status === 'reply_accepted').length;
  const disputed = items.filter((i) => i.status === 'reply_disputed').length;
  const unchecked = items.filter((i) => i.status === 'not_checked').length;
  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (disputed > 0) parts.push(`${disputed} still open`);
  if (unchecked > 0) parts.push(`${unchecked} not checked`);
  return parts.length > 0 ? `Replies checked: ${parts.join(', ')}.` : 'Replies checked.';
}

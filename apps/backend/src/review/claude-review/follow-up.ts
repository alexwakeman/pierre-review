// FOLLOW-UP ON THE PREVIOUS REVIEW (Pro) — the pure half: which earlier findings are sent to the
// model, how its report is reconciled, and how a still-open finding is raised again.
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
// The earlier findings' text was written by an earlier model run over the same attacker-influenced
// pull request, so prompts.ts fences it with the run's nonce like every other untrusted block.
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpItemRecord,
  ClaudeFollowUpStatus,
} from '@pierre-review/shared';
import type { ReviewFinding, ReviewFollowUpReport } from '../../pro/contract.js';

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
  // It was posted to GitHub (postedAt set).
  posted: boolean;
  // true ⇒ from an OLDER review: it was 'not_checked' last time, or it is still open and posted
  // but its reminder was left out of the review (see persist.ts), and is carried forward.
  carried: boolean;
}

export interface PriorReviewForFollowUp {
  reviewId: number;
  headSha: string;
  findings: PriorFindingForFollowUp[];
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
  // Over the count / size cap — never shown; recorded 'not_checked'.
  omitted: PriorFindingForFollowUp[];
}

/**
 * The follow-up's eligibility rule. `included === false` is the user's "Ignore" (and
 * review-memory's `finding_dismissed` signal), so an ignored finding is left out — UNLESS it was
 * posted, because a posted comment is on the pull request whatever the tick says now. Praise is
 * never followed up: there is nothing to address.
 *
 * ⚠ Known edge: runs from before findings were included by default carry `included = false`
 * unless the user ticked them, so they read as ignored. Accepted (the column default is false).
 */
export function isFollowUpEligible(f: {
  included: boolean;
  postedAt: unknown;
  severity: ClaudeFindingSeverity;
}): boolean {
  return (f.included === true || f.postedAt != null) && f.severity !== 'praise';
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
    200
  );
}

/**
 * Choose what the model is shown. The previous review's OWN findings come first (blocker,
 * warning, question, nit, then id), then the carried ones in the same order. Refs P1.. are handed
 * out while fewer than PRIOR_FINDINGS_MAX are sent and the running size stays within
 * PRIOR_BLOCK_CHARS; at the first one that does not fit, it and everything after it is omitted.
 */
export function selectPriorFindings(prior: PriorReviewForFollowUp, headSha: string): FollowUpPlan {
  const own = prior.findings.filter((f) => !f.carried).sort(bySeverityThenId);
  const carried = prior.findings.filter((f) => f.carried).sort(bySeverityThenId);
  const ordered = [...own, ...carried];
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
  return {
    priorReviewId: prior.reviewId,
    priorHeadSha: prior.headSha,
    headSha,
    headMoved: prior.headSha !== headSha,
    sent,
    omitted,
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
]);

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
): ClaudeFollowUpItemRecord {
  return {
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
  };
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
  const byRef = new Map<string, { status: ClaudeFollowUpStatus; explanation: string | null }>();
  for (const r of reported ?? []) {
    if (!r || typeof r.ref !== 'string') continue;
    const ref = r.ref.trim().toUpperCase();
    if (!known.has(ref) || byRef.has(ref)) continue;
    if (!REPORTABLE.has(r.status)) continue;
    byRef.set(ref, { status: r.status, explanation: clipExplanation(r.explanation) });
  }
  const out: ClaudeFollowUpItemRecord[] = [];
  for (const { ref, finding } of plan.sent) {
    const hit = byRef.get(ref);
    out.push(
      hit
        ? recordFor(plan, finding, ref, true, hit.status, hit.explanation)
        : recordFor(plan, finding, ref, true, 'not_checked', null),
    );
  }
  for (const finding of plan.omitted) {
    out.push(recordFor(plan, finding, null, false, 'not_checked', null));
  }
  return out;
}

export type LinkedFinding = ReviewFinding & {
  priorFindingId: number | null;
  // Set to false ONLY for a re-raise of a comment already posted on this same commit (below).
  // Absent ⇒ the writer's default (included).
  included?: boolean;
};

const REOPEN: ReadonlySet<ClaudeFollowUpStatus> = new Set(['not_addressed', 'partly_addressed']);

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
 *   - an open item the model did not raise again gets a SYNTHESIZED finding (prior severity, title,
 *     side, path; a templated first sentence, Claude's explanation, then the earlier body). When
 *     the code has NOT moved since THAT finding was raised the earlier anchor, hunk and suggestion
 *     still describe the same code and are copied; when it moved the line is dropped (posting
 *     re-anchors to the file's first change) rather than asserting a line from an older head.
 *     ⚠ "Moved" is PER FINDING (`findingHeadMoved`): a carried finding was raised at an older head
 *     than the previous review's, and copying its line onto a same-head re-run would offer an
 *     applyable suggestion on whatever code sits at that line now;
 *   - a re-raise (linked or synthesized) of a comment already posted on this commit is saved with
 *     `included: false` (`isAlreadyOnThisCommit`).
 */
export function linkReraisedFindings(
  plan: FollowUpPlan,
  items: ReadonlyArray<ClaudeFollowUpItemRecord>,
  findings: ReadonlyArray<ReviewFinding>,
  changedFiles: ReadonlySet<string>,
): LinkedFinding[] {
  const openByRef = new Map<string, ClaudeFollowUpItemRecord>();
  for (const it of items) if (it.ref && REOPEN.has(it.status)) openByRef.set(it.ref, it);
  const priorById = new Map(plan.sent.map((s) => [s.finding.id, s.finding]));
  const leftOut = (prior: PriorFindingForFollowUp | undefined): { included?: false } =>
    prior && isAlreadyOnThisCommit(plan, prior) ? { included: false } : {};
  const linkedRefs = new Set<string>();
  const out: LinkedFinding[] = findings.map((f) => {
    const ref = typeof f.priorRef === 'string' ? f.priorRef.trim().toUpperCase() : '';
    const item = ref ? openByRef.get(ref) : undefined;
    if (item && !linkedRefs.has(ref)) {
      linkedRefs.add(ref);
      return { ...f, priorFindingId: item.priorFindingId, ...leftOut(priorById.get(item.priorFindingId)) };
    }
    return { ...f, priorFindingId: null };
  });
  for (const it of items) {
    if (!it.ref || !REOPEN.has(it.status) || linkedRefs.has(it.ref)) continue;
    const prior = priorById.get(it.priorFindingId);
    if (!prior) continue;
    const where = prior.carried ? 'an earlier review' : 'the last review';
    const lead =
      it.status === 'partly_addressed'
        ? `Raised in ${where} and only partly addressed.`
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

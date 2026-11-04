import type {
  ClaudeFindingSeverity,
  ClaudeFollowUpStatus,
  ClaudeReviewPrState,
  ClaudeReviewStandingRef,
  ClaudeReviewStateSummary,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { CLEAN_CLASS, OUTDATED_CLASS } from './claudeReviewFollowUp.js';
import { teammateName } from './teammateReviews.js';
import { relativeTime } from './ui.js';

// Pure helpers for the Claude Review panel on each Open PRs card (OpenPrsCards → ClaudeReviewCell).
// The column reads ONE batched `POST /api/claude-review/states` answer and starts runs through the
// SAME `POST /api/prs/:id/claude-review` the Claude Review tab uses — no picker, the defaults.

// The same words the Claude Review tab's verdict badge uses.
export const CLAUDE_VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

/** Whose review a `done` cell shows when a teammate's posted review LEADS (`state.teammateLead`,
 *  the server's ONE lead rule): their first name ("Robin", else "@robin-dev"), the hover / accessible
 *  title ("Robin’s review") and their avatar. Absent = the reader's own run. */
export interface ReviewCellBy {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  name: string;
  title: string;
}

// `auto: true` = the workspace's auto review started that run; the cell adds an "Auto review"
// marker. A queued or running auto run HOLDS the PR: the start route answers 409
// AutoReviewInProgress, so those cells offer no button.
export type ReviewCell =
  // never reviewed, or the last run failed / was cancelled (`failed` = it failed: the strip says so)
  | { kind: 'start'; failed?: true }
  | { kind: 'starting' } // this click's request is in flight
  | { kind: 'queued'; auto?: true }
  | { kind: 'running'; auto?: true }
  | {
      kind: 'done';
      reviewId: number | null;
      verdict?: ClaudeReviewVerdict;
      verdictLabel: string;
      headMoved: boolean;
      auto?: true;
      // A teammate's posted review leads: `verdict` / `headMoved` are THEIRS, attributed.
      by?: ReviewCellBy;
      // STANDING VERDICTS: the verdict shown is a Request changes still in force on GitHub that is not
      // the newest review (`state.standing.blocking`). `latest` then names who reviewed last.
      stillBlocking?: true;
      latest?: { text: string; title: string };
    };

/**
 * What one row's cell shows. `starting` (the start mutation for this PR is in flight, from this
 * table OR the PR's own Claude Review tab — they share a mutation key) wins over the stored state,
 * so the button disables the moment it is pressed.
 */
export function reviewCellFor(
  state: ClaudeReviewPrState | undefined,
  starting: boolean,
): ReviewCell {
  if (state == null) return starting ? { kind: 'starting' } : { kind: 'start' };
  const auto = state.trigger === 'auto' ? ({ auto: true } as const) : {};
  // ⚠ An auto review in flight wins even over a start in flight: that start is the one the
  // server is about to refuse, so the cell must not flicker back to a button in between.
  if (auto.auto && (state.status === 'queued' || state.status === 'running')) {
    return { kind: state.status, ...auto };
  }
  if (starting) return { kind: 'starting' };
  // STRICTEST STANDING VERDICT: a Request changes still in force on GitHub outranks a newer, milder
  // review. A run of the reader's in flight still shows as running.
  const block = standingBlockShown(state);
  if (block != null && state.status !== 'queued' && state.status !== 'running') {
    const latest = state.standing?.latest ?? null;
    const by = block.you || block.poster == null ? undefined : cellBy(block.poster.login, block.poster.displayName, block.poster.avatarUrl);
    return {
      kind: 'done',
      reviewId: block.reviewId ?? state.reviewId,
      verdict: 'REQUEST_CHANGES',
      verdictLabel: CLAUDE_VERDICT_LABEL.REQUEST_CHANGES,
      headMoved: block.headSha != null && state.currentHeadSha != null && block.headSha !== state.currentHeadSha,
      ...(by != null ? { by } : {}),
      stillBlocking: true,
      ...(latest != null && !sameRef(latest, block) ? { latest: latestReviewerLine(latest) } : {}),
    };
  }
  // THE NEWEST REVIEW LEADS: the server sets `teammateLead` only when a teammate's posted review is
  // newer than the reader's last real review (and none of the reader's is in flight).
  const mate = state.teammateLead;
  if (mate != null) {
    const name = teammateName({ login: mate.login, displayName: mate.name });
    return {
      kind: 'done',
      reviewId: state.reviewId,
      ...(mate.verdict != null ? { verdict: mate.verdict } : {}),
      verdictLabel: mate.verdict != null ? CLAUDE_VERDICT_LABEL[mate.verdict] : 'Reviewed',
      headMoved: mate.headMoved,
      by: { login: mate.login, displayName: mate.name, avatarUrl: mate.avatarUrl, name, title: `${name}’s review` },
    };
  }
  switch (state.status) {
    case 'queued':
      return { kind: 'queued' };
    case 'running':
      return { kind: 'running' };
    case 'succeeded':
      return {
        kind: 'done',
        reviewId: state.reviewId,
        ...(state.verdict != null ? { verdict: state.verdict } : {}),
        verdictLabel: state.verdict != null ? CLAUDE_VERDICT_LABEL[state.verdict] : 'Reviewed',
        headMoved: state.headMoved,
        ...auto,
      };
    case 'failed':
      return { kind: 'start', failed: true };
    case 'cancelled':
      return { kind: 'start' };
  }
}

function cellBy(login: string, displayName: string | null, avatarUrl: string | null): ReviewCellBy {
  const name = teammateName({ login, displayName });
  return { login, displayName, avatarUrl, name, title: `${name}’s review` };
}

function sameRef(a: ClaudeReviewStandingRef, b: ClaudeReviewStandingRef): boolean {
  return a.you === b.you && (a.you || a.poster?.userId === b.poster?.userId) && a.reviewId === b.reviewId;
}

/** "4 Nov" — a review's day, short. */
export function shortDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Who reviewed last, beside a standing block: "Latest: Robin · Comment · 4 Nov". */
export function latestReviewerLine(latest: ClaudeReviewStandingRef): { text: string; title: string } {
  const who = latest.you || latest.poster == null ? 'You' : teammateName({ login: latest.poster.login, displayName: latest.poster.displayName });
  const verdict = latest.verdict != null ? CLAUDE_VERDICT_LABEL[latest.verdict] : 'Reviewed';
  const day = shortDay(latest.at);
  return { text: `Latest: ${[who, verdict, day].filter(Boolean).join(' · ')}`, title: `The newest review is ${who === 'You' ? 'yours' : `${who}’s`}` };
}

/**
 * The standing block a cell shows INSTEAD of its lead (pure): `state.standing.blocking`, unless the
 * review the cell already leads with is that block (the reader's own Request changes, or the leading
 * teammate review itself). null = nothing to raise.
 */
export function standingBlockShown(state: ClaudeReviewPrState | undefined): ClaudeReviewStandingRef | null {
  const block = state?.standing?.blocking ?? null;
  if (state == null || block == null) return null;
  const mate = state.teammateLead;
  if (mate != null) return !block.you && mate.reviewId === block.reviewId ? null : block;
  if (block.you && state.status === 'succeeded' && state.verdict === 'REQUEST_CHANGES') return null;
  return block;
}

/** "Robin · Approve" for a teammate's leading review; the bare verdict label for the reader's own. */
export function leadVerdictText(cell: Extract<ReviewCell, { kind: 'done' }>): string {
  return cell.by != null ? `${cell.by.name} · ${cell.verdictLabel}` : cell.verdictLabel;
}

/** The figures of the reader's OWN finished run (`summary`), only while that run is what the cell
 *  shows — a teammate's leading review carries none, and the reader's older counts are not its. */
export function ownSummaryFor(cell: ReviewCell, state: ClaudeReviewPrState | undefined): ClaudeReviewStateSummary | undefined {
  // A standing block shows the reader's figures only when it IS the reader's latest run (same head).
  if (cell.kind === 'done' && cell.stillBlocking) {
    const block = state?.standing?.blocking;
    return block?.you && block.headSha != null && block.headSha === state?.reviewedHeadSha ? state?.summary : undefined;
  }
  return cell.kind === 'done' && cell.by == null ? state?.summary : undefined;
}

/** When the review the cell shows was done: a standing block's, the teammate's post when theirs
 *  leads, else the run. */
export function leadFinishedAt(state: ClaudeReviewPrState | undefined): string | null {
  return standingBlockShown(state)?.at ?? state?.teammateLead?.postedAt ?? state?.finishedAt ?? null;
}

/** Is the review the cell shows on the PR's current commit? The teammate's head when theirs leads
 *  (the newer-commit count is the reader's run's, so it is not reused there). */
export function leadCurrency(state: ClaudeReviewPrState | undefined): ReviewCurrency | null {
  if (state == null) return null;
  const block = standingBlockShown(state);
  if (block != null) return reviewCurrency({ reviewedHeadSha: block.headSha, currentHeadSha: state.currentHeadSha });
  const mate = state.teammateLead;
  return mate != null
    ? reviewCurrency({ reviewedHeadSha: mate.reviewedHeadSha, currentHeadSha: state.currentHeadSha })
    : reviewCurrency({ reviewedHeadSha: state.reviewedHeadSha, currentHeadSha: state.currentHeadSha, commitsSince: state.commitsSince });
}

/**
 * The column's sort rank — under 'asc', the rows that still need a review lead: never reviewed or
 * failed, then reviewed-but-moved, then in flight, then reviewed at the current head.
 */
export function reviewCellRank(cell: ReviewCell): number {
  switch (cell.kind) {
    case 'start':
      return 0;
    case 'done':
      return cell.headMoved ? 1 : 4;
    case 'starting':
    case 'queued':
      return 2;
    case 'running':
      return 3;
  }
}

// ---- the strip's figures (all read off the server's `summary`; nothing here decides a status) ----

/** The severities the strip counts, most pressing first. `praise` is not something to act on. */
export const STRIP_SEVERITIES: readonly ClaudeFindingSeverity[] = ['blocker', 'warning', 'nit', 'question'];

const SEVERITY_WORDS: Record<ClaudeFindingSeverity, [string, string]> = {
  blocker: ['blocker', 'blockers'],
  warning: ['warning', 'warnings'],
  nit: ['nit', 'nits'],
  question: ['question', 'questions'],
  praise: ['praise', 'praise'],
};

export interface SeverityPill {
  severity: ClaudeFindingSeverity;
  count: number;
  label: string; // "2 blockers"
}

/** One pill per severity the run found, most pressing first. [] for a clean run. */
export function severityPills(summary: ClaudeReviewStateSummary): SeverityPill[] {
  return STRIP_SEVERITIES.filter((sev) => (summary.findings[sev] ?? 0) > 0).map((sev) => {
    const n = summary.findings[sev];
    return { severity: sev, count: n, label: `${n} ${SEVERITY_WORDS[sev][n === 1 ? 0 : 1]}` };
  });
}

/** Every finding the run raised (the posted denominator). Praise is not a finding: an older run's
 *  stored praise is left out, and so is every finding the reader IGNORED — the server folds those
 *  out of `findings` into `ignoredCount`. */
export function findingTotal(summary: ClaudeReviewStateSummary): number {
  return (Object.entries(summary.findings) as Array<[ClaudeFindingSeverity, number]>)
    .filter(([sev]) => sev !== 'praise')
    .reduce((a, [, n]) => a + n, 0);
}

/**
 * IS THIS REVIEW ON THE PR'S CURRENT COMMIT? The ONE answer the Claude Review pane's header and the
 * Open PRs card both print, so the two can never disagree.
 *
 *   current  -> green "On latest commit" (+ `sha`, the short head, for a caller with room for it)
 *   behind   -> amber "N newer commits" / "1 newer commit", or "Branch changed" when the newer
 *               commits cannot be counted (a rewritten history, or the reviewed commit not synced)
 *
 * null when either commit is unknown: no reading is never "current" and never "moved".
 */
export interface ReviewCurrency {
  tone: 'current' | 'behind';
  label: string;
  /** The PR's current head, shortened (7 chars). */
  sha: string;
  /** The chip colour: CLEAN_CLASS when current, OUTDATED_CLASS when behind. */
  className: string;
  /** A hover line naming both commits. */
  title: string;
}

export function reviewCurrency(r: {
  reviewedHeadSha: string | null | undefined;
  currentHeadSha: string | null | undefined;
  commitsSince?: number | null;
}): ReviewCurrency | null {
  const reviewed = r.reviewedHeadSha;
  const current = r.currentHeadSha;
  if (!reviewed || !current) return null;
  const sha = current.slice(0, 7);
  if (reviewed === current) {
    return { tone: 'current', label: 'On latest commit', sha, className: CLEAN_CLASS, title: `Reviewed ${sha}, the PR's latest commit` };
  }
  const n = r.commitsSince;
  return {
    tone: 'behind',
    label: n == null || n <= 0 ? 'Branch changed' : `${n} newer commit${n === 1 ? '' : 's'}`,
    sha,
    className: OUTDATED_CLASS,
    title: `Reviewed ${reviewed.slice(0, 7)}; the PR is now at ${sha}`,
  };
}

/** The previous review's findings, in three figures: fixed, settled by a reply (accepted), and
 *  still open (not or partly fixed, or pushed back on a reply). `not_checked` / `no_longer_applies`
 *  are none of them. null when there was nothing to follow up. A count missing from an older
 *  server reads as 0. */
export function followUpTally(
  followUp: Partial<Record<ClaudeFollowUpStatus, number>> | null,
): { fixed: number; settled: number; open: number } | null {
  if (followUp == null) return null;
  const n = (k: ClaudeFollowUpStatus): number => followUp[k] ?? 0;
  const fixed = n('addressed');
  const settled = n('reply_accepted');
  const open = n('not_addressed') + n('partly_addressed') + n('reply_disputed');
  if (fixed === 0 && settled === 0 && open === 0) return null;
  return { fixed, settled, open };
}

/**
 * The Claude Review panel's left accent on an Open PRs card — the run's OUTCOME at a glance.
 * `none` = never reviewed (or cancelled): no accent, the panel is just an offer to review.
 */
export type ReviewTone = 'none' | 'active' | 'bad' | 'ok' | 'neutral';

export function reviewTone(cell: ReviewCell): ReviewTone {
  switch (cell.kind) {
    case 'start':
      return cell.failed ? 'bad' : 'none';
    case 'starting':
    case 'queued':
    case 'running':
      return 'active';
    case 'done':
      if (cell.verdict === 'REQUEST_CHANGES') return 'bad';
      if (cell.verdict === 'APPROVE') return 'ok';
      return 'neutral';
  }
}

/** "2 ignored" — the findings the reader ignored, which the pills and the posted total leave out.
 *  null when none (or an older server that does not send the count). */
export function ignoredLabel(summary: Pick<ClaudeReviewStateSummary, 'ignoredCount'>): string | null {
  const n = summary.ignoredCount ?? 0;
  return n > 0 ? `${n} ignored` : null;
}

/** Other reviewers' threads Claude judged right and not yet dealt with. null when none, or when
 *  the run did not judge threads (never a fake zero). */
export function threadsToFixLabel(summary: Pick<ClaudeReviewStateSummary, 'threadAssessments'>): string | null {
  const n = summary.threadAssessments?.validUnaddressed ?? 0;
  return n > 0 ? `${n} thread${n === 1 ? '' : 's'} to fix` : null;
}

/** The Findings sort value: most severe run first under 'desc'. A PR with no finished run sorts
 *  below a clean one (-1), so "nothing known" never ranks as "nothing found". */
export function findingsRank(state: ClaudeReviewPrState | undefined): number {
  // A teammate's leading review carries no counts here; the reader's older ones are not its.
  const f = state?.teammateLead != null ? undefined : state?.summary?.findings;
  if (f == null) return -1;
  return f.blocker * 1_000_000 + f.warning * 1_000 + f.nit + f.question;
}

/** Is this PR held by an auto review (queued in its lane, or running)? A manual start is refused
 *  with 409 AutoReviewInProgress until the hold ends. */
export function heldByAutoReview(state: ClaudeReviewPrState | undefined): boolean {
  return (
    state?.trigger === 'auto' && (state.status === 'queued' || state.status === 'running')
  );
}

/**
 * Every piece of Claude work in progress on ONE PR, in a fixed order, for the Open PRs card's
 * header chip: the code review (queued or running, the auto lane included), the ticket review, the
 * CI review and AI Fix. [] = nothing running. Read off the list's batched answers only.
 */
export function reviewWorkInProgress(i: {
  review: ClaudeReviewPrState | undefined;
  /** This PR's review start is in flight from this list or the PR's tab (shared mutation key). */
  starting?: boolean;
  ticketRunning: boolean;
  ciRunning: boolean;
}): string[] {
  const out: string[] = [];
  const status = i.review?.status;
  if (status === 'running') out.push('Reviewing');
  else if (status === 'queued' || i.starting) out.push('Review queued');
  if (i.ticketRunning) out.push('Checking story');
  if (i.ciRunning) out.push('Checking CI');
  if (i.review?.fix === 'running') out.push('Fixing');
  return out;
}

/** Does any listed PR have a run in flight? The column polls only while one does — which
 *  includes an auto review still waiting in its lane (reported as `queued`). */
export function anyReviewInFlight(states: readonly ClaudeReviewPrState[] | undefined): boolean {
  return (states ?? []).some((s) => s.status === 'queued' || s.status === 'running');
}


// ── WHEN THE REVIEW RAN ──
//
// Every surface that shows a finished review says how long ago it ran: the Open PRs panel, the
// Pending card's Claude line, the Claude Review tab's header. `relativeTime` turns into a bare date
// past a month, so the words follow it ("reviewed on 03/04/2026", never "reviewed 03/04/2026").

const isRelative = (rel: string): boolean => rel === 'just now' || rel.endsWith(' ago');

/** "reviewed 2 days ago", or "reviewed on <date>" for a run older than a month. */
export function reviewedAgoLabel(iso: string): string {
  const rel = relativeTime(iso);
  return isRelative(rel) ? `reviewed ${rel}` : `reviewed on ${rel}`;
}

/**
 * The outcome pill on the PR pane's "Claude Review" TAB LABEL, from the tab's own cached read
 * (`['claude-review', prId]`, DB-only). The latest run's verdict once it succeeded (a teammate's when
 * their posted review leads, `teamView.lead`); "Reviewing…" /
 * "Queued" while one is in flight (a start from any surface counts); "Failed" when the latest run
 * failed. null = say nothing (never reviewed, cancelled, a finished run with no verdict, or the
 * read not back yet).
 */
export type ReviewTabPill =
  | { kind: 'verdict'; verdict: ClaudeReviewVerdict; label: string }
  | { kind: 'running' | 'queued' | 'failed'; label: string };

export function reviewTabPill(
  data:
    | {
        review: { status: string; verdict: ClaudeReviewVerdict | null } | null;
        autoReview?: 'queued' | 'running' | null;
        teamView?: {
          lead: 'own' | 'teammate' | null;
          teammateReviewId: number | null;
          standings?: { blocking: ClaudeReviewStandingRef | null };
        };
        teammateReviews?: ReadonlyArray<{ reviewId: number; verdict: ClaudeReviewVerdict | null }>;
      }
    | undefined,
  starting: boolean,
): ReviewTabPill | null {
  if (data == null) return null;
  const r = data.review;
  if (r?.status === 'running' || data.autoReview === 'running') return { kind: 'running', label: 'Reviewing…' };
  if (starting || r?.status === 'queued' || data.autoReview === 'queued') return { kind: 'queued', label: 'Queued' };
  // STRICTEST STANDING VERDICT: a Request changes still in force on GitHub, whoever's, heads the pill.
  if (data.teamView?.standings?.blocking != null)
    return { kind: 'verdict', verdict: 'REQUEST_CHANGES', label: CLAUDE_VERDICT_LABEL.REQUEST_CHANGES };
  // ONE REVIEW (docs/CLAUDE-REVIEW.md § Teammates' reviews → One review): when a teammate's posted
  // review is the newest, it heads the tab, so the pill says its verdict, not the reader's older one.
  if (data.teamView?.lead === 'teammate') {
    const mate = data.teammateReviews?.find((t) => t.reviewId === data.teamView?.teammateReviewId);
    if (mate?.verdict != null) return { kind: 'verdict', verdict: mate.verdict, label: CLAUDE_VERDICT_LABEL[mate.verdict] };
  }
  if (r == null) return null;
  if (r.status === 'failed') return { kind: 'failed', label: 'Failed' };
  if (r.status === 'succeeded' && r.verdict != null) {
    return { kind: 'verdict', verdict: r.verdict, label: CLAUDE_VERDICT_LABEL[r.verdict] };
  }
  return null;
}

/**
 * The review preview's top-level body as the reader will SEE it on GitHub: the server appends a
 * hidden provenance marker (`<!-- pierre:claude-review v=1 -->`, review/post-seam.ts) that GitHub
 * does not render, so the preview drops it too. '' = no summary.
 */
export function visibleReviewBody(body: string): string {
  return body.replace(/<!--\s*pierre:claude-review[^>]*-->/g, '').trim();
}

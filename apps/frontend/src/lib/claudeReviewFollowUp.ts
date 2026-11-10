// The pure half of the Claude Review tab's follow-up and user-story UI: ordering, anchors and the
// chip palette. No JSX, so it is unit-tested from `test/`.
//
// ⚠ NOTHING HERE DECIDES A STATUS. Every status comes from the server's reconcile step
// (`packages/pro/src/claude-review/follow-up.ts` / `ticket.ts`), which never invents "addressed";
// this module only orders and paints what it was sent. The caps and the criteria split are NOT
// retyped here either — they live once in `@pierre-review/shared` (`claude-review.ts`).
import {
  aiProviderName,
  FOLLOW_UP_STATUS_LABEL,
  isThreadToFix,
  judgementHowOf,
  storyMissingRef,
  storyName,
  TICKET_CRITERION_STATUS_LABEL,
} from '@pierre-review/shared';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFindingStory,
  ClaudeFollowUpItem,
  ClaudeFollowUpStatus,
  ClaudeReview,
  ClaudeReviewTicket,
  ClaudeReviewTicketEntry,
  ClaudeReviewTicketSource,
  ClaudeReviewVerdict,
  ClaudeSettledFinding,
  ClaudeTicketAlignment,
  ClaudeTicketCriterionStatus,
  ClaudeThreadAddressed,
  ClaudeThreadAssessment,
  ClaudeThreadAssessmentCounts,
  ClaudeThreadValidity,
} from '@pierre-review/shared';

// ---- severity (moved here from ClaudeReviewTab so the follow-up list paints the same pill) ----

export const SEVERITY_RANK: Record<ClaudeFindingSeverity, number> = {
  blocker: 0,
  warning: 1,
  nit: 2,
  question: 3,
  praise: 4,
};

export const SEVERITY_CLASS: Record<ClaudeFindingSeverity, string> = {
  // A blocker is red (it blocks), a warning amber (look at it); the rest are counts in grey (docs/redesign/DESIGN.md § 3).
  blocker: 'bg-ui-danger/10 text-ui-danger',
  warning: 'bg-ui-warn/10 text-ui-warn',
  nit: 'bg-ui-raise text-ui-mute',
  question: 'bg-ui-raise text-ui-mute',
  praise: 'bg-ui-raise text-ui-mute',
};

// ---- praise: not a finding ----
//
// A review no longer raises praise as a finding (the summary carries one plain line of it). Older
// runs stored some: they are HIDDEN everywhere — the findings list, its counts, the follow-up of an
// earlier praise item — and nothing is deleted. Applied ONCE, where the tab takes the run.

export const isPraise = (f: { severity: ClaudeFindingSeverity }): boolean => f.severity === 'praise';

/** The run with stored praise findings, and follow-up items about earlier praise, left out. */
export function withoutPraise<T extends Pick<ClaudeReview, 'findings' | 'followUp'>>(review: T): T {
  const hasPraise =
    review.findings.some(isPraise) || (review.followUp?.items.some(isPraise) ?? false);
  if (!hasPraise) return review;
  return {
    ...review,
    findings: review.findings.filter((f) => !isPraise(f)),
    followUp:
      review.followUp == null
        ? review.followUp
        : { ...review.followUp, items: review.followUp.items.filter((it) => !isPraise(it)) },
  };
}

/**
 * The findings list order: severity first (as before), and within one severity the findings that
 * RAISE AN EARLIER COMMENT AGAIN come first — they are the "still not fixed" ones the reader came
 * back for. Stable otherwise (the server's own order).
 */
export function sortFindingsForDisplay(findings: readonly ClaudeFinding[]): ClaudeFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity];
      if (bySeverity !== 0) return bySeverity;
      const aRe = a.f.priorFindingId != null ? 0 : 1;
      const bRe = b.f.priorFindingId != null ? 0 : 1;
      if (aRe !== bRe) return aRe - bRe;
      return a.i - b.i;
    })
    .map((x) => x.f);
}

// ---- chip palette (the file's existing contrast-safe pairs) ----

// The colour rule (docs/redesign/DESIGN.md § Colour): red for what is still to fix (it blocks),
// green only for an Approve verdict (ready). Every other count is grey words on the neutral raise, so a row of counts never
// reads as a row of coloured pills.
const CHIP_RED = 'bg-ui-danger/10 text-ui-danger';
const CHIP_ORANGE = 'bg-ui-raise text-ui-mute';
const CHIP_GREEN = 'bg-ui-raise text-ui-mute';
const CHIP_GREY = 'bg-ui-raise text-ui-mute';
const CHIP_SKY = 'bg-ui-raise text-ui-mute';
// The one other tint: an APPROVE verdict — ready to land.
const CHIP_READY = 'bg-ui-raise text-ui-success';

// ⚠ `not_checked` is GREY, never amber: it is unknown, not "not addressed".
export const FOLLOW_UP_STATUS_CLASS: Record<ClaudeFollowUpStatus, string> = {
  not_addressed: CHIP_RED,
  partly_addressed: CHIP_ORANGE,
  not_checked: CHIP_GREY,
  addressed: CHIP_GREEN,
  no_longer_applies: CHIP_GREY,
  // A reply settled it: nothing left to fix, so green like addressed.
  reply_accepted: CHIP_GREEN,
  // Claude disagreed with a reply: still open, so amber like partly addressed.
  reply_disputed: CHIP_ORANGE,
};

export const TICKET_CRITERION_STATUS_CLASS: Record<ClaudeTicketCriterionStatus, string> = {
  met: CHIP_GREEN,
  // Done, but by a person's comment, not code: the same green, its own label (TICKET_CRITERION_STATUS_LABEL).
  met_outside_code: CHIP_GREEN,
  partly_met: CHIP_ORANGE,
  not_met: CHIP_RED,
  unclear: CHIP_GREY,
  not_checked: CHIP_GREY,
};

// The Open PRs strip: a finished run that found nothing to act on, and a review the PR moved past.
export const CLEAN_CLASS = CHIP_GREEN;
// A review behind the head keeps the warn ink (the legacy attention mark: it may be stale).
export const OUTDATED_CLASS = 'bg-ui-raise text-ui-warn';

// The verdict badge (Claude Review tab) and the Open PRs strip's verdict pill.
export const VERDICT_CLASS: Record<ClaudeReviewVerdict, string> = {
  APPROVE: CHIP_READY,
  REQUEST_CHANGES: CHIP_RED,
  COMMENT: CHIP_SKY,
};

export const TICKET_ALIGNMENT_CLASS: Record<ClaudeTicketAlignment, string> = {
  aligned: CHIP_GREEN,
  partly_aligned: CHIP_ORANGE,
  not_aligned: CHIP_RED,
  unclear: CHIP_GREY,
  not_checked: CHIP_GREY,
};

// ---- the previous-review list ----

// Open = the reader still has something to look at. Not addressed first (the headline), then
// pushed back (a reply Claude disagreed with), partly addressed, then the ones nobody checked.
// Closed = addressed, settled by a reply, or no longer applies.
const OPEN_ORDER: Partial<Record<ClaudeFollowUpStatus, number>> = {
  not_addressed: 0,
  reply_disputed: 1,
  partly_addressed: 2,
  not_checked: 3,
};

export function partitionFollowUp(items: readonly ClaudeFollowUpItem[]): {
  open: ClaudeFollowUpItem[];
  closed: ClaudeFollowUpItem[];
} {
  const open: { it: ClaudeFollowUpItem; i: number }[] = [];
  const closed: ClaudeFollowUpItem[] = [];
  items.forEach((it, i) => {
    if (OPEN_ORDER[it.status] != null) open.push({ it, i });
    else closed.push(it);
  });
  open.sort((a, b) => (OPEN_ORDER[a.it.status] ?? 9) - (OPEN_ORDER[b.it.status] ?? 9) || a.i - b.i);
  return { open: open.map((x) => x.it), closed };
}

// ---- the earlier findings, ON THE FINDINGS LIST ----
// There is no separate "Previous review" section (removed 2026-11-10). What the latest run said about
// each earlier finding — its status, the one-line HOW, the reply and its buttons — rides on that
// finding's own row in Findings ("Open", then "Resolved or addressed"). An item no row shows (an
// older server, a finding the team fold leaves out) gets a row of its own in the same group.

/** The one line under an earlier finding: how it was dealt with, or the one thing still needed. */
export function followUpOneLine(
  item: Pick<ClaudeFollowUpItem, 'how' | 'explanation' | 'status' | 'sent'>,
  by = 'Claude',
): string | null {
  const how = judgementHowOf(item);
  if (how != null) return how;
  return item.status === 'not_checked' ? notCheckedReason(item, by) : null;
}

export interface EarlierNotes {
  // The latest run's follow-up item, by the earlier finding's id AND by its re-raise's id.
  items: ReadonlyMap<number, ClaudeFollowUpItem>;
  // A finding an earlier review settled by accepting a reply, by its id.
  settled: ReadonlyMap<number, ClaudeSettledFinding>;
}

/** Index the run's follow-up and settled-earlier rows by every finding id a row may show. Pure. */
export function earlierNotes(
  items: readonly ClaudeFollowUpItem[],
  settled: readonly ClaudeSettledFinding[],
): EarlierNotes {
  const byId = new Map<number, ClaudeFollowUpItem>();
  for (const it of items) {
    byId.set(it.priorFindingId, it);
    if (it.reraisedFindingId != null) byId.set(it.reraisedFindingId, it);
  }
  return { items: byId, settled: new Map(settled.map((x) => [x.priorFindingId, x])) };
}

/** What the run said about a row showing any of these finding ids (its own, and everyone's who raised it too). */
export function earlierNoteFor(
  notes: EarlierNotes,
  ids: readonly number[],
): { item: ClaudeFollowUpItem | null; settled: ClaudeSettledFinding | null } {
  let item: ClaudeFollowUpItem | null = null;
  let settled: ClaudeSettledFinding | null = null;
  for (const id of ids) {
    item ??= notes.items.get(id) ?? null;
    settled ??= notes.settled.get(id) ?? null;
  }
  return { item, settled: item == null ? settled : null };
}

/**
 * The follow-up items and settled findings NO shown row carries (`shownIds`: every finding id the
 * Findings rows show), split the way the list is: still open, then closed. Pure.
 */
export function unplacedEarlier(
  items: readonly ClaudeFollowUpItem[],
  settled: readonly ClaudeSettledFinding[],
  shownIds: ReadonlySet<number>,
): { open: ClaudeFollowUpItem[]; closed: ClaudeFollowUpItem[]; settled: ClaudeSettledFinding[] } {
  const placed = (it: ClaudeFollowUpItem): boolean =>
    shownIds.has(it.priorFindingId) || (it.reraisedFindingId != null && shownIds.has(it.reraisedFindingId));
  const { open, closed } = partitionFollowUp(items.filter((it) => !placed(it)));
  return { open, closed, settled: settled.filter((x) => !shownIds.has(x.priorFindingId)) };
}

/**
 * The status chip on a row's note, or null when the row already says it: a re-raised finding's own
 * chip ("Not addressed"), or a closed row's reason ("Your review found it addressed"). A reply status
 * always shows ("Pushed back", "Reply accepted: not an issue").
 */
export function earlierNoteChip(
  item: Pick<ClaudeFollowUpItem, 'status' | 'acceptKind'>,
  row: { reraisedChip: boolean; closedReason: boolean },
): string | null {
  const reply = replyStatusHeading(item);
  if (reply != null) return reply;
  if (row.reraisedChip) return null;
  if (row.closedReason && (item.status === 'addressed' || item.status === 'no_longer_applies')) return null;
  return FOLLOW_UP_STATUS_LABEL[item.status];
}

export interface CodeAnchor {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  // Whether the Changes tab has this file to show (else the anchor is plain text).
  inChangeset: boolean;
}

/**
 * Whether the code has moved since THIS earlier comment was raised. The item's own flag first: a
 * comment carried from an OLDER review was raised at an older head than the previous review's, so
 * the record's `headMoved` (previous review vs this run) is wrong for it. Rows from before the
 * per-item flag fall back to the record's.
 */
export function itemHeadMoved(
  item: Pick<ClaudeFollowUpItem, 'headMoved'>,
  recordHeadMoved: boolean,
): boolean {
  return item.headMoved ?? recordHeadMoved;
}

/**
 * Where an earlier comment's anchor should point NOW. The finding that raised it again carries the
 * current path and line, so prefer it. Otherwise the earlier finding's own path — and its line
 * only when the code has NOT moved since it was raised (`itemHeadMoved`; a line from an older head
 * would point at the wrong code).
 */
export function followUpAnchor(
  item: ClaudeFollowUpItem,
  findingsById: ReadonlyMap<number, ClaudeFinding>,
  headMoved: boolean,
  changedPaths: ReadonlySet<string>,
): CodeAnchor {
  const re = item.reraisedFindingId != null ? findingsById.get(item.reraisedFindingId) : undefined;
  if (re) {
    return {
      path: re.path,
      line: re.line,
      side: re.side,
      inChangeset: changedPaths.size > 0 ? changedPaths.has(re.path) : re.fileInDiff,
    };
  }
  return {
    path: item.path,
    line: itemHeadMoved(item, headMoved) ? null : item.line,
    side: item.side,
    inChangeset: changedPaths.has(item.path),
  };
}

export function anchorLabel(path: string, line: number | null): string {
  return line != null ? `${path}:${line}` : path;
}

/** Why an earlier comment carries no verdict. Two different facts, so two sentences. `by`: the
 *  provider that ran the review ('Claude' | 'Codex'; default Claude). */
export function notCheckedReason(item: Pick<ClaudeFollowUpItem, 'sent'>, by = 'Claude'): string {
  return item.sent ? `${by} didn't report on this one.` : `Not sent to ${by}: too many earlier comments.`;
}

// ---- other reviewers' threads ----

// ⚠ `not_checked` / `unclear` are GREY, never amber: unknown is not "still to fix".
export const THREAD_VALIDITY_CLASS: Record<ClaudeThreadValidity, string> = {
  valid: CHIP_ORANGE,
  partly_valid: CHIP_ORANGE,
  not_valid: CHIP_GREY,
  unclear: CHIP_GREY,
  not_checked: CHIP_GREY,
};

export const THREAD_ADDRESSED_CLASS: Record<ClaudeThreadAddressed, string> = {
  not_addressed: CHIP_RED,
  partly_addressed: CHIP_ORANGE,
  addressed: CHIP_GREEN,
  unclear: CHIP_GREY,
  not_checked: CHIP_GREY,
};

/** The addressed pill's colour. A comment Claude found wrong owes no fix, so it is never red. */
export function threadAddressedClass(
  t: Pick<ClaudeThreadAssessment, 'validity' | 'addressed'>,
): string {
  return t.validity === 'not_valid' ? CHIP_GREY : THREAD_ADDRESSED_CLASS[t.addressed];
}

/**
 * A thread the reader can stop looking at: resolved on GitHub (Claude judges those too, but its
 * pill reads "Resolved" and it is never to fix), dealt with, or Claude found the comment wrong.
 */
export function isThreadSettled(
  t: Pick<ClaudeThreadAssessment, 'validity' | 'addressed' | 'resolved'>,
): boolean {
  return (
    t.resolved === true ||
    (!isThreadToFix(t) && (t.addressed === 'addressed' || t.validity === 'not_valid'))
  );
}

/**
 * The Review threads list: still to fix first (the shared `isThreadToFix`), then the other open
 * ones (judged before not checked); the settled ones (`isThreadSettled`) go behind "Show N more".
 * Stable otherwise (the server's own order).
 */
export function partitionThreads(items: readonly ClaudeThreadAssessment[]): {
  shown: ClaudeThreadAssessment[];
  more: ClaudeThreadAssessment[];
} {
  const rank = (t: ClaudeThreadAssessment): number =>
    isThreadToFix(t) ? 0 : t.validity === 'not_checked' && t.addressed === 'not_checked' ? 2 : 1;
  const shown: { t: ClaudeThreadAssessment; i: number }[] = [];
  const more: ClaudeThreadAssessment[] = [];
  items.forEach((t, i) => {
    if (isThreadSettled(t)) more.push(t);
    else shown.push({ t, i });
  });
  shown.sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i);
  return { shown: shown.map((x) => x.t), more };
}

export interface ThreadCountPill {
  key: 'toFix' | 'addressed' | 'notValid' | 'notChecked';
  label: string;
  cls: string;
}

/** The header's count pills, zeros left out. Figures are the server's (code-derived) counts. */
export function threadCountPills(c: ClaudeThreadAssessmentCounts): ThreadCountPill[] {
  const pills: ThreadCountPill[] = [
    { key: 'toFix', label: `${c.validUnaddressed} still to fix`, cls: CHIP_RED },
    // The thread pills' ONE vocabulary (lib/claudeThreadMarker.ts): "Addressed", "Doesn't hold".
    { key: 'addressed', label: `${c.addressed} addressed`, cls: CHIP_GREEN },
    { key: 'notValid', label: `${c.notValid} ${c.notValid === 1 ? 'doesn’t' : 'don’t'} hold up`, cls: CHIP_GREY },
    { key: 'notChecked', label: `${c.notChecked} not checked`, cls: CHIP_GREY },
  ];
  const n: Record<ThreadCountPill['key'], number> = {
    toFix: c.validUnaddressed,
    addressed: c.addressed,
    notValid: c.notValid,
    notChecked: c.notChecked,
  };
  return pills.filter((p) => n[p.key] > 0);
}

/** Why a thread carries no verdict. `by`: the provider that judged it (default Claude). */
export function threadNotCheckedReason(t: Pick<ClaudeThreadAssessment, 'sent'>, by = 'Claude'): string {
  return t.sent ? `${by} didn't report on this one.` : `Not sent to ${by}: too many open threads.`;
}

export type ReraisedStatus = 'not_addressed' | 'partly_addressed' | 'reply_disputed';

/**
 * finding id -> the status of the earlier comment it raises again. Only the two OPEN statuses:
 * a finding linked to anything else is not a "still not fixed" claim and gets no chip.
 */
export function reraisedStatusByFindingId(
  review: Pick<ClaudeReview, 'findings' | 'followUp'>,
): Map<number, ReraisedStatus> {
  const out = new Map<number, ReraisedStatus>();
  const items = review.followUp?.items ?? [];
  if (items.length === 0) return out;
  const byPrior = new Map<number, ClaudeFollowUpStatus>();
  for (const it of items) byPrior.set(it.priorFindingId, it.status);
  for (const f of review.findings) {
    if (f.priorFindingId == null) continue;
    const s = byPrior.get(f.priorFindingId);
    if (s === 'not_addressed' || s === 'partly_addressed' || s === 'reply_disputed') out.set(f.id, s);
  }
  return out;
}

export const RERAISED_CHIP: Record<ReraisedStatus, { label: string; cls: string }> = {
  not_addressed: { label: 'Not addressed since last review', cls: CHIP_RED },
  partly_addressed: { label: 'Partly addressed since last review', cls: CHIP_ORANGE },
  reply_disputed: { label: 'Reply did not settle it', cls: CHIP_ORANGE },
};

// ---- replies on Limn's own findings (reply_accepted / reply_disputed) ----

/** The row's heading for a reply status; null for every other status. */
export function replyStatusHeading(item: Pick<ClaudeFollowUpItem, 'status' | 'acceptKind'>): string | null {
  if (item.status === 'reply_disputed') return 'Pushed back';
  if (item.status !== 'reply_accepted') return null;
  return item.acceptKind === 'deferred' ? 'Reply accepted: to be handled later' : 'Reply accepted: not an issue';
}

/**
 * A pushback on a thread someone RESOLVED on GitHub: still open here (it counts and is raised
 * again), so the row says the thread was closed. Limn never pushes back there on its own.
 */
export function isResolvedPushback(item: Pick<ClaudeFollowUpItem, 'status' | 'threadResolved'>): boolean {
  return item.status === 'reply_disputed' && item.threadResolved === true;
}

export const RESOLVED_ON_GITHUB_CHIP = { label: 'Resolved on GitHub', cls: CHIP_GREY };

/** The heading of a finding an EARLIER review settled by accepting a reply. */
export function settledEarlierHeading(s: Pick<ClaudeSettledFinding, 'acceptKind'>): string {
  return replyStatusHeading({ status: 'reply_accepted', acceptKind: s.acceptKind })!;
}

/**
 * The settled-earlier rows to show beside this run's closed follow-up items: praise left out, and
 * an id the follow-up still lists left out (it shows there). Stable (the server's order).
 */
export function settledEarlierRows(
  review: Pick<ClaudeReview, 'followUp' | 'settledEarlier'>,
): ClaudeSettledFinding[] {
  const listed = new Set((review.followUp?.items ?? []).map((it) => it.priorFindingId));
  return (review.settledEarlier ?? []).filter((s) => s.severity !== 'praise' && !listed.has(s.priorFindingId));
}

/**
 * What became of the reply Limn would post (the acknowledgement or the pushback): a note about the
 * write, whether to show the drafted text, and which buttons the row offers. Reads the thread
 * OWNER's record, which an EARLIER run may have written:
 *   - ⚠ "Post reply" is offered only when no reply of Limn's can be on the thread already — any
 *     record except a CLEAR refusal (`refused: true`) shuts it, including a `posting` one and an
 *     unclear failure (a 5xx may have posted). The server claims the same record before it writes,
 *     so this is the screen agreeing with it, not the only guard.
 *   - A record from ANOTHER review is not this run's write: the row says Limn already replied
 *     earlier and hides this run's text (it was never posted).
 */
export function replyActions(
  item: Pick<ClaudeFollowUpItem, 'status' | 'response' | 'threadId' | 'threadResolved' | 'autoResolve' | 'pushback' | 'prComment'>,
  reviewId: number,
): { note: string | null; showText: boolean; canPost: boolean; canResolve: boolean } {
  const text = (item.response ?? '').trim();
  // A PR-LEVEL finding (posted as a PR comment) has no thread: Limn writes a new PR comment that
  // links it, and "resolving" hides the finding comment as resolved.
  const prLevel = item.threadId == null && item.prComment != null;
  const hasThread = item.threadId != null || prLevel;
  const where = prLevel ? 'about this comment' : 'on this thread';
  const UNCLEAR = prLevel
    ? 'Couldn’t confirm the reply posted. Check the pull request on GitHub.'
    : 'Couldn’t confirm the reply posted. Check the thread on GitHub.';
  if (item.status === 'reply_accepted') {
    const ar = item.autoResolve ?? null;
    const mine = ar != null && ar.byReviewId === reviewId;
    const how = ar?.manual ? '' : ' automatically';
    const replyMayBeOn = ar != null && !(ar.status === 'failed' && ar.replyCommentId == null && ar.refused === true);
    const resolved = item.threadResolved === true || ar?.status === 'resolved';
    let note: string | null = null;
    if (ar != null && !mine) {
      if (replyMayBeOn) note = `Limn already replied ${where} earlier.`;
    } else if (ar != null) {
      if (ar.status === 'resolved') note = ar.replyCommentId == null && prLevel ? 'Marked resolved.' : `Replied and resolved${how}.`;
      else if (ar.status === 'resolving') note = `Replying${how}…`;
      else if (ar.replyCommentId != null) note = `Replied${how}, but couldn’t resolve: ${ar.error?.trim() || 'GitHub did not accept it.'}`;
      else if (ar.refused === true) note = `Couldn’t reply${how}: ${ar.error?.trim() || 'GitHub did not accept it.'}`;
      else note = UNCLEAR;
    }
    if (note == null && resolved) note = prLevel ? 'The comment is marked resolved.' : 'The thread is resolved.';
    return {
      note,
      showText: !(ar != null && !mine && replyMayBeOn),
      canPost: hasThread && text !== '' && !replyMayBeOn && !resolved,
      canResolve: hasThread && !resolved && (ar == null || ar.status === 'failed'),
    };
  }
  if (item.status === 'reply_disputed') {
    const pb = item.pushback ?? null;
    const mine = pb != null && pb.byReviewId === reviewId;
    const how = pb?.manual ? '' : ' automatically';
    const mayBeOn = pb != null && !(pb.status === 'failed' && pb.refused === true);
    let note: string | null = null;
    if (pb != null && !mine) {
      if (mayBeOn) note = prLevel ? 'Limn already said this is still open.' : 'Limn already pushed back on this thread earlier.';
    } else if (pb != null) {
      if (pb.status === 'posted') note = `Posted${how}.`;
      else if (pb.status === 'posting') note = `Posting${how}…`;
      else if (pb.refused === true) note = `Couldn’t post${how}: ${pb.error?.trim() || 'GitHub did not accept it.'}`;
      else note = UNCLEAR;
    }
    return {
      note,
      showText: !(pb != null && !mine && mayBeOn),
      canPost: hasThread && text !== '' && !mayBeOn,
      canResolve: false,
    };
  }
  return { note: null, showText: true, canPost: false, canResolve: false };
}

/**
 * May the row offer "Post still open"? A NOT (or partly) ADDRESSED item, with a one-line "how" to
 * post, on a thread GitHub shows RESOLVED (Limn writes nothing there by itself) — or on a PR-LEVEL
 * finding that Limn has not called still open yet (once per finding, ever). Pure.
 */
export function stillOpenPostable(
  item: Pick<ClaudeFollowUpItem, 'status' | 'how' | 'explanation' | 'threadId' | 'threadResolved' | 'prComment' | 'pushback' | 'raisedBy'>,
): boolean {
  if (item.status !== 'not_addressed' && item.status !== 'partly_addressed') return false;
  // The other provider's finding: the check never says "still open" on GitHub.
  if (item.raisedBy != null) return false;
  if (judgementHowOf(item) == null) return false;
  // A PR-LEVEL finding: once per finding, ever — offered until Limn said it (or GitHub refused it).
  if (item.threadId == null && item.prComment != null) {
    const pb = item.pushback ?? null;
    return pb == null || (pb.status === 'failed' && pb.refused === true);
  }
  return item.threadId != null && item.threadResolved === true;
}

/**
 * Who raised a finding the OTHER provider checked: "Raised by Codex · checked by Claude". null for
 * the run's own finding. `by`: the provider that ran the check (default Claude). Pure.
 */
export function raisedByLine(item: Pick<ClaudeFollowUpItem, 'raisedBy'>, by = 'Claude'): string | null {
  if (item.raisedBy == null) return null;
  return `Raised by ${aiProviderName(item.raisedBy)} · checked by ${by}`;
}

/** Is this item a PR-LEVEL finding (posted as a PR comment, so it has no thread)? Pure. */
export function isPrLevelItem(item: Pick<ClaudeFollowUpItem, 'threadId' | 'prComment'>): boolean {
  return item.threadId == null && item.prComment != null;
}

/**
 * The findings that repeat a comment ALREADY POSTED ON THIS SAME COMMIT: the earlier comment was
 * posted and the code has not moved since it was raised. The server saves these left out of the
 * review (so Post review does not put the same comment on GitHub twice); this names them so the
 * row can say why. Reads the stored item flags only — it decides nothing.
 */
export function alreadyPostedReraiseIds(
  review: Pick<ClaudeReview, 'findings' | 'followUp'>,
): Set<number> {
  const out = new Set<number>();
  const fu = review.followUp;
  if (!fu || fu.items.length === 0) return out;
  const onThisCommit = new Set<number>();
  for (const it of fu.items) {
    if (it.priorPosted === true && !itemHeadMoved(it, fu.headMoved)) onThisCommit.add(it.priorFindingId);
  }
  for (const f of review.findings) {
    if (f.priorFindingId != null && onThisCommit.has(f.priorFindingId)) out.add(f.id);
  }
  return out;
}

export const ALREADY_POSTED_CHIP = {
  label: 'Already posted',
  title: 'This comment is already on the pull request, on this same commit, so it starts ignored.',
  cls: CHIP_GREY,
};

// ---- the user story, as drawn ----

// A story as the story views draw it (JiraStoryView): always three strings. `source: 'jira'`
// (+ key/url/fetchedAt) marks a story Limn READ from the tracker. (Typing a story by hand was
// removed: a stored one without a source is an older run's.)
export interface TicketDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  source?: ClaudeReviewTicketSource;
  key?: string;
  url?: string;
  fetchedAt?: string;
  // CLIENT-ONLY, never sent (the check builds the request from the fields above): the Jira field
  // the acceptance criteria were taken from — null = none chosen, undefined = not known (a story
  // prefilled from a stored run) — and the ticket's issue type, which keys the remembered choice.
  acField?: { id: string; name: string } | null;
  issueTypeId?: string | null;
}

export const EMPTY_TICKET_DRAFT: TicketDraft = { title: '', description: '', acceptanceCriteria: '' };

export function ticketDraftFromStored(ticket: ClaudeReviewTicket | null | undefined): TicketDraft {
  if (!ticket) return EMPTY_TICKET_DRAFT;
  const d: TicketDraft = {
    title: ticket.title ?? '',
    description: ticket.description ?? '',
    acceptanceCriteria: ticket.acceptanceCriteria ?? '',
  };
  if (ticket.source === 'jira') {
    d.source = 'jira';
    if (ticket.key != null) d.key = ticket.key;
    if (ticket.url != null) d.url = ticket.url;
    if (ticket.fetchedAt != null) d.fetchedAt = ticket.fetchedAt;
  }
  return d;
}

/** The stories a run was given, as drafts (the per-ticket entries, else the legacy single one). */
export function ticketDraftsFromReview(
  review: Pick<ClaudeReview, 'tickets' | 'ticket'> | null | undefined,
): TicketDraft[] {
  if (review == null) return [];
  const stored =
    review.tickets != null ? review.tickets.map((e) => e.ticket) : review.ticket ? [review.ticket] : [];
  return stored.map(ticketDraftFromStored).filter(ticketDraftHasContent);
}

export function isJiraDraft(d: TicketDraft): boolean {
  return d.source === 'jira';
}

export function ticketDraftHasContent(d: TicketDraft): boolean {
  return d.title.trim() !== '' || d.description.trim() !== '' || d.acceptanceCriteria.trim() !== '';
}

// ---- story findings ----
// Every unmet / partly met criterion and every "Not done" item of a run is a FINDING of that run
// (`ClaudeFinding.story`, made server-side). ⚠ EACH ONE IS SHOWN ONCE, IN ITS STORY: the User
// stories section renders the SAME finding card the Findings list uses, in place of the item's
// row, and the Findings list leaves it out (`placeStoryFindings`). Older runs (before story
// findings) have none, so their items fall back to the compact read-only rows. A story finding
// whose story this run does not list (never expected) stays in the Findings list with its chip.

const storyKey = (index: number, ref: string): string => `${index}:${ref}`;

/** `${ticketIndex}:${ref}` → the id of THIS run's finding for that story item (the first one). */
export function storyFindingIds(findings: readonly ClaudeFinding[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) {
    if (f.story == null) continue;
    const k = storyKey(f.story.index, f.story.ref);
    if (!out.has(k)) out.set(k, f.id);
  }
  return out;
}

/** The finding id for a criterion row (`ref` 'AC2') or a not-done row (0-based `missingIndex`). */
export function storyFindingIdFor(
  ids: ReadonlyMap<string, number>,
  ticketIndex: number,
  item: { ref: string } | { missingIndex: number },
): number | null {
  const ref = 'ref' in item ? item.ref : storyMissingRef(item.missingIndex);
  return ids.get(storyKey(ticketIndex, ref)) ?? null;
}

/**
 * The chip on a story finding's card: "BMD-1040 · AC2", "Story 2 · Not done". The story's name
 * comes from the run's own ticket list; a ticket missing from it (a re-raise of an older run's
 * story finding) reads "Story".
 */
export function storyChipLabel(
  story: ClaudeFindingStory,
  tickets: readonly ClaudeReviewTicketEntry[] | null | undefined,
): string {
  const entry = (tickets ?? []).find((t) => t.index === story.index);
  const name = entry ? storyName(entry.ticket, entry.index) : 'Story';
  return `${name} · ${/^M\d+$/.test(story.ref) ? 'Not done' : story.ref}`;
}

/**
 * Which of this run's findings render INSIDE the Story check section: the one finding per unmet
 * criterion / "Not done" item that the section has a row for. `placed` is what the Findings list
 * must leave out, so every finding is on screen exactly once.
 */
export function placeStoryFindings(
  findings: readonly ClaudeFinding[],
  tickets: readonly ClaudeReviewTicketEntry[] | null | undefined,
): { byId: Map<number, ClaudeFinding>; ids: Map<string, number>; placed: Set<number> } {
  const ids = storyFindingIds(findings);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const placed = new Set<number>();
  for (const entry of tickets ?? []) {
    const a = entry.assessment;
    if (a == null) continue;
    for (const c of a.criteria) {
      if (c.status !== 'not_met' && c.status !== 'partly_met') continue;
      const id = storyFindingIdFor(ids, entry.index, { ref: c.ref });
      if (id != null) placed.add(id);
    }
    a.missing.forEach((_g, i) => {
      const id = storyFindingIdFor(ids, entry.index, { missingIndex: i });
      if (id != null) placed.add(id);
    });
  }
  return { byId, ids, placed };
}

/** The chip on a story finding's card INSIDE its story: "AC2 · Partly met", or "Not done". */
export function storyItemChipLabel(
  ref: string,
  status: 'not_met' | 'partly_met' | null,
): string {
  if (status == null) return 'Not done';
  return `${ref} · ${TICKET_CRITERION_STATUS_LABEL[status]}`;
}

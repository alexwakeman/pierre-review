// The pure half of the Claude Review tab's follow-up and user-story UI: ordering, anchors, the
// draft <-> request mapping and the chip palette. No JSX, so it is unit-tested from `test/`.
//
// ⚠ NOTHING HERE DECIDES A STATUS. Every status comes from the server's reconcile step
// (`packages/pro/src/claude-review/follow-up.ts` / `ticket.ts`), which never invents "addressed";
// this module only orders and paints what it was sent. The caps and the criteria split are NOT
// retyped here either — they live once in `@pierre-review/shared` (`claude-review.ts`).
import {
  checkClaudeReviewTicket,
  CLAUDE_REVIEW_TICKET_LIMITS,
} from '@pierre-review/shared';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpItem,
  ClaudeFollowUpStatus,
  ClaudeReview,
  ClaudeReviewTicket,
  ClaudeReviewTicketCheck,
  ClaudeReviewTicketField,
  ClaudeReviewTicketInput,
  ClaudeTicketAlignment,
  ClaudeTicketCriterionStatus,
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
  blocker: 'bg-red-500/10 text-red-700 dark:text-red-400',
  warning: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  nit: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500',
  question: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  praise: 'bg-green-500/10 text-green-700 dark:text-green-400',
};

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

const CHIP_RED = 'bg-red-500/10 text-red-700 dark:text-red-400';
const CHIP_ORANGE = 'bg-orange-500/10 text-orange-700 dark:text-orange-400';
const CHIP_GREEN = 'bg-green-500/10 text-green-700 dark:text-green-400';
const CHIP_GREY = 'bg-gray-500/10 text-gray-600 dark:text-gray-300';

// ⚠ `not_checked` is GREY, never amber: it is unknown, not "not addressed".
export const FOLLOW_UP_STATUS_CLASS: Record<ClaudeFollowUpStatus, string> = {
  not_addressed: CHIP_RED,
  partly_addressed: CHIP_ORANGE,
  not_checked: CHIP_GREY,
  addressed: CHIP_GREEN,
  no_longer_applies: CHIP_GREY,
};

export const TICKET_CRITERION_STATUS_CLASS: Record<ClaudeTicketCriterionStatus, string> = {
  met: CHIP_GREEN,
  partly_met: CHIP_ORANGE,
  not_met: CHIP_RED,
  unclear: CHIP_GREY,
  not_checked: CHIP_GREY,
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
// partly addressed, then the ones nobody checked. Closed = addressed or no longer applies.
const OPEN_ORDER: Partial<Record<ClaudeFollowUpStatus, number>> = {
  not_addressed: 0,
  partly_addressed: 1,
  not_checked: 2,
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

/** Why an earlier comment carries no verdict. Two different facts, so two sentences. */
export function notCheckedReason(item: Pick<ClaudeFollowUpItem, 'sent'>): string {
  return item.sent
    ? "Claude didn't report on this one."
    : 'Not sent to Claude: too many earlier comments.';
}

export type ReraisedStatus = 'not_addressed' | 'partly_addressed';

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
    if (s === 'not_addressed' || s === 'partly_addressed') out.set(f.id, s);
  }
  return out;
}

export const RERAISED_CHIP: Record<ReraisedStatus, { label: string; cls: string }> = {
  not_addressed: { label: 'Not addressed since last review', cls: CHIP_RED },
  partly_addressed: { label: 'Partly addressed since last review', cls: CHIP_ORANGE },
};

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

// ---- the user story draft ----

// What the three inputs hold, untrimmed (the check trims). Always three strings, so the inputs
// stay controlled.
export interface TicketDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
}

export const EMPTY_TICKET_DRAFT: TicketDraft = { title: '', description: '', acceptanceCriteria: '' };

export function ticketDraftFromStored(ticket: ClaudeReviewTicket | null | undefined): TicketDraft {
  if (!ticket) return EMPTY_TICKET_DRAFT;
  return {
    title: ticket.title ?? '',
    description: ticket.description ?? '',
    acceptanceCriteria: ticket.acceptanceCriteria ?? '',
  };
}

export function ticketDraftHasContent(d: TicketDraft): boolean {
  return d.title.trim() !== '' || d.description.trim() !== '' || d.acceptanceCriteria.trim() !== '';
}

export function checkTicketDraft(d: TicketDraft): ClaudeReviewTicketCheck {
  return checkClaudeReviewTicket(d);
}

/**
 * The request's `ticket`, or undefined when there is nothing to send (all blank) or the draft
 * does not pass the check (the caller refuses to run then). Sends the NORMALISED fields the check
 * produced; the server runs the same check again, and trimming is idempotent.
 */
export function ticketRequestFromCheck(
  check: ClaudeReviewTicketCheck,
): ClaudeReviewTicketInput | undefined {
  if (!check.ok || check.ticket == null) return undefined;
  const t = check.ticket;
  const out: ClaudeReviewTicketInput = {};
  if (t.title != null) out.title = t.title;
  if (t.description != null) out.description = t.description;
  if (t.acceptanceCriteria != null) out.acceptanceCriteria = t.acceptanceCriteria;
  return out;
}

/**
 * What the COLLAPSED panel's header adds, so a closed panel never hides that a user story will be
 * sent — or that one is blocking the run. '' when empty.
 */
export function ticketPanelHint(d: TicketDraft, check: ClaudeReviewTicketCheck): string {
  if (!ticketDraftHasContent(d)) return '';
  if (!check.ok) return ' · needs a fix';
  return ' · added';
}

const FIELD_CAP: Record<ClaudeReviewTicketField, number> = {
  title: CLAUDE_REVIEW_TICKET_LIMITS.titleChars,
  description: CLAUDE_REVIEW_TICKET_LIMITS.descriptionChars,
  acceptanceCriteria: CLAUDE_REVIEW_TICKET_LIMITS.acceptanceCriteriaChars,
};

/**
 * The per-field character counter: shown past 80% of the cap, flagged once over it. Measures the
 * TRIMMED length, exactly what the check measures, so the counter and the 400 never disagree.
 */
export function fieldCounter(
  field: ClaudeReviewTicketField,
  value: string,
): { text: string; over: boolean } | null {
  const cap = FIELD_CAP[field];
  const len = value.trim().length;
  if (len <= cap * 0.8) return null;
  return { text: `${len} / ${cap} characters`, over: len > cap };
}

// ---- the draft store (a per-session convenience) ----

// Survives a tab switch or a PR change within the session, so a half-typed user story is not lost.
// A PR with an entry here was TOUCHED by the reader, and a stored ticket must not overwrite it.
// Bounded: the oldest entry is dropped past the cap.
export const TICKET_DRAFT_CAP = 50;

export function createTicketDraftStore(cap = TICKET_DRAFT_CAP): {
  get: (prId: number) => TicketDraft | undefined;
  set: (prId: number, d: TicketDraft) => void;
  has: (prId: number) => boolean;
} {
  const m = new Map<number, TicketDraft>();
  return {
    get: (prId) => m.get(prId),
    has: (prId) => m.has(prId),
    set: (prId, d) => {
      m.delete(prId);
      m.set(prId, d);
      while (m.size > cap) {
        const oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    },
  };
}

/**
 * The draft to show for a PR: the reader's own (touched) draft when there is one, else the latest
 * run's stored user story, else empty. The stored ticket was written at QUEUE time, so a failed or
 * cancelled run still prefills.
 */
export function resolveTicketDraft(
  own: TicketDraft | undefined,
  latestStored: ClaudeReviewTicket | null | undefined,
): TicketDraft {
  return own ?? ticketDraftFromStored(latestStored);
}

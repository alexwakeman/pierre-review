// USER STORY / TASK — the story half that SURVIVES the split of Claude Review into a PR review and a
// ticket review (review/ticket-review/).
//
// ⚠ THE PR REVIEW NO LONGER JUDGES STORIES. Its prompt carries no "User stories" section, its
// submit schema has no `tickets` field, and a new run writes no `ticket` / `ticket_assessment` /
// story finding. What stays here is:
//   • READING the history — old runs stored their stories + assessments (`ticketEntriesOf`,
//     `cleanStoredAssessment`) and still render in the old layout;
//   • the criteria reconcile (`reconcileTicketAssessment[s]`): Claude reads the acceptance-criteria
//     text and enumerates the criteria itself, best effort — tickets arrive in too many shapes for a
//     code-side split. The server renumbers Claude's list AC1..n in its order, drops rows with no
//     text or an unknown status, caps the list, and keeps ONE 'not_checked' row when criteria text
//     existed but Claude reported none — it never invents 'met'. Everything the model wrote is
//     clipped and sanitised, because it is rendered as plain text in the SPA;
//   • `storyMatchKey`, the "same item across runs" key the ticket review links re-raised items by.
import type {
  ClaudeReviewTicket,
  ClaudeReviewTicketEntry,
  ClaudeTicketAssessment,
  ClaudeTicketCriterionResult,
  ClaudeTicketCriterionStatus,
  ClaudeTicketGap,
  ClaudeFindingStory,
} from '@pierre-review/shared';
import { CLAUDE_REVIEW_TICKET_MAX_CRITERIA, storedList, ticketRef } from '@pierre-review/shared';
import type { ReviewTicketGapReport, ReviewTicketReport } from '../../pro/contract.js';

export const TICKET_SUMMARY_CHARS = 1_000;
export const TICKET_EXPLANATION_CHARS = 1_000;
export const TICKET_GAP_TITLE_CHARS = 200;
export const TICKET_GAP_LIST_MAX = 20;
export const TICKET_PATH_CHARS = 500;

const ALIGNMENTS = new Set(['aligned', 'partly_aligned', 'not_aligned', 'unclear']);
const CRITERION_STATUSES: ReadonlySet<string> = new Set(['met', 'partly_met', 'not_met', 'unclear']);

function clip(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  return t && t.length <= TICKET_PATH_CHARS ? t : null;
}

function cleanLine(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

function gaps(list: ReadonlyArray<ReviewTicketGapReport> | undefined): ClaudeTicketGap[] {
  const out: ClaudeTicketGap[] = [];
  for (const g of list ?? []) {
    if (out.length >= TICKET_GAP_LIST_MAX) break;
    const title = clip(g?.title, TICKET_GAP_TITLE_CHARS);
    if (!title) continue;
    out.push({
      title,
      explanation: clip(g.explanation, TICKET_EXPLANATION_CHARS),
      path: cleanPath(g.path),
      line: cleanLine(g.line),
    });
  }
  return out;
}

/** The ref of the criterion at `index` (0-based). */
export const criterionRef = (index: number): string => `AC${index + 1}`;

export const TICKET_CRITERION_TEXT_CHARS = 500;

export function reconcileTicketAssessment(
  ticket: ClaudeReviewTicket,
  reported: ReviewTicketReport | undefined,
): ClaudeTicketAssessment {
  // Claude enumerates the criteria itself (there is no code-side split). If the ticket carried
  // criteria text and Claude reported none, keep ONE 'not_checked' row holding the pasted text so
  // the gap is visible — the server never invents 'met', and never drops the criteria silently.
  const unchecked = (): ClaudeTicketCriterionResult[] =>
    ticket.acceptanceCriteria
      ? [
          {
            ref: criterionRef(0),
            index: 0,
            text: clip(ticket.acceptanceCriteria, TICKET_CRITERION_TEXT_CHARS) ?? 'Acceptance criteria',
            status: 'not_checked',
            explanation: null,
            path: null,
            line: null,
          },
        ]
      : [];
  if (!reported) {
    return { alignment: 'not_checked', summary: null, criteria: unchecked(), missing: [], notRequested: [] };
  }
  const criteria: ClaudeTicketCriterionResult[] = [];
  if (ticket.acceptanceCriteria) {
    for (const c of reported.criteria ?? []) {
      if (criteria.length >= CLAUDE_REVIEW_TICKET_MAX_CRITERIA) break;
      if (!c || !CRITERION_STATUSES.has(c.status)) continue;
      const text = clip(c.text, TICKET_CRITERION_TEXT_CHARS);
      if (!text) continue;
      const index = criteria.length;
      criteria.push({
        ref: criterionRef(index),
        index,
        text,
        status: c.status as ClaudeTicketCriterionStatus,
        explanation: clip(c.explanation, TICKET_EXPLANATION_CHARS),
        path: cleanPath(c.path),
        line: cleanLine(c.line),
      });
    }
  }
  return {
    alignment: ALIGNMENTS.has(reported.alignment) ? reported.alignment : 'not_checked',
    summary: clip(reported.summary, TICKET_SUMMARY_CHARS),
    criteria: criteria.length > 0 ? criteria : unchecked(),
    missing: gaps(reported.missing),
    notRequested: gaps(reported.notRequested),
  };
}

// ---- several tickets ----

/**
 * One assessment per ticket, index-aligned with `tickets`. The model reports each by `ref`
 * ('T1'…); an unknown or repeated ref is dropped, and a ticket with no report is 'not_checked'.
 * `legacy` is the old single `ticket` report, read as T1 when no `tickets` arrived.
 */
export function reconcileTicketAssessments(
  tickets: readonly ClaudeReviewTicket[],
  reports: ReadonlyArray<ReviewTicketReport> | undefined,
  legacy?: ReviewTicketReport,
): ClaudeTicketAssessment[] {
  const byRef = new Map<string, ReviewTicketReport>();
  for (const r of reports ?? []) {
    const ref = typeof r?.ref === 'string' ? r.ref.trim().toUpperCase() : '';
    if (!ref || byRef.has(ref)) continue;
    byRef.set(ref, r);
  }
  if (byRef.size === 0 && legacy) byRef.set(ticketRef(0), legacy);
  // A lone ticket answered with a missing/odd ref is still that ticket's answer.
  if (tickets.length === 1 && !byRef.has(ticketRef(0)) && (reports?.length ?? 0) === 1) {
    byRef.set(ticketRef(0), reports![0]!);
  }
  return tickets.map((t, i) => reconcileTicketAssessment(t, byRef.get(ticketRef(i))));
}

// A stored assessment as it may sit in the column: rows written while the retired per-ticket
// "Post as comment" existed carry a `posted` record beside it. It is IGNORED on read (stripped,
// never served) — what a story sends to GitHub now is its findings.
type StoredTicketAssessment = ClaudeTicketAssessment & { posted?: unknown };

/** The stored assessment minus anything retired (the old per-ticket `posted` record). */
export function cleanStoredAssessment(a: StoredTicketAssessment): ClaudeTicketAssessment {
  const { posted: _retired, ...rest } = a;
  return rest;
}

/**
 * The stored pair → the wire list. Older runs stored ONE object in each column (read as a
 * one-element list).
 */
export function ticketEntriesOf(
  storedTickets: ClaudeReviewTicket | ClaudeReviewTicket[] | null | undefined,
  storedAssessments: StoredTicketAssessment | StoredTicketAssessment[] | null | undefined,
): ClaudeReviewTicketEntry[] {
  const tickets = storedList(storedTickets);
  const assessments = storedList(storedAssessments);
  return tickets.map((ticket, index) => {
    const a = assessments[index] ?? null;
    return { index, ref: ticketRef(index), ticket, assessment: a ? cleanStoredAssessment(a) : null };
  });
}

// ---- the cross-run item key ----

/**
 * What makes two story items "the same item" across runs — the ticket review links a re-raised item
 * to the earlier one by it (ticket-review/persist.ts `ticketItemMatchKey`). Refs renumber between
 * runs (Claude enumerates the criteria each time), so the key is the KIND (criterion vs not done)
 * and the item's own text, case- and space-folded. null for an ordinary finding.
 */
export function storyMatchKey(f: { title: string; story?: ClaudeFindingStory | null }): string | null {
  if (!f.story) return null;
  const kind = /^M\d+$/.test(f.story.ref) ? 'missing' : 'criterion';
  return `${kind}\u0000${f.title.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

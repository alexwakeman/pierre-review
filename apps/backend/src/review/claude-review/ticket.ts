// USER STORY / TASK (Pro) — reconcile the model's assessment against the STORED ticket.
//
// Claude reads the acceptance-criteria text and enumerates the criteria itself, best effort —
// tickets arrive in too many shapes for a code-side split. The server renumbers Claude's list
// AC1..n in its order, drops rows with no text or an unknown status, caps the list, and keeps ONE
// 'not_checked' row when criteria text existed but Claude reported none — it never invents
// 'met'. Everything the model wrote is clipped and sanitised here, because it is rendered as plain
// text in the SPA.
import type {
  ClaudeReviewTicket,
  ClaudeTicketAssessment,
  ClaudeTicketCriterionResult,
  ClaudeTicketCriterionStatus,
  ClaudeTicketGap,
} from '@pierre-review/shared';
import { CLAUDE_REVIEW_TICKET_MAX_CRITERIA } from '@pierre-review/shared';
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

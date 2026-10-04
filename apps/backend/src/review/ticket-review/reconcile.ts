// TICKET REVIEW — reconcile the model's report against the run's STORED inputs. Ported from the PR
// review's `reconcileTicketAssessment` (claude-review/ticket.ts), with the cross-PR rules on top.
//
// Claude enumerates the criteria itself (tickets arrive in too many shapes for a code-side split);
// the server renumbers them AC1..n, drops rows with no text or an unknown status, caps the list,
// and keeps ONE 'not_checked' row when criteria text existed but Claude reported none. Then:
//
//   • MEMBERS ARE NAMED BY REF ('PR1'…). `deliveredBy`, `evidence` and `expectedIn` keep only refs
//     the prompt handed out; anything else is stripped, never guessed.
//   • A `met` MUST NAME WHO DELIVERS IT. With no member left in `deliveredBy` and no evidence, it is
//     demoted to `unclear` — the server never keeps a "met" nobody can point at. Evidence alone
//     fills `deliveredBy`.
//   • A MEMBER THAT COULD NOT BE CHECKED OUT may deliver anything. While one exists, no criterion
//     may be `not_met` — it reads `unclear` (the prompt says so too; this is the guarantee) — and no
//     missing item becomes a postable item.
//   • Unreported ⇒ `not_checked` (no report at all: alignment `not_checked` and the one row).
//
// Every string is clipped and trimmed here, because the SPA renders it as plain text. The items —
// what can be posted — are derived from the reconciled assessment, deterministically: every
// `not_met` / `partly_met` criterion and every missing item. `owner_pr_id` is the member Claude
// named in `expectedIn`, else null (the reader's PR, at post time).
import {
  CLAUDE_REVIEW_TICKET_MAX_CRITERIA,
  storyMissingRef,
  type ClaudeReviewTicket,
  type ClaudeTicketAlignment,
  type ClaudeTicketCriterionStatus,
  type TicketAssessment,
  type TicketCriterion,
  type TicketEvidence,
  type TicketExpectedIn,
  type TicketMissingItem,
  type TicketNotRequestedItem,
} from '@pierre-review/shared';
import {
  TICKET_CRITERION_TEXT_CHARS,
  TICKET_EXPLANATION_CHARS,
  TICKET_GAP_LIST_MAX,
  TICKET_GAP_TITLE_CHARS,
  TICKET_PATH_CHARS,
  TICKET_SUMMARY_CHARS,
  criterionRef,
} from '../claude-review/ticket.js';
import type { TicketItemWrite } from './persist.js';

/** One member as the prompt named it. */
export interface ReconcileMember {
  ref: string;
  prId: number;
  repoId: number;
  // 'owner/name'
  repo: string;
  // The PR number, so prose can name the PR the way the reader knows it.
  number?: number;
  checkedOut: boolean;
}

// The report as it may arrive: every field optional and untrusted (the tool schema is advisory —
// the server re-checks everything).
export interface TicketReport {
  alignment?: unknown;
  summary?: unknown;
  criteria?: ReadonlyArray<Record<string, unknown> | null | undefined>;
  missing?: ReadonlyArray<Record<string, unknown> | null | undefined>;
  notRequested?: ReadonlyArray<Record<string, unknown> | null | undefined>;
}

const EVIDENCE_MAX = 10;
const ALIGNMENTS: ReadonlySet<string> = new Set(['aligned', 'partly_aligned', 'not_aligned', 'unclear']);
const STATUSES: ReadonlySet<string> = new Set(['met', 'partly_met', 'not_met', 'unclear']);

function clip(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const t = p.trim().replace(/^\.\//, '');
  return t && t.length <= TICKET_PATH_CHARS && !t.includes('\u0000') ? t : null;
}

function cleanLine(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The prompt names members by ref (PR1, PR2, …) so the server can verify citations; the reader
 * knows them as name#number. Rewrites every ref in the model's prose that names a member.
 */
export function namePrRefs(text: string | null, members: readonly ReconcileMember[]): string | null {
  if (text == null) return null;
  const byRef = new Map(members.map((m) => [m.ref.toUpperCase(), m]));
  return text.replace(/\bPR\s?(\d+)\b/gi, (whole, n: string) => {
    const m = byRef.get(`PR${n}`);
    if (m?.number == null) return whole;
    return `${m.repo.split('/').pop() ?? m.repo}#${m.number}`;
  });
}

/** Ref → member, case- and space-folded ('pr 2' and 'PR2' are the same ref). */
function memberIndex(members: readonly ReconcileMember[]): (ref: unknown) => ReconcileMember | null {
  const byRef = new Map(members.map((m) => [m.ref.toUpperCase(), m]));
  return (ref) => (typeof ref === 'string' ? (byRef.get(ref.replace(/\s+/g, '').toUpperCase()) ?? null) : null);
}

function expectedInOf(
  raw: unknown,
  member: (ref: unknown) => ReconcileMember | null,
  members: readonly ReconcileMember[],
): TicketExpectedIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const m = member(r.pr);
  if (m) return { prId: m.prId, repoId: m.repoId };
  if (typeof r.repo === 'string') {
    const name = r.repo.trim().toLowerCase();
    const inRepo = members.find((x) => x.repo.toLowerCase() === name);
    if (inRepo) return { prId: null, repoId: inRepo.repoId };
  }
  return null;
}

export interface ReconciledTicketReview {
  assessment: TicketAssessment;
  items: TicketItemWrite[];
}

export function reconcileTicketReview(
  ticket: Pick<ClaudeReviewTicket, 'acceptanceCriteria'>,
  members: readonly ReconcileMember[],
  reported: TicketReport | null | undefined,
): ReconciledTicketReview {
  const member = memberIndex(members);
  const anyUnchecked = members.some((m) => !m.checkedOut);
  const unchecked = (): TicketCriterion[] =>
    ticket.acceptanceCriteria
      ? [
          {
            ref: criterionRef(0),
            index: 0,
            text: clip(ticket.acceptanceCriteria, TICKET_CRITERION_TEXT_CHARS) ?? 'Acceptance criteria',
            status: 'not_checked',
            explanation: null,
            deliveredBy: [],
            evidence: [],
            expectedIn: null,
          },
        ]
      : [];

  if (!reported) {
    const assessment: TicketAssessment = {
      alignment: 'not_checked',
      summary: null,
      criteria: unchecked(),
      missing: [],
      notRequested: [],
    };
    return { assessment, items: [] };
  }

  // Path + line pinned to ONE member: a path the model gave with no member to place it in is
  // meaningless in a multi-repo review and is dropped.
  const where = (r: Record<string, unknown>, prId: number | null): { path: string | null; line: number | null } => {
    const path = prId != null ? cleanPath(r.path) : null;
    return { path, line: path ? cleanLine(r.line) : null };
  };

  const criteria: TicketCriterion[] = [];
  const criterionWhere: Array<{ path: string | null; line: number | null }> = [];
  if (ticket.acceptanceCriteria) {
    for (const c of reported.criteria ?? []) {
      if (criteria.length >= CLAUDE_REVIEW_TICKET_MAX_CRITERIA) break;
      if (!c || typeof c.status !== 'string' || !STATUSES.has(c.status)) continue;
      const text = clip(c.text, TICKET_CRITERION_TEXT_CHARS);
      if (!text) continue;

      const evidence: TicketEvidence[] = [];
      for (const e of Array.isArray(c.evidence) ? (c.evidence as unknown[]) : []) {
        if (evidence.length >= EVIDENCE_MAX) break;
        if (!e || typeof e !== 'object') continue;
        const er = e as Record<string, unknown>;
        const m = member(er.pr);
        const path = cleanPath(er.path);
        if (!m || !path) continue;
        evidence.push({ prId: m.prId, path, line: cleanLine(er.line) });
      }
      const delivered = new Set<number>();
      for (const ref of Array.isArray(c.deliveredBy) ? (c.deliveredBy as unknown[]) : []) {
        const m = member(ref);
        if (m) delivered.add(m.prId);
      }
      for (const e of evidence) delivered.add(e.prId);

      let status = c.status as ClaudeTicketCriterionStatus;
      // A "met" nobody can point at is not a met.
      if (status === 'met' && delivered.size === 0) status = 'unclear';
      // An unread member may be the one that delivers it.
      if (status === 'not_met' && anyUnchecked) status = 'unclear';

      const expectedIn =
        status === 'not_met' || status === 'partly_met' || status === 'unclear'
          ? expectedInOf(c.expectedIn, member, members)
          : null;
      const index = criteria.length;
      criteria.push({
        ref: criterionRef(index),
        index,
        text,
        status,
        explanation: namePrRefs(clip(c.explanation, TICKET_EXPLANATION_CHARS), members),
        deliveredBy: members.map((m) => m.prId).filter((id) => delivered.has(id)),
        evidence,
        expectedIn,
      });
      criterionWhere.push(where(c, expectedIn?.prId ?? null));
    }
  }

  const missing: TicketMissingItem[] = [];
  const missingWhere: Array<{ path: string | null; line: number | null }> = [];
  for (const g of reported.missing ?? []) {
    if (missing.length >= TICKET_GAP_LIST_MAX) break;
    if (!g) continue;
    const title = namePrRefs(clip(g.title, TICKET_GAP_TITLE_CHARS), members);
    if (!title) continue;
    const expectedIn = expectedInOf(g.expectedIn, member, members);
    missing.push({
      ref: storyMissingRef(missing.length),
      title,
      explanation: namePrRefs(clip(g.explanation, TICKET_EXPLANATION_CHARS), members),
      expectedIn,
    });
    missingWhere.push(where(g, expectedIn?.prId ?? null));
  }

  const notRequested: TicketNotRequestedItem[] = [];
  for (const g of reported.notRequested ?? []) {
    if (notRequested.length >= TICKET_GAP_LIST_MAX) break;
    if (!g) continue;
    const title = namePrRefs(clip(g.title, TICKET_GAP_TITLE_CHARS), members);
    if (!title) continue;
    const m = member(g.pr);
    const w = where(g, m?.prId ?? null);
    notRequested.push({
      title,
      explanation: namePrRefs(clip(g.explanation, TICKET_EXPLANATION_CHARS), members),
      prId: m?.prId ?? null,
      path: w.path,
      line: w.line,
    });
  }

  const alignment: ClaudeTicketAlignment =
    typeof reported.alignment === 'string' && ALIGNMENTS.has(reported.alignment)
      ? (reported.alignment as ClaudeTicketAlignment)
      : 'not_checked';
  const assessment: TicketAssessment = {
    alignment,
    summary: namePrRefs(clip(reported.summary, TICKET_SUMMARY_CHARS), members),
    criteria: criteria.length > 0 ? criteria : unchecked(),
    missing,
    notRequested,
  };

  const items: TicketItemWrite[] = [];
  criteria.forEach((c, i) => {
    if (c.status !== 'not_met' && c.status !== 'partly_met') return;
    items.push({
      ref: c.ref,
      status: c.status,
      title: c.text,
      body: c.explanation ?? '',
      ownerPrId: c.expectedIn?.prId ?? null,
      ...criterionWhere[i]!,
    });
  });
  // ⚠ A missing item says NO member delivers something. While a member could not be read, that is
  // not known — the item stays in the assessment for the reader, but is never postable or seeded
  // into a fix (the same guard as `not_met` → `unclear` above).
  if (!anyUnchecked) missing.forEach((g, i) => {
    items.push({
      ref: g.ref,
      status: 'missing',
      title: g.title,
      body: g.explanation ?? '',
      ownerPrId: g.expectedIn?.prId ?? null,
      ...missingWhere[i]!,
    });
  });
  return { assessment, items };
}

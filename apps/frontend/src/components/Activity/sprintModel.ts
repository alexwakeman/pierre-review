import {
  SPRINT_CHIPS,
  SPRINT_PROVIDER_LABEL,
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_TEXT_MAX,
  proposedCriteriaMarkdown,
  sprintCommentMarkdown,
  type SprintAssessmentPhase,
  type SprintAssessmentRecord,
  type SprintAssessmentStatus,
  type SprintChip,
  type SprintPhase,
  type SprintReplaceTarget,
  type SprintTicketRow,
  type SprintWriteMode,
  type SprintWriteRecord,
} from '@pierre-review/shared';
import { chipFixesMarkdown } from '../../lib/copy.js';

// Reports → This sprint: the pure folds behind the tab (test/sprintModel.test.ts).
//
// ⚠ THE ORDER IS THE SERVER'S (Not started, then In progress; most flags first; then key). The
// grouping here keeps it; nothing re-ranks, and nothing ever sorts by assignee.

/** The two groups in the server's order, each keeping the server's order inside it. */
export function groupSprintTickets(tickets: readonly SprintTicketRow[]): Array<{ phase: SprintPhase; tickets: SprintTicketRow[] }> {
  const groups: Array<{ phase: SprintPhase; tickets: SprintTicketRow[] }> = [
    { phase: 'not_started', tickets: [] },
    { phase: 'in_progress', tickets: [] },
  ];
  for (const t of tickets) groups[t.phase === 'not_started' ? 0 : 1]!.tickets.push(t);
  return groups.filter((g) => g.tickets.length > 0);
}

/** Code chips first, then label chips — the card shows them as two styles. */
export function splitChips(chips: readonly SprintChip[]): { code: SprintChip[]; label: SprintChip[] } {
  return {
    code: chips.filter((c) => SPRINT_CHIPS[c.id].source === 'code'),
    label: chips.filter((c) => SPRINT_CHIPS[c.id].source === 'label'),
  };
}

export function assessmentActive(status: SprintAssessmentStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

/** The progress line under a running assessment. */
export function assessmentProgressLine(status: SprintAssessmentStatus, phase: SprintAssessmentPhase | null): string {
  if (status === 'queued') return 'Waiting for a free slot…';
  switch (phase) {
    case 'checking_out':
      return 'Checking out the repos…';
    case 'writing':
      return 'Writing the assessment…';
    case 'reading':
    default:
      return 'Reading the code…';
  }
}

/** The assess button's word, or null when no button belongs there (a current assessment, or one in
 *  flight). */
export function assessButtonLabel(t: Pick<SprintTicketRow, 'assessment'>): 'Assess with code' | 'Re-assess' | null {
  const a = t.assessment;
  if (a == null) return 'Assess with code';
  if (assessmentActive(a.record.status)) return null;
  if (a.record.status === 'succeeded') return a.currency === 'stale' ? 'Re-assess' : null;
  return 'Assess with code';
}

/** The latest SUCCEEDED assessment body, or null. */
export function assessmentBody(t: Pick<SprintTicketRow, 'assessment'>): SprintAssessmentRecord['body'] {
  const r = t.assessment?.record;
  return r != null && r.status === 'succeeded' ? r.body : null;
}

// ── The update panel ─────────────────────────────────────────────────────────────────────────────

/** The text "Replace" overwrites: the criteria field or the description, by the ONE rule. */
export function currentTextFor(t: Pick<SprintTicketRow, 'acceptanceCriteria' | 'description'>, target: SprintReplaceTarget): string {
  return target.kind === 'ac_field' ? t.acceptanceCriteria : t.description;
}

/** The radio's words for "Replace". */
export function replaceModeLabel(target: SprintReplaceTarget): string {
  return target.kind === 'ac_field' ? `Replace ${target.fieldName}` : 'Replace description';
}

/** What the confirm dialog says will happen, naming the ticket. */
export function writeTargetSentence(key: string, mode: SprintWriteMode, target: SprintReplaceTarget): string {
  if (mode === 'comment') return `Adds a comment to ${key}.`;
  return target.kind === 'ac_field' ? `Replaces ${target.fieldName} on ${key}.` : `Replaces the description of ${key}.`;
}

export function updateButtonLabel(t: Pick<SprintTicketRow, 'provider'>): string {
  return `Update in ${SPRINT_PROVIDER_LABEL[t.provider]}`;
}

const AC_PHRASE_RE = /acceptance\s+criteria/i;
const HEADING_RE = /^(?:#{1,6}\s|h[1-6]\.\s)/i;
const LABEL_ONLY_RE = /^(?:\*\*|__|\*|_)?\s*(?:acceptance\s+criteria|a\/?cs?)\s*:?\s*(?:\*\*|__|\*|_)?\s*:?$/i;
const BOLD_LINE_RE = /^(?:\*\*[^*]+\*\*|\*[^*\s][^*]*\*|__[^_]+__)\s*:?$/;
const BULLET_RE = /^(?:[-+*•#]+|\d+[.)])\s+\S/;

/**
 * The description with its "Acceptance criteria" section's body replaced by `criteria` — the same
 * heading rule the server's criteria reader uses (a heading, a label-only line, or a bold line naming
 * acceptance criteria, up to the next heading). No such section → one is appended.
 */
export function replaceCriteriaSection(description: string, criteria: string): string {
  const lines = description.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return AC_PHRASE_RE.test(t) && (HEADING_RE.test(t) || LABEL_ONLY_RE.test(t) || BOLD_LINE_RE.test(t));
  });
  if (start < 0) {
    const body = description.trimEnd();
    return `${body}${body === '' ? '' : '\n\n'}## Acceptance criteria\n\n${criteria}`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    if (t === '') continue;
    if (HEADING_RE.test(t) || BOLD_LINE_RE.test(t) || (/:$/.test(t) && t.length <= 60 && !BULLET_RE.test(t))) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${criteria}${after === '' ? '' : `\n\n${after}`}`;
}

/** The right-hand side's starting text for a mode: from the latest succeeded assessment when there
 *  is one, else from the chips' fixes (comment) or the current text (replace). */
export function proposedDefault(t: SprintTicketRow, mode: SprintWriteMode): string {
  const body = assessmentBody(t);
  if (mode === 'comment') {
    if (body != null) return sprintCommentMarkdown(t.criteria.items, body);
    return chipFixesMarkdown(t);
  }
  const current = currentTextFor(t, t.replaceTarget);
  if (body == null) return current;
  const list = proposedCriteriaMarkdown(t.criteria.items, body.suggestion);
  return t.replaceTarget.kind === 'ac_field' ? list : replaceCriteriaSection(current, list);
}

/** null when the text may be sent; else the one line saying why not. Mirrors the server's check. */
export function writeTextProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Nothing to write.';
  if (t.length > SPRINT_WRITE_TEXT_MAX) return `Too long: ${t.length.toLocaleString()} of ${SPRINT_WRITE_TEXT_MAX.toLocaleString()} characters.`;
  return null;
}

/** A fresh claim key per confirm dialog (matches `SPRINT_WRITE_REQUEST_ID_RE`). */
export function newWriteRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c != null && typeof c.randomUUID === 'function') return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** The line a ticket shows for its latest write. */
export function writeRecordLine(w: SprintWriteRecord, provider: SprintTicketRow['provider']): {
  tone: 'ok' | 'bad' | 'warn' | 'busy';
  text: string;
} {
  switch (w.status) {
    case 'written':
      return { tone: 'ok', text: w.mode === 'comment' ? `Comment added in ${SPRINT_PROVIDER_LABEL[provider]}.` : `Updated in ${SPRINT_PROVIDER_LABEL[provider]}.` };
    case 'writing':
      return { tone: 'busy', text: 'Writing…' };
    case 'maybe_written':
      return { tone: 'warn', text: w.message ?? SPRINT_WRITE_MAYBE_SENTENCE };
    case 'failed':
      return { tone: 'bad', text: w.message ?? 'The update failed.' };
  }
}

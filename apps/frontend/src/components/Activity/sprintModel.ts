import {
  SPRINT_PROVIDER_LABEL,
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_TEXT_MAX,
  criteriaListMarkdown,
  sprintBullets,
  sprintCurrentAssessmentBodyOf,
  sprintCommentMarkdown,
  type SprintAssessmentPhase,
  type SprintAssessmentStatus,
  type SprintChecks,
  type SprintPhase,
  type SprintReplaceTarget,
  type SprintTicketRow,
  type SprintWriteMode,
  type SprintWriteRecord,
} from '@pierre-review/shared';

// Reports → This sprint: the pure folds behind the tab (test/sprintModel.test.ts).
//
// ⚠ THE ORDER IS THE SERVER'S (Not started, then In progress; most issues first; then key). The
// grouping here keeps it; nothing re-ranks, and nothing ever sorts by assignee.
// ⚠ THE ISSUES AND THEIR BULLETS ARE SHARED FOLDS (`story-issues.ts`, `sprintBullets`) — nothing here
// re-derives an issue or re-words a bullet.

/** The two groups in the server's order, each keeping the server's order inside it. */
export function groupSprintTickets(tickets: readonly SprintTicketRow[]): Array<{ phase: SprintPhase; tickets: SprintTicketRow[] }> {
  const groups: Array<{ phase: SprintPhase; tickets: SprintTicketRow[] }> = [
    { phase: 'not_started', tickets: [] },
    { phase: 'in_progress', tickets: [] },
  ];
  for (const t of tickets) groups[t.phase === 'not_started' ? 0 : 1]!.tickets.push(t);
  return groups.filter((g) => g.tickets.length > 0);
}

/** How many checks differ from the default — the header's disclosure: each issue switched off, plus
 *  one for a limited issue-type list. */
export function changedCheckCount(c: SprintChecks): number {
  return c.off.length + (c.issueTypes.length > 0 ? 1 : 0);
}

/** The issue-type choices in the Checks panel: this sprint's types plus any saved ones (so saving
 *  never drops a stored type silently), de-duplicated case-insensitively, sorted. */
export function checkTypeChoices(sprintTypes: readonly string[], saved: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of [...sprintTypes, ...saved]) {
    const k = t.trim().toLowerCase();
    if (k !== '' && !seen.has(k)) seen.set(k, t.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Toggle one type in a saved list (case-insensitive match). */
export function toggleCheckType(list: readonly string[], type: string): string[] {
  const k = type.trim().toLowerCase();
  return list.some((x) => x.trim().toLowerCase() === k) ? list.filter((x) => x.trim().toLowerCase() !== k) : [...list, type];
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
 *  flight). An outdated-format run offers a fresh check, not "again". */
export function assessButtonLabel(t: Pick<SprintTicketRow, 'assessment'>): 'Check against code' | 'Check again' | null {
  const a = t.assessment;
  if (a == null) return 'Check against code';
  if (assessmentActive(a.record.status)) return null;
  if (a.record.status === 'succeeded') {
    if (a.record.outdated) return 'Check against code';
    return a.currency === 'stale' ? 'Check again' : null;
  }
  return 'Check against code';
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

/** The right-hand side's starting text for a mode. Comment: the summary (current assessment only), one bullet
 *  per issue and any revised criteria. Replace: the revised criteria when the assessment proposed
 *  some (the list alone for a criteria field; the description with its criteria section swapped),
 *  else the current text. */
export function proposedDefault(t: SprintTicketRow, mode: SprintWriteMode, checks: SprintChecks): string {
  const body = sprintCurrentAssessmentBodyOf(t);
  if (mode === 'comment') return sprintCommentMarkdown(sprintBullets(t, checks), body);
  const current = currentTextFor(t, t.replaceTarget);
  if (body == null || body.revisedCriteria.length === 0) return current;
  const list = criteriaListMarkdown(body.revisedCriteria);
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

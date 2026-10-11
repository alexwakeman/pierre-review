import {
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_IN_PROGRESS_HEADING,
  SPRINT_STAGE_LABEL,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_PROVIDER_LABEL,
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_TEXT_MAX,
  criteriaListMarkdown,
  sprintBullets,
  sprintCurrentAssessmentBodyOf,
  sprintCommentMarkdown,
  sprintSpecGapLines,
  type SprintAssessmentPhase,
  type SprintAssessmentStatus,
  type SprintChecks,
  type SprintStage,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusLayoutEntry,
  type SprintStatusSettings,
  type SprintReplaceTarget,
  type SprintTicketRow,
  type SprintWriteMode,
  type SprintWriteRecord,
} from '@pierre-review/shared';

// Reports → This sprint: the pure folds behind the tab (test/sprintModel.test.ts).
//
// ⚠ THE ORDER IS THE SERVER'S (stage, then status section in the layout's order, then most issues,
// then key). The sections here keep it; nothing re-ranks, and nothing ever sorts by assignee.
// ⚠ THE ISSUES AND THEIR BULLETS ARE SHARED FOLDS (`story-issues.ts`, `sprintBullets`) — nothing here
// re-derives an issue or re-words a bullet.

// ── Sections by status ─────────────────────────────────────────────────────────────────────────

/** One status section inside a stage. `status` is null for Not started (one section; each card shows
 *  its own status). */
export interface SprintSection {
  status: string | null;
  tickets: SprintTicketRow[];
}

export interface SprintStageGroup {
  stage: Exclude<SprintStage, 'done'>;
  heading: string;
  sections: SprintSection[];
}

const normStatus = (s: string): string => s.trim().toLowerCase();

/**
 * THE SECTIONS: Not started (one section), then the in-progress statuses before "code delivered"
 * ("Writing code", or "In progress" when nothing splits), then "Code delivered" — one section per
 * status, in the LAYOUT's order, only non-empty ones. Each section keeps the server's order (most
 * issues first). The stage is the row's own (`stage`, the server's `sprintStageOf`) — never re-derived
 * here. A status the layout does not list sits after the listed ones, in first-seen order. Done rows
 * are never listed.
 */
export function sprintSections(
  tickets: readonly SprintTicketRow[],
  layout: Pick<SprintStatusLayout, 'order' | 'deliveredFrom'> | null,
): SprintStageGroup[] {
  const order = layout?.order ?? [];
  const rank = new Map(order.map((o, i) => [normStatus(o.name), i]));
  const notStarted: SprintTicketRow[] = [];
  const byStage: Record<'writing' | 'delivered', Map<string, SprintSection>> = { writing: new Map(), delivered: new Map() };
  for (const t of tickets) {
    if (t.stage === 'done') continue;
    if (t.stage === 'not_started') {
      notStarted.push(t);
      continue;
    }
    const name = t.status?.name.trim() ?? '';
    const k = normStatus(name);
    const m = byStage[t.stage];
    const sec = m.get(k) ?? { status: name === '' ? null : name, tickets: [] };
    sec.tickets.push(t);
    m.set(k, sec);
  }
  const ordered = (m: Map<string, SprintSection>): SprintSection[] => {
    const firstSeen = [...m.keys()];
    return [...m.entries()]
      .sort(
        (a, b) =>
          (rank.get(a[0]) ?? order.length + firstSeen.indexOf(a[0])) -
          (rank.get(b[0]) ?? order.length + firstSeen.indexOf(b[0])),
      )
      .map(([, sec]) => sec);
  };
  const out: SprintStageGroup[] = [];
  if (notStarted.length > 0) {
    out.push({ stage: 'not_started', heading: SPRINT_STAGE_LABEL.not_started, sections: [{ status: null, tickets: notStarted }] });
  }
  const writing = ordered(byStage.writing);
  if (writing.length > 0) {
    out.push({
      stage: 'writing',
      heading: layout?.deliveredFrom == null ? SPRINT_IN_PROGRESS_HEADING : SPRINT_STAGE_LABEL.writing,
      sections: writing,
    });
  }
  const delivered = ordered(byStage.delivered);
  if (delivered.length > 0) out.push({ stage: 'delivered', heading: SPRINT_STAGE_LABEL.delivered, sections: delivered });
  return out;
}

// ── The status settings ──────────────────────────────────────────────────────────────────────────

/** Can this status be the "code delivered from" point? Only in-progress (or unknown-category) ones. */
export function statusSplittable(e: Pick<SprintStatusLayoutEntry, 'category'>): boolean {
  return e.category !== 'new' && e.category !== 'done';
}

const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
const categoryRank = (c: string | null | undefined): number => (c == null ? 1 : (CATEGORY_RANK[c] ?? 1));

/** Can this entry move one step up (-1) or down (+1)? Not past either end, and never past a status of
 *  another category: the server keeps the categories in order (not started, in progress, done), so
 *  such a move would snap back on Save. `categoryOf` absent → ends only. */
export function canMoveStatus(
  names: readonly string[],
  index: number,
  dir: -1 | 1,
  categoryOf?: (name: string) => string | null | undefined,
): boolean {
  const to = index + dir;
  if (index < 0 || index >= names.length || to < 0 || to >= names.length) return false;
  if (categoryOf == null) return true;
  return categoryRank(categoryOf(names[index]!)) === categoryRank(categoryOf(names[to]!));
}

/** Move one entry up (-1) or down (+1); a move `canMoveStatus` refuses returns the list unchanged. */
export function moveStatus(
  names: readonly string[],
  index: number,
  dir: -1 | 1,
  categoryOf?: (name: string) => string | null | undefined,
): string[] {
  const to = index + dir;
  if (!canMoveStatus(names, index, dir, categoryOf)) return [...names];
  const out = [...names];
  const [x] = out.splice(index, 1);
  out.splice(to, 0, x!);
  return out;
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => normStatus(x) === normStatus(b[i]!));

/**
 * What Save sends. ORDER: unchanged from what was shown → the stored override as it was (null when
 * there is none); moved → every name, in the new order. DELIVERED FROM: untouched → the stored value as
 * it was; picked → the name, or null when the pick is the automatic answer (so it keeps following the
 * evidence).
 */
export function statusSettingsToSave(
  layout: Pick<SprintStatusLayout, 'order' | 'deliveredFromAuto' | 'settings'>,
  draft: { order: readonly string[]; deliveredFrom: string | null; deliveredTouched: boolean },
): SprintStatusSettings {
  const shown = layout.order.map((o) => o.name);
  // Capped at the route's limit: a status past it keeps its automatic position anyway.
  const order = sameNames(shown, draft.order) ? layout.settings.order : draft.order.slice(0, SPRINT_STATUS_ORDER_MAX);
  let deliveredFrom = layout.settings.deliveredFrom;
  if (draft.deliveredTouched) {
    deliveredFrom =
      draft.deliveredFrom == null ||
      (layout.deliveredFromAuto != null && normStatus(draft.deliveredFrom) === normStatus(layout.deliveredFromAuto))
        ? null
        : draft.deliveredFrom;
  }
  return { order, deliveredFrom };
}

/** Where the order came from, in words. `inSentence` → the mid-sentence form (proper nouns keep
 *  their capitals; never lower-case the whole label). */
export function statusOrderSourceLabel(
  source: SprintStatusLayout['orderSource'],
  opts: { inSentence?: boolean } = {},
): string {
  if (opts.inSentence) {
    switch (source) {
      case 'override':
        return 'your order';
      case 'jira_board':
        return 'your board’s columns';
      case 'linear_states':
        return 'Linear’s workflow';
      case 'github':
        return 'open, then closed';
      case 'fallback':
        return 'status category, then name';
    }
  }
  switch (source) {
    case 'override':
      return 'Your order';
    case 'jira_board':
      return 'Your board’s columns';
    case 'linear_states':
      return 'Linear’s workflow';
    case 'github':
      return 'Open, then closed';
    case 'fallback':
      return 'Status category, then name';
  }
}

/** A share as "3 in 5" (smallest denominator up to 10 that states it exactly), else a percentage. */
export function shareWords(share: number): string {
  for (let d = 2; d <= 10; d += 1) {
    const n = share * d;
    if (Math.abs(n - Math.round(n)) < 1e-9) return `${Math.round(n)} in ${d}`;
  }
  return `${Math.round(share * 100)}%`;
}

/** The automatic "code delivered from" rule, read from the shared constants. */
export function deliveredRuleSentence(): string {
  return `The first in-progress status where at least ${shareWords(SPRINT_DELIVERED_MIN_SHARE)} tickets with pull requests have them all merged, and at least ${SPRINT_DELIVERED_MIN_TICKETS} do.`;
}

/** "Ready for QA · 4 of 6 merged". */
export function statusEvidenceLine(e: SprintStatusEvidence): string {
  return `${e.status} · ${e.allMerged} of ${e.withPrs} merged`;
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
 *  per issue, the spec gaps and any revised criteria. Replace: the revised criteria when the assessment proposed
 *  some (the list alone for a criteria field; the description with its criteria section swapped),
 *  else the current text. */
export function proposedDefault(t: SprintTicketRow, mode: SprintWriteMode, checks: SprintChecks): string {
  const body = sprintCurrentAssessmentBodyOf(t);
  if (mode === 'comment') return sprintCommentMarkdown(sprintBullets(t, checks), body, sprintSpecGapLines(t, checks));
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

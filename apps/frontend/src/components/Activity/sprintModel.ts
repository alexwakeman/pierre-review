import {
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_STAGES,
  SPRINT_STAGE_LABEL,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_PROVIDER_LABEL,
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_TEXT_MAX,
  criteriaListMarkdown,
  type SprintAssessmentPhase,
  type SprintAssessmentStatus,
  type SprintAssessMode,
  type SprintChecks,
  type SprintFinding,
  type SprintRepoRef,
  type StoryIssueId,
  type SprintStage,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusSettings,
  type SprintReplaceTarget,
  type SprintTicketRow,
  type SprintRelatedTicket,
  type TicketSite,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type SprintWriteRecord,
} from '@pierre-review/shared';
import type { TicketLinkOptions } from '../../lib/ticketLinks.js';

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
  stage: SprintStage;
  heading: string;
  sections: SprintSection[];
}

const normStatus = (s: string): string => s.trim().toLowerCase();

/**
 * THE SECTIONS: the four stages in order — Not started (one section), In progress, In review, Done —
 * the last three with one section per status, in the LAYOUT's order, only non-empty ones. Each
 * section keeps the server's order (most issues first). The stage is the row's own (`stage`, the
 * server's `sprintStageOf`) — never re-derived here. A status the layout does not list sits after the
 * listed ones, in first-seen order.
 */
export function sprintSections(
  tickets: readonly SprintTicketRow[],
  layout: Pick<SprintStatusLayout, 'order'> | null,
): SprintStageGroup[] {
  const order = layout?.order ?? [];
  const rank = new Map(order.map((o, i) => [normStatus(o.name), i]));
  const notStarted: SprintTicketRow[] = [];
  const byStage = new Map<SprintStage, Map<string, SprintSection>>(SPRINT_STAGES.map((k) => [k, new Map()]));
  for (const t of tickets) {
    if (t.stage === 'not_started') {
      notStarted.push(t);
      continue;
    }
    const name = t.status?.name.trim() ?? '';
    const k = normStatus(name);
    const m = byStage.get(t.stage)!;
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
  for (const stage of SPRINT_STAGES) {
    const sections = stage === 'not_started' ? (notStarted.length > 0 ? [{ status: null, tickets: notStarted }] : []) : ordered(byStage.get(stage)!);
    if (sections.length > 0) out.push({ stage, heading: SPRINT_STAGE_LABEL[stage], sections });
  }
  return out;
}

// ── The status settings ──────────────────────────────────────────────────────────────────────────

/** The draft: every status, per stage, in order. */
export type StatusSectionsDraft = Record<SprintStage, string[]>;

/** The layout as a draft (its resolved placement). */
export function statusSectionsOf(layout: Pick<SprintStatusLayout, 'order'>): StatusSectionsDraft {
  const out: StatusSectionsDraft = { not_started: [], in_progress: [], in_review: [], done: [] };
  for (const o of layout.order) out[o.stage].push(o.name);
  return out;
}

/** Move one status one step up (-1) or down (+1), crossing into the neighbouring stage at either end
 *  of its list (it lands last / first there). Off either end of the whole list → unchanged. */
export function moveInSections(draft: StatusSectionsDraft, stage: SprintStage, index: number, dir: -1 | 1): StatusSectionsDraft {
  const out: StatusSectionsDraft = { not_started: [...draft.not_started], in_progress: [...draft.in_progress], in_review: [...draft.in_review], done: [...draft.done] };
  const list = out[stage];
  if (index < 0 || index >= list.length) return out;
  const to = index + dir;
  if (to >= 0 && to < list.length) {
    const [x] = list.splice(index, 1);
    list.splice(to, 0, x!);
    return out;
  }
  const si = SPRINT_STAGES.indexOf(stage) + dir;
  const next = SPRINT_STAGES[si];
  if (next == null) return out;
  const [x] = list.splice(index, 1);
  if (dir < 0) out[next].push(x!);
  else out[next].unshift(x!);
  return out;
}

/**
 * THE DRAG MOVE: take the status at `from` and insert it at SLOT `toIndex` of `toStage`'s list — a slot
 * counted over that list AS SHOWN, before the move (0 = above its first row, `length` = below its
 * last). Within one list a slot just above or below the row itself is a no-op. Bad indexes → unchanged
 * (a copy).
 */
export function moveStatusTo(
  draft: StatusSectionsDraft,
  from: { stage: SprintStage; index: number },
  toStage: SprintStage,
  toIndex: number,
): StatusSectionsDraft {
  const out: StatusSectionsDraft = { not_started: [...draft.not_started], in_progress: [...draft.in_progress], in_review: [...draft.in_review], done: [...draft.done] };
  const src = out[from.stage];
  if (from.index < 0 || from.index >= src.length) return out;
  const dst = out[toStage];
  if (toIndex < 0 || toIndex > dst.length) return out;
  const [x] = src.splice(from.index, 1);
  const at = toStage === from.stage && toIndex > from.index ? toIndex - 1 : toIndex;
  dst.splice(at, 0, x!);
  return out;
}

/** Where a status sits: its stage and index, or null when the draft does not list it. */
export function statusPlaceOf(draft: StatusSectionsDraft, name: string): { stage: SprintStage; index: number } | null {
  for (const stage of SPRINT_STAGES) {
    const index = draft[stage].indexOf(name);
    if (index >= 0) return { stage, index };
  }
  return null;
}

/** "Coding begins" / "Coding ends", read off the DRAFT by the server's rule: the first status of In
 *  progress, and the first of In review (null when that stage is empty). */
export function codingBoundsOf(draft: StatusSectionsDraft): { begins: string | null; ends: string | null } {
  return { begins: draft.in_progress[0] ?? null, ends: draft.in_review[0] ?? null };
}

/** Did the reader change anything from what was shown? (Save is offered only then.) */
export function statusDraftChanged(layout: Pick<SprintStatusLayout, 'order'>, draft: StatusSectionsDraft): boolean {
  return !sameDraft(statusSectionsOf(layout), draft);
}

/** Can that move happen at all? */
export function canMoveInSections(draft: StatusSectionsDraft, stage: SprintStage, index: number, dir: -1 | 1): boolean {
  const flat = SPRINT_STAGES.flatMap((k) => draft[k].map((n) => [k, n] as const));
  const at = flat.findIndex(([k, n]) => k === stage && n === draft[stage][index]);
  return at >= 0 && (dir < 0 ? !(at === 0 && stage === 'not_started') : !(at === flat.length - 1 && stage === 'done'));
}

const sameDraft = (a: StatusSectionsDraft, b: StatusSectionsDraft): boolean =>
  SPRINT_STAGES.every((k) => a[k].length === b[k].length && a[k].every((x, i) => normStatus(x) === normStatus(b[k][i]!)));

/** What Save sends: unchanged from what was shown → the stored override as it was; changed → every
 *  name in its stage, in order (capped at the route's limit overall). */
export function statusSettingsToSave(
  layout: Pick<SprintStatusLayout, 'order' | 'settings'>,
  draft: StatusSectionsDraft,
): SprintStatusSettings {
  if (sameDraft(statusSectionsOf(layout), draft)) return layout.settings;
  let room = SPRINT_STATUS_ORDER_MAX;
  const sections: StatusSectionsDraft = { not_started: [], in_progress: [], in_review: [], done: [] };
  for (const k of SPRINT_STAGES) {
    sections[k] = draft[k].slice(0, Math.max(0, room));
    room -= sections[k].length;
  }
  return { sections };
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

/** The automatic "In review starts at" rule, read from the shared constants. */
export function reviewRuleSentence(): string {
  return `In review starts at a status whose name reads as review or QA, or the first in-progress status where at least ${shareWords(SPRINT_DELIVERED_MIN_SHARE)} tickets with pull requests have them all merged, and at least ${SPRINT_DELIVERED_MIN_TICKETS} do.`;
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

/** The progress line under a running assessment, in the run's own words (plan / verify). */
export function assessmentProgressLine(
  status: SprintAssessmentStatus,
  phase: SprintAssessmentPhase | null,
  mode: SprintAssessMode | null = null,
): string {
  if (status === 'queued') return 'Waiting for a free slot…';
  switch (phase) {
    case 'checking_out':
      return 'Checking out the repos…';
    case 'writing':
      return mode === 'verify' ? 'Writing up the check…' : mode === 'plan' ? 'Writing up the plan…' : 'Writing the assessment…';
    case 'reading':
    default:
      return mode === 'verify'
        ? 'Checking each criterion against the code…'
        : mode === 'plan'
          ? 'Reading the code to plan the work…'
          : 'Reading the code…';
  }
}

/**
 * The progress bar's fill (0–100) for a running check. NOT a measure of work done — the agent reports
 * no fraction — so it is PHASE-BASED with a slow ease inside the long reading phase, and never
 * reaches 100 before the run ends: queued ≤ 5, checking out 5–20, reading 20–85 (easing on the time
 * since the run was created, ~90 s time constant), writing 90.
 */
export function assessmentProgressPct(status: SprintAssessmentStatus, phase: SprintAssessmentPhase | null, elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  const ease = (tau: number): number => 1 - Math.exp(-t / tau);
  if (status === 'queued') return 2 + 3 * ease(30);
  switch (phase) {
    case 'checking_out':
      return 5 + 15 * ease(20);
    case 'writing':
      return 90;
    case 'reading':
    default:
      return 20 + 65 * ease(90);
  }
}

/** Elapsed time as "45s" / "2m 05s". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
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

/** What the confirm dialog says will happen to one field, naming the ticket. */
export function writeTargetSentence(key: string, target: SprintReplaceTarget): string {
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

// ── The opened card: the ticket text, its findings, the proposals ────────────────────────────────

/** Where the opened card renders the criteria. `field` = the tracker's criteria field as Markdown;
 *  `items` = the numbered criteria (lifted from somewhere the description does not show, e.g. sub-issues);
 *  null = they are already in the description (or there are none) — never shown twice. */
export type SprintCriteriaShown = { kind: 'field'; markdown: string } | { kind: 'items'; items: string[] } | null;

const squash = (s: string): string => s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function sprintCriteriaShown(
  t: Pick<SprintTicketRow, 'acField' | 'acceptanceCriteria' | 'criteria' | 'description'>,
): SprintCriteriaShown {
  const field = t.acceptanceCriteria.trim();
  if (t.acField != null && field !== '') return { kind: 'field', markdown: t.acceptanceCriteria };
  if (t.criteria.source !== 'acceptance_criteria') return null;
  const first = t.criteria.items[0];
  const inDescription = first != null && squash(t.description).includes(squash(first));
  if (inDescription) return null;
  if (field !== '') return { kind: 'field', markdown: t.acceptanceCriteria };
  return t.criteria.items.length > 0 ? { kind: 'items', items: [...t.criteria.items] } : null;
}

/** Which rendered block a finding's quote is looked for in. null = unanchored. */
export function sprintFindingBlock(
  f: Pick<SprintFinding, 'quote' | 'where'>,
  criteriaApart: boolean,
): 'title' | 'description' | 'criteria' | null {
  if (f.quote == null || f.quote.trim() === '') return null;
  if (f.where === 'title') return 'title';
  if (f.where === 'criteria') return criteriaApart ? 'criteria' : 'description';
  return 'description';
}

/** The first words of a finding's detail for its row: whole words, ≤ `max` characters, then "…". */
export function findingSnippet(detail: string, max = 70): string {
  const s = detail.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The draft field and text "Apply to draft" writes for proposed criteria: the list alone into a
 *  criteria field of the ticket's own, else the draft description with its criteria section swapped
 *  (`replaceCriteriaSection`). */
export function proposedCriteriaDraft(
  draft: { description: string; criteria: string | null },
  revised: readonly string[],
): { field: 'description' | 'criteria'; text: string } {
  const list = criteriaListMarkdown(revised);
  return draft.criteria != null ? { field: 'criteria', text: list } : { field: 'description', text: replaceCriteriaSection(draft.description, list) };
}

/** The issue pill's colours (light and dark), one per story issue. */
export const STORY_ISSUE_PILL_CLASS: Record<StoryIssueId, string> = {
  unclear_done: 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  blocked: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  spec_gaps: 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
};

/** The repo picker's options: every workspace repo not accepted — the suggested ones first (in the
 *  server's order, tagged), then the rest by name. */
export function repoPickerOptions(
  repos: readonly SprintRepoRef[],
  accepted: readonly SprintRepoRef[],
  suggested: readonly SprintRepoRef[],
): Array<{ repoId: number; text: string }> {
  const taken = new Set(accepted.map((r) => r.repoId));
  const sugg = suggested.filter((r) => !taken.has(r.repoId));
  const suggIds = new Set(sugg.map((r) => r.repoId));
  const rest = repos
    .filter((r) => !taken.has(r.repoId) && !suggIds.has(r.repoId))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return [
    ...sugg.map((r) => ({ repoId: r.repoId, text: `${r.fullName} · suggested` })),
    ...rest.map((r) => ({ repoId: r.repoId, text: r.fullName })),
  ];
}

/** The ticket's tracker site, from its ident (shared `parseTicketIdent` → `trackerTicketRow`); null for
 *  an ident that is not a tracker's. */
export function sprintTicketSite(t: Pick<SprintTicketRow, 'ident'>): TicketSite | null {
  const p = parseTicketIdent(t.ident);
  if (!isTrackerIdent(p)) return null;
  const row = trackerTicketRow(p);
  return { provider: row.provider, root: row.apiRoot };
}

/** What the card's text links (lib/ticketLinks.ts): the site, the ticket's own key, the related list. */
export function sprintTicketLinkOptions(t: Pick<SprintTicketRow, 'ident' | 'key' | 'related'>): TicketLinkOptions | null {
  const site = sprintTicketSite(t);
  return site == null ? null : { site, selfKey: t.key, related: (t.related ?? []).map((r) => ({ key: r.key, title: r.title })) };
}

/** The collapsed card's related-ticket pill: "BMD-855 · Hedgerow summary · In Progress" parts. */
export function relatedPillParts(r: Pick<SprintRelatedTicket, 'key' | 'title' | 'status'>, titleMax = 32): { key: string; title: string | null; status: string | null } {
  const title = r.title != null && r.title.trim() !== '' ? r.title.trim() : null;
  const short = title == null ? null : title.length <= titleMax ? title : `${title.slice(0, titleMax - 1).trimEnd()}…`;
  return { key: r.key, title: short, status: r.status };
}

/** One row of the findings panel: a single finding, or every finding with the SAME issue + rule
 *  folded into one expandable row ("Several outcomes · 11"). */
export type SprintFindingRow =
  | { kind: 'one'; finding: SprintFinding }
  | { kind: 'group'; key: string; issue: SprintFinding['issue']; rule: SprintFinding['rule']; label: string; findings: SprintFinding[] };

/** Group the panel's findings by issue + rule (pure). A rule met once stays a single row; a rule met
 *  twice or more becomes ONE group row at its first finding's place, its findings in their order. The
 *  label is the rule's (`brief`). Highlights in the text are not grouped — one per finding. */
export function groupSprintFindings(findings: readonly SprintFinding[]): SprintFindingRow[] {
  const byKey = new Map<string, SprintFinding[]>();
  for (const f of findings) {
    const k = `${f.issue}|${f.rule}`;
    const list = byKey.get(k) ?? [];
    list.push(f);
    byKey.set(k, list);
  }
  const out: SprintFindingRow[] = [];
  const placed = new Set<string>();
  for (const f of findings) {
    const k = `${f.issue}|${f.rule}`;
    const list = byKey.get(k)!;
    if (list.length === 1) out.push({ kind: 'one', finding: f });
    else if (!placed.has(k)) {
      placed.add(k);
      out.push({ kind: 'group', key: k, issue: f.issue, rule: f.rule, label: f.brief, findings: list });
    }
  }
  return out;
}

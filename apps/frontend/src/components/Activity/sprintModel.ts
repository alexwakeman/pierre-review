import {
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_STAGES,
  SPRINT_STATUS_ORDER_MAX,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type SprintAssessmentCurrency,
  type SprintAssessmentPhase,
  type SprintAssessmentRecord,
  type SprintAssessmentStatus,
  type SprintAssessMode,
  type SprintRepoRef,
  type SprintStage,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusSettings,
  type TicketSite,
} from '@pierre-review/shared';

// Activity → This Sprint: the pure folds behind the tab that survive the move to the GRAPH (status
// settings, the "Check against code" progress, the repo picker). test/sprintModel.test.ts.
// ⚠ Nothing here ranks tickets or people.

const normStatus = (s: string): string => s.trim().toLowerCase();

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
export function assessButtonLabel(t: {
  assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null;
}): 'Check against code' | 'Check again' | null {
  const a = t.assessment;
  if (a == null) return 'Check against code';
  if (assessmentActive(a.record.status)) return null;
  if (a.record.status === 'succeeded') {
    if (a.record.outdated) return 'Check against code';
    return a.currency === 'stale' ? 'Check again' : null;
  }
  return 'Check against code';
}

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
export function sprintTicketSite(t: { ident: string }): TicketSite | null {
  const p = parseTicketIdent(t.ident);
  if (!isTrackerIdent(p)) return null;
  const row = trackerTicketRow(p);
  return { provider: row.provider, root: row.apiRoot };
}

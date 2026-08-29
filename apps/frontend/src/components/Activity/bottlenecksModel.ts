import type {
  FlowCoverage,
  FlowFinding,
  FlowFindingKind,
  FlowFindingPrRef,
  FlowFindingRefusal,
  FlowFindingSubjectKind,
  FlowFindingUnit,
  FlowFindingsResponse,
  User,
} from '@pierre-review/shared';
import type { InsightsInnerTab } from '../../store/filters.js';
import { INSIGHTS_INNER_TABS } from '../../store/filters.js';

// The Bottlenecks panel's model — PURE (no React, no store, no query client), so the rules that
// are the point of this feature are unit-testable from `test/` without mounting anything.
//
// ⚠ THE SUBJECT OF A ROW IS THE FLOW, NEVER A PERSON (the contract's header rule, restated here
// because this file is where it would be broken). A row's identity is `subject` — a directory, a
// repo, a size band — and people reach the screen ONLY as `actors`, a field INSIDE the row,
// resolved through the response's `users` table. There is no sort by person, no group by person,
// no cross-person shape, and `BottleneckSection` is keyed by KIND for exactly that reason: it is
// the one grouping that cannot become a leaderboard.
//
// ⚠ SECTIONS ARE ALWAYS ALL FOUR KINDS. A kind with nothing to say renders its reason rather than
// vanishing, because an absent section reads as "we checked and there is nothing here" — a much
// stronger claim than either thing that actually happened. The two are DIFFERENT states and the
// panel must not blur them:
//   • 'refused'  — the kind could not clear its sample floor. "Not enough data to say X."
//   • 'measured' — the floors were cleared and nothing crossed the emission threshold. This is
//                  the honest "we looked, and nothing stands out", and it is the ONLY state
//                  entitled to say so. The server emits a refusal only when `clearedFloor === 0`,
//                  so a kind can legitimately return neither a finding nor a refusal.

/**
 * DERIVE the visible tab; never write a correction back to the store.
 *
 * Both members are free on every tier, so the only degradation left is a value outside the union
 * — a hand-edited `?insightsTab=`, or a member removed in a later build whose literal survives in
 * a history entry a browser Back replays. It normalises FOR THE RENDER only. A `set…()` here
 * would permanently forget the reader's choice the moment a future member became gated, which is
 * the bug `botsInnerTab` / `feedInnerTab` are commented against.
 */
export function effectiveInsightsTab(tab: string | null | undefined): InsightsInnerTab {
  return (INSIGHTS_INNER_TABS as readonly string[]).includes(tab ?? '')
    ? (tab as InsightsInnerTab)
    : 'overview';
}

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

/** Section order. FIXED and kind-keyed — never data-derived, so the panel does not silently
 *  re-rank itself between refetches, and never person-derived (see the header). */
export const FLOW_KIND_ORDER: readonly FlowFindingKind[] = [
  'single_reviewer_path',
  'size_latency',
  'approval_parked',
  'round_trips',
];

/** The section heading, and — critically — the NAME a refusal is refused UNDER. "Not enough data
 *  to say X" needs an X the reader can hold, which is why these are sentences about the flow and
 *  not the enum spelling. */
export const FLOW_KIND_LABEL: Record<FlowFindingKind, string> = {
  single_reviewer_path: 'Directories one person reviews',
  size_latency: 'How long big changes wait',
  approval_parked: 'Approved work that sat',
  round_trips: 'Areas that take several passes',
};

/** What kind of thing the row is ABOUT, rendered as a chip in front of the subject so the row's
 *  subject can never be mistaken for a name. There is deliberately no `'person'` member. */
export const FLOW_SUBJECT_KIND_LABEL: Record<FlowFindingSubjectKind, string> = {
  path: 'Directory',
  repo: 'Repository',
  size_band: 'PR size',
};

/** What `baseline` is measured against, per kind — the second half of the comparison, in words.
 *  A magnitude with no comparison is not a finding, so this string is never optional. */
export const FLOW_BASELINE_LABEL: Record<FlowFindingKind, string> = {
  single_reviewer_path: 'across the workspace',
  size_latency: 'for the smallest measured band',
  approval_parked: 'across the workspace',
  round_trips: 'across the workspace',
};

/**
 * What the row's `actorIds` ARE, in the row's own terms.
 *
 * ⚠ THIS CAPTION IS THE GUARDRAIL, not decoration. A bare row of faces beside a slow number reads
 * as an accusation; the caption says what the chips are evidence OF, which is a fact about the
 * flow. Two kinds carry no actors at all by design — `approval_parked` because "who merges
 * slowly" is a person-shaped claim about a step between approval and merge, and `round_trips`
 * because a negotiation has no owner — so their captions exist only for exhaustiveness.
 */
export const FLOW_ACTOR_CAPTION: Record<FlowFindingKind, string> = {
  single_reviewer_path: 'Taking most of the reviews here',
  size_latency: 'Authors whose changes run large in this window',
  approval_parked: 'Involved',
  round_trips: 'Involved',
};

// ── Figure formatting ────────────────────────────────────────────────────────────────────────
// ⚠ THIS MIRRORS `fmtHours` / `fmtCount` / `fmtPct` IN apps/backend/src/db/flow-findings.ts, and
// it has to. The server writes the SAME figure into its templated `headline` already formatted;
// this formats `value`/`baseline` for the row's own comparison chip. A divergent rounding rule
// puts two different spellings of one number on one row — "18h" in the sentence, "18.2h" beside
// it — which reads as two measurements and destroys the only claim the row makes.

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/**
 * ⚠ A STRICTLY POSITIVE FIGURE MUST NEVER PRINT AS ZERO.
 *
 * The pair shares one unit, taken from the LARGER figure — which means the smaller one can round
 * away entirely: `formatFlowPair(60, 1, 'hours')` picked days and rendered "2.5 days vs 0 days",
 * on a row that had just passed the emission gate BECAUSE the two differ. "0 days" is both false
 * and self-refuting, and it lands on the widest gaps, which are the rows worth reading.
 *
 * A floor spelling keeps the shared unit (so the pair is still comparable at a glance) and stays
 * true. Dropping just the small figure to a finer unit would be more precise and would reintroduce
 * exactly the mixed-unit row this function exists to prevent.
 */
function floored(n: number, text: string, floor: string, unit: string): string {
  const rendersZero = Number.parseFloat(text) === 0;
  const sep = unit === 'h' ? '' : ' ';
  if (rendersZero && n > 0) return `<${floor}${sep}${unit}`;
  return `${text}${sep}${unit}`;
}

export function formatFlowValue(value: number, unit: FlowFindingUnit): string {
  switch (unit) {
    case 'hours':
      if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
      if (value < 10) return `${oneDp(value)}h`;
      if (value < 48) return `${Math.round(value)}h`;
      return `${oneDp(value / 24)} days`;
    case 'days':
      return `${oneDp(value)} days`;
    case 'pct':
      return `${Math.round(value * 100)}%`;
    case 'comments':
      return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} ${
        value === 1 ? 'comment' : 'comments'
      }`;
    case 'count':
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

/**
 * A value/baseline PAIR, formatted in ONE unit.
 *
 * ⚠ FORMATTING THE TWO INDEPENDENTLY IS A REAL DEFECT, and it shipped: `bevyengine/bevy` rendered
 * "2.6 days vs 36h" because 62.4h crosses the 48h day threshold and 36h does not. The whole job of
 * a baseline is an AT-A-GLANCE comparison, and two units force the reader to do arithmetic —
 * precisely when the gap is widest, since straddling the threshold is what a big gap looks like.
 *
 * The unit is chosen from the LARGER of the two and applied to both, so the pair always reads as
 * one comparison. Only `hours` has a switching threshold; every other unit is already stable, and
 * routing them through here anyway keeps one entry point rather than a rule callers must remember.
 */
export function formatFlowPair(
  value: number,
  baseline: number,
  unit: FlowFindingUnit,
): { value: string; baseline: string } {
  if (unit !== 'hours') {
    return { value: formatFlowValue(value, unit), baseline: formatFlowValue(baseline, unit) };
  }
  const scale = Math.max(value, baseline);
  const fmt = (n: number): string => {
    if (scale >= 48) return floored(n / 24, oneDp(n / 24), '0.1', 'days');
    if (scale >= 10) return floored(n, String(Math.round(n)), '1', 'h');
    if (scale >= 1) return floored(n, oneDp(n), '0.1', 'h');
    return `${Math.max(1, Math.round(n * 60))} min`;
  };
  return { value: fmt(value), baseline: fmt(baseline) };
}

/** "N pull requests" / "N threads" is the reader's ONLY defence against a confident number
 *  computed from four observations, so every row renders it — including the ones that look
 *  dramatic, which are exactly the ones a thin sample produces. */
export function formatSample(n: number, kind: FlowFindingKind): string {
  const noun = kind === 'round_trips' ? 'thread' : 'pull request';
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

/** A person implicated by a finding. ⚠ EVIDENCE INSIDE A ROW, never a row of their own — this
 *  type has no section, no ordering of its own and no aggregate anywhere. `user` is undefined
 *  when the id did not resolve (a deleted account); the chip still renders the id's placeholder
 *  rather than dropping the evidence. */
export interface FlowActor {
  id: number;
  user: User | undefined;
}

export interface BottleneckRow {
  id: string;
  kind: FlowFindingKind;
  /** THE ROW'S SUBJECT — the flow. Rendered verbatim and leading. */
  subject: string;
  subjectKindLabel: string;
  headline: string;
  detail: string;
  /** The measured figure and what it is measured against, ALWAYS rendered together. */
  value: string;
  baseline: string;
  baselineLabel: string;
  sample: string;
  sampleSize: number;
  evidence: FlowFindingPrRef[];
  actors: FlowActor[];
  /** What the actor chips are evidence OF. See FLOW_ACTOR_CAPTION. */
  actorCaption: string;
}

export type BottleneckSectionState = 'findings' | 'refused' | 'measured';

export interface BottleneckSection {
  kind: FlowFindingKind;
  label: string;
  state: BottleneckSectionState;
  rows: BottleneckRow[];
  /** The server's templated reason, verbatim — for BOTH silent states. Under `'refused'` it says
   *  why nothing could be measured; under `'measured'` it says what WAS measured and found fine,
   *  which is more specific than the panel's own fallback sentence and is preferred over it. */
  refusalReason: string | null;
}

export interface BottlenecksModel {
  /** The window the SERVER measured, echoed back — never the client's request. It clamps to
   *  [7, 90], so a bookmarked `?days=400` is answered over 90 and every sentence on screen must
   *  say 90 or it is describing a window nobody computed. */
  windowDays: number;
  sections: BottleneckSection[];
  /** True when NOTHING was found and NOTHING was refused — every kind cleared its floors and
   *  none crossed a threshold. The one state entitled to say "nothing stands out". */
  nothingStandsOut: boolean;
  /** Every kind refused. A FRAMING flag only: the panel adds one line above the sections so four
   *  dashed boxes read as intentional rather than broken (the empty-workspace case refuses all
   *  four with one reason). ⚠ It must never REPLACE the sections — each refusal still renders
   *  under its own name, because that name is the "X" in "not enough data to say X". */
  allRefused: boolean;
  /** The one-line coverage sentence. Never null: retroactive history is coverage-biased and the
   *  reader should not have to know that, so the panel always says what it measured. */
  coverageLine: string;
  /** A second line, present only when coverage is actually compromised — partial repo coverage or
   *  a scan that hit its cap. Rendered as a caution, not as body text. */
  coverageCaution: string | null;
}

function actorsFor(f: FlowFinding, usersById: Map<number, User>): FlowActor[] {
  return f.actorIds.map((id) => ({ id, user: usersById.get(id) }));
}

function rowFor(f: FlowFinding, usersById: Map<number, User>): BottleneckRow {
  return {
    id: f.id,
    kind: f.kind,
    subject: f.subject,
    subjectKindLabel: FLOW_SUBJECT_KIND_LABEL[f.subjectKind],
    headline: f.headline,
    detail: f.detail,
    // ⚠ ONE call, not two — the pair shares a unit. See formatFlowPair.
    ...formatFlowPair(f.value, f.baseline, f.unit),
    baselineLabel: FLOW_BASELINE_LABEL[f.kind],
    sample: formatSample(f.sampleSize, f.kind),
    sampleSize: f.sampleSize,
    evidence: f.evidence,
    actors: actorsFor(f, usersById),
    actorCaption: FLOW_ACTOR_CAPTION[f.kind],
  };
}

/**
 * "Measured N of M repositories, N pull requests, last D days."
 *
 * ⚠ ALWAYS RENDERED. `docs/PERIOD-REPORTING.md`'s coverage-bias rule in one line: a workspace
 * that onboarded repos across the window produces figures that are partly onboarding, and
 * `reposWithData` is the only defence a reader has against believing otherwise. Putting it behind
 * a disclosure would make it exactly as useful as leaving it out.
 */
export function coverageLineFor(c: FlowCoverage, windowDays: number): string {
  const repos = `${c.reposWithData} of ${c.reposInWorkspace} ${
    c.reposInWorkspace === 1 ? 'repository' : 'repositories'
  }`;
  const prs = `${c.prsScanned} pull ${c.prsScanned === 1 ? 'request' : 'requests'}`;
  return `Measured ${repos} · ${prs} · last ${windowDays} days.`;
}

export function coverageCautionFor(c: FlowCoverage): string | null {
  const parts: string[] = [];
  // A repo with no measured PR contributes nothing to any median, so a workspace where most repos
  // are silent is describing a minority of its own work.
  if (c.reposInWorkspace > 0 && c.reposWithData < c.reposInWorkspace) {
    parts.push(
      `${c.reposInWorkspace - c.reposWithData} of these repositories had no measurable review activity in the window, so these figures describe the rest.`,
    );
  }
  // ⚠ TWO DIFFERENT CAVEATS, AND THEY WERE ONE. `truncated` is a claim about the WINDOW — a row
  // scan stopped early, so every median on screen covers only part of the period the header
  // names. `filesTruncatedPrs` is far smaller: the window was scanned in full and only the
  // per-directory split under-counts a few large pull requests. Shipped merged, a single
  // 120-file PR made a 262-PR workspace announce that its figures came from part of the window —
  // a caveat the reader cannot act on, which teaches them to ignore the one that matters.
  if (c.truncated) {
    parts.push('A scan reached its cap, so these figures come from part of the window only.');
  }
  if (c.filesTruncatedPrs > 0) {
    const n = c.filesTruncatedPrs;
    parts.push(
      `${n} scanned pull ${n === 1 ? 'request' : 'requests'} changed more files than are stored, so the per-directory split under-counts ${n === 1 ? 'it' : 'them'}.`,
    );
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * Fold one response into the panel's render model. `undefined` (loading, or the idle
 * unresolved-workspace state) yields no sections — the panel renders its skeleton, never an
 * empty-state claim it has not earned.
 */
export function buildBottlenecksModel(resp: FlowFindingsResponse | undefined): BottlenecksModel | null {
  if (resp == null) return null;
  const usersById = new Map<number, User>(resp.users.map((u) => [u.id, u]));
  const refusalByKind = new Map<FlowFindingKind, FlowFindingRefusal>();
  // Last writer wins, but the server emits at most one refusal per kind; the Map exists so a
  // second one could never render as a duplicate section.
  for (const r of resp.refusals) refusalByKind.set(r.kind, r);

  const sections: BottleneckSection[] = FLOW_KIND_ORDER.map((kind) => {
    // Server order is kept verbatim WITHIN a kind — it is already ranked by severity then sample
    // size (`takeTop`). Re-sorting here would put a second ranking on screen that no figure in
    // the row explains.
    const rows = resp.findings.filter((f) => f.kind === kind).map((f) => rowFor(f, usersById));
    const refusal = refusalByKind.get(kind) ?? null;
    // ⚠ THE STATE COMES OFF `basis`, NEVER OFF "is there a refusal at all". The server emits a
    // refusal for BOTH silences now (a kind that says nothing renders as nothing, which is the
    // strongest claim of the three and always the wrong one), so presence alone can no longer
    // tell them apart — and rendering a clean bill of health under "Not enough data to say" sends
    // the reader looking for a sync problem that does not exist.
    const state: BottleneckSectionState =
      rows.length > 0
        ? 'findings'
        : refusal == null || refusal.basis === 'measured_clean'
          ? 'measured'
          : 'refused';
    return { kind, label: FLOW_KIND_LABEL[kind], state, rows, refusalReason: refusal?.reason ?? null };
  });

  return {
    windowDays: resp.windowDays,
    sections,
    nothingStandsOut: resp.findings.length === 0 && resp.refusals.length === 0,
    allRefused: sections.every((s) => s.state === 'refused'),
    coverageLine: coverageLineFor(resp.coverage, resp.windowDays),
    coverageCaution: coverageCautionFor(resp.coverage),
  };
}

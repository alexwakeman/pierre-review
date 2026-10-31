// THE DATA-FLOW DIAGRAM'S PURE FOLD (test/dataFlow.test.ts; docs/FRONTEND.md § Design diagrams): which
// lanes render, where each numbered step's arrow and label sit, and the words every step reads as. The
// component (components/FlowDiagram.tsx) only lays this out.
//
//   LANES    the participants, left to right, in the order the server stored them (the order the data
//            first reaches them). A duplicate id keeps its first.
//   ROWS     one per step, in step order, top to bottom. A step naming a lane that is not drawn is
//            dropped (the validator refuses it; an old or hand-made row must not crash the pane).
//   GEOMETRY percentages of the figure's width, so the drawing scales with the lanes. Each step's SPAN
//            runs from the centre of its `from` lane to the centre of its `to` lane: the step's box sits
//            centred in it and its arrow runs from one lane's line to the box's edge, and from the
//            box's other edge to the other lane's line. A step that stays on one lane (a check or a
//            transform) spans from its lane's line up to LOOP_LANES towards its open side — the right, or the
//            left on the last lane (a lone lane: to the figure's edge) — with its box beside the line
//            and a loop out to the box and back.
import {
  DESIGN_CHANGES,
  FLOW_LANES,
  FLOW_STEP_WORD,
  type DesignChange,
  type FlowDiagram,
  type FlowParticipant,
  type FlowStep,
  type SequenceDiagramMember,
} from '@pierre-review/shared';
import { memberForRef } from './designGrid.js';

export interface FlowLane {
  participant: FlowParticipant;
  col: number;
  // "Database", "API route" …
  kindLabel: string;
  // Story designs: the pull request that builds it.
  member: SequenceDiagramMember | null;
}

export interface FlowRow {
  step: FlowStep;
  fromCol: number;
  toCol: number;
  // The step stays on one lane (a check or a transform done in place).
  self: boolean;
  // Which way the arrowhead points.
  dir: 'right' | 'left' | 'self';
  // A loop (self step) opens to the right of its lane — or to the left, on the last lane.
  loopRight: boolean;
  // "Check", "Write" …
  word: string;
  // Story designs: the pull request that does this step.
  member: SequenceDiagramMember | null;
  // How the step reads as text: "Step 3, Write: from Orders route to orders table — order row."
  text: string;
  // Percentages of the figure's width: lane line to lane line (a loop: lane line to one lane over).
  span: { left: number; width: number };
}

export interface FlowLayout {
  lanes: FlowLane[];
  rows: FlowRow[];
}

/** How far a loop's span reaches from its lane's line, in lanes (less where the figure ends). */
export const LOOP_LANES = 1.75;

export function layoutFlow(flow: FlowDiagram, members: readonly SequenceDiagramMember[] = []): FlowLayout {
  const lanes: FlowLane[] = [];
  const colOf = new Map<string, number>();
  for (const p of flow.participants) {
    if (colOf.has(p.id)) continue;
    colOf.set(p.id, lanes.length);
    lanes.push({
      participant: p,
      col: lanes.length,
      kindLabel: (FLOW_LANES as Record<string, string>)[p.kind] ?? p.kind,
      member: memberForRef(p.pr, members),
    });
  }
  const n = Math.max(1, lanes.length);
  const pct = (lanesWide: number): number => (lanesWide / n) * 100;
  const rows: FlowRow[] = [];
  for (const step of flow.steps) {
    const fromCol = colOf.get(step.from);
    const toCol = colOf.get(step.to);
    if (fromCol == null || toCol == null) continue;
    const self = fromCol === toCol;
    const lo = Math.min(fromCol, toCol);
    const hi = Math.max(fromCol, toCol);
    // A loop opens to the right of its lane, or to the left on the last lane.
    const opensRight = fromCol < n - 1 || n === 1;
    // A loop's box may run past the next lane's line (it is opaque, as a long step's box is), so its
    // words get about as much room as a step between lanes — never past the figure's edge.
    const loopW = Math.min(LOOP_LANES, opensRight ? n - fromCol - 0.5 : fromCol + 0.5);
    const span = self
      ? opensRight
        ? { left: pct(fromCol + 0.5), width: pct(loopW) }
        : { left: pct(fromCol + 0.5 - loopW), width: pct(loopW) }
      : { left: pct(lo + 0.5), width: pct(hi - lo) };
    const word = FLOW_STEP_WORD[step.kind] ?? step.kind;
    const fromLabel = lanes[fromCol]!.participant.label;
    const toLabel = lanes[toCol]!.participant.label;
    const member = memberForRef(step.pr, members);
    const where = self ? `in ${fromLabel}` : `from ${fromLabel} to ${toLabel}`;
    rows.push({
      step,
      fromCol,
      toCol,
      self,
      dir: self ? 'self' : toCol > fromCol ? 'right' : 'left',
      loopRight: self && opensRight,
      word,
      member,
      text: `Step ${step.n}, ${word}: ${where} — ${step.label}.${member != null ? ` Pull request ${member.repo} #${member.number}.` : ''}`,
      span,
    });
  }
  return { lanes, rows };
}

/** The participant changes the figure draws, in DESIGN_CHANGES order — the key lists only these. */
export function laneChangesPresent(layout: Pick<FlowLayout, 'lanes'>): DesignChange[] {
  const seen = new Set(layout.lanes.map((l) => l.participant.change));
  return DESIGN_CHANGES.filter((k) => seen.has(k));
}

/** The narrowest a lane is drawn, in rem — below this the figure scrolls sideways inside itself. */
export const FLOW_LANE_MIN_REM = 12;
/** …and in a phone-sized box (narrower than FLOW_PHONE_BOX_PX), where a 12rem lane is most of the screen. */
export const FLOW_LANE_MIN_REM_PHONE = 9;
export const FLOW_PHONE_BOX_PX = 480;

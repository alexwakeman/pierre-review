// DESIGN DIAGRAMS — the SPA's pure folds (test/sequenceDiagram.test.ts): when to poll, and the one
// status line under a slot. docs/FRONTEND.md § Design diagrams.
import {
  aiRunProviderName,
  sequenceDiagramRefusalText,
  type AiProviderName,
  type PrSequenceDiagramsResponse,
  type RedrawSequenceDiagramResponse,
  type SequenceDiagramPhase,
  type SequenceDiagramProgress,
  type SequenceDiagramSlot,
  type SequenceDiagramView,
} from '@pierre-review/shared';

export const DIAGRAM_POLL_MS = 5000;
// How long after a review finished the PR read waits for its diagram to be queued.
export const AFTER_REVIEW_WAIT_MS = 90_000;

/** Is a run of this slot queued or running? */
export function slotDrawing(slot: SequenceDiagramSlot | null | undefined): boolean {
  const s = slot?.latest?.status ?? slot?.diagram?.status;
  return s === 'queued' || s === 'running';
}

/** Is anything stored for the CURRENT head / member set? */
export function slotHasCurrent(slot: SequenceDiagramSlot | null | undefined): boolean {
  return slot?.diagram?.current === true || slot?.latest?.current === true;
}

export function prDiagramsPollMs(
  data: PrSequenceDiagramsResponse | undefined,
  waitingSinceMs: number | null,
  nowMs: number = Date.now(),
): number | false {
  if (data == null) return false;
  if (slotDrawing(data.pr) || data.stories.some((s) => slotDrawing(s))) return DIAGRAM_POLL_MS;
  // After a review the trigger queues the PR's diagram AND each multi-PR ticket's story diagram, so
  // keep polling until every one of them has a row for the current head / member set.
  const awaiting = !slotHasCurrent(data.pr) || data.stories.some((s) => s.memberCount >= 2 && !slotHasCurrent(s));
  if (waitingSinceMs != null && nowMs - waitingSinceMs < AFTER_REVIEW_WAIT_MS && awaiting) return DIAGRAM_POLL_MS;
  return false;
}

/** The line under a slot's diagram (or in its place). Null = nothing to say. */
export function slotStatusLine(slot: SequenceDiagramSlot, redrawing: boolean): string | null {
  if (redrawing || slotDrawing(slot)) return 'Drawing…';
  // The last finished review skipped it on a limit (the server says so only while that still holds).
  const skipped = autoSkippedLine(slot);
  if (skipped != null) return skipped;
  const l = slot.latest;
  if (l == null) return slot.diagram == null ? 'No design yet.' : null;
  // A refusal names the provider that RAN this drawing (its row's), never the active one.
  const by = aiRunProviderName(l);
  if (l.status === 'refused' && l.refusal != null) return sequenceDiagramRefusalText(l.refusal, by, l.refusalDetail);
  if (l.status === 'failed') {
    return l.refusal != null ? sequenceDiagramRefusalText(l.refusal, by) : 'Drawing failed.';
  }
  if (l.status === 'cancelled') return 'Drawing was cancelled.';
  return null;
}

/** A redraw refused now: `by` is the provider it would have run on (the active one). */
export function redrawRefusalText(r: RedrawSequenceDiagramResponse | undefined, by: AiProviderName = 'Claude'): string | null {
  return r?.outcome === 'refused' && r.refusal != null ? sequenceDiagramRefusalText(r.refusal, by) : null;
}


/** Why a finished review did not draw an out-of-date design: a limit, in one line. Null otherwise. */
export function autoSkippedLine(slot: Pick<SequenceDiagramSlot, 'autoSkipped' | 'diagram'>): string | null {
  const what = slot.diagram == null ? 'Not drawn yet' : 'Not redrawn';
  switch (slot.autoSkipped) {
    case 'daily_limit':
      return `${what}: today’s automatic designs are used up. They start again at 00:00 UTC.`;
    case 'redraw_limit':
      return `${what}: it was already redrawn today.`;
    default:
      return null;
  }
}

// ---- the drawing's progress bar (components/ClaudeReviewDiagrams.tsx `DiagramProgress`) ----

export const DIAGRAM_PHASE_LABEL: Record<SequenceDiagramPhase, string> = {
  waiting: 'Waiting to start',
  preparing: 'Reading the changes',
  reading: 'Reading the code',
  checking: 'Checking the design',
  saving: 'Saving',
};

/** The run in flight in this slot (queued or running), or null. */
export function slotRunInFlight(slot: SequenceDiagramSlot | null | undefined): SequenceDiagramView | null {
  for (const v of [slot?.latest, slot?.diagram]) if (v != null && (v.status === 'queued' || v.status === 'running')) return v;
  return null;
}

/** A 0–100 reading for the bar; null = no phase known (an older server): the bar eases on its own. */
export function diagramProgressPct(p: SequenceDiagramProgress | null | undefined): number | null {
  if (p == null) return null;
  switch (p.phase) {
    case 'waiting':
      return 5;
    case 'preparing':
      return 15;
    case 'reading':
      // Each file read or search moves it on; never past the checking step.
      return Math.min(80, 25 + p.steps * 3);
    case 'checking':
      return 88;
    case 'saving':
      return 96;
  }
}

/** The words beside the bar. */
export function diagramProgressText(run: Pick<SequenceDiagramView, 'status' | 'progress'> | null, redrawing: boolean): string {
  if (run?.progress != null) return DIAGRAM_PHASE_LABEL[run.progress.phase];
  if (run?.status === 'queued') return DIAGRAM_PHASE_LABEL.waiting;
  if (run?.status === 'running') return 'Drawing the design';
  return redrawing ? 'Starting' : 'Drawing the design';
}

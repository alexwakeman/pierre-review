// SEQUENCE DIAGRAMS — the SPA's pure folds (test/sequenceDiagram.test.ts): when to poll, and the one
// status line under a slot. docs/FRONTEND.md § Sequence diagrams.
import {
  SEQUENCE_DIAGRAM_REFUSAL_TEXT,
  type PrSequenceDiagramsResponse,
  type RedrawSequenceDiagramResponse,
  type SequenceDiagramSlot,
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
  const l = slot.latest;
  if (l == null) return slot.diagram == null ? 'No diagram yet.' : null;
  if (l.status === 'refused' && l.refusal != null) return SEQUENCE_DIAGRAM_REFUSAL_TEXT[l.refusal];
  if (l.status === 'failed') {
    return l.refusal != null ? SEQUENCE_DIAGRAM_REFUSAL_TEXT[l.refusal] : 'Drawing failed.';
  }
  if (l.status === 'cancelled') return 'Drawing was cancelled.';
  return null;
}

export function redrawRefusalText(r: RedrawSequenceDiagramResponse | undefined): string | null {
  return r?.outcome === 'refused' && r.refusal != null ? SEQUENCE_DIAGRAM_REFUSAL_TEXT[r.refusal] : null;
}


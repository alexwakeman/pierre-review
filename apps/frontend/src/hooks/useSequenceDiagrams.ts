import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PrSequenceDiagramsResponse,
  RedrawSequenceDiagramResponse,
  TicketSequenceDiagramResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { DIAGRAM_POLL_MS, prDiagramsPollMs, slotDrawing } from '../lib/sequenceDiagrams.js';

export { slotDrawing };

// SEQUENCE DIAGRAMS' server state (docs/API.md § Sequence diagrams). Gated by the caller on
// `me.ai.enabled` (local, free) — the routes are absent in the cloud. Both reads are STORED rows.
//
// POLLING. A diagram is queued by the server a moment AFTER a review finishes, so the PR read polls
// (5 s) while a run is queued or running AND for a short window after the review's `finishedAt`
// when nothing is stored at the current head yet (`waitingSinceMs`). Nothing polls otherwise.

export const prSequenceDiagramsKey = (prId: number): readonly unknown[] => ['sequence-diagrams', 'pr', prId];
export const storySequenceDiagramKey = (ident: string): readonly unknown[] => ['sequence-diagrams', 'story', ident];
// ONE mutation key per subject, so two mounts show the same "Drawing…" while a Redraw is in flight.
const redrawPrKey = (prId: number): readonly unknown[] => ['sequence-diagram-redraw', 'pr', prId];
const redrawStoryKey = (ident: string): readonly unknown[] => ['sequence-diagram-redraw', 'story', ident];

export function usePrSequenceDiagrams(prId: number, enabled: boolean, waitingSinceMs: number | null) {
  return useQuery<PrSequenceDiagramsResponse>({
    queryKey: prSequenceDiagramsKey(prId),
    queryFn: () => api.prSequenceDiagrams(prId),
    enabled,
    staleTime: 10_000,
    refetchInterval: (q) => prDiagramsPollMs(q.state.data, waitingSinceMs),
  });
}

export function useStorySequenceDiagram(ident: string, enabled: boolean) {
  return useQuery<TicketSequenceDiagramResponse>({
    queryKey: storySequenceDiagramKey(ident),
    queryFn: () => api.storySequenceDiagram(ident),
    enabled,
    staleTime: 10_000,
    refetchInterval: (q) => (slotDrawing(q.state.data) ? DIAGRAM_POLL_MS : false),
  });
}

export function useRedrawPrDiagram(prId: number) {
  const qc = useQueryClient();
  return useMutation<RedrawSequenceDiagramResponse, Error, void>({
    mutationKey: redrawPrKey(prId),
    mutationFn: () => api.redrawPrSequenceDiagram(prId),
    onSettled: () => void qc.invalidateQueries({ queryKey: prSequenceDiagramsKey(prId) }),
  });
}

export function useRedrawStoryDiagram(ident: string) {
  const qc = useQueryClient();
  return useMutation<RedrawSequenceDiagramResponse, Error, void>({
    mutationKey: redrawStoryKey(ident),
    mutationFn: () => api.redrawStorySequenceDiagram(ident),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: storySequenceDiagramKey(ident) });
      // The same story also shows in its PRs' review tabs.
      void qc.invalidateQueries({ queryKey: ['sequence-diagrams', 'pr'] });
    },
  });
}

export function useRedrawingPr(prId: number): boolean {
  return useIsMutating({ mutationKey: redrawPrKey(prId) }) > 0;
}
export function useRedrawingStory(ident: string): boolean {
  return useIsMutating({ mutationKey: redrawStoryKey(ident) }) > 0;
}

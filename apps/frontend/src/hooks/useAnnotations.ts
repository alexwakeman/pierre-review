import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunResponse,
  AnnotationTargetKind,
  CommentAnnotation,
  PrAnnotationsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The blast-radius IMPACT NOTE's storage — the one kind left on
// the annotations platform. ONE query per PR holds the stored note; the render site looks it up by
// (kind, targetKind, targetId).
//
// The GET is a PURE CACHED READ — it never generates, so mounting can never bill.
// `staleTime: Infinity` because the stored set only changes when a run mutates it, and the run
// does that itself (see `useRunImpactNote`).

export function prAnnotationsKey(prId: number | null): unknown[] {
  return ['pr-annotations', prId];
}

export const annotationKey = (
  kind: AnnotationKind,
  targetKind: AnnotationTargetKind,
  targetId: number,
): string => `${kind}|${targetKind}|${targetId}`;

/**
 * MODULE-LEVEL so react-query memoises the projection per observer: the index is rebuilt only
 * when the response changes, not on every render of every comment card.
 */
const selectIndex = (r: PrAnnotationsResponse): Map<string, CommentAnnotation> => {
  const m = new Map<string, CommentAnnotation>();
  for (const a of r.annotations) m.set(annotationKey(a.kind, a.targetKind, a.targetId), a);
  return m;
};

/** The PR's annotations indexed by (kind, targetKind, targetId) — what render sites look into. */
export function useAnnotationIndex(
  prId: number | null,
  enabled: boolean,
): Map<string, CommentAnnotation> | undefined {
  return useQuery<PrAnnotationsResponse, Error, Map<string, CommentAnnotation>>({
    queryKey: prAnnotationsKey(prId),
    queryFn: () => api.prAnnotations(prId as number),
    enabled: prId != null && enabled,
    staleTime: Infinity,
    select: selectIndex,
  }).data;
}

// ---- the run ---------------------------------------------------------------------------------

export interface AnnotationRunState {
  running: boolean;
  result: AnnotationRunResponse | null;
  error: string | null;
}

const IDLE: AnnotationRunState = { running: false, result: null, error: null };

/**
 * Write (or refresh) the blast-radius impact note for one PR — the one billed annotation run left.
 *
 * The AbortController is load-bearing: it closes the socket, and the route's
 * `reply.raw.on('close')` is what stops the billing call when the reader navigates away.
 */
export function useRunImpactNote(prId: number): {
  state: AnnotationRunState;
  run: () => void;
} {
  const qc = useQueryClient();
  const [state, setState] = useState<AnnotationRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...IDLE, running: true });

    void (async () => {
      try {
        const result = await api.runPrAnnotations(
          prId,
          { kind: 'impact' } satisfies AnnotationRunBody,
          ac.signal,
        );
        setState({ running: false, result, error: null });
      } catch (err: unknown) {
        // An abort is the user leaving, not a failure.
        if ((err as Error)?.name === 'AbortError') {
          setState(IDLE);
          return;
        }
        setState({ running: false, result: null, error: (err as Error)?.message ?? 'Failed' });
      } finally {
        void qc.invalidateQueries({ queryKey: prAnnotationsKey(prId) });
      }
    })();
  }, [prId, qc]);

  return { state, run };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunKind,
  AnnotationRunResponse,
  AnnotationTargetKind,
  CommentAnnotation,
  PrAnnotationsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The comment-ANNOTATIONS platform (Pro; the prSummary capability). ONE query per PR holds every
// stored judgement about its comments and threads; each render site looks itself up by
// (kind, targetKind, targetId). Every annotation surface shares this query key, so a PR with 300
// bot threads still costs exactly one request no matter how many chips are on screen.
//
// The GET is a PURE CACHED READ — it never generates, so mounting these components can never
// bill. `staleTime: Infinity` because the stored set only changes when a run mutates it, and the
// run does that itself (see `useRunAnnotations`).

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

// ---- runs ------------------------------------------------------------------------------------

export interface AnnotationRunState {
  running: boolean;
  result: AnnotationRunResponse | null;
  error: string | null;
}

const IDLE: AnnotationRunState = { running: false, result: null, error: null };

/**
 * Spend one "Check review" on ONE anchor (a thread, a PR comment) — the only run surface left.
 *
 * PLAIN JSON, NOT SSE. The PR-wide sweep that needed live per-item progress is gone, and a
 * per-item run is a single billed call in the common case (see the plugin's isClockExemptRun), so
 * there is nothing worth streaming: the button reads "Checking…" and then shows the outcome.
 *
 * The AbortController is still load-bearing. It is what closes the socket, and the route's
 * `reply.raw.on('close')` is what stops the billing loop — without a signal a run that the user
 * navigated away from keeps paying to completion. A fat thread anchor (a root plus more than
 * COMBINED_CHUNK_SIZE long replies) really is several calls, so this is not hypothetical.
 */
export function useRunAnnotations(prId: number): {
  state: AnnotationRunState;
  run: (kind: AnnotationRunKind, opts?: Omit<AnnotationRunBody, 'kind'>) => void;
} {
  const qc = useQueryClient();
  const [state, setState] = useState<AnnotationRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    (kind: AnnotationRunKind, opts?: Omit<AnnotationRunBody, 'kind'>) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState({ ...IDLE, running: true });

      void (async () => {
        try {
          const result = await api.runPrAnnotations(
            prId,
            { kind, ...opts } satisfies AnnotationRunBody,
            ac.signal,
          );
          setState({ running: false, result, error: null });
        } catch (err: unknown) {
          // An abort is the user leaving, not a failure — surfacing it would flash an error on
          // every unmount.
          if ((err as Error)?.name === 'AbortError') {
            setState(IDLE);
            return;
          }
          setState({ running: false, result: null, error: (err as Error)?.message ?? 'Failed' });
        } finally {
          // ONE refetch for the whole run: every open panel on the PR picks the new judgements up
          // at once off the shared per-PR query.
          void qc.invalidateQueries({ queryKey: prAnnotationsKey(prId) });
        }
      })();
    },
    [prId, qc],
  );

  return { state, run };
}

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
import { sseStream } from '../api/sse.js';

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

export function usePrAnnotations(prId: number | null, enabled: boolean) {
  return useQuery<PrAnnotationsResponse>({
    queryKey: prAnnotationsKey(prId),
    queryFn: () => api.prAnnotations(prId as number),
    enabled: prId != null && enabled,
    staleTime: Infinity,
  });
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
//
// MIRROR of the plugin's AnnotationRunProgress (packages/pro/src/annotations/runner.ts). It is
// deliberately not in @pierre-review/shared — the contract layer ships only the JSON
// `AnnotationRunResponse`, and this is the plugin's own stream. Keep the two in lockstep.
export type AnnotationRunProgress =
  | {
      type: 'start';
      kind: AnnotationRunKind;
      total: number;
      cached: number;
      skipped: number;
      truncated: boolean;
      remaining: number;
    }
  | {
      type: 'item';
      targetKind: AnnotationTargetKind;
      targetId: number;
      verdict: string | null;
      done: number;
      total: number;
    }
  | { type: 'error'; message: string }
  | { type: 'done'; result: AnnotationRunResponse };

export interface AnnotationRunState {
  running: boolean;
  kind: AnnotationRunKind | null;
  done: number;
  total: number;
  /** Eligible targets this run could NOT reach because of the 50-per-run cap. */
  remaining: number;
  result: AnnotationRunResponse | null;
  error: string | null;
}

const IDLE: AnnotationRunState = {
  running: false,
  kind: null,
  done: 0,
  total: 0,
  remaining: 0,
  result: null,
  error: null,
};

/**
 * Run one annotation kind across a PR, streamed. Mirrors `usePrAddressedCheck`: SSE for live
 * per-item progress, an AbortController for Stop, and a single cache invalidation at the end so
 * every open card picks the new judgements up at once (invalidating per item would refetch the
 * whole PR's annotations up to 50 times).
 *
 * The cap is RESUMABLE — `state.remaining` is what's left, so the caller can offer "check the
 * next N" rather than silently truncating.
 */
export function useRunAnnotations(prId: number): {
  state: AnnotationRunState;
  run: (
    kinds: AnnotationRunKind | readonly AnnotationRunKind[],
    opts?: Omit<AnnotationRunBody, 'kind'>,
  ) => void;
  stop: () => void;
  reset: () => void;
} {
  const qc = useQueryClient();
  const [state, setState] = useState<AnnotationRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    (
      kinds: AnnotationRunKind | readonly AnnotationRunKind[],
      opts?: Omit<AnnotationRunBody, 'kind'>,
    ) => {
      const list = Array.isArray(kinds) ? [...kinds] : [kinds as AnnotationRunKind];
      if (list.length === 0) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState({ ...IDLE, running: true, kind: list[0]! });

      // SEQUENTIAL, never concurrent: the server serialises runs per account anyway (one
      // in-flight run at a time), so firing them in parallel would just make all but the first
      // bounce off that guard. Awaiting each stream also keeps the progress readout honest.
      const runOne = async (kind: AnnotationRunKind): Promise<void> => {
        setState((s) => ({ ...s, kind, done: 0, total: 0 }));
        await sseStream<AnnotationRunProgress>(`/api/pro/prs/${prId}/annotations/run/stream`, {
          method: 'POST',
          body: { kind, ...opts } satisfies AnnotationRunBody,
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === 'start') {
              setState((s) => ({ ...s, total: e.total, remaining: e.remaining }));
            } else if (e.type === 'item') {
              setState((s) => ({ ...s, done: e.done, total: e.total }));
            } else if (e.type === 'error') {
              setState((s) => ({ ...s, error: e.message }));
            } else {
              // Accumulate across the sequence so the summary line reports the whole sweep.
              // NOTE the counting UNIT differs by run kind: a 'review' run counts TARGETS (a
              // thread, a comment — up to three rows each) while a per-kind run counts rows. A
              // caller that mixes the two in one sequence therefore gets a mildly incoherent
              // total. Cosmetic, and the alternative (two counters on the wire) buys nothing.
              setState((s) => ({
                ...s,
                result:
                  s.result == null
                    ? e.result
                    : {
                        ...e.result,
                        requested: s.result.requested + e.result.requested,
                        generated: s.result.generated + e.result.generated,
                        cached: s.result.cached + e.result.cached,
                        skipped: s.result.skipped + e.result.skipped,
                        failed: s.result.failed + e.result.failed,
                        truncated: s.result.truncated || e.result.truncated,
                        creditsExhausted: s.result.creditsExhausted || e.result.creditsExhausted,
                      },
              }));
            }
          },
        });
      };

      void (async () => {
        try {
          for (const kind of list) {
            if (ac.signal.aborted) break;
            await runOne(kind);
          }
        } catch (err: unknown) {
          if ((err as Error)?.name !== 'AbortError') {
            setState((s) => ({ ...s, error: (err as Error)?.message ?? 'Failed' }));
          }
        } finally {
          setState((s) => ({ ...s, running: false }));
          // ONE refetch for the whole sweep (invalidating per item would refetch the PR's
          // annotations up to 50 times). Also refresh the two legacy per-item caches — they now
          // read the SAME rows, so a run must not leave a stale marker on screen.
          void qc.invalidateQueries({ queryKey: prAnnotationsKey(prId) });
          void qc.invalidateQueries({ queryKey: ['addressed-check'] });
          void qc.invalidateQueries({ queryKey: ['comment-assessment'] });
        }
      })();
    },
    [prId, qc],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, stop, reset };
}

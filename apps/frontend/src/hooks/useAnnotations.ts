import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunKind,
  AnnotationRunResponse,
  AnnotationRunTarget,
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

// ---- in-flight runs, keyed by the ANCHOR the user clicked --------------------------------------
//
// A run's state lives in the hook instance the BUTTON owns, but the panels that run rewrites are a
// SIBLING component (ThreadCheckOutput / CommentAnnotations) with nothing between them to carry it
// — and at two of the three mount sites the button and the output sit inside a `.map()` row, so
// there is no shared parent to lift it into either. Hence a module-level claim, the same idiom the
// AI-Fix reply guard uses (CommentFixReport.tsx): the runner claims the anchors it is about to
// overwrite, and any panel can ask "is my result about to be replaced?".
//
// KEYED ON THE ANCHOR, never on the PR alone: a bot-flooded PR has dozens of these blocks, and a
// prId-only key would blank all of them because ONE thread was re-checked.
//
// Not a React Query mutation: `useRunAnnotations` aborts on unmount ON PURPOSE (that abort is what
// stops the server billing — see below), so a shared mutation key would be decorative.

const RUNNING = new Map<string, number>();
const RUN_LISTENERS = new Set<() => void>();

function subscribeRuns(onChange: () => void): () => void {
  RUN_LISTENERS.add(onChange);
  return () => {
    RUN_LISTENERS.delete(onChange);
  };
}

/** The claim key for one anchor of one PR — what a run claims and what a panel reads. */
export function annotationRunKey(prId: number, target: AnnotationRunTarget): string {
  return `${prId}|${target.targetKind}|${target.targetId}`;
}

// COUNTED, not a boolean, because two claims on one anchor overlap in ordinary use: `run` aborts
// an in-flight run and claims again SYNCHRONOUSLY, while the aborted one releases a microtask
// later (and one anchor can have two mounts — ThreadCard renders in seven places). A flag would be
// cleared by whichever settles first, un-blanking a panel whose own run is still going.
function claimRuns(keys: readonly string[], delta: 1 | -1): void {
  if (keys.length === 0) return;
  for (const k of keys) {
    const n = (RUNNING.get(k) ?? 0) + delta;
    if (n > 0) RUNNING.set(k, n);
    else RUNNING.delete(k);
  }
  for (const l of RUN_LISTENERS) l();
}

/**
 * Whether a "Check review" is in flight against THIS anchor — i.e. whether everything stored under
 * it is about to be overwritten, so what is on screen is the PREVIOUS result. Either argument null
 * (no PR, no anchor) is simply false.
 */
export function useAnnotationRunBusy(
  prId: number | null,
  target: AnnotationRunTarget | null,
): boolean {
  const key = prId != null && target != null ? annotationRunKey(prId, target) : null;
  // Returns a primitive, so a fresh getSnapshot closure per render is fine.
  return useSyncExternalStore(subscribeRuns, () => key != null && RUNNING.has(key));
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

      // Claim the anchors this run will rewrite, so their panels drop the previous result for the
      // placeholder sweep instead of presenting it as current for the whole run. A whole-PR run
      // (no `targets` — no UI sends one any more, but the wire still allows it) claims NOTHING:
      // blanking every panel on the PR is a blackout, not feedback.
      const claimed = (opts?.targets ?? []).map((t) => annotationRunKey(prId, t));
      claimRuns(claimed, 1);

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
          // RELEASED UNCONDITIONALLY, and deliberately NOT awaited on that refetch. A re-run can
          // legitimately end with nothing rewritten (a payload-hash hit — "Already up to date."),
          // and holding the placeholder until a refetch that is retrying, or has no observer left
          // to run at all, would strand it forever. The cost is that a genuinely-new judgement
          // shows its previous text for the length of one cached local read.
          claimRuns(claimed, -1);
        }
      })();
    },
    [prId, qc],
  );

  return { state, run };
}

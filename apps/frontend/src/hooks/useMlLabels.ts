import { useQuery } from '@tanstack/react-query';
import type {
  MlEnrichmentStatus,
  MlLabel,
  MlLabelTargetKind,
  PrMlLabelsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useMe } from './useTriage.js';

// ML severity/category labels on bot comments (CORE, FREE TIER — a local ONNX classifier on the
// server, no LLM, nothing billed, no GitHub quota).
//
// Shaped after the annotation index deliberately: ONE query per PR holds every label on it, and
// each badge looks itself up by (targetKind, targetId). A PR with 300 bot comments still costs
// exactly one request no matter how many badges are on screen, and a target with no label
// renders nothing.

/** Is enrichment live on this deployment? False under `npx`, which ships no model. */
export function useMlSeverityEnabled(): boolean {
  return useMe().data?.mlSeverity ?? false;
}

/**
 * Per-PR key. NO workspace segment on purpose — a PR names its own scope server-side, exactly
 * like ['pr-annotations', prId] and ['bot-dedup', prId].
 */
export function prMlLabelsKey(prId: number | null): unknown[] {
  return ['ml-labels', prId];
}

export const mlLabelKey = (targetKind: MlLabelTargetKind, targetId: number): string =>
  `${targetKind}|${targetId}`;

/** MODULE-LEVEL so react-query memoises the projection per observer, not per render. */
const selectIndex = (r: PrMlLabelsResponse): Map<string, MlLabel> => {
  const m = new Map<string, MlLabel>();
  for (const l of r.labels) m.set(mlLabelKey(l.targetKind, l.targetId), l);
  return m;
};

/**
 * The PR's ML labels indexed by (targetKind, targetId).
 *
 * `staleTime: Infinity` because the set only changes when the background worker adds to it, and
 * nothing in the UI can trigger that — so a refetch would be pure cost. A PR opened before its
 * comments were labelled shows badges on the next full page load, which is the honest behaviour
 * for a background sweep.
 */
export function useMlLabelIndex(
  prId: number | null,
  enabled: boolean,
): Map<string, MlLabel> | undefined {
  return useQuery<PrMlLabelsResponse, Error, Map<string, MlLabel>>({
    queryKey: prMlLabelsKey(prId),
    queryFn: () => api.prMlLabels(prId as number),
    enabled: prId != null && enabled,
    staleTime: Infinity,
    select: selectIndex,
  }).data;
}

// (`useBotSeverity` / `botSeverityKey` were REMOVED with GET /api/bot-severity — the merged
// Bots ROI table reads the severity fold off `getBotAnalytics` instead. C7 cut list.)

// ---- The scoring phase of a sync ---------------------------------------------------------
//
// Syncing a repo has TWO halves: the GitHub walk, and the model pass that scores the bot text
// the walk just stored. The second cannot run inside the first (docs/ML-SEVERITY.md), so it
// always follows it — which is why a progress indicator that ends with the walk announces
// "complete" while the CPU is still working. These read `/api/ml-status` so the sync surfaces
// can represent the second half too.

/**
 * Is there scoring to show the user right now?
 *
 * ⚠ BACKLOG IS NOT WORK IN FLIGHT, and the difference is the whole point of this predicate.
 * `pending > 0` on its own would spin an indicator forever in three separate real situations,
 * each of which is a worse lie than the one this seam exists to fix:
 *
 *   • the URL is set but nothing is listening (a dev machine whose sibling `pierre-ml` is not
 *     running) — `serviceHealthy === false`,
 *   • the worker has backed off after repeated failures — `pausedUntil`,
 *   • a few comments the service REJECTS. The candidate query is "has no label row", so a batch
 *     the service 500s on is re-selected on every tick forever (four comments in this repo's own
 *     dev database do exactly this). The signal is a completed tick that failed and scored
 *     nothing — a tick that scored 300 and failed one batch is still progressing and must
 *     keep its indicator.
 *
 * `serviceHealthy === null` (no attempt yet) counts as available: the worker is about to find
 * out, and a brief optimistic spinner is the right call while it does.
 */
export function isMlScoring(status: MlEnrichmentStatus | undefined): boolean {
  if (!status?.enabled) return false;
  if (status.running) return true;
  if (status.serviceHealthy === false) return false;
  if (status.pausedUntil) return false;
  if (status.failuresThisRun > 0 && status.scoredThisRun === 0) return false;
  return status.pending > 0;
}

/**
 * Poll the worker's live state.
 *
 * `active` means a sync round is open in the UI. It only RAISES the cadence — the poll also
 * stays fast on its own while scoring is in flight, because the backlog from a sync outlives
 * the round that produced it (a first backfill can leave tens of thousands of items) and the
 * header indicator keeps reporting it long after the modal is gone.
 */
export function useMlEnrichmentStatus(active: boolean) {
  const enabled = useMlSeverityEnabled();
  return useQuery<MlEnrichmentStatus>({
    queryKey: ['ml-status'],
    queryFn: api.mlStatus,
    enabled,
    // The server caches the backlog scan for a few seconds, so a fast poll collapses to one
    // scan regardless of how many tabs are open.
    refetchInterval: (q) => (active || isMlScoring(q.state.data) ? 4_000 : 60_000),
    refetchIntervalInBackground: false,
  });
}

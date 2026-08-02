import { useQuery } from '@tanstack/react-query';
import { skipToken } from '@tanstack/react-query';
import type {
  BotSeverityResponse,
  MlLabel,
  MlLabelTargetKind,
  PrMlLabelsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';
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

/**
 * The Bots-interface severity rollup for one workspace.
 *
 * WORKSPACE-scoped, so the key carries the `ws:<id>` segment: two workspaces with no repo
 * narrowing build the identical request URL otherwise, and React Query would serve one's
 * numbers under the other's name with no refetch and no error.
 */
export function botSeverityKey(
  workspaceId: number | null,
  repoIds: number[] | null,
): unknown[] {
  return ['bot-severity', workspaceKey(workspaceId), repoKeySlot(repoIds)];
}

export function useBotSeverity(
  workspaceId: number | null,
  repoIds: number[] | null,
  enabled: boolean,
) {
  return useQuery<BotSeverityResponse>({
    queryKey: botSeverityKey(workspaceId, repoIds),
    queryFn:
      workspaceId != null && enabled
        ? () => api.botSeverity(workspaceId, repoIds)
        : skipToken,
    staleTime: 60_000,
  });
}

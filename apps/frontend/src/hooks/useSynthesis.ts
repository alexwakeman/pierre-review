import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotWindowKind,
  MlCategory,
  MlSeverity,
  SynthesisFlaggingSelect,
  SynthesisResponse,
  SynthesisScopeKind,
  VendorDisagreeDirection,
} from '@pierre-review/shared';
import { api, type SynthesisRequestParams } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';

// The synthesis verdict (plan P2.1) — the GET-backed cached read + the generate mutation, for
// every surface that mounts a SynthesisCard (P2.2's drill-downs, P2.3's Measure card).
//
// ⚠ THE QUERY KEY CARRIES THE WHOLE DESCRIPTOR, one slot per field (`ws:<id>` + `bot:<id>` per
// §8.12 — the refineQueryKey precedent): two bots' cards, or a tile card and the workspace card,
// must never share a cache entry.
//
// ⚠ THE MUTATION KEY IS SHARED PER SCOPE (the CiAnalysisCard two-mounts lesson): a paid
// generation's in-flight state must be readable from EVERY mount of the same scope via
// `useIsMutating`, or a tab switch mid-run resets the button to "Summarise" and invites a second
// BILLED POST. `synthesisKeySlots` is the one spelling of those segments — the query key, the
// mutation key and the setQueryData write all build from it, so they cannot drift.

export interface SynthesisDescriptor {
  kind: SynthesisScopeKind;
  window: BotWindowKind;
  /** Repo NARROWING within the workspace — send whenever the array exists, INCLUDING empty. */
  repoIds?: number[] | null;
  botUserId?: number | null;
  direction?: VendorDisagreeDirection | null;
  select?: SynthesisFlaggingSelect | null;
  severities?: MlSeverity[] | null;
  category?: MlCategory | null;
}

/** The canonical client-side key segments for one synthesis scope. Mirrors the server's
 *  canonicalisation (the 'findings' default; severities sorted) so omitted-vs-explicit spellings
 *  of one drill-down share one cache entry and ONE in-flight mutation. */
export function synthesisKeySlots(
  workspaceId: number | null,
  d: SynthesisDescriptor,
): (string | number)[] {
  const flagging = d.kind === 'bot-flagging';
  const select = flagging ? (d.select ?? 'findings') : null;
  // The windowless kind mirrors the server's canonicalisation: 'bot-threads' (a current-state
  // backlog) carries no window.
  const windowless = d.kind === 'bot-threads';
  return [
    d.kind,
    windowless ? 'w:-' : `w:${d.window}`,
    workspaceKey(workspaceId),
    repoKeySlot(d.repoIds ?? null),
    d.botUserId != null && (flagging || d.kind === 'bot-volume') ? `bot:${d.botUserId}` : 'bot:-',
    `dir:${(flagging ? d.direction : null) ?? '-'}`,
    `sel:${select ?? '-'}`,
    `sev:${select === 'severity' && d.severities ? [...d.severities].sort().join(',') : '-'}`,
    `cat:${(select === 'category' ? d.category : null) ?? '-'}`,
  ];
}

function requestParams(workspaceId: number, d: SynthesisDescriptor): SynthesisRequestParams {
  return {
    kind: d.kind,
    window: d.window,
    workspaceId,
    repoIds: d.repoIds ?? null,
    botUserId: d.botUserId ?? null,
    direction: d.direction ?? null,
    select: d.select ?? null,
    severities: d.severities ?? null,
    category: d.category ?? null,
  };
}

/** The cached synthesis + stale flag. Free — the server never generates on this path. */
export function useSynthesis(
  workspaceId: number | null,
  d: SynthesisDescriptor,
  enabled = true,
) {
  return useQuery<SynthesisResponse>({
    queryKey: ['synthesis', ...synthesisKeySlots(workspaceId, d)],
    // `skipToken`, not a bare `enabled`: it narrows workspaceId to a number, so a request the
    // server would answer from the account's DEFAULT workspace cannot be written (§ the
    // workspaceId-null rule — nothing renders workspace-scoped data while unresolved).
    queryFn: workspaceId == null ? skipToken : () => api.synthesis(requestParams(workspaceId, d)),
    enabled,
    staleTime: 60_000,
  });
}

/** The generate mutation (the ONLY billing path). Shared mutation key per scope — read the
 *  in-flight state via `useSynthesisGenerating`, never a per-mount `isPending` alone. */
export function useGenerateSynthesis(workspaceId: number | null, d: SynthesisDescriptor) {
  const qc = useQueryClient();
  const slots = synthesisKeySlots(workspaceId, d);
  return useMutation({
    mutationKey: ['synthesis-generate', ...slots],
    // The mutation cannot be skipToken-gated, so it refuses outright: generating for an
    // unresolved workspace would BILL for the account's Default and cache under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.synthesisGenerate(requestParams(workspaceId, d));
    },
    onSuccess: (data) => {
      // Written under the SAME slots the read uses — a hand-spelled key here is how a
      // "Summarise" click appears to do nothing until the next refetch.
      qc.setQueryData<SynthesisResponse>(['synthesis', ...slots], data);
    },
  });
}

/** True while ANY mount of this scope is generating (the shared-mutation-key read). */
export function useSynthesisGenerating(
  workspaceId: number | null,
  d: SynthesisDescriptor,
): boolean {
  return (
    useIsMutating({ mutationKey: ['synthesis-generate', ...synthesisKeySlots(workspaceId, d)] }) >
    0
  );
}

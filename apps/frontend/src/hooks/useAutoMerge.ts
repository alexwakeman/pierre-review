import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArmMergeBody, ArmedMergeListResponse, ArmedMergeRequest } from '@pierre-review/shared';
import { api } from '../api/client.js';

// ---- Auto-merge ("merge when ready") -----------------------------------------------------
//
// Pierre-side, not GitHub's native auto-merge: arming stores an intent and a server-side
// watcher lands the PR when the blockers clear. The watcher only runs WHILE THE SERVER IS
// RUNNING, which every surface here says out loud rather than implying a cloud guarantee.

export const ARMED_MERGES_KEY = ['auto-merge'] as const;

// How often the cross-PR list is re-read. The watcher ticks every ~2 minutes, so polling
// faster than that only adds requests; 45s is a compromise that keeps the "it landed" toast
// feeling prompt without a per-minute request from an idle tab.
const ARMED_POLL_MS = 45_000;

/**
 * Every armed (and recently-resolved) intent for the account. A pure DB read server-side, so
 * polling it is cheap — it never touches GitHub. Drives both the PR-detail armed state and
 * the global AutoMergeBanner toast.
 */
export function useArmedMerges(enabled = true) {
  return useQuery<ArmedMergeListResponse>({
    queryKey: ARMED_MERGES_KEY,
    queryFn: () => api.armedMerges(),
    enabled,
    refetchInterval: ARMED_POLL_MS,
    // The list is only interesting when the user is looking; a background tab polling for a
    // toast it can't show is pure waste (the toast appears on the next foreground poll).
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

/**
 * The live armed intent for ONE PR — a selector over the account-wide list the app already
 * polls (AutoMergeBanner keeps the query warm), so it costs zero new requests. The list also
 * carries recently-RESOLVED intents for 24h, so row existence is NOT armed-ness: only
 * `state === 'armed'` counts. Cross-tab the answer can lag the 45s poll; the user's OWN
 * arm/disarm is instant via the ARMED_MERGES_KEY invalidation below.
 */
export function usePrArmedIntent(prId: number | null): ArmedMergeRequest | null {
  const { data } = useArmedMerges();
  if (prId == null) return null;
  return data?.requests.find((r) => r.prId === prId && r.state === 'armed') ?? null;
}

/**
 * Arm auto-merge on one PR. The server pins the LIVE head SHA, so the returned request's
 * `expectedHeadOid` is the consent anchor — a later push disarms rather than merging.
 */
export function useArmAutoMerge(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ArmMergeBody) => api.armAutoMerge(prId, body),
    onSuccess: () => {
      // merge-options carries `autoMerge.armed`, which is what the merge control renders.
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ARMED_MERGES_KEY });
    },
  });
}

/** Disarm (idempotent server-side — a 204 whether or not anything was armed). */
export function useDisarmAutoMerge(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.disarmAutoMerge(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ARMED_MERGES_KEY });
    },
  });
}

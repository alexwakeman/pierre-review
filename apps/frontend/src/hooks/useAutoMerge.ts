import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArmMergeBody, ArmedMergeListResponse, ArmedMergeRequest } from '@pierre-review/shared';
import { api } from '../api/client.js';

// ---- Auto-merge ("merge when ready") -----------------------------------------------------
//
// Pierre-side, not GitHub's native auto-merge: arming stores an intent and a server-side
// watcher lands the PR when the blockers clear. The watcher only runs WHILE THE SERVER IS
// RUNNING, which every surface here says out loud rather than implying a cloud guarantee.

export const ARMED_MERGES_KEY = ['auto-merge'] as const;

// How often the cross-PR list is re-read when NOTHING is armed — the query still has to exist
// (it is what notices a fresh arm from another tab), but nothing is moving.
const ARMED_IDLE_POLL_MS = 45_000;
// …and while at least one intent is live. The watcher ticks every ~2 minutes, so this is not
// about seeing every phase change the instant it happens; it is about a card that is drawing a
// PHASE not lagging the DB by most of a minute. Faster than this would just add requests
// between two watcher ticks.
const ARMED_LIVE_POLL_MS = 8_000;

/** The row shape the cache holds, so the optimistic writers below can be spelled once. */
type ArmedList = ArmedMergeListResponse;

/**
 * Every armed (and recently-resolved) intent for the account. A pure DB read server-side, so
 * polling it is cheap — it never touches GitHub. Drives the PR-detail armed state and the
 * global AutoMergeBanner progress stack, which is why the cadence is adaptive: an idle account
 * must not pay a per-8s request for a stack that renders nothing.
 */
export function useArmedMerges(enabled = true) {
  return useQuery<ArmedMergeListResponse>({
    queryKey: ARMED_MERGES_KEY,
    queryFn: () => api.armedMerges(),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.requests.some((r) => r.state === 'armed')
        ? ARMED_LIVE_POLL_MS
        : ARMED_IDLE_POLL_MS,
    // The list is only interesting when the user is looking; a background tab polling for a
    // card it can't show is pure waste (the card catches up on the next foreground poll).
    refetchIntervalInBackground: false,
    staleTime: 5_000,
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
    onSuccess: (armed) => {
      // merge-options carries `autoMerge.armed`, which is what the merge control renders.
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      // SEED the list from the POST's own response — it is the full row, identity and
      // `phase: 'pending_first_check'` included. Without this the progress card only appears
      // on the next poll, i.e. the surface that exists to say "I heard you" would be up to a
      // poll interval late on the one action it acknowledges. The invalidate still runs; this
      // is a head start, not a substitute (the row is authoritative server-side).
      qc.setQueryData<ArmedList>(ARMED_MERGES_KEY, (prev) =>
        prev == null
          ? { requests: [armed] }
          : { requests: [armed, ...prev.requests.filter((r) => r.prId !== armed.prId)] },
      );
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
      // The DELETE removes the row outright (no terminal state to observe), so drop it here
      // too: the progress card must go on the click, not linger until the refetch lands.
      qc.setQueryData<ArmedList>(ARMED_MERGES_KEY, (prev) =>
        prev == null ? prev : { requests: prev.requests.filter((r) => r.prId !== prId) },
      );
      void qc.invalidateQueries({ queryKey: ARMED_MERGES_KEY });
    },
  });
}

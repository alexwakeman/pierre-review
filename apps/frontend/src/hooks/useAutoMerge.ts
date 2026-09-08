import { useSyncExternalStore } from 'react';
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

// ---- The ARM DRAFT — a half-finished confirmation, keyed by PULL REQUEST --------------------
//
// ⚠ WHY THIS IS NOT `useState` INSIDE THE CONTROL. A Pending card's React key IS its card id, and
// the server builds the two forward-card ids as `wp:merge:<prId>` and `wp:update_branch:<prId>`
// (db/queries.ts) — THE MERGE KIND IS IN THE KEY. So the moment trunk moves under a PR and the
// next board response flips it clean→behind, the card's key changes, React unmounts the whole
// subtree and mounts a fresh one, and every plain `useState` in it is gone. That is the reported
// bug end to end: arm one or two PRs, the auto-merge runner lands them on its ~2-minute tick,
// trunk moves, the 60s liveness sweep reports `changed > 0` and re-fetches the board, and the
// third card — the one you were half-way through confirming — silently reverts to an unpressed
// button. Nothing errors, and it looks like a dead button rather than a remount, because
// `useMergeOptions` is CACHED (30s staleTime, 5min gc): the new mount reads the GitHub answer
// straight back out of the cache and renders the full un-pressed button rather than the compact
// "ask GitHub" trigger.
//
// ⚠ KEYED BY prId, NEVER BY CARD ID — the card id is the thing that changes.
//
// A module-level store rather than a `store/filters.ts` slice, following `useAnnotations`' RUNNING
// set: this is per-PR interaction state with one reader and one writer, it never reaches the URL,
// and it must never be persisted (a confirmation left open yesterday is not consent today). The
// filters store is persisted AND mirrored to the URL, so putting a consent step in it would make
// both true by accident.

/** What the reader has done so far on ONE pull request. `idle` is the absence of an entry. */
export type ArmDraft = 'idle' | 'asked' | 'confirming';

export type ArmDraftEvent =
  /** Clicked the compact trigger: bought the merge-options call for this PR. */
  | { type: 'ask' }
  /** Clicked "Merge when ready": the contract sentence + "Arm auto-merge" are on screen. */
  | { type: 'confirm' }
  /** Backed out of the confirm step. Drops to `asked`, not `idle` — the GitHub answer is already
   *  bought, and re-asking for it would be a second round trip for nothing. */
  | { type: 'cancel' }
  /** An armed intent now owns this row — the POST landed, or a cancel removed the one that was
   *  there. Either way nothing local is left to hold, and a STRANDED draft would pop the confirm
   *  panel open the instant the chip went away (reachable cross-tab: the other tab's arm reaches
   *  this one through the polled list, leaving this tab's draft behind the chip). */
  | { type: 'settled' };

export function armDraftReducer(state: ArmDraft, event: ArmDraftEvent): ArmDraft {
  switch (event.type) {
    case 'ask':
      // One-way, exactly like the per-mount `asked` flag it replaces: once the reader has paid for
      // the answer, nothing may take it back and make them click a second time to see it.
      return state === 'idle' ? 'asked' : state;
    case 'confirm':
      return 'confirming';
    case 'cancel':
      return state === 'confirming' ? 'asked' : state;
    case 'settled':
      return 'idle';
  }
}

/** Everything the control can be showing, in the order the component branches on it. */
export type ArmPhase = 'idle' | 'asked' | 'confirming' | 'arming' | 'armed';

/**
 * THE ONE PLACE THAT DECIDES WHAT THE CONTROL SHOWS — and the reason there is never a frame with
 * neither the confirmation nor the armed chip on it.
 *
 * ⚠ `armed` OUTRANKS `arming`, and the overlap is real rather than theoretical: TanStack runs a
 * mutation's hook-level `onSuccess` (which seeds the armed list) BEFORE it dispatches 'success',
 * so for one render the intent already exists while the mutation is still counted in flight. The
 * server-confirmed fact wins; the alternative is a row saying "Arming…" about a PR already armed.
 *
 * ⚠ ARMED-NESS NEVER COMES FROM THE DRAFT. `intentArmed` is `usePrArmedIntent`, a live server row.
 * A draft that remembered "armed" would keep claiming it after the watcher had given up.
 */
export function armControlPhase(input: {
  draft: ArmDraft;
  /** `usePrArmedIntent(prId) != null` — a live `state === 'armed'` row, not a local flag. */
  intentArmed: boolean;
  /** The arm POST for THIS pr, read off the shared mutation key so it survives a remount. */
  posting: boolean;
}): ArmPhase {
  if (input.intentArmed) return 'armed';
  if (input.posting) return 'arming';
  return input.draft;
}

const ARM_DRAFTS = new Map<number, ArmDraft>();
const ARM_DRAFT_LISTENERS = new Set<() => void>();

function subscribeArmDrafts(onChange: () => void): () => void {
  ARM_DRAFT_LISTENERS.add(onChange);
  return () => {
    ARM_DRAFT_LISTENERS.delete(onChange);
  };
}

/** One PR's draft with no React attached — what `useArmDraft` reads on every render. */
export function armDraftFor(prId: number): ArmDraft {
  return ARM_DRAFTS.get(prId) ?? 'idle';
}

/** Returns a primitive, so a fresh getSnapshot closure per render is fine. */
export function useArmDraft(prId: number): ArmDraft {
  return useSyncExternalStore(subscribeArmDrafts, () => armDraftFor(prId));
}

/** The ONE writer. `idle` DELETES the entry, so the map never outgrows the reader's own clicks. */
export function dispatchArmDraft(prId: number, event: ArmDraftEvent): void {
  const prev = armDraftFor(prId);
  const next = armDraftReducer(prev, event);
  if (next === prev) return;
  if (next === 'idle') ARM_DRAFTS.delete(prId);
  else ARM_DRAFTS.set(prId, next);
  for (const l of ARM_DRAFT_LISTENERS) l();
}

// ⚠ EXPLICIT KEY, BECAUSE THE IN-FLIGHT FACT MUST OUTLIVE THE MOUNT THAT STARTED IT — the same
// rule `mergePrMutationKey` / `updateBranchMutationKey` live under, and for a sharper reason here:
// a per-mount `arm.isPending` is not merely invisible to a second mount, it is DESTROYED by the
// card-id remount described above, so a POST that is still in flight renders as an untouched
// button and invites a second one. Read it with `useIsMutating({ mutationKey })`.
export function armAutoMergeMutationKey(prId: number): unknown[] {
  return ['arm-auto-merge', prId];
}

/**
 * Arm auto-merge on one PR. The server pins the LIVE head SHA, so the returned request's
 * `expectedHeadOid` is the consent anchor — a later push disarms rather than merging.
 */
export function useArmAutoMerge(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: armAutoMergeMutationKey(prId),
    mutationFn: (body: ArmMergeBody) => api.armAutoMerge(prId, body),
    // ⚠ HOOK-LEVEL, NEVER `mutate(..., { onSuccess })`. A mutate-scoped callback is skipped when
    // the observer has no listeners, i.e. exactly when the card remounted mid-POST — which is the
    // case this whole slice exists for. With the draft now OUTLIVING the mount, a lost callback no
    // longer merely fails to tidy up: it would strand the row in `confirming` forever, behind an
    // armed chip, with an "Arm auto-merge" button offering to arm it a second time.
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
      // ⚠ ['attention-cards'] IS DELIBERATELY ABSENT, even though the Pending board now arms from
      // its own rows. Arming changes nothing that board's response carries — the PR is still
      // merge-ready and still on it — and the armed row it draws reads `usePrArmedIntent`, a
      // selector over the list seeded three lines up, so the card updates on the click either way.
      // `/api/attention` is on the `search` rate tier (it folds getWorkspaceInsights); spending a
      // round trip there to re-render an unchanged list is a cost with no observable effect. The
      // MERGE itself does invalidate it — see useMergePr — because that really does retire a card.
      //
      // ⚠ LAST, AFTER THE SEED, AND THE ORDER IS THE POINT. `armControlPhase` reads the intent
      // first and the draft last, so seeding then clearing hands the row straight from the
      // confirmation to the chip; clearing first would open a frame in which the draft says `idle`
      // and the list has not been seeded yet — the un-pressed button, one render after a
      // successful arm.
      dispatchArmDraft(prId, { type: 'settled' });
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
      // The chip is going away this render, so any draft hiding behind it must go with it —
      // otherwise cancelling an intent armed in ANOTHER TAB (which reached this one through the
      // polled list, leaving this tab's half-finished draft underneath) replaces the chip with a
      // confirm panel the reader never re-opened.
      dispatchArmDraft(prId, { type: 'settled' });
    },
  });
}

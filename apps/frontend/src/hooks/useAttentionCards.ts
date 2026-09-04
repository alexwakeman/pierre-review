import { useEffect } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttentionCardsResponse,
  AttentionLivenessResponse,
  MyTurnDismissKind,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The **Pending** cards (stalled reviews / untouched threads / reviewer load / needs-a-
// reviewer) — CORE/free, powering the Activity rail's **Pending** entry. Same scope semantics
// + sync cadence as the Pro Insights hook, but NO capability gate (every tier). The workspace is in
// the cache key so each one caches independently, and the key stays `['attention-cards', …]` so a
// reviewer "Assign" (which invalidates that PREFIX — see usePrWrites) refreshes every workspace's
// copy of the tab.
export function useAttentionCards(workspaceId: number | null) {
  return useQuery<AttentionCardsResponse>({
    queryKey: ['attention-cards', workspaceKey(workspaceId)],
    // `skipToken` (not `enabled`) holds it idle until the store's id resolves: it is the form that
    // NARROWS `workspaceId` to a number, so an unscoped request — which the server would answer
    // from the account's DEFAULT workspace — is unrepresentable rather than merely discouraged.
    queryFn: workspaceId == null ? skipToken : () => api.attentionCards(workspaceId),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    // ⚠ SCOPED TO THIS QUERY, NEVER THE APP DEFAULT. `main.tsx` sets `refetchOnWindowFocus:false`
    // globally, and that is the right default for a persisted PR-detail cache and a heavy vis
    // board. But it left the ONE surface whose whole claim is "here is what is still outstanding"
    // frozen at whatever it fetched before you switched to GitHub, merged three PRs by hand and
    // came back — the cards you had just retired were still on it. Focus is the cheapest possible
    // signal that the world may have moved, and `staleTime: 60_000` bounds it: rapid tab flipping
    // refetches at most once a minute, well inside the route's 60/min `search` tier.
    //
    // ⚠ It must be set here, on `useDailyBrief` and on `useWorkPlan` TOGETHER — the three are one
    // fold read three times, and a focus policy on only one of them is two snapshots of one
    // population, which is precisely the "the strip says 5, the board lists 3" defect.
    refetchOnWindowFocus: true,
  });
}

/**
 * THE BOARD'S LIVENESS SWEEP — one batched GitHub question for the whole board.
 *
 * The query above is served entirely from synced rows, which is what lets it paint fifty cards
 * for the price of one request. Its cost is staleness against GITHUB: a PR merged, closed or
 * unblocked by SOMEBODY ELSE keeps its card until the adaptive scheduler walks that repo — two
 * minutes on a hot repo, fifteen on a cold one. This hook closes that, for 2 GraphQL points per
 * sweep, by handing the server the ids the board is showing and letting it re-read them in one
 * `nodes(ids:)` call. See sync/pr-liveness-sweep.ts for the measured cost model.
 *
 * ⚠ IT REFETCHES THE BOARD. IT NEVER EDITS IT. The response carries counts, not cards, precisely
 * so that "the probe proved this card is dead" cannot be implemented as a local splice: the board
 * is `head ∪ tail === cards`, disjoint, and every cap disclosure gates on `shown === count` where
 * `shown` is counted off this list and `count` comes from `useDailyBrief`. Drop one card locally
 * and the "50 of 148" line vanishes silently on exactly the workspaces where the cap bites. So on
 * `changed > 0` we invalidate the board and the brief TOGETHER, and let the server re-rank.
 *
 * ⚠ NOT A PER-CARD FETCH, AND THIS IS THE RULE IT LIVES UNDER. Nothing on the board may fetch on
 * mount — `MergeWhenReadyControl` is mounted with `eager={false}` for exactly this reason, since
 * fifty cards asking for their own merge-options is ~200 upstream calls to paint a screen. ONE
 * board-level batched sweep is the sanctioned alternative to that, not an exception to it.
 *
 * ⚠ THE QUERY KEY DOES NOT CARRY THE IDS. It is `['attention-liveness', 'ws:<id>']` and the ids
 * ride the closure: keying on them would make the sweep refetch every time the board refetched,
 * and since a sweep can CAUSE a board refetch that is a loop with a GitHub call in it.
 */
const LIVENESS_POLL_MS = 60_000;

/**
 * How many distinct PR ids one sweep may carry.
 *
 * ⚠ MIRRORS the server's `PR_LIVENESS_MAX_IDS` (sync/pr-liveness-sweep.ts), which is GitHub's
 * `nodes(ids:)` batch. The server 400s an over-cap request rather than truncating it — a board
 * that believed it was freshened and was not is worse than one that knows it asked too much — so
 * the CALLER ranks before it slices, and this constant is what it slices to. Two spellings of one
 * number, and the server's is the enforcer.
 */
export const ATTENTION_LIVENESS_MAX_IDS = 90;

export function useAttentionLiveness(
  workspaceId: number | null,
  prIds: number[],
  enabled: boolean,
): void {
  const qc = useQueryClient();
  const ids = prIds;
  const query = useQuery<AttentionLivenessResponse>({
    queryKey: ['attention-liveness', workspaceKey(workspaceId)],
    queryFn:
      workspaceId == null
        ? skipToken
        : () => api.attentionLiveness(workspaceId, { prIds: ids }),
    // The board must actually be on screen with cards on it. An empty board has nothing to
    // freshen, and a sweep of zero ids is a request that can only ever answer "checked: 0".
    enabled: enabled && ids.length > 0,
    // A minute is the whole design budget: 2 GraphQL points a minute per open board is ~120
    // points/hour against a 5,000-point window, and the route sits on the 60/min `prDetail`
    // bucket. Faster buys very little — the expensive half already takes ~5s of that minute.
    refetchInterval: LIVENESS_POLL_MS,
    refetchIntervalInBackground: false,
    // The "I merged three PRs on GitHub and came back" case, and the reason this hook is worth
    // more than the interval alone. `staleTime` bounds a burst of tab-flipping to one sweep.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    // A failed sweep is a board rendering synced rows — which is what it rendered before this
    // existed. Never retried into a loop, never surfaced: `paused` is a rate-limit fact, not an
    // error, and the caller renders nothing for either.
    retry: false,
    gcTime: 0,
  });

  const { data, dataUpdatedAt } = query;
  useEffect(() => {
    if (!data || data.changed <= 0) return;
    // BOTH KEYS, ONE SNAPSHOT — `shown` is counted off the board and `count` comes off the brief,
    // and `capFor` compares them for equality. Refreshing one without the other is the
    // "the strip says 5, the board lists 3" defect with a GitHub call in front of it.
    void qc.invalidateQueries({ queryKey: ['attention-cards'] });
    void qc.invalidateQueries({ queryKey: ['daily-brief'] });
    // The third read of the same fold (the ranked plan under the board). See ACTIVITY_QUERY_KEYS.
    void qc.invalidateQueries({ queryKey: ['work-plan'] });
    // Keyed on dataUpdatedAt as well as data (the usePrLiveRefresh rule): two consecutive sweeps
    // can report an identical `changed` count over different PRs, and each still needs its
    // repaint.
  }, [data, dataUpdatedAt, qc]);
}

// "Done" on a `my_turn` attention card → POST /api/my-turn/dismiss. The route and the
// `my_turn_dismissals` table have existed all along; nothing in the SPA could reach them because
// `api.dismissMyTurn` did not exist (only its `undismiss` twin did).
//
// OPTIMISTIC, deliberately: a dismissal is a "mark as seen" click, and the whole point of this
// surface is that a click does something visible immediately. We drop the card from every cached
// attention response (`setQueriesData` on the PREFIX — a card id is unique across workspaces, and
// only the owning workspace can hold it), roll back on error, and re-fetch on settle.
//
// ⚠ The three invalidations are NOT interchangeable with the optimistic write:
//   ['attention-cards'] — this board (the server backfills card #51 under the my_turn cap)
//   ['daily-brief']     — the "N need your review or reply" line, which counts these very cards
//   ['my-turn']         — the older My-Turn triage surfaces reading the same rows
// The brief count is deliberately NOT patched optimistically: it is capped at the same
// MY_TURN_CARD_CAP as the list, so on a workspace above the cap dismissing one card leaves the
// number unchanged, and a local decrement would flash a figure the server never reports.
export function useDismissMyTurn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kind: MyTurnDismissKind; refId: number; cardId: string }) =>
      api.dismissMyTurn(vars.kind, vars.refId),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['attention-cards'] });
      const snapshot = qc.getQueriesData<AttentionCardsResponse>({ queryKey: ['attention-cards'] });
      qc.setQueriesData<AttentionCardsResponse>({ queryKey: ['attention-cards'] }, (prev) =>
        prev == null ? prev : { ...prev, cards: prev.cards.filter((c) => c.id !== vars.cardId) },
      );
      return { snapshot };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
    },
  });
}

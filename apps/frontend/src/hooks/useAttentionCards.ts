import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttentionCardsResponse, MyTurnDismissKind } from '@pierre-review/shared';
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
  });
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

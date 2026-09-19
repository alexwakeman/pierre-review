import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, MyTurnSettings, MyTurnSettingsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// ── MY TURN SETTINGS, client side ────────────────────────────────────────────────────────────
//
// ACCOUNT-GRAINED, so it rides `/api/me` like the blast-radius config next door (`['me']`, no
// `ws:<id>` segment). `/api/me` carries the RAW stored overrides, and the Settings form resolves
// them through the ONE shared resolver (`seedMyTurnForm` → `resolveMyTurnSettings`) — the server
// resolves through the same function, so the form and the fold cannot disagree about "unset".
//
// ⚠ THERE IS DELIBERATELY NO "resolved settings" HOOK FOR THE BOARD. The board explains ITS order
// from the `rules` the server sent with the cards (`AttentionCardsResponse.rules`): between a save
// and the board's refetch the two differ, and an explanation must describe the list on screen.

/** One spelling of the write's key — see `useSetMyTurnSettings`. */
const MY_TURN_SETTINGS_MUTATION_KEY = ['my-turn-settings'] as const;

/**
 * Write the account's settings. `null` resets everything to the product default.
 *
 * ⚠ ONE SAVE MOVES FIVE READS, AND THEY MOVE TOGETHER. A type switched off leaves the list, every
 * count, the brief lines and the notifications at once (the gate runs inside `getMyTurn`), so:
 *   • `['me']` — Settings re-seeds from what was stored;
 *   • `['my-turn']` — the notification watcher, which re-baselines on the new `configKey` rather
 *     than announcing a backlog it was just told to show;
 *   • `['attention-cards']` + `['daily-brief']` + `['work-plan']` — the THREE reads of the one
 *     board fold, invalidated together (the liveness rule): the brief's count and the board's list
 *     are compared for equality by the cap disclosures, and the plan's `stale` chip exists to say
 *     the list moved. `useMyTurnByWorkspace` rides `['daily-brief']`.
 */
export function useSetMyTurnSettings() {
  const qc = useQueryClient();
  return useMutation<MyTurnSettingsResponse, Error, MyTurnSettings | null>({
    mutationKey: MY_TURN_SETTINGS_MUTATION_KEY,
    mutationFn: (settings) => api.setMyTurnSettings(settings),
    onSuccess: (res) => {
      // Seat what the DATABASE holds at once, so the form does not flash back to the old value
      // while `/api/me` refetches.
      qc.setQueryData<MeResponse>(['me'], (prev) =>
        prev != null ? { ...prev, myTurnSettings: res.myTurnSettings } : prev,
      );
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
    },
  });
}

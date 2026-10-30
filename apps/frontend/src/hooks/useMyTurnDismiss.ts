import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { MyTurnDismissTarget } from '@pierre-review/shared';
import { api } from '../api/client.js';

// ── DISMISSING A MY TURN ENTRY, client side ──────────────────────────────────────────────────
//
// The server decides everything (db/my-turn-dismissals.ts): a dismissal hides a PR — or a red
// default branch's repo — from My Turn until something newer happens on it, and drops itself once
// the subject leaves your plate. This file only asks, re-reads and offers an Undo.
//
// ⚠ NOTHING IS SPLICED OUT LOCALLY. The board's counts and its cap disclosures compare the list
// with the brief (`capFor`'s `shown === count`), so a card removed on the client would break that
// pairing. Instead the mutation stays PENDING until the reads it moved have refetched — the button
// says "Dismissing…" and the card leaves with the refetch, the counts moving in the same frame.
//
// ⚠ FOUR READS MOVE TOGETHER, the My Turn settings save's list: `['my-turn']` (the notification
// watcher), and the three reads of the one board fold — `['attention-cards']`, `['daily-brief']`,
// `['work-plan']`.

async function refetchMyTurnReads(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['my-turn'] }),
    qc.invalidateQueries({ queryKey: ['attention-cards'] }),
    qc.invalidateQueries({ queryKey: ['daily-brief'] }),
    qc.invalidateQueries({ queryKey: ['work-plan'] }),
  ]);
}

// ⚠ A RESTORE MUST NOT RING. A restored entry comes back with its OLD clock, and the notification
// watcher diffs item ids, so without this it would announce the entry as new. One-shot, read by
// `useMyTurnNotifications`, which re-baselines instead of firing on its next change.
let rebaselinePending = false;
export function consumeMyTurnRebaseline(): boolean {
  const pending = rebaselinePending;
  rebaselinePending = false;
  return pending;
}

// ── THE PENDING INBOX'S OPTIMISTIC PATH (`e` and the panel's Dismiss) ──────────────────────────
//
// The inbox removes the row AT ONCE (components/ui/undo.ts) and offers Undo in the one header
// strip, so it needs only the two writes (the old per-card toast is gone). Same server calls,
// same four reads moved together; the restore re-baselines the notification watcher exactly like
// `useRestoreMyTurn`, so an undone dismissal never rings.
//
// ⚠ THE ROW IS HIDDEN ONLY UNTIL THESE REFETCHES LAND: `useOptimisticList` drops the hidden key
// once the board no longer lists the card, and the caller un-hides it if the board still does —
// so the counts and the cap disclosures read the server's figures again within one refetch.

/** Dismiss now and wait for the board to move. Throws on failure (the caller puts the row back). */
export async function dismissMyTurnNow(qc: QueryClient, target: MyTurnDismissTarget): Promise<void> {
  await api.dismissMyTurn(target);
  await refetchMyTurnReads(qc);
}

/** Bring a dismissed subject back (the Undo of `dismissMyTurnNow`). */
export async function restoreMyTurnNow(qc: QueryClient, target: MyTurnDismissTarget): Promise<void> {
  rebaselinePending = true;
  try {
    await api.restoreMyTurn(target);
  } finally {
    // A 404 means the dismissal had already gone: either way, show what is true now.
    await refetchMyTurnReads(qc);
  }
}

/** Bring a subject back — the Dismissed list's rows. */
export function useRestoreMyTurn() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['my-turn-restore'],
    mutationFn: (target: MyTurnDismissTarget) => api.restoreMyTurn(target),
    onSuccess: async () => {
      rebaselinePending = true;
      await refetchMyTurnReads(qc);
    },
    // A 404 means the server had already dropped the dismissal (the entry left your plate, or came
    // back on its own). Refetch and show what is true now.
    onError: async () => {
      await refetchMyTurnReads(qc);
    },
  });
}

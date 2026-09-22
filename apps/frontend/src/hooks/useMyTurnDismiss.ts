import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
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

/** What the Undo toast names. */
export interface LastDismissed {
  target: MyTurnDismissTarget;
  /** "acme/api #12", or the repo for a red default branch. */
  label: string;
}

/** The Undo toast's one piece of state — the most recent dismissal, until undone or timed out. */
export const useMyTurnDismissToast = create<{
  last: LastDismissed | null;
  show: (d: LastDismissed) => void;
  clear: () => void;
}>((set) => ({
  last: null,
  show: (d) => set({ last: d }),
  clear: () => set({ last: null }),
}));

// ⚠ A RESTORE MUST NOT RING. A restored entry comes back with its OLD clock, and the notification
// watcher diffs item ids, so without this it would announce the entry as new. One-shot, read by
// `useMyTurnNotifications`, which re-baselines instead of firing on its next change.
let rebaselinePending = false;
export function consumeMyTurnRebaseline(): boolean {
  const pending = rebaselinePending;
  rebaselinePending = false;
  return pending;
}

const keyOf = (t: MyTurnDismissTarget) => ['my-turn-dismiss', t.kind, t.id] as const;

/** Dismiss ONE subject. Per-target mutation key, so each card knows only about its own press. */
export function useDismissMyTurn(target: MyTurnDismissTarget, label: string) {
  const qc = useQueryClient();
  const toast = useMyTurnDismissToast((s) => s.show);
  return useMutation({
    mutationKey: keyOf(target),
    mutationFn: () => api.dismissMyTurn(target),
    onSuccess: async () => {
      // Awaited, so the button stays "Dismissing…" until the card has actually gone.
      await refetchMyTurnReads(qc);
      toast({ target, label });
    },
  });
}

/** Bring a subject back — the toast's Undo and the Dismissed list's rows. */
export function useRestoreMyTurn() {
  const qc = useQueryClient();
  const clear = useMyTurnDismissToast((s) => s.clear);
  return useMutation({
    mutationKey: ['my-turn-restore'],
    mutationFn: (target: MyTurnDismissTarget) => api.restoreMyTurn(target),
    onSuccess: async () => {
      rebaselinePending = true;
      clear();
      await refetchMyTurnReads(qc);
    },
    // A 404 means the server had already dropped the dismissal (the entry left your plate, or came
    // back on its own). Refetch and show what is true now.
    onError: async () => {
      clear();
      await refetchMyTurnReads(qc);
    },
  });
}

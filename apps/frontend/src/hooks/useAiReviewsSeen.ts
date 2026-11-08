import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiReviewCard } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { aiReviewsStampToSend } from '../lib/aiReviewsSeen.js';
import { rowsToRecord } from '../lib/aiReviewsLedger.js';
import { useAiReviewsLedger } from '../store/aiReviewsSeen.js';
import { workspaceKey } from './useActivity.js';

// PENDING → "AI REVIEWS": ONE VISIT'S "NEW" LINE, AND THE LAST-LOOKED STAMP (lib/aiReviewsSeen.ts;
// docs/FRONTEND.md § The AI reviews list).
//
// The rows are the server's list as it stands — a stable reference, never cut by looking. This hook
// only (1) holds the stamp the VISIT started with (`baseline`), so a row's "New" tag stays while the
// tab is on screen, and (2) moves the workspace's stamp to the newest row shown
// (`POST /api/attention/ai-reviews/seen`), at most once per newer review.
//
// ⚠ NEVER ON THE BOARD'S MOUNT FOR ANOTHER TAB: nothing is sent unless "AI reviews" is the tab on
// screen and the page is visible — the reader looking IS the action. The POST refetches the board
// (its badge), not the daily brief, which never counts these. ⚠ It cannot loop: see
// `aiReviewsStampToSend`.
//
// (3) THE SEEN BLOCKS: while the tab is on screen and the page visible, every row New against the
// visit's stamp is written to this browser's ledger (store/aiReviewsSeen.ts) at the VISIT's start
// time, rows arriving by poll included, so the next visit draws them as "Seen today 14:32". A
// workspace never looked at records nothing.

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

const parseIso = (iso: string | null | undefined): number | null => {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export function useAiReviewsSeen(opts: {
  workspaceId: number | null;
  /** "AI reviews" is the tab on screen, with a settled response. */
  active: boolean;
  /** The tab's `ai_review` rows, as listed. */
  cards: readonly AiReviewCard[];
  /** The response's `aiReviewsSeenAt` (null = never looked; undefined = not sent). */
  seenAt: string | null | undefined;
}): { baseline: number | null; visitStartMs: number | null } {
  const { workspaceId, active, cards, seenAt } = opts;
  const visible = usePageVisible();
  const qc = useQueryClient();
  // The stamp the visit started with, per workspace; null key = no visit.
  const [visit, setVisit] = useState<{ ws: number | null; baseline: number | null; startMs: number | null }>({
    ws: null,
    baseline: null,
    startMs: null,
  });
  const ledger = useAiReviewsLedger((s) => s.ledger);
  const record = useAiReviewsLedger((s) => s.record);
  // The newest time this visit has sent, so an unchanged list never posts twice.
  const sent = useRef<number | null>(null);

  const mark = useMutation({
    mutationFn: (v: { ws: number; through: number }) =>
      api.markAiReviewsSeen(v.ws, { through: new Date(v.through).toISOString() }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['attention-cards', workspaceKey(v.ws)] });
    },
  });
  const markRef = useRef(mark.mutate);
  markRef.current = mark.mutate;

  // The visit starts on the first settled response with the tab on screen, and ends when the tab or
  // the workspace changes.
  useEffect(() => {
    if (!active || workspaceId == null || seenAt === undefined) {
      if (!active || workspaceId == null) {
        sent.current = null;
        setVisit((v) => (v.ws == null ? v : { ws: null, baseline: null, startMs: null }));
      }
      return;
    }
    setVisit((v) => (v.ws === workspaceId ? v : { ws: workspaceId, baseline: parseIso(seenAt), startMs: Date.now() }));
  }, [active, workspaceId, seenAt]);

  useEffect(() => {
    if (!active || !visible || workspaceId == null || seenAt === undefined) return;
    const through = aiReviewsStampToSend(cards, parseIso(seenAt), sent.current);
    if (through == null) return;
    sent.current = through;
    markRef.current({ ws: workspaceId, through });
  }, [active, visible, workspaceId, cards, seenAt]);

  // The seen ledger: this visit's New rows, at the visit's start time.
  const inVisit = visit.ws != null && visit.ws === workspaceId;
  useEffect(() => {
    if (!active || !visible || !inVisit || visit.startMs == null) return;
    const rows = rowsToRecord(cards, ledger, visit.baseline);
    if (rows.length > 0) record(rows, visit.startMs);
  }, [active, visible, inVisit, visit.startMs, visit.baseline, cards, ledger, record]);

  return {
    baseline: inVisit ? visit.baseline : parseIso(seenAt),
    visitStartMs: inVisit ? visit.startMs : null,
  };
}

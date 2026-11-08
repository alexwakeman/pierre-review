import { create } from 'zustand';
import type { AiReviewCard } from '@pierre-review/shared';
import {
  AI_REVIEWS_LEDGER_KEY,
  emptyLedger,
  mergeLedgers,
  parseLedger,
  recordSeen,
  type AiReviewsLedger,
} from '../lib/aiReviewsLedger.js';

// PENDING → "AI REVIEWS": THIS BROWSER'S SEEN LEDGER (lib/aiReviewsLedger.ts). One localStorage
// key, per browser. Every read and write is in try/catch: a private window or blocked storage only
// means no seen blocks. Another tab's write arrives through the `storage` event and is MERGED
// (earliest seen time wins), and a write first merges what is stored, so two tabs never undo
// each other.

function readStored(): AiReviewsLedger {
  try {
    return parseLedger(localStorage.getItem(AI_REVIEWS_LEDGER_KEY));
  } catch {
    return emptyLedger();
  }
}

function writeStored(l: AiReviewsLedger): void {
  try {
    localStorage.setItem(AI_REVIEWS_LEDGER_KEY, JSON.stringify(l));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

interface AiReviewsSeenState {
  ledger: AiReviewsLedger;
  /** Records `rows` as seen in the visit that started at `visitStartMs`. */
  record: (rows: readonly Pick<AiReviewCard, 'reviewId' | 'prId'>[], visitStartMs: number) => void;
}

export const useAiReviewsLedger = create<AiReviewsSeenState>((set, get) => ({
  ledger: readStored(),
  record: (rows, visitStartMs) => {
    if (rows.length === 0) return;
    const now = Date.now();
    const base = mergeLedgers(get().ledger, readStored());
    const next = recordSeen(base, rows, visitStartMs, now);
    if (next !== base) writeStored(next);
    set({ ledger: next });
  },
}));

if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== AI_REVIEWS_LEDGER_KEY) return;
      useAiReviewsLedger.setState((s) => ({ ledger: mergeLedgers(s.ledger, parseLedger(e.newValue)) }));
    });
  } catch {
    /* no window events — one tab only */
  }
}

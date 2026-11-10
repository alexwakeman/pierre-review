import { create } from 'zustand';

// THE "REVIEW STARTED" NOTE for a start made from a place that closes as it is pressed (the Open PRs
// row menu). It shows on the AI reviews circle in the ONE toast cluster (ClaudeReviewBanner) — never a
// toast of its own — for a few seconds, or until dismissed. A failed start leaves its reason there.
// Transient, never persisted.

export const REVIEW_START_NOTE_MS = 6_000;

export interface ReviewStartNote {
  /** Bumped per note, so a newer note restarts the timer. */
  id: number;
  prId: number;
  prNumber: number;
  /** Null: the start was accepted. Else the reason it was not. */
  error: string | null;
}

interface ReviewStartNoteStore {
  note: ReviewStartNote | null;
  show: (n: Omit<ReviewStartNote, 'id'>) => void;
  clear: (id?: number) => void;
}

let seq = 0;

export const useReviewStartNote = create<ReviewStartNoteStore>((set) => ({
  note: null,
  show: (n) => set({ note: { ...n, id: ++seq } }),
  // With an id: only that note (a timer must not clear a newer one).
  clear: (id) => set((s) => (id == null || s.note?.id === id ? { note: null } : s)),
}));

/** The note's line: "Review started for #615", or why it did not start. */
export function reviewStartNoteText(n: Pick<ReviewStartNote, 'prNumber' | 'error'>): string {
  return n.error == null ? `Review started for #${n.prNumber}` : `Review not started for #${n.prNumber}`;
}

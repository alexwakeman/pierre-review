import { create } from 'zustand';
import {
  CLAUDE_REVIEW_CHAT_MAX_PINS,
  type ClaudeReviewChatPinRef,
} from '@pierre-review/shared';

// "SEND TO CHAT" — the findings and story items the reader has pinned to a PR's Review chat, waiting
// for the next Ask. In memory only (never storage, never the URL, never the server until asked):
// a reload starts empty. Keyed by PR, because a story item belongs to a ticket review, not to one
// Claude Review run; a FINDING pin also carries its review id, and the chat panel shows (and sends)
// only the finding pins of the run it is about — so switching to an older run hides, never mixes.
//
// `chats` is which review run's chat panel is MOUNTED for each PR: the Send to chat buttons render
// only when there is a chat to send to. `focus` is a tick the panel answers by opening and scrolling
// into view.

export interface ChatPinEntry {
  key: string;
  ref: ClaudeReviewChatPinRef;
  // Display only — the server builds its own label from the stored row.
  label: string;
  // A finding pin's review run (null for a story item).
  reviewId: number | null;
}

export type PinOutcome = 'added' | 'already' | 'full';

export const chatPinKey = (r: ClaudeReviewChatPinRef): string =>
  r.kind === 'finding' ? `f:${r.findingId}` : `s:${r.ticketReviewId}:${r.itemId}`;

/** The pins a chat about `reviewId` shows and sends: every story item, and its own run's findings. */
export function pinsForChat(entries: readonly ChatPinEntry[], reviewId: number): ChatPinEntry[] {
  return entries.filter((e) => e.reviewId == null || e.reviewId === reviewId);
}

interface ReviewChatPinsState {
  byPr: Readonly<Record<number, readonly ChatPinEntry[]>>;
  chats: Readonly<Record<number, number>>;
  focus: { prId: number; tick: number } | null;
  pin: (prId: number, entry: Omit<ChatPinEntry, 'key'>) => PinOutcome;
  unpin: (prId: number, key: string) => void;
  /** Drop these keys (sent), or put them back (a failed send) — `restore` keeps order, skips dupes. */
  remove: (prId: number, keys: readonly string[]) => void;
  restore: (prId: number, entries: readonly ChatPinEntry[]) => void;
  registerChat: (prId: number, reviewId: number) => void;
  unregisterChat: (prId: number, reviewId: number) => void;
}

export const useReviewChatPins = create<ReviewChatPinsState>((set, get) => ({
  byPr: {},
  chats: {},
  focus: null,
  pin: (prId, entry) => {
    const key = chatPinKey(entry.ref);
    const list = get().byPr[prId] ?? [];
    const tick = (get().focus?.tick ?? 0) + 1;
    if (list.some((e) => e.key === key)) {
      set({ focus: { prId, tick } });
      return 'already';
    }
    // The cap counts what THIS chat would send, so an older run's hidden finding pins never block it.
    const chatReview = get().chats[prId];
    const visible = chatReview != null ? pinsForChat(list, chatReview) : list;
    if (visible.length >= CLAUDE_REVIEW_CHAT_MAX_PINS) {
      set({ focus: { prId, tick } });
      return 'full';
    }
    set({ byPr: { ...get().byPr, [prId]: [...list, { ...entry, key }] }, focus: { prId, tick } });
    return 'added';
  },
  unpin: (prId, key) => {
    const list = get().byPr[prId] ?? [];
    set({ byPr: { ...get().byPr, [prId]: list.filter((e) => e.key !== key) } });
  },
  remove: (prId, keys) => {
    const drop = new Set(keys);
    const list = get().byPr[prId] ?? [];
    set({ byPr: { ...get().byPr, [prId]: list.filter((e) => !drop.has(e.key)) } });
  },
  restore: (prId, entries) => {
    const list = get().byPr[prId] ?? [];
    const have = new Set(list.map((e) => e.key));
    const merged = [...entries.filter((e) => !have.has(e.key)), ...list];
    // ⚠ THE CAP HOLDS ON RESTORE TOO. Ask empties the pins at once, so the reader may pin more while
    // the send is in flight; a failed send putting its own back must not leave this chat over the
    // cap (the server 400s TooManyPins, and the restore would repeat it for ever). What this chat
    // would send is capped, the NEWEST over-cap pins go — the same ones `pin` would have refused.
    const chatReview = get().chats[prId];
    const counts = (e: ChatPinEntry): boolean => chatReview == null || e.reviewId == null || e.reviewId === chatReview;
    let n = 0;
    const kept = merged.filter((e) => !counts(e) || ++n <= CLAUDE_REVIEW_CHAT_MAX_PINS);
    set({ byPr: { ...get().byPr, [prId]: kept } });
  },
  registerChat: (prId, reviewId) => set({ chats: { ...get().chats, [prId]: reviewId } }),
  unregisterChat: (prId, reviewId) => {
    if (get().chats[prId] !== reviewId) return;
    const next = { ...get().chats };
    delete next[prId];
    set({ chats: next });
  },
}));

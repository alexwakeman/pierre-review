import { create } from 'zustand';

// THE STORY CHAT TO SHOW NEXT. A page that sends the reader to a saved story chat (the build tab's "How to
// test" pointer, docs/STORY-BUILD.md § How to test after a build) asks for it here, then opens the story;
// the story view's chat panel (Ticket/StoryChat.tsx) takes it — selects that chat and scrolls to it — and
// clears it. Transient, never persisted; keyed by the ticket ident so another story never takes it.

interface StoryChatFocusStore {
  pending: { ident: string; chatId: number } | null;
  request: (ident: string, chatId: number) => void;
  /** The chat asked for this story, taken once (cleared). */
  take: (ident: string) => number | null;
}

export const useStoryChatFocus = create<StoryChatFocusStore>((set, get) => ({
  pending: null,
  request: (ident, chatId) => set({ pending: { ident, chatId } }),
  take: (ident) => {
    const p = get().pending;
    if (p == null || p.ident !== ident) return null;
    set({ pending: null });
    return p.chatId;
  },
}));

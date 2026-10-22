import { create } from 'zustand';
import type { DocsDeepLink } from '../lib/docReferences.js';

// Activity → Docs: what the reader has open, PER WORKSPACE, for the visit (not in the URL, not
// persisted). A module store rather than component state so leaving the rail line and coming back
// keeps the section and the conversation — and so the chat's HOOK-level onSuccess can seat a new
// conversation's id even when the pane closed mid-answer.

export interface DocsOpen {
  path: string;
  anchor: string | null;
  /**
   * The SERVER-CHECKED words the link rests on (a review reference, a story-docs point, a chat
   * citation, a finding's borrowed quote), highlighted in the section; null = anchor only.
   */
  quote: string | null;
  /** Bumped on every open, so re-opening the same anchor scrolls to it again. */
  seq: number;
}

interface DocsViewState {
  open: Record<number, DocsOpen | undefined>;
  /** Document ids whose contents tree is expanded. */
  expanded: Record<number, number[] | undefined>;
  /** The conversation on screen; null = a new one. */
  conversation: Record<number, string | null | undefined>;
  /** Below the wide breakpoint the viewer and the chat share one column. */
  narrowPane: 'viewer' | 'chat';
  openPath: (workspaceId: number, path: string, anchor?: string | null, quote?: string | null) => void;
  toggleExpanded: (workspaceId: number, docId: number) => void;
  setExpanded: (workspaceId: number, docId: number, on: boolean) => void;
  setConversation: (workspaceId: number, conversationId: string | null) => void;
  setNarrowPane: (pane: 'viewer' | 'chat') => void;
  /**
   * A DEEP LINK's target (`?activityRepo=docs&doc=…&section=…`, lib/docReferences.ts), seated by the
   * URL hydrate before the workspace resolves and consumed ONCE by the pane (which knows the
   * workspace). The serializer does not emit those keys, so the link is a one-shot by design.
   */
  pendingDeepLink: DocsDeepLink | null;
  seatDeepLink: (loc: DocsDeepLink | null) => void;
}

let seq = 0;

export const useDocsView = create<DocsViewState>((set) => ({
  open: {},
  expanded: {},
  conversation: {},
  narrowPane: 'viewer',
  openPath: (workspaceId, path, anchor = null, quote = null) =>
    set((s) => ({ open: { ...s.open, [workspaceId]: { path, anchor, quote, seq: ++seq } }, narrowPane: 'viewer' })),
  toggleExpanded: (workspaceId, docId) =>
    set((s) => {
      const cur = s.expanded[workspaceId] ?? [];
      const next = cur.includes(docId) ? cur.filter((d) => d !== docId) : [...cur, docId];
      return { expanded: { ...s.expanded, [workspaceId]: next } };
    }),
  setExpanded: (workspaceId, docId, on) =>
    set((s) => {
      const cur = s.expanded[workspaceId] ?? [];
      if (cur.includes(docId) === on) return {};
      return { expanded: { ...s.expanded, [workspaceId]: on ? [...cur, docId] : cur.filter((d) => d !== docId) } };
    }),
  setConversation: (workspaceId, conversationId) =>
    set((s) => ({ conversation: { ...s.conversation, [workspaceId]: conversationId } })),
  setNarrowPane: (pane) => set({ narrowPane: pane }),
  pendingDeepLink: null,
  seatDeepLink: (loc) => set({ pendingDeepLink: loc }),
}));

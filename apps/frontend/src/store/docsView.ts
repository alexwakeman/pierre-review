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
  /** Opened from OUTSIDE the library list (a citation in a review, a chat, a story check, a deep
   *  link): the contents tree reveals the row — ancestors opened, scrolled to, highlighted briefly. */
  reveal?: boolean;
}

interface DocsViewState {
  open: Record<number, DocsOpen | undefined>;
  /** The document whose contents tree is expanded — AT MOST ONE (an accordion: opening one closes the
   *  other). An array for the store's shape; never more than one id. */
  expanded: Record<number, number[] | undefined>;
  /** The conversation on screen; null = a new one. */
  conversation: Record<number, string | null | undefined>;
  /** Below the wide breakpoint the viewer and the chat share one column. */
  narrowPane: 'library' | 'viewer' | 'chat';
  openPath: (workspaceId: number, path: string, anchor?: string | null, quote?: string | null, reveal?: boolean) => void;
  toggleExpanded: (workspaceId: number, docId: number) => void;
  setExpanded: (workspaceId: number, docId: number, on: boolean) => void;
  setConversation: (workspaceId: number, conversationId: string | null) => void;
  setNarrowPane: (pane: 'library' | 'viewer' | 'chat') => void;
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
  narrowPane: 'library',
  openPath: (workspaceId, path, anchor = null, quote = null, reveal = false) =>
    set((s) => ({ open: { ...s.open, [workspaceId]: { path, anchor, quote, seq: ++seq, ...(reveal ? { reveal: true } : {}) } }, narrowPane: 'viewer' })),
  // ⚠ AN ACCORDION: expanding a document collapses any other.
  toggleExpanded: (workspaceId, docId) =>
    set((s) => {
      const cur = s.expanded[workspaceId] ?? [];
      return { expanded: { ...s.expanded, [workspaceId]: cur.includes(docId) ? [] : [docId] } };
    }),
  setExpanded: (workspaceId, docId, on) =>
    set((s) => {
      const cur = s.expanded[workspaceId] ?? [];
      if (on ? cur.length === 1 && cur[0] === docId : !cur.includes(docId)) return {};
      return { expanded: { ...s.expanded, [workspaceId]: on ? [docId] : cur.filter((d) => d !== docId) } };
    }),
  setConversation: (workspaceId, conversationId) =>
    set((s) => ({ conversation: { ...s.conversation, [workspaceId]: conversationId } })),
  setNarrowPane: (pane) => set({ narrowPane: pane }),
  pendingDeepLink: null,
  seatDeepLink: (loc) => set({ pendingDeepLink: loc }),
}));

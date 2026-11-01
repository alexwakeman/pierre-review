// Activity → Docs: is the "Ask about these docs" column open, and which conversation does it show
// first? Pure, so the rule is pinned by test/docsChatDefault.test.ts; DocsView.tsx reads the stored
// choice and the conversation list (GET /api/docs/chats, newest first) and applies the answer.
//
// THE RULE:
//   - A conversation updated in the last 24 hours is RECENT.
//   - No stored choice: open when a recent conversation exists, collapsed otherwise.
//   - The reader opened it: open (the choice stands).
//   - The reader collapsed it: collapsed — unless a conversation was updated AFTER that click (asked
//     in the narrow layout, another tab), which opens it again.
//   - A recent conversation is shown first (not "New conversation") once the column is open and
//     nothing is picked yet this visit — the caller applies that, since the narrow layout has no
//     collapsed state.

import type { ReferenceDocsConversationSummary } from '@pierre-review/shared';

export const DOCS_CHAT_RECENT_MS = 24 * 60 * 60 * 1000;

/** The reader's own expand / collapse click, with when it happened (epoch ms). */
export interface DocsChatChoice {
  collapsed: boolean;
  at: number;
}

export interface DocsChatDefaultInput {
  /** The stored choice; null when the reader never pressed the chevron or the strip. */
  choice: DocsChatChoice | null;
  /** The conversation list (any order); undefined while it loads. */
  conversations: readonly Pick<ReferenceDocsConversationSummary, 'conversationId' | 'updatedAt'>[] | undefined;
  now: number;
}

export interface DocsChatDefault {
  collapsed: boolean;
  /** The newest RECENT conversation, to pre-select when nothing is picked yet; null = "New conversation". */
  conversationId: string | null;
}

/** The newest conversation by `updatedAt`, or null (an unparseable timestamp never wins). */
export function latestConversation<T extends Pick<ReferenceDocsConversationSummary, 'conversationId' | 'updatedAt'>>(
  conversations: readonly T[],
): { conversation: T; at: number } | null {
  let best: { conversation: T; at: number } | null = null;
  for (const c of conversations) {
    const at = Date.parse(c.updatedAt);
    if (!Number.isFinite(at)) continue;
    if (best == null || at > best.at) best = { conversation: c, at };
  }
  return best;
}

export function docsChatDefault({ choice, conversations, now }: DocsChatDefaultInput): DocsChatDefault {
  const latest = conversations == null ? null : latestConversation(conversations);
  const recent = latest != null && now - latest.at <= DOCS_CHAT_RECENT_MS ? latest : null;
  let collapsed: boolean;
  if (choice == null) collapsed = recent == null;
  else if (!choice.collapsed) collapsed = false;
  else collapsed = !(latest != null && latest.at > choice.at);
  return { collapsed, conversationId: recent?.conversation.conversationId ?? null };
}

/** A stored value that is not a well-formed choice (an old boolean, hand-edited JSON) reads as none. */
export function parseDocsChatChoice(raw: unknown): DocsChatChoice | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.collapsed === 'boolean' && typeof r.at === 'number' && Number.isFinite(r.at) ? { collapsed: r.collapsed, at: r.at } : null;
}

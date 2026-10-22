import { createContext, useCallback, useContext } from 'react';
import { usePinnedTabs } from '../store/pinnedTabs.js';

// THE ONE WAY TO OPEN A STORY (docs/FRONTEND.md § The story view). The story view is the ticket tab:
// one ticket's header, its Story section (OPEN here) and its pull requests, drawn as the Open PRs ticket
// stack. Every entry point — This Sprint's tickets, Reports → Stories' "Time and pull requests", a
// ticket key in a Claude answer — calls the function this hook returns:
//
//   const openStory = useOpenStory();
//   openStory({ ident, key, title });
//
// `ident` is shared `trackerTicketIdent` (every Stories / sprint / report row carries it); `key` is the
// tracker key printed on the chip; `title` may be null. Opening from Activity arms the Back entry
// exactly like a PR tab (`fromActivity: true`). The view is FREE core.
//
// ⚠ The Story section is ALWAYS OPEN, and only here: the Open PRs board does not draw it (its ticket
// key + title open this view instead). The internal
// TabKind stays 'ticket' and the key/URL `ticket:<ident>`, so old links still land here.
export interface OpenStoryArgs {
  ident: string;
  key: string;
  title: string | null;
}

export function useOpenStory(): (t: OpenStoryArgs) => void {
  const open = usePinnedTabs((s) => s.openTicketTab);
  return useCallback((t: OpenStoryArgs) => open({ ident: t.ident, key: t.key, title: t.title }, { fromActivity: true }), [open]);
}

/**
 * A PAGE'S OWN WAY TO SHOW A STORY, for the ticket links drawn inside it. This Sprint provides one (its
 * story TRAY beside the board), so a ticket key in a call-out or an Ask Claude answer opens the tray
 * there; everywhere else nothing is provided and a link opens the story TAB. ⚠ `useOpenStory` stays the
 * ONLY way to open the TAB — this override never opens a tab, and a page that wants the tab (the tray's
 * own "Open story tab", the card's corner arrow) calls `useOpenStory` directly.
 */
export const StoryOpenOverride = createContext<((t: OpenStoryArgs) => void) | null>(null);

/** What a ticket LINK does on click: the page's override when there is one, else the story tab. */
export function useStoryLinkOpener(): (t: OpenStoryArgs) => void {
  const override = useContext(StoryOpenOverride);
  const tab = useOpenStory();
  return override ?? tab;
}

/** The story tab's words: the chip, the chip's tooltip / accessible name, and its close button. Pure
 *  (test/ticketTab.test.ts). */
export function storyTabLabels(key: string | null | undefined): { chip: string; title: string; closeAria: string } {
  const k = key != null && key.trim() !== '' ? key.trim() : null;
  return {
    chip: k != null ? `${k} · Story` : 'Story',
    title: k != null ? `${k}: story and pull requests` : 'Story and pull requests',
    closeAria: 'Close story tab',
  };
}

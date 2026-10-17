import { useCallback } from 'react';
import { usePinnedTabs } from '../store/pinnedTabs.js';

// THE ONE WAY TO OPEN A STORY (docs/FRONTEND.md § The story view). The story view is the ticket tab:
// one ticket's header, its Story section (OPEN here) and its pull requests, drawn as the Open PRs ticket
// stack. Every entry point — This Sprint's tickets, Reports → Stories' "Time and pull requests", the
// story report's ticket chips, a ticket key in a Claude answer — calls the function this hook returns:
//
//   const openStory = useOpenStory();
//   openStory({ ident, key, title });
//
// `ident` is shared `trackerTicketIdent` (every Stories / sprint / report row carries it); `key` is the
// tracker key printed on the chip; `title` may be null. Opening from Activity arms the Back entry
// exactly like a PR tab (`fromActivity: true`). The view is FREE core.
//
// ⚠ The Story section opens EXPANDED because the view mounts it so (it is collapsed only in Open PRs),
// not because of anything stored: re-opening a story tab always shows the section open. The internal
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

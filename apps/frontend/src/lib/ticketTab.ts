import { useCallback } from 'react';
import { usePinnedTabs } from '../store/pinnedTabs.js';

// THE ONE WAY TO OPEN A TICKET TAB (docs/FRONTEND.md § The ticket tab). Every entry point — Reports →
// Stories' "Time and pull requests", the story report's ticket chips, This sprint cards' PR list,
// Story health's hover list — calls the function this hook returns:
//
//   const openTicketTab = useOpenTicketTab();
//   openTicketTab({ ident, key, title });
//
// `ident` is shared `trackerTicketIdent` (every Stories / sprint / report row carries it); `key` is the
// tracker key printed on the chip; `title` may be null. Opening from Activity arms the Back entry
// exactly like a PR tab (`fromActivity: true`). The tab is FREE core: it lists PR data only.
export interface OpenTicketTabArgs {
  ident: string;
  key: string;
  title: string | null;
}

export function useOpenTicketTab(): (t: OpenTicketTabArgs) => void {
  const open = usePinnedTabs((s) => s.openTicketTab);
  return useCallback((t: OpenTicketTabArgs) => open({ ident: t.ident, key: t.key, title: t.title }, { fromActivity: true }), [open]);
}

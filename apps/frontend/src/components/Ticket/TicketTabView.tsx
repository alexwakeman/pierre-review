import { parseTicketTabKey, usePinnedTabs } from '../../store/pinnedTabs.js';
import { StoryViewBody } from './StoryViewBody.js';

// THE STORY VIEW (the ticket tab; docs/FRONTEND.md § The story view): the active tab's ticket, drawn
// by the ONE story body (StoryViewBody.tsx — This Sprint's tray draws the same body). Every entry point
// opens the TAB through `useOpenStory` (lib/ticketTab.ts). The tab key is `ticket:<ident>`; the header
// falls back to the tab's meta (captured at open time) until a read names the ticket.
export function TicketTabView(): JSX.Element | null {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const ident = parseTicketTabKey(activeTab);
  const meta = tabs.find((t) => t.key === activeTab)?.ticketMeta ?? null;
  if (ident == null) return null;
  return (
    <div data-testid="ticket-tab-view" className="mx-auto max-w-5xl px-3 py-4 md:px-5 md:py-6">
      <StoryViewBody ident={ident} meta={meta} />
    </div>
  );
}

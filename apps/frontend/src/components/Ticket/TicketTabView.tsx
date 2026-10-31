import { parseTicketTabKey, usePinnedTabs } from '../../store/pinnedTabs.js';
import { StoryViewBody } from './StoryViewBody.js';
import { PAGE_GUTTER } from '../ui/PageHeader.js';

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
    // The page gutter (the ONE every destination's title sits on); the story's header is the PAGE
    // header (`page`), with no card around the story. No max width here: the body measures this
    // width and picks one column (capped) or two (StoryLayout.tsx).
    <div data-testid="ticket-tab-view" className={`pb-6 ${PAGE_GUTTER}`}>
      <StoryViewBody ident={ident} meta={meta} page />
    </div>
  );
}

import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useShell } from '../../store/shell.js';
import { EllipsisIcon, PendingBallIcon, PullRequestIcon, TicketIcon, TimelineIcon } from '../Icons.js';
import { cx } from '../ui/cx.js';
import { currentLocation, destination, DESTINATIONS, goTo, SHORT_LABEL, type DestinationId } from './nav.js';

const ICON: Partial<Record<DestinationId, JSX.Element>> = {
  attention: <PendingBallIcon size={18} />,
  'open-prs': <PullRequestIcon size={18} />,
  sprint: <TicketIcon size={18} />,
  timeline: <TimelineIcon size={18} />,
};

// THE PHONE'S BOTTOM BAR (below `md`, docs/redesign/DESIGN.md § 6): the four primary destinations
// and "More", which opens the sidebar as a drawer (Library, Insights, Repositories, open tabs, the
// workspace, sync, AI usage, settings). Every item is a 56px-tall target; the bar pads for the home
// indicator.
export function BottomBar(): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setDrawerOpen = useShell((s) => s.setDrawerOpen);
  const loc = currentLocation(activeTab, tabs, activityRepoId);
  const primaries = DESTINATIONS.filter((d) => d.group === 'primary');
  // "More" is where you are when you are anywhere the four do not cover.
  const elsewhere = !primaries.some((d) => d.id === loc);
  const item = (on: boolean): string =>
    cx(
      'flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-meta outline-none',
      'focus-visible:bg-ui-hover',
      on ? 'text-ui-ink' : 'text-ui-faint',
    );
  return (
    <nav
      aria-label="Main"
      data-testid="bottom-bar"
      className="flex shrink-0 bg-ui-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {primaries.map((d) => {
        const on = loc === d.id;
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => goTo(d.id)}
            aria-current={on ? 'page' : undefined}
            aria-label={destination(d.id).label}
            className={item(on)}
          >
            {ICON[d.id]}
            <span aria-hidden className="max-w-full truncate px-1">
              {SHORT_LABEL[d.id] ?? d.label}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="More: everything else"
        aria-current={elsewhere ? 'page' : undefined}
        className={item(elsewhere)}
      >
        <EllipsisIcon size={18} />
        <span aria-hidden>More</span>
      </button>
    </nav>
  );
}

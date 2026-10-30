import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useShell } from '../../store/shell.js';
import { EllipsisIcon, PendingBallIcon, PullRequestIcon, TicketIcon, TimelineIcon } from '../Icons.js';
import { cx } from '../ui/cx.js';
import { AlertDot } from './AlertDot.js';
import { useShellSignals } from './shellSignals.js';
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
  const signals = useShellSignals();
  // "More" carries a mark when something inside the drawer wants a look: a sync error or the AI
  // budget (red / amber), else other workspaces that need you (the accent).
  const moreTone = signals.alert ?? (signals.elsewhere > 0 ? 'accent' : null);
  const moreWords = [
    signals.alertWords,
    signals.elsewhere > 0 ? `${signals.elsewhere} need you in other workspaces` : null,
  ].filter(Boolean);
  const primaries = DESTINATIONS.filter((d) => d.group === 'primary');
  // "More" is where you are when you are anywhere the four do not cover.
  const elsewhere = !primaries.some((d) => d.id === loc);
  const item = (on: boolean): string =>
    cx(
      'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-meta outline-none',
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
            aria-label={
              d.id === 'attention' && signals.pending != null
                ? `${destination(d.id).label}, ${signals.pending.count}${signals.pending.capped ? ' or more' : ''} need you`
                : destination(d.id).label
            }
            className={item(on)}
          >
            <span className="relative flex">
              {ICON[d.id]}
              {d.id === 'attention' && signals.pending != null && (
                <span
                  aria-hidden
                  data-testid="bottom-bar-pending-count"
                  className="absolute -right-3 -top-1.5 min-w-[18px] rounded-full bg-ui-accent-fill px-1 text-center text-meta leading-[18px] tabular-nums text-ui-on-accent"
                >
                  {signals.pending.count}
                  {signals.pending.capped ? '+' : ''}
                </span>
              )}
            </span>
            <span aria-hidden className="max-w-full truncate px-1">
              {SHORT_LABEL[d.id] ?? d.label}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label={moreWords.length > 0 ? `More: everything else. ${moreWords.join('; ')}` : 'More: everything else'}
        title={moreWords.length > 0 ? moreWords.join('; ') : undefined}
        aria-current={elsewhere ? 'page' : undefined}
        data-alert={moreTone ?? undefined}
        className={item(elsewhere)}
      >
        <span className="relative flex">
          <EllipsisIcon size={18} />
          {moreTone != null && <AlertDot tone={moreTone} onIcon />}
        </span>
        <span aria-hidden>More</span>
      </button>
    </nav>
  );
}

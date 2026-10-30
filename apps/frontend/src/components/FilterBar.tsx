import { useMemo, useState } from 'react';
import { useIsPhone } from './ui/media.js';
import { type User } from '@pierre-review/shared';
import { buildMemberSections } from '../hooks/useMemberSections.js';
import { useMergers, useRepos, useSearchTimeline, useUsers } from '../hooks/useTimeline.js';
import { useSearchOpenPrs } from '../hooks/useTriage.js';
import { useWorkspaces, workspaceRepoIds } from '../hooks/useWorkspaces.js';
import { useFilters, type RangePreset } from '../store/filters.js';
import { boardSlotMode, usePinnedTabs } from '../store/pinnedTabs.js';
import { useTimelineLayout } from '../store/timelineLayout.js';
import { EventSelectPanel } from './EventSelectPanel.js';
import { RepoSelectPanel } from './RepoSelectPanel.js';
import { StatusSelectPanel } from './StatusSelectPanel.js';
import { ThreadStateSelectPanel } from './ThreadStateSelectPanel.js';
import { UserSelectPanel } from './UserSelectPanel.js';
import { useTimelineCommands } from './Timeline/useTimelineCommands.js';
import { BotIcon, ChevronIcon, FilterIcon } from './Icons.js';
import { cx, FOCUS_RING } from './ui/cx.js';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['7d', '14d', '30d', '90d'];

/** One quiet toolbar button (Now, Clear filters, the phone's Filters / List toggles). */
const TOOL = `inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ui px-2.5 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:px-3 motion-safe:transition-colors motion-safe:duration-ui-fast ${FOCUS_RING}`;

/**
 * A SEGMENTED control: the Range presets, and the phone's Board / List choice. One raised track, the
 * chosen segment in the selection tone (never a coloured fill — colour is for what blocks or lands).
 */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ id: T; label: React.ReactNode; title?: string }>;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 items-center rounded-ui bg-ui-raise p-0.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={cx(
              'inline-flex h-6 items-center gap-1 rounded-ui px-2 text-body tabular-nums touch:h-10 touch:px-3',
              'motion-safe:transition-colors motion-safe:duration-ui-fast',
              on ? 'bg-ui-sel font-medium text-ui-ink shadow-sm shadow-black/20' : 'text-ui-mute hover:text-ui-ink',
              FOCUS_RING,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const RANGE_OPTIONS = PRESETS.map((p) => ({ id: p, label: p, title: `The last ${p.replace('d', ' days')}` }));

function Section({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex items-center gap-1.5">{children}</div>;
}

export function FilterBar(): JSX.Element | null {
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const { data: users } = useUsers();

  // ⚠ ONLY THE WORKSPACE SELECTOR (+ the global search) SHOWS ON EVERY VIEW. Everything else in
  // this bar — the per-repo show/hide panel, Members, Status, Events, Threads, Range and the
  // right-hand Clear-filters cluster — is TIMELINE-only, because the timeline board is the only
  // surface that honours any of it.
  //
  // The repos panel used to be the exception, mounted everywhere on the reasoning that Activity
  // "consumes `repoIds` hardest". That was the bug, not the justification: `repoIds` now narrows
  // the TIMELINE and nothing else (Activity / Feed / Bots / Compare always cover every repo in the
  // selected workspace, and you narrow Activity by clicking a repo row in its rail), so a picker
  // left on those views would silently scope screens that cannot see it — the worst kind of
  // filter, one whose control is visible and whose effect is not.
  //
  // ⚠ THE ONE EXCEPTION IS A PR FOCUS TAB, AND IT IS EXACTLY TWO CONTROLS: Events (categories +
  // review verdicts) and a Bots on/off toggle. Both are the SHARED store fields (same URL keys —
  // a choice made in Focus also applies on the board, and back), and the isolate Timeline
  // honours them CLIENT-side over its unfiltered `prIds=<id>` payload
  // (components/Timeline/isolateFilter.ts). Nothing else shows there: Repos / Status / Range
  // cannot change a single-PR view, Members and Threads are not applied in Focus, and "Now"
  // (centerTimelineNow → showTimeline()) would pull the user out of the tab.
  //
  // The FilterBar is always fully live — PR-isolation focus is a separate TAB (its own keyed
  // <Timeline>), so it never disables or fades the board filters. Repo/workspace MANAGEMENT
  // (add/remove/move) lives in the WorkspaceManager modal, reached from inside the
  // WorkspaceSelector dropdown below; the FilterBar itself carries the SCOPE (which workspace,
  // everywhere) and — on the Timeline, plus the two Focus controls — the board filters.
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const isTimeline = activeTab === 'timeline';
  // The SAME resolver App uses to mount the board slot, so a stale focus key can never show
  // Focus controls over the shared board.
  const isFocus = boardSlotMode(activeTab, tabs) != null;
  const showEvents = isTimeline || isFocus;

  // Member-AGNOSTIC, repo-scoped activity (ignores the member filter, so the
  // option list never collapses to just the already-selected members). When a
  // repo filter is active these payloads already contain only the selected repos.
  // Idle on a Focus tab, which shows no Members panel: the shared board is not mounted there,
  // and the string carries `types`, so every Events toggle would refetch it for nobody.
  const { data: searchTimeline } = useSearchTimeline({ enabled: !isFocus });
  const { data: searchOpenPrs } = useSearchOpenPrs();
  const { data: mergers } = useMergers();

  const f = useFilters();
  // Bots the board's Members panel keeps visible under "Exclude bots" — Focus honours them too.
  const keptBotCount = f.allowedBotIds?.length ?? 0;

  // ── The workspace's repos ────────────────────────────────────────────────────────────────────
  // RepoSelectPanel lists ONLY the active workspace's repos, never the account's: `repoIds = null`
  // means "every repo in THIS workspace", so an account-wide list would let the user tick a repo
  // that is not in scope and would make "all" mean two different things in two places.
  // `useRepos()` is account-wide, so it is narrowed by the membership the workspace row carries.
  const workspaceRepos = useMemo(() => {
    if (workspaces == null || f.workspaceId == null) return [];
    const member = new Set(workspaceRepoIds(f.workspaceId, workspaces));
    return (repos ?? []).filter((r) => member.has(r.id));
  }, [repos, workspaces, f.workspaceId]);

  // Show/hide a single repo ON THE TIMELINE BOARD. `repoIds` is the explicit visible subset (null =
  // every repo in the workspace). Toggling canonicalises back to null when the whole workspace is
  // visible again, so the URL stays clean and the trigger reads the plain total. "All" and "none"
  // are all-or-none OF THE WORKSPACE — the account's other repos are not in this list and cannot be
  // reached from it.
  const toggleRepoVisibility = (id: number): void => {
    const allIds = workspaceRepos.map((r) => r.id);
    const visible = new Set(useFilters.getState().repoIds ?? allIds);
    if (visible.has(id)) visible.delete(id);
    else visible.add(id);
    f.setRepoIds(
      visible.size === 0 || visible.size === allIds.length
        ? null
        : allIds.filter((x) => visible.has(x)),
    );
  };

  // Isolate to a single repo (deselect the rest) — quick switching without unchecking everything.
  // Canonicalises to null when it is the workspace's only repo (so the trigger still reads "all").
  const showOnlyRepo = (id: number): void => {
    f.setRepoIds(workspaceRepos.length <= 1 ? null : [id]);
  };

  // Member picker options, organised into sections: one section per in-scope repo
  // listing that repo's members. A member active in several repos is intentionally
  // REPEATED across those sections; selection is keyed by user id, so checking them
  // in one section checks them everywhere. A trailing "Other" group holds the full
  // non-bot roster remainder (when no repo filter is set) plus any selected-but-
  // inactive members, so anyone stays pickable and selections stay visible.
  // maintainerIds (merge rights in the relevant repo(s)) drives both the per-row
  // shields and the panel's "Maintainers" quick-select — it is no longer a section.
  //
  // The FOLD lives in buildMemberSections (hooks/useMemberSections.ts) (pure, so it is a
  // test); this call site passes exactly the inputs the old
  // inline fold read, so the output stays byte-identical (pinned by test/memberSections.test.ts).
  const {
    sections: memberSections,
    botSections,
    maintainerIds,
  } = useMemo(() => {
    const repoScoped = f.repoIds != null && f.repoIds.length > 0;
    // ⚠ IN-SCOPE IS NOW ALWAYS BOUNDED BY THE WORKSPACE, even with no per-repo narrowing.
    // `repoIds == null` used to mean "every repo in the account" and a null set here was
    // therefore correct; it now means "every repo in THIS WORKSPACE". Two of the three sources
    // feeding the builder's `repoMembers` are already workspace-scoped server-side, but
    // `useMergers()` is account-wide and unscoped — so a null set let maintainers of OTHER
    // workspaces' repos in as members of a board that can never show them.
    const workspaceRepoIdSet = new Set(workspaceRepos.map((r) => r.id));
    const explicit = f.repoIds;
    const inScopeRepoIds =
      explicit != null && explicit.length > 0
        ? new Set(explicit.filter((id) => workspaceRepoIdSet.has(id)))
        : workspaceRepoIdSet;
    return buildMemberSections({
      users,
      repos,
      searchTimeline,
      searchOpenPrs,
      mergers,
      inScopeRepoIds,
      repoScoped,
      selectedIds: f.userIds ?? [],
      allowedBotIds: f.allowedBotIds ?? [],
      // ⚠ This fold's Bots half uses the global flag alone, but the board's excludeBots hides
      // the server's UNION set (getTimeline → hiddenBotUserIds: users.isBot ∪ the workspace's
      // automated reviewers, a manual "human" winning both ways). So a bot known only to the
      // union lists among the people here although the board hides it — a known gap, not the
      // rule (lib/unionBot.ts holds the union verdict the Focus tab uses).
      isBot: (u: User) => u.isBot,
      includeRosterRemainder: true,
    });
  }, [
    users,
    searchTimeline,
    searchOpenPrs,
    mergers,
    repos,
    workspaceRepos,
    f.repoIds,
    f.userIds,
    f.allowedBotIds,
  ]);

  // On a phone the board's filters fold behind one "Filters" button (they wrapped to three rows
  // above a board that needs the height); Now and the Board / List choice stay on the line.
  const phone = useIsPhone();
  const [phoneOpen, setPhoneOpen] = useState(false);
  // A phone reads the Timeline as a LIST by default (components/Timeline/TimelineList.tsx); the board
  // is one tap away. Wider screens always draw the board.
  const phoneLayout = useTimelineLayout((s) => s.phone);
  const setPhoneLayout = useTimelineLayout((s) => s.setPhone);

  // ⌘K: the Timeline's own actions (range, Now, Clear filters, Board / List), while it is on screen.
  useTimelineCommands({ enabled: isTimeline, phone });

  // Nothing to filter off the board (every hook above still ran: rules of hooks).
  if (!showEvents) return null;

  const layoutToggle = phone && isTimeline && (
    <Segmented
      label="Show the timeline as"
      value={phoneLayout}
      onChange={setPhoneLayout}
      options={[
        { id: 'list', label: 'List', title: 'One line per pull request' },
        { id: 'board', label: 'Board', title: 'The time-axis board' },
      ]}
    />
  );
  const nowButton = isTimeline && (
    <button type="button" onClick={() => f.centerTimelineNow()} title="Recenter the timeline on the current time (keeps the zoom)" className={TOOL}>
      Now
    </button>
  );

  if (phone && !phoneOpen) {
    return (
      <div data-testid="filter-bar" className="flex shrink-0 items-center gap-1 bg-ui-bg px-2 py-1.5">
        <button type="button" onClick={() => setPhoneOpen(true)} aria-expanded={false} className={TOOL}>
          <FilterIcon size={13} />
          Filters
          <ChevronIcon dir="down" size={10} />
        </button>
        <span className="ml-auto" />
        {/* Now moves the board; the list has no "now" to centre on. */}
        {phoneLayout === 'board' && nowButton}
        {layoutToggle}
      </div>
    );
  }

  return (
    <>
    {/* THE PAGE HEADER (docs/redesign/DESIGN.md § 1): every page opens on its title; the board's
        filters are its header row. Not on a phone (the top bar names the page) and not on a PR
        Focus tab (its tab chip names it). */}
    {isTimeline && !phone && (
      <header className="shrink-0 bg-ui-bg px-7 pt-5" data-testid="timeline-header">
        <h2 className="text-display text-ui-ink">Timeline</h2>
      </header>
    )}
    <div data-testid="filter-bar" className={cx('flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-2 bg-ui-bg px-3 py-2', isTimeline && !phone ? 'md:px-[18px] md:pb-3' : 'md:px-4')}>
      {phone && (
        <button type="button" onClick={() => setPhoneOpen(false)} aria-expanded className={cx(TOOL, '-ml-1 text-ui-ink')}>
          <FilterIcon size={13} />
          Filters
          <ChevronIcon dir="up" size={10} />
        </button>
      )}
      {/* The board filters. Always live — focus is a separate tab now, not an overlay
          that locks the board. */}
      <div className="contents">
        {/* The workspace picker and the search box LEFT this bar with the redesign's shell: the
            picker heads the sidebar, and search is ⌘K (or `/`), which runs the same workspace
            search. What remains is the Timeline's own board filters, so the bar shows only on the
            Timeline and on a PR Focus tab. */}

        {/* The per-repo show/hide panel is TIMELINE-ONLY, in placement AND in effect: `repoIds`
            narrows the timeline board and nothing else. Narrowing Activity is the sidebar's job
            (a repo row); narrowing a drill-down table is that table's own repo dropdown. */}
        {isTimeline && (
          <Section>
            <RepoSelectPanel
              repos={workspaceRepos}
              repoIds={f.repoIds}
              onToggle={toggleRepoVisibility}
              onOnly={showOnlyRepo}
              onShowAll={() => f.setRepoIds(null)}
            />
          </Section>
        )}

        {/* Members is timeline-only too — off the board nothing honours the member selection
            (Activity's bot filtering lives in the feed's own lens pills), so the panel shows
            only on the Timeline. */}
        {isTimeline && (
          <Section>
            <UserSelectPanel
              sections={memberSections}
              botSections={botSections}
              userIds={f.userIds}
              maintainerIds={maintainerIds}
              onApply={(ids) => f.setUserIds(ids)}
              excludeBots={f.excludeBots}
              onExcludeBotsChange={f.setExcludeBots}
              allowedBotIds={f.allowedBotIds}
              onToggleAllowedBot={f.toggleAllowedBot}
            />
          </Section>
        )}

        {/* Status / Threads / Range are timeline-only; Events also shows on a PR Focus tab. */}
        {isTimeline && (
          <Section>
            <StatusSelectPanel
              statuses={f.prStatuses}
              onToggle={f.togglePrStatus}
              onSet={f.setPrStatuses}
              excludeStale={f.excludeStale}
              onExcludeStaleChange={f.setExcludeStale}
            />
          </Section>
        )}

        {/* Events shows on the Timeline AND on a PR Focus tab (the isolate Timeline applies it
            client-side there). */}
        {showEvents && (
          <Section>
            <EventSelectPanel
              categories={f.categories}
              onToggleCategory={(c) => f.toggleCategory(c)}
              onSetCategories={(c) => f.setCategories(c)}
              reviewStates={f.reviewStates}
              onToggleReviewState={(s) => f.toggleReviewState(s)}
              onSetReviewStates={(s) => f.setReviewStates(s)}
            />
          </Section>
        )}

        {/* Focus-only: hide bots. The board keeps this inside the Members panel as the
            "Exclude bots" checkbox; Focus has no Members panel, so the same shared `excludeBots`
            gets a toggle with the SAME polarity (pressed = bots hidden, like checked there).
            The allow-list (`allowedBotIds`, ticked in the board's Members panel) still keeps
            those bots visible while it is on, so the label says so rather than claiming every
            bot is hidden. */}
        {isFocus && (
          <Section>
            <button
              type="button"
              aria-pressed={f.excludeBots}
              onClick={() => f.setExcludeBots(!f.excludeBots)}
              title={
                !f.excludeBots
                  ? 'Bot activity is shown'
                  : keptBotCount > 0
                    ? `Bot activity is hidden, except ${keptBotCount} ${keptBotCount === 1 ? 'bot' : 'bots'} you chose to keep`
                    : 'Bot activity is hidden'
              }
              className={cx(TOOL, f.excludeBots ? 'bg-ui-sel text-ui-ink' : 'bg-ui-raise')}
            >
              <BotIcon size={12} />
              {f.excludeBots && keptBotCount > 0 ? `Hide bots (except ${keptBotCount})` : 'Hide bots'}
            </button>
          </Section>
        )}

        {isTimeline && (
          <Section>
            <ThreadStateSelectPanel
              derivedStates={f.derivedStates}
              onToggle={(s) => f.toggleDerivedState(s)}
              onClear={() => f.setDerivedStates([])}
            />
          </Section>
        )}

        {/* Range (+ Now) sits at the END of the board-filters cluster. A custom from/to (URL only)
            leaves no preset pressed. */}
        {isTimeline && (
          <Section>
            <span className="ml-1.5 text-meta text-ui-faint">Range</span>
            <Segmented label="Range" value={f.preset === 'custom' ? null : f.preset} options={RANGE_OPTIONS} onChange={(p) => f.setPreset(p)} />
            {!phone && nowButton}
          </Section>
        )}
      </div>

      {/* Right cluster: Clear filters (Timeline only), and on a phone the Board / List choice. */}
      {isTimeline && (
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => f.resetAllFilters()} title="Reset all filters to their defaults" className={TOOL}>
            Clear filters
          </button>
          {phone && phoneLayout === 'board' && nowButton}
          {layoutToggle}
        </div>
      )}
    </div>
    </>
  );
}

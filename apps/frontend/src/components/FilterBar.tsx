import { useMemo } from 'react';
import { type InsightsRangeKey, type User } from '@pierre-review/shared';
import { buildMemberSections } from '../hooks/useMemberSections.js';
import { useMergers, useRepos, useSearchTimeline, useUsers } from '../hooks/useTimeline.js';
import { useSearchOpenPrs } from '../hooks/useTriage.js';
import { useWorkspaces, workspaceRepoIds } from '../hooks/useWorkspaces.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useProSettings } from '../hooks/useProSettings.js';
import { defaultInsightsRange, INSIGHTS_RANGE_LABEL } from '../lib/insightsRange.js';
import { useFilters, type RangePreset } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { EventSelectPanel } from './EventSelectPanel.js';
import { RepoSelectPanel } from './RepoSelectPanel.js';
import { StatusSelectPanel } from './StatusSelectPanel.js';
import { WorkspaceSelector } from './WorkspaceSelector.js';
import { GlobalSearch } from './Search/GlobalSearch.js';
import { ThreadStateSelectPanel } from './ThreadStateSelectPanel.js';
import { UserSelectPanel } from './UserSelectPanel.js';
import { CloseIcon } from './Icons.js';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['7d', '14d', '30d', '90d'];

function Chip({
  active,
  onClick,
  children,
  color,
  title,
  onRemove,
  removeTitle,
  removeDisabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
  title?: string;
  onRemove?: () => void;
  removeTitle?: string;
  removeDisabled?: boolean;
}): JSX.Element {
  const pill = `whitespace-nowrap rounded-full border text-xs transition ${
    active
      ? 'border-transparent bg-blue-600 text-white'
      : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500'
  }`;
  const style = active && color ? { backgroundColor: color } : undefined;

  // Without a remove affordance the chip is a single button. With one, render
  // the toggle and the ✕ as *sibling* buttons inside a shared pill — never a
  // button nested in a button (which can swallow the inner click).
  if (!onRemove) {
    return (
      <button type="button" onClick={onClick} title={title} className={`${pill} px-2.5 py-0.5`} style={style}>
        {children}
      </button>
    );
  }
  return (
    <span className={`inline-flex items-center ${pill}`} style={style}>
      <button type="button" onClick={onClick} title={title} className="py-0.5 pl-2.5 pr-1">
        {children}
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={removeDisabled}
        title={removeTitle}
        aria-label={removeTitle}
        className="flex items-center self-stretch py-0.5 pl-0.5 pr-2 opacity-50 hover:opacity-100 disabled:opacity-30"
      >
        <CloseIcon size={11} />
      </button>
    </span>
  );
}

function Section({
  label,
  children,
}: {
  // Optional: the dropdown-panel sections (Repos / Status / Members / Events /
  // Threads) omit it because their trigger button already shows the name — the
  // label would be redundant. The Range chip section keeps it, since its chips
  // don't repeat the category name. Without a label the wrapper still groups its
  // children with the same spacing.
  label?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {label != null && (
        <span className="text-[11px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

// The Insights chat's Range chips — the Timeline's control, in the Timeline's slot, over a
// different value (store `insightsRange`; see the note there on why they are not one field).
//
// "Sprint to date" is offered only when the account has BOTH a cadence and a start date stored: a
// cadence alone cannot locate a window, so the chip would be a button that silently answers over a
// rolling fortnight. When it IS offered it leads, because it is the range those accounts think in.
//
// The highlighted chip is the RESOLVED range, not the stored override: `insightsRange === null`
// means "whatever Settings → Sprint says", so the bar shows that as the live selection rather than
// as nothing selected. Clicking it re-asserts the same window, which is a no-op — correct, since
// there is nothing to clear.
function InsightsRangeSection(): JSX.Element | null {
  const insightsRange = useFilters((s) => s.insightsRange);
  const setInsightsRange = useFilters((s) => s.setInsightsRange);
  // The chat is Pro; without the capability the pane these chips scope isn't rendered at all, so
  // the settings fetch stays gated exactly as the config modal's does.
  const { data: settings } = useProSettings(useProCapabilities().workspaceInsights);

  const sprint = settings?.sprint;
  const hasSprint = sprint != null && sprint.cadenceDays != null && sprint.startDate != null;
  const active = insightsRange ?? defaultInsightsRange(sprint?.comparisonMode ?? null, hasSprint);

  const keys: InsightsRangeKey[] = hasSprint
    ? ['sprint', '7d', '14d', '30d', '90d']
    : ['7d', '14d', '30d', '90d'];
  const titleFor = (k: InsightsRangeKey): string =>
    k === 'sprint'
      ? `Answer over the current sprint so far (${sprint?.cadenceDays}-day cadence)`
      : `Answer over the last ${k.replace('d', '')} days`;

  return (
    <Section label="Range">
      {keys.map((k) => (
        <Chip
          key={k}
          active={active === k}
          title={titleFor(k)}
          onClick={() => setInsightsRange(k)}
        >
          {INSIGHTS_RANGE_LABEL[k]}
        </Chip>
      ))}
    </Section>
  );
}

export function FilterBar(): JSX.Element {
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const { data: users } = useUsers();
  // Member-AGNOSTIC, repo-scoped activity (ignores the member filter, so the
  // option list never collapses to just the already-selected members). When a
  // repo filter is active these payloads already contain only the selected repos.
  const { data: searchTimeline } = useSearchTimeline();
  const { data: searchOpenPrs } = useSearchOpenPrs();
  const { data: mergers } = useMergers();

  const f = useFilters();

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
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const isTimeline = activeTab === 'timeline';
  // The ONE non-Timeline surface with a bar control (see the Range section below). Both halves
  // matter: the Activity board must be the active TAB and its rail must be on the Insights entry,
  // or the chips would hang over the Feed / Bots / Compare panes, which have no window to scope.
  const isInsights = activeTab === 'activity' && f.activityRepoId === 'insights';

  // The FilterBar is always fully live now — PR-isolation / My-Turn focus is a separate
  // TAB (its own keyed <Timeline>), so it no longer disables or fades the board filters.
  // Repo/workspace MANAGEMENT (add/remove/move) lives in the WorkspaceManager modal, reached from
  // inside the WorkspaceSelector dropdown below; the FilterBar itself carries the SCOPE (which
  // workspace, everywhere) and — on the Timeline only — the board filters, `repoIds` among them.

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
  // The FOLD lives in buildMemberSections (hooks/useMemberSections.ts) so the Reports People
  // picker reuses it at workspace scope; this call site passes exactly the inputs the old
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
      // The Timeline board's bot verdict is the global flag alone (the union verdict is the
      // Feed/Reports rule — this dropdown's Bots half must keep listing exactly what the
      // board's excludeBots hides).
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

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
      {/* The board filters. Always live — focus is a separate tab now, not an overlay
          that locks the board. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* THE SCOPE, and it is now a SINGLE control: WHICH WORKSPACE (single-select — there is no
            "all", a workspace is the only scope). It shows on EVERY view (Timeline +
            Activity/Insights + every drill-down); repo and workspace management lives inside the
            selector's dropdown, so the Activity rail carries no scope control of its own. */}
        <Section>
          <WorkspaceSelector />
        </Section>

        {/* Full-text search — global (shown on EVERY view), scoped to the active workspace.
            Searches the server index (PR bodies, review threads, comments, people), distinct from
            the timeline-title TimelineSearch below. */}
        <Section>
          <GlobalSearch />
        </Section>

        {/* The per-repo show/hide panel is TIMELINE-ONLY, in placement AND in effect: `repoIds`
            narrows the timeline board and nothing else. It sits with the other board filters
            below, NOT beside the workspace selector — a control mounted on a view it cannot
            change is exactly the confusion this move removes. Narrowing Activity is the rail's
            job (click a repo row); narrowing a drill-down table is that table's own repo
            dropdown. */}
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

        {/* Status / Events / Threads / Range are timeline-only — shown only on the Timeline
            board; every other tab keeps just the workspace selector + global search. */}
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

        {isTimeline && (
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

        {isTimeline && (
          <Section>
            <ThreadStateSelectPanel
              derivedStates={f.derivedStates}
              onToggle={(s) => f.toggleDerivedState(s)}
              onClear={() => f.setDerivedStates([])}
            />
          </Section>
        )}

        {/* Range (+ Now) sits at the END of the board-filters cluster. */}
        {isTimeline && (
          <Section label="Range">
            {PRESETS.map((p) => (
              <Chip key={p} active={f.preset === p} onClick={() => f.setPreset(p)}>
                {p}
              </Chip>
            ))}
            <button
              type="button"
              onClick={() => f.centerTimelineNow()}
              title="Recenter the timeline on the current time (keeps the zoom)"
              className="whitespace-nowrap rounded-full border border-sky-300 px-2.5 py-0.5 text-xs text-sky-600 transition hover:border-sky-400 hover:bg-sky-50 dark:border-sky-700 dark:text-sky-400 dark:hover:bg-sky-900/30"
            >
              Now
            </button>
          </Section>
        )}

        {/* THE ONE DELIBERATE EXCEPTION to the Timeline-only rule at the top of this component: the
            Insights pane's chat answers a question about a PERIOD, so its range belongs in the bar
            where every other range lives rather than buried in the panel. It is a different value
            from the Timeline's `preset` (see store `insightsRange`) and carries no "Now" — that
            recentres a timeline, which means nothing to a date range. */}
        {isInsights && <InsightsRangeSection />}

      </div>

      {/* Right cluster, pinned next to the timeline. Timeline-only — Clear filters shows only on
          the Timeline board (every other tab keeps just the workspace selector + global search). */}
      {isTimeline && (
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => f.resetAllFilters()}
            title="Reset all filters to their defaults"
            className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition hover:border-gray-400 hover:text-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:text-gray-100"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}

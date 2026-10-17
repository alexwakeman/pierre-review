import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SPRINT_GHOST_MAX,
  SPRINT_STAGE_LABEL,
  SPRINT_STAGES,
  SPRINT_TICKETS_MAX,
  sprintSourceTitle,
} from '@pierre-review/shared';
import { useSprintAssessOn, useSprintGraph, useSprintRefresh, useSprintRefreshing } from '../../hooks/useSprintStories.js';
import { useFilters } from '../../store/filters.js';
import { GearIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintPathsStrip } from './SprintPathsStrip.js';
import { pathsWriting, sprintDatesLine } from './sprintPathsModel.js';
import { TicketRefOpenContext, type TicketRefOpener } from '../TicketRefLink.js';
import { SprintAskPanel } from './SprintAskPanel.js';
import { SprintGraph } from './SprintGraph.js';
import { SprintStatusSettings } from './SprintStatusSettings.js';
import { SprintTicketDrawer } from './SprintTicketDrawer.js';
import {
  DEFAULT_VISIBILITY,
  NO_EPIC,
  NO_FILTERS,
  NO_THEME,
  SPRINT_GROUP_MODES,
  SPRINT_GROUP_MODE_LABEL,
  UNASSIGNED,
  assignGroups,
  canSplitByAssignee,
  canSplitByStatus,
  effectiveGroupMode,
  filterGraph,
  filterKey,
  filterOptions,
  filtersActive,
  groupList,
  pinnedStorageKey,
  readGroupMode,
  readSplitAssignee,
  readSplitStatus,
  safeLocalStorage,
  sprintProgress,
  stageRing,
  toggleStage,
  visibleGraph,
  writeGroupMode,
  writeSplitAssignee,
  writeSplitStatus,
  type SprintGraphFilters,
  type SprintGraphVisibility,
  type SprintGroupMode,
} from './sprintGraphModel.js';

// This Sprint (its own rail line, FREE) — THE SPRINT GRAPH (GET /api/sprint-graph): the tracker's current sprint as a
// graph of tickets (plus the GHOST tickets outside the sprint they reach), their links and their pull
// requests. Toolbar (title + ⓘ, Ask Claude, statuses, Refresh), filters, the canvas (SprintGraph), the
// drawer for one ticket (SprintTicketDrawer) and "Ask Claude about this sprint" (SprintAskPanel).
// Filters HIDE what they set aside (and any halo left empty); the tickets left re-pack and the view fits
// them (`filterGraph`, `filterKey`). A selected node dims everything beyond one (or two) links. The VIEW row decides what is DRAWN at all — shipped ghosts and the faint link kinds are
// off by default (`visibleGraph`) — and how tickets GROUP (Epic · Theme · Section · Dependencies · None, remembered per
// browser; "Theme" needs the theme pass and falls back to Epic until it has run). Every state of the page is one short sentence. ⚠ Nothing here ranks tickets or people.

const MUTED = 'text-gray-500 dark:text-gray-400';
const TOOL_BUTTON =
  'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** After Refresh, how often the graph is re-read while the sprint read runs, and when to stop waiting. */
const READ_POLL_MS = 2500;
const READ_WAIT_MS = 90_000;
/** A refetch shows the bar only once it has run this long, so a quick background poll never flashes it. */
const FETCH_SHOW_AFTER_MS = 400;

/** `on`, but only once it has stayed true for `afterMs`. */
function useLingering(on: boolean, afterMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), afterMs);
    return () => window.clearTimeout(t);
  }, [on, afterMs]);
  return on && shown;
}

export function SprintView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError, isFetching, refetch } = useSprintGraph(workspaceId);
  const refresh = useSprintRefresh(workspaceId);
  const refreshing = useSprintRefreshing(workspaceId);
  // Refresh asks for a sprint read and returns at once (the read runs in the background). The read has
  // finished when the graph's `read.checkedAt` (its last attempt) moves; until then the bar shows and the
  // graph is re-read every few seconds. Given up on after READ_WAIT_MS.
  const [awaitRead, setAwaitRead] = useState<{ checkedAt: string | null; since: number } | null>(null);
  const readDone = awaitRead != null && data != null && data.read.checkedAt !== awaitRead.checkedAt;
  useEffect(() => {
    if (awaitRead == null) return;
    if (readDone || refresh.isError) {
      setAwaitRead(null);
      return;
    }
    const poll = window.setInterval(() => void refetch(), READ_POLL_MS);
    const stop = window.setTimeout(() => setAwaitRead(null), Math.max(0, awaitRead.since + READ_WAIT_MS - Date.now()));
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
  }, [awaitRead, readDone, refresh.isError, refetch]);
  const fetchingSlow = useLingering(isFetching && !isLoading, FETCH_SHOW_AFTER_MS);
  const askOn = useSprintAssessOn();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [filters, setFilters] = useState<SprintGraphFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  /** Bumped on every open, so the graph frames the ticket (and its links) even when it was selected. */
  const [frameRequest, setFrameRequest] = useState(0);
  /** A card clicked (SprintPathsStrip): the graph frames and highlights its tickets; [] = back to Fit, no highlight. */
  const [focusRequest, setFocusRequest] = useState<{ seq: number; idents: readonly string[] } | null>(null);
  const graphBox = useRef<HTMLDivElement | null>(null);
  const focusStory = useCallback((ids: string[]): void => {
    setFocusRequest((r) => ({ seq: (r?.seq ?? 0) + 1, idents: ids }));
    // The strip sits above the canvas: bring the canvas into view so the framing is seen.
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    graphBox.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, []);
  const [hops, setHops] = useState<1 | 2>(1);
  const [visibility, setVisibility] = useState<SprintGraphVisibility>(DEFAULT_VISIBILITY);
  const [groupChoice, setGroupChoice] = useState<SprintGroupMode>(() => readGroupMode(safeLocalStorage()));
  const [splitChoice, setSplitChoice] = useState<boolean>(() => readSplitStatus(safeLocalStorage()));
  const [personChoice, setPersonChoice] = useState<boolean>(() => readSplitAssignee(safeLocalStorage()));

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const idents = useMemo(() => new Set(nodes.map((n) => n.ident)), [nodes]);
  const options = useMemo(() => filterOptions(nodes), [nodes]);
  const members = useMemo(() => new Map(options.members.map((m) => [m.id, m])), [options]);
  const shown = useMemo(() => visibleGraph(nodes, edges, visibility), [nodes, edges, visibility]);
  const themesOn = data?.themes != null && data.themes.length > 0;
  const groupMode = effectiveGroupMode(groupChoice, themesOn);
  // The second picker follows the grouping: Theme while grouping by theme, none by dependency chain,
  // Epic otherwise. The hidden one's choice is kept but not applied (derived here, never written back).
  const picker: 'theme' | 'epic' | null = groupMode === 'theme' ? 'theme' : groupMode === 'dependencies' ? null : 'epic';
  const applied = useMemo<SprintGraphFilters>(
    () => ({ ...filters, epic: picker === 'epic' ? filters.epic : null, theme: picker === 'theme' ? filters.theme : null }),
    [filters, picker],
  );
  // Filters HIDE: the canvas gets only what they leave (`filterGraph`), grouped over that, so a halo with
  // nothing left in it goes too.
  const drawn = useMemo(() => filterGraph(shown, applied, members), [shown, applied, members]);
  const groupOf = useMemo(() => assignGroups(drawn.nodes, drawn.edges, groupMode), [drawn, groupMode]);
  const groups = useMemo(() => groupList(drawn.nodes, groupOf, groupMode), [drawn, groupOf, groupMode]);
  const chooseGroup = useCallback((m: SprintGroupMode): void => {
    setGroupChoice(m);
    writeGroupMode(safeLocalStorage(), m);
  }, []);
  // "Split by status" applies to an Epic or Theme grouping only; the stored choice survives the others.
  const canSplit = canSplitByStatus(groupMode);
  const splitOn = splitChoice && canSplit;
  const chooseSplit = useCallback((on: boolean): void => {
    setSplitChoice(on);
    writeSplitStatus(safeLocalStorage(), on);
  }, []);
  // "Assigned to": one level deeper, under any grouping but None and Dependencies.
  const canSplitPeople = canSplitByAssignee(groupMode);
  const personOn = personChoice && canSplitPeople;
  const choosePerson = useCallback((on: boolean): void => {
    setPersonChoice(on);
    writeSplitAssignee(safeLocalStorage(), on);
  }, []);

  const open = useCallback((ident: string): void => {
    setSelected(ident);
    setDrawer(ident);
    setFrameRequest((n) => n + 1);
  }, []);
  const closeDrawer = useCallback((): void => {
    const ident = drawer;
    setDrawer(null);
    if (ident == null) return;
    // Hand focus back to the node the drawer was opened for.
    requestAnimationFrame(() => {
      const el = document.querySelector<SVGGElement>(`[data-sg-node="${CSS.escape(ident)}"]`);
      el?.focus();
    });
  }, [drawer]);
  // Escape closes the drawer and NOTHING ELSE. The app's global Escape (useKeyboard: "leave this tab for
  // the Timeline") listens on window, so it also fired — closing the drawer threw the reader out to the
  // Timeline, and coming back re-ran the graph's opening animation. Handled on `document` (bubbling, so a
  // menu inside the drawer that takes Escape first still wins), which runs before any window listener.
  useEffect(() => {
    if (drawer == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.stopPropagation();
      closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, closeDrawer]);
  const opener = useCallback<TicketRefOpener>(
    (t) => {
      if (!idents.has(t.ident)) return false;
      open(t.ident);
      return true;
    },
    [idents, open],
  );

  if (isError) return <p className="text-sm text-rose-700 dark:text-rose-400">Could not load this sprint.</p>;
  if (isLoading || data == null || workspaceId == null) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  if (!data.trackerOn) {
    return (
      <div data-testid="sprint-view" className={`rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm dark:border-gray-700 ${MUTED}`}>
        No issue tracker is connected to this workspace.
      </div>
    );
  }
  const reading = data.read.readAt == null && data.read.error == null;
  const sprintCount = nodes.filter((n) => !n.ghost).length;
  const ghostCount = shown.nodes.length - sprintCount;
  const title = data.source != null ? sprintSourceTitle(data.source) : 'This sprint';
  // The sprint's dates (the tracker's own, else the cadence's), short, in the reader's locale.
  const datesLine = sprintDatesLine(data.sprintDates, Date.now());
  const pinKey = pinnedStorageKey(data.workspaceId, title);
  const active = filtersActive(applied);
  const showAsk = askOn && data.aiEnabled;
  const progress = sprintProgress({
    awaitingRead: refreshing || (awaitRead != null && !readDone),
    firstRead: reading,
    fetching: fetchingSlow,
    briefs: data.aiEnabled ? data.briefs : null,
    pathsWriting: pathsWriting(data.aiEnabled, data.pathsStatus),
  });
  const startRefresh = (): void => {
    setAwaitRead({ checkedAt: data.read.checkedAt, since: Date.now() });
    refresh.mutate();
  };

  return (
    <TicketRefOpenContext.Provider value={opener}>
      <div data-testid="sprint-view" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {title}
            <InfoButton title="Reading the sprint graph">
              <GraphInfo />
            </InfoButton>
          </h3>
          {datesLine != null && (
            <span data-testid="sprint-dates" className="text-xs text-gray-600 dark:text-gray-300">
              {datesLine}
            </span>
          )}
          {!reading && nodes.length > 0 && (
            <span className={`text-xs ${MUTED}`}>
              {plural(sprintCount, 'ticket')} · {ghostCount} outside the sprint · {plural(shown.edges.length, 'link')}
            </span>
          )}
          {reading && <span className={`text-xs ${MUTED}`}>Reading the sprint…</span>}
          <span className="ml-auto" />
          {showAsk && (
            <button
              type="button"
              onClick={() => setAskOpen((o) => !o)}
              aria-pressed={askOpen}
              className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-0.5 text-xs font-medium text-ai-ink hover:bg-ai-surface-2"
            >
              <SparkleIcon size={12} className="text-ai-signal" />
              Ask Claude
            </button>
          )}
          <button type="button" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen} className={TOOL_BUTTON}>
            <GearIcon size={12} />
            Statuses
          </button>
          <button type="button" onClick={startRefresh} disabled={refreshing || progress?.label === 'Reading the sprint'} className={TOOL_BUTTON}>
            <RefreshIcon size={12} className={progress?.kind === 'busy' ? 'animate-spin motion-reduce:animate-none' : undefined} />
            Refresh
          </button>
        </div>
        {settingsOpen && data.statusLayout != null && <SprintStatusSettings workspaceId={data.workspaceId} layout={data.statusLayout} />}
        {data.read.error != null && <p className="text-xs text-rose-700 dark:text-rose-400">{data.read.error}</p>}
        {(data.read.truncated || data.ghostsTruncated || (data.aiEnabled && data.briefs.pending > 0)) && (
          <p className={`text-xs ${MUTED}`}>
            {[
              data.read.truncated ? `Showing the first ${SPRINT_TICKETS_MAX} tickets.` : null,
              data.ghostsTruncated ? `Showing ${SPRINT_GHOST_MAX} tickets outside the sprint.` : null,
              data.aiEnabled && data.briefs.pending > 0 ? `Summarising ${plural(data.briefs.pending, 'ticket')}…` : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </p>
        )}

        {nodes.length > 0 && (
          <SprintPathsStrip paths={data.paths ?? null} status={data.pathsStatus} aiEnabled={data.aiEnabled} signals={data.signals ?? []} onFocus={focusStory} />
        )}
        {nodes.length === 0 ? (
          !reading && <p className={`text-sm ${MUTED}`}>No tickets in this sprint.</p>
        ) : (
          <>
            <ViewControls
              groupMode={groupMode}
              onGroup={chooseGroup}
              split={splitOn}
              canSplit={canSplit}
              onSplit={chooseSplit}
              splitPeople={personOn}
              canSplitPeople={canSplitPeople}
              onSplitPeople={choosePerson}
              themesOn={themesOn}
              visibility={visibility}
              setVisibility={setVisibility}
            />
            <Filters
              filters={filters}
              setFilters={setFilters}
              options={options}
              picker={picker}
              active={active}
              shownCount={drawn.nodes.filter((n) => !n.ghost).length}
              totalCount={sprintCount}
              selected={selected}
              hops={hops}
              setHops={setHops}
              onClearSelection={() => setSelected(null)}
            />
            <div ref={graphBox} className="relative">
              <SprintGraph
                nodes={drawn.nodes}
                edges={drawn.edges}
                groupMode={groupMode}
                groupOf={groupOf}
                groups={groups}
                splitStatus={splitOn}
                splitAssignee={personOn}
                members={members}
                faintShown={visibility.faint}
                layoutIntent={`${groupMode}|${splitOn ? 1 : 0}|${personOn ? 1 : 0}|${visibility.history ? 1 : 0}|${visibility.faint ? 1 : 0}`}
                filterKey={filterKey(applied)}
                pinKey={pinKey}
                selected={selected}
                hops={hops}
                drawerOpen={drawer != null}
                frameRequest={frameRequest}
                focusRequest={focusRequest}
                progress={progress}
                onOpen={open}
                onClearSelection={() => setSelected(null)}
              />
              {drawn.nodes.length === 0 && (
                <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-slate-200">No tickets match these filters.</p>
              )}
              {showAsk && askOpen && <SprintAskPanel workspaceId={data.workspaceId} nodes={nodes} onClose={() => setAskOpen(false)} />}
            </div>
          </>
        )}
      </div>
      {drawer != null && (
        <SprintTicketDrawer
          workspaceId={data.workspaceId}
          ident={drawer}
          repos={data.repos}
          onClose={closeDrawer}
          onOpenTicket={open}
        />
      )}
    </TicketRefOpenContext.Provider>
  );
}

function ViewControls({
  groupMode,
  onGroup,
  split,
  canSplit,
  onSplit,
  splitPeople,
  canSplitPeople,
  onSplitPeople,
  themesOn,
  visibility,
  setVisibility,
}: {
  groupMode: SprintGroupMode;
  onGroup: (m: SprintGroupMode) => void;
  split: boolean;
  canSplit: boolean;
  onSplit: (on: boolean) => void;
  splitPeople: boolean;
  canSplitPeople: boolean;
  onSplitPeople: (on: boolean) => void;
  themesOn: boolean;
  visibility: SprintGraphVisibility;
  setVisibility: (v: SprintGraphVisibility) => void;
}): JSX.Element {
  const seg = (on: boolean): string =>
    `px-2 py-0.5 text-xs first:rounded-l last:rounded-r border-y border-r first:border-l focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
      on
        ? 'border-gray-400 bg-gray-100 font-medium text-gray-900 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
        : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/60'
    }`;
  const toggle = (on: boolean): string =>
    `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
      on
        ? 'border-gray-400 bg-gray-100 text-gray-800 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
        : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-300'
    } hover:border-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="group" aria-label="View">
      <span className="inline-flex items-center gap-1.5">
        <span id="sprint-group-by" className="text-xs text-gray-600 dark:text-gray-300">
          Group by
        </span>
        <span className="inline-flex" role="radiogroup" aria-labelledby="sprint-group-by">
          {SPRINT_GROUP_MODES.map((m) => {
            const disabled = m === 'theme' && !themesOn;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={groupMode === m}
                disabled={disabled}
                aria-describedby={disabled ? 'sprint-themes-pending' : undefined}
                onClick={() => onGroup(m)}
                className={seg(groupMode === m)}
              >
                {SPRINT_GROUP_MODE_LABEL[m]}
              </button>
            );
          })}
        </span>
        {!themesOn && (
          <span id="sprint-themes-pending" className={`text-xs ${MUTED}`}>
            Themes appear after Claude reads the sprint
          </span>
        )}
        <button
          type="button"
          aria-pressed={split}
          disabled={!canSplit}
          onClick={() => onSplit(!split)}
          className={`${toggle(split)} disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-50 disabled:hover:border-gray-300 dark:disabled:hover:border-gray-700`}
        >
          Split by status
        </button>
        <button
          type="button"
          aria-pressed={splitPeople}
          disabled={!canSplitPeople}
          onClick={() => onSplitPeople(!splitPeople)}
          className={`${toggle(splitPeople)} disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-50 disabled:hover:border-gray-300 dark:disabled:hover:border-gray-700`}
        >
          Assigned to
        </button>
      </span>
      <button
        type="button"
        aria-pressed={visibility.history}
        onClick={() => setVisibility({ ...visibility, history: !visibility.history })}
        className={toggle(visibility.history)}
      >
        Show shipped history
      </button>
      <button
        type="button"
        aria-pressed={visibility.faint}
        onClick={() => setVisibility({ ...visibility, faint: !visibility.faint })}
        className={toggle(visibility.faint)}
      >
        Show builds on / replaces
      </button>
    </div>
  );
}

function Filters({
  filters,
  setFilters,
  options,
  picker,
  active,
  shownCount,
  totalCount,
  selected,
  hops,
  setHops,
  onClearSelection,
}: {
  filters: SprintGraphFilters;
  setFilters: (f: SprintGraphFilters) => void;
  options: ReturnType<typeof filterOptions>;
  /** The second picker: themes (grouping by theme), epics, or none (grouping by dependency chain). */
  picker: 'theme' | 'epic' | null;
  active: boolean;
  /** Sprint tickets left on the canvas, and in the sprint. */
  shownCount: number;
  totalCount: number;
  selected: string | null;
  hops: 1 | 2;
  setHops: (h: 1 | 2) => void;
  onClearSelection: () => void;
}): JSX.Element {
  const chip = (on: boolean): string =>
    `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
      on
        ? 'border-gray-400 bg-gray-100 text-gray-800 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
        : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-300'
    } hover:border-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;
  const allStages = filters.stages.size === 4;
  const select =
    'max-w-[12rem] rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200';
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
      {SPRINT_STAGES.map((s) => {
        const on = !allStages && filters.stages.has(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() =>
              setFilters({ ...filters, stages: allStages ? new Set([s]) : toggleStage(filters.stages, s) })
            }
            className={chip(on)}
          >
            <svg width="10" height="10" aria-hidden="true">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke={stageRing(s)} strokeWidth="2" />
            </svg>
            {SPRINT_STAGE_LABEL[s]}
          </button>
        );
      })}
      <select
        aria-label="Member"
        value={filters.assignee ?? ''}
        onChange={(e) => setFilters({ ...filters, assignee: e.target.value === '' ? null : e.target.value })}
        className={select}
      >
        <option value="">Anyone</option>
        {options.members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {options.anyUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
      </select>
      {picker === 'theme' ? (
        (options.themes.length > 0 || options.anyNoTheme) && (
          <select
            aria-label="Theme"
            value={filters.theme ?? ''}
            onChange={(e) => setFilters({ ...filters, theme: e.target.value === '' ? null : e.target.value })}
            className={select}
          >
            <option value="">Any theme</option>
            {options.themes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            {options.anyNoTheme && <option value={NO_THEME}>No theme</option>}
          </select>
        )
      ) : (
        picker === 'epic' &&
        (options.epics.length > 0 || options.anyNoEpic) && (
          <select
            aria-label="Epic"
            value={filters.epic ?? ''}
            onChange={(e) => setFilters({ ...filters, epic: e.target.value === '' ? null : e.target.value })}
            className={select}
          >
            <option value="">Any epic</option>
            {options.epics.map((ep) => (
              <option key={ep.key} value={ep.key}>
                {ep.title != null ? `${ep.title} (${ep.key})` : ep.key}
              </option>
            ))}
            {options.anyNoEpic && <option value={NO_EPIC}>No epic</option>}
          </select>
        )
      )}
      <button type="button" aria-pressed={filters.hasPrs} onClick={() => setFilters({ ...filters, hasPrs: !filters.hasPrs })} className={chip(filters.hasPrs)}>
        Has PRs
      </button>
      <button type="button" aria-pressed={filters.hasDeps} onClick={() => setFilters({ ...filters, hasDeps: !filters.hasDeps })} className={chip(filters.hasDeps)}>
        Has dependencies
      </button>
      {active && (
        <>
          <span className="text-xs text-gray-600 dark:text-gray-300" data-testid="sprint-filter-count">
            {shownCount} of {totalCount} tickets
          </span>
          <button type="button" onClick={() => setFilters(NO_FILTERS)} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            Clear filters
          </button>
        </>
      )}
      {selected != null && (
        <span className="ml-auto inline-flex items-center gap-1.5">
          <button type="button" aria-pressed={hops === 2} onClick={() => setHops(hops === 2 ? 1 : 2)} className={chip(hops === 2)}>
            2 hops
          </button>
          <button type="button" onClick={onClearSelection} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            Show all
          </button>
        </span>
      )}
    </div>
  );
}

function GraphInfo(): JSX.Element {
  return (
    <>
      <p>Each circle is a ticket in the sprint. Click one, or press Enter on it, to open it.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Ring colour</strong> is the ticket&rsquo;s section: not started, in progress, in review or complete.
          The circle&rsquo;s fill takes the same colour, and the mark in its middle repeats it as a shape: an empty
          circle, a half-filled circle, an eye or a tick (a question mark when the status is not known). Complete
          tickets are fainter. Hover for the exact status.
        </li>
        <li>
          <strong>The small round picture</strong> on a ticket&rsquo;s edge is the person it is assigned to (their
          initials when there is no picture).
        </li>
        <li>
          <strong>Size</strong> is how many of the lines on screen touch the ticket.
        </li>
        <li>
          <strong>Lines</strong>: an arrow points from a ticket to one it depends on (a blocking link in the tracker, or
          the ticket&rsquo;s own text). A dashed line joins tickets built alongside each other. &ldquo;Show builds on /
          replaces&rdquo; adds faint lines where one ticket builds on or replaces another. Hover a line for the words
          behind it.
        </li>
        <li>
          <strong>Small dashed circles</strong> are tickets outside the sprint that a sprint ticket leads to, up to three
          links away. The further away, the fainter. Only unfinished ones show; &ldquo;Show shipped history&rdquo; adds
          the complete ones and the chains behind them.
        </li>
        <li>
          <strong>Group by</strong> gathers tickets inside a faint labelled circle: by theme (the default), by epic or by
          section.
          Lines still cross between groups. A ticket outside the sprint joins the group of the sprint ticket it is
          linked to. Themes are short names Claude gives the sprint&rsquo;s main areas of work, read from the tickets;
          each ticket is in one; until Claude has named them, Theme shows epics. This browser remembers your choice.
        </li>
        <li>
          <strong>Dependencies</strong> puts each chain of tickets that depend on each other in its own circle, read
          left to right: what has to happen first is on the left. The chain is named after the ticket most others in
          it wait on. Tickets with no dependencies sit together in Standalone. Split by status and Assigned to are
          off in this view, and the epic filter is hidden.
        </li>
        <li>
          <strong>Split by status</strong> divides each epic or theme into not started, in progress, in review and complete,
          left to right, each in a small circle of its section&rsquo;s colour. It works with Epic and Theme only. This
          browser remembers it.
        </li>
        <li>
          <strong>Assigned to</strong> puts each person&rsquo;s tickets in a small grey circle with their name, inside
          the epic, theme or section (and inside the status, when that is split too). It does nothing with None or
          Dependencies.
        </li>
        <li>
          <strong>Member</strong> picks one person: the tickets assigned to them and the tickets carrying a pull request
          they opened. A tracker name and a GitHub account count as one person when the names match.
        </li>
        <li>
          <strong>Dots</strong> circling a ticket are its pull requests: open, draft or merged. A red ring means its checks
          are failing.
        </li>
      </ul>
      <p>
        The graph moves for a few seconds after it loads or changes, then stays still. Drag a ticket to pin it there;
        this browser remembers it. Scroll or pinch to zoom. Drag the
        background to move around. Fit frames what is shown.
      </p>
      <p>Opening a ticket zooms to it and the tickets it links to. Clicking a card above the graph zooms to its tickets; click it again to see the whole sprint.</p>
      <p>Where tickets crowd, some names hide. Hover or zoom in to read them.</p>
      <p>
        Filters hide the tickets they leave out, and any circle left empty. The rest close up and the view fits them;
        clearing the filters puts everything back. A ticket outside the sprint follows the section filter only, and
        stays while it is linked to a ticket that is shown. A selected ticket fades everything more than one link away.
      </p>
    </>
  );
}

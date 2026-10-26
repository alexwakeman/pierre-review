import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { sprintShouldAutoRefetch } from '../../lib/sprintChangeToken.js';
import {
  SPRINT_GHOST_MAX,
  SPRINT_TICKETS_MAX,
  sprintSourceTitle,
  type SprintGraphNode,
  type SprintGraphResponse,
  type SprintRefreshTicketChecks,
} from '@pierre-review/shared';
import { useSprintAiOn, useSprintChangeToken, useSprintGraph, useSprintRefresh, useSprintRefreshing } from '../../hooks/useSprintStories.js';
import { StoryOpenOverride, useOpenStory, type OpenStoryArgs } from '../../lib/ticketTab.js';
import { ticketKeyOfIdent } from '../../store/pinnedTabs.js';
import type { SprintBoardView } from '../../lib/laneBoard.js';
import { useFilters } from '../../store/filters.js';
import { GearIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { AiStatusLine } from '../AiStatusLine.js';
import { SprintAskPanel } from './SprintAskPanel.js';
import { SprintBoardFilters, SprintPathsView, SprintPeopleView, SprintThemesView, type SprintCardActions } from './SprintBoards.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { pathsWriting, sprintDatesLine, sprintProgress } from './sprintPathsModel.js';
import { SprintStatusSettings } from './SprintStatusSettings.js';
import { SprintTrackerSetup } from '../Sprint/SprintTrackerSetup.js';
import { SprintStoryTray } from '../Sprint/SprintStoryTray.js';
import { useAiProviderName } from '../../hooks/useAiCapabilities.js';

// This Sprint (a fixed tab, FREE) — THE SPRINT (GET /api/sprint-graph; the route keeps its name):
// the toolbar (title + ⓘ, dates, Ask Claude, the status buckets behind the gear, Refresh), the page's
// progress bar, and ONE of three views on the lane board (SprintBoards.tsx): Critical path, Theme or
// People — `view`, the tab's DERIVED sub-tab. A ticket clicked on this page (a card, a call-out key, a
// ticket key in an Ask Claude answer — `StoryOpenOverride`) shows its story in the STORY TRAY on the
// right (Sprint/SprintStoryTray.tsx: the story tab's own body); a card's corner arrow and the tray's
// "Open story tab" open the TAB (`useOpenStory`). Every state of the page is one short sentence.
// Above the board, the "Has PRs" / "Needs code" filter chips (`SprintBoardFilters`) apply to every view.
//
//   AUTO-REFRESH  the cards' change token is polled (`useSprintChangeToken`, every minute, only while
//            this tab is mounted and the page visible — DB only) and when it differs the board is
//            re-fetched AUTOMATICALLY (no tracker read, no ticket checks). Nothing changed ⇒ no graph
//            read and no re-layout.
//   TOOLBAR REFRESH  reads the sprint from the tracker now AND (local, AI on) starts up to
//            SPRINT_REFRESH_TICKET_CHECKS ticket checks; the count started is said briefly after.

const MUTED = 'text-gray-600 dark:text-gray-300';
const TOOL_BUTTON =
  'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** After Refresh, how often the sprint is re-read while the sprint read runs, and when to stop waiting. */
const READ_POLL_MS = 2500;
const READ_WAIT_MS = 90_000;
/** How long the "Checking N tickets" note stays after a Refresh. */
const CHECKS_NOTE_MS = 10_000;
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

export function SprintView({ view }: { view: SprintBoardView }): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useSprintGraph(workspaceId);
  const refresh = useSprintRefresh(workspaceId);
  const aiName = useAiProviderName();
  const { changed, tokenUpdatedAt } = useSprintChangeToken(
    workspaceId,
    data != null && data.trackerOn ? { changeToken: data.changeToken, updatedAt: dataUpdatedAt, fetching: isFetching } : null,
  );
  // "Checking N tickets…" after a Refresh, for a few seconds (this mount's own answer only).
  const [checksNote, setChecksNote] = useState<string | null>(null);
  useEffect(() => {
    if (!refresh.isSuccess) return;
    const note = ticketChecksNote(refresh.data.ticketChecks, aiName);
    setChecksNote(note);
    if (note == null) return;
    const t = window.setTimeout(() => setChecksNote(null), CHECKS_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [refresh.isSuccess, refresh.data]);
  const refreshing = useSprintRefreshing(workspaceId);
  // Refresh asks for a sprint read and returns at once (the read runs in the background). The read has
  // finished when `read.checkedAt` (its last attempt) moves; until then the bar shows and the sprint is
  // re-read every few seconds. Given up on after READ_WAIT_MS.
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
  const askOn = useSprintAiOn();
  // The sprint changed since the board was loaded: re-fetch it now (the board only, no tracker read).
  // Not while the reader's own Refresh is landing — that already re-reads the board.
  // ONCE PER OBSERVED TOKEN (`sprintShouldAutoRefetch`): a failed re-fetch waits for the next poll.
  const autoRefetchedFor = useRef<number | null>(null);
  useEffect(() => {
    if (refreshing || awaitRead != null) return;
    if (!sprintShouldAutoRefetch({ changed, tokenUpdatedAt, lastActedAt: autoRefetchedFor.current })) return;
    autoRefetchedFor.current = tokenUpdatedAt;
    void refetch();
  }, [changed, tokenUpdatedAt, refreshing, awaitRead, refetch]);
  const openStory = useOpenStory();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const open = useCallback(
    (n: SprintGraphNode): void => openStory({ ident: n.ident, key: n.key, title: n.title !== '' ? n.title : null }),
    [openStory],
  );
  // THE STORY TRAY: `?sprintStory=<ident>` (filters store, a navigation key — Back closes it).
  const trayIdent = useFilters((s) => s.sprintStoryIdent);
  const setTray = useFilters((s) => s.setSprintStory);
  const trayId = useId();
  const showInTray = useCallback((t: OpenStoryArgs): void => setTray(t.ident), [setTray]);
  const select = useCallback((n: SprintGraphNode): void => setTray(n.ident), [setTray]);
  const actions = useMemo<SprintCardActions>(
    () => ({ onSelect: select, onOpen: open, selectedIdent: trayIdent, trayId }),
    [select, open, trayIdent, trayId],
  );
  const trayNode = trayIdent != null ? data?.nodes.find((n) => n.ident === trayIdent) : undefined;

  if (isError) return <p className="text-sm text-rose-700 dark:text-rose-400">Could not load this sprint.</p>;
  if (isLoading || data == null || workspaceId == null) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  // No tracker: one line and the way to set one up (Settings → Workspace → Issue tracker).
  if (!data.trackerOn) return <SprintTrackerSetup />;
  const reading = data.read.readAt == null && data.read.error == null;
  const sprintCount = data.nodes.filter((n) => !n.ghost).length;
  const title = data.source != null ? sprintSourceTitle(data.source) : 'This sprint';
  // The sprint's dates (the tracker's own, else the cadence's), short, in the reader's locale.
  const datesLine = sprintDatesLine(data.sprintDates, Date.now());
  const showAsk = askOn && data.aiEnabled;
  const progress = sprintProgress({
    awaitingRead: refreshing || (awaitRead != null && !readDone),
    firstRead: reading,
    fetching: fetchingSlow,
    briefs: data.aiEnabled ? data.briefs : null,
    pathsWriting: pathsWriting(data.aiEnabled, data.pathsStatus),
  });
  const aiPass = sprintAiPass(data);
  const startRefresh = (): void => {
    setAwaitRead({ checkedAt: data.read.checkedAt, since: Date.now() });
    refresh.mutate();
  };

  return (
    <StoryOpenOverride.Provider value={showInTray}>
    <div className="flex items-start gap-3">
    <div data-testid="sprint-view" data-view={view} className="min-w-0 flex-1 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          {title}
          <InfoButton title="Reading this sprint">
            <BoardInfo name={aiName} />
          </InfoButton>
        </h3>
        {datesLine != null && (
          <span data-testid="sprint-dates" className="text-xs text-gray-600 dark:text-gray-300">
            {datesLine}
          </span>
        )}
        {!reading && sprintCount > 0 && <span className={`text-xs ${MUTED}`}>{plural(sprintCount, 'ticket')}</span>}
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
            Ask {aiName}
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
      {progress != null && <SprintProgressBar progress={progress} className="h-[3px] w-full rounded-full" />}
      {settingsOpen && data.statusLayout != null && <SprintStatusSettings workspaceId={data.workspaceId} layout={data.statusLayout} />}
      {checksNote != null && (
        <p data-testid="sprint-checks-note" role="status" className={`text-xs ${MUTED}`}>
          {checksNote}
        </p>
      )}
      {data.read.error != null && <p className="text-xs text-rose-700 dark:text-rose-400">{data.read.error}</p>}
      {(data.read.truncated || (data.ghostsTruncated && view === 'paths')) && (
        <p className={`text-xs ${MUTED}`}>
          {[
            data.read.truncated ? `Showing the first ${SPRINT_TICKETS_MAX} tickets.` : null,
            data.ghostsTruncated && view === 'paths' ? `Showing ${SPRINT_GHOST_MAX} tickets outside the sprint.` : null,
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
      {/* The ONE agentic status line (components/AiStatusLine): the passes run in order — ticket
          summaries, then themes, then the critical paths — so at most one is named at a time. */}
      {aiPass != null && <AiStatusLine stage={aiPass.stage} count={aiPass.count} />}
      {showAsk && askOpen && <SprintAskPanel workspaceId={data.workspaceId} nodes={data.nodes} onClose={() => setAskOpen(false)} />}

      {sprintCount > 0 && <SprintBoardFilters data={data} />}
      {sprintCount === 0 ? (
        !reading && <p className={`text-sm ${MUTED}`}>No tickets in this sprint.</p>
      ) : view === 'themes' ? (
        <SprintThemesView data={data} actions={actions} />
      ) : view === 'people' ? (
        <SprintPeopleView data={data} actions={actions} />
      ) : (
        <SprintPathsView data={data} actions={actions} />
      )}
    </div>
    {trayIdent != null && (
      <SprintStoryTray
        id={trayId}
        ident={trayIdent}
        ticketKey={trayNode?.key ?? ticketKeyOfIdent(trayIdent)}
        title={trayNode != null && trayNode.title !== '' ? trayNode.title : null}
        onClose={() => setTray(null)}
      />
    )}
    </div>
    </StoryOpenOverride.Provider>
  );
}

function BoardInfo({ name }: { name: string }): JSX.Element {
  return (
    <>
      <p>
        Three ways to read the same sprint. Click a ticket to see its story beside the board; its corner arrow opens the
        story in its own tab.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Critical path</strong>: the chains of tickets that most put the sprint at risk, one per row, with the pace above them
          and a count of every ticket below.
        </li>
        <li>
          <strong>Theme</strong>: one row per theme {name} named from the tickets; tickets in none sit in No theme. Under each name,
          {name} says in a sentence what the work involves. The counts under it are Limn&rsquo;s.
        </li>
        <li>
          <strong>People</strong>: one row per person the tickets are assigned to, Unassigned last. Reviews
          waiting counts open pull requests in this workspace waiting on their review, where Limn knows their GitHub account. An
          arrow between two rows is a hand-off.
        </li>
        <li>
          <strong>Row order</strong>: on every view, the rows with the most pull requests (open, merged or closed) come first; each
          row says its count. Ties keep the usual order: riskiest path, largest theme, then name. No theme and Unassigned stay last.
        </li>
        <li>
          <strong>Row lines</strong> (Theme and People): the row&rsquo;s tickets by column, then how many have an open or merged pull
          request. A ticket without one may be design, analysis or other work, or code not opened yet. The colour bar shows the same
          split; hover it for its key.
        </li>
        <li>
          <strong>Columns</strong> are your status buckets, in order (change them under Statuses). Product review holds QA and
          other sign-offs, and tickets in Code review whose pull requests have all merged. Complete columns fold to a count;
          Show opens the column, and a row&rsquo;s own count opens that row only.
        </li>
        <li>
          <strong>Borders</strong>: a thick orange border is a ticket on a critical path; a dashed one is waiting on another
          unfinished ticket; a faint dashed one on a grey ground is outside the sprint. A violet dot before the key is a ticket
          with an open or merged pull request, and those tickets come first in each cell. The key under each board names them.
        </li>
        <li>
          <strong>Names</strong>: Critical path and Theme show who each ticket is assigned to; People shows its theme there
          instead.
        </li>
        <li>
          <strong>Under the title</strong>: {name}&rsquo;s one-line summary of the ticket, then its acceptance criteria.
          &ldquo;3 of 4 criteria met&rdquo; comes from the latest ticket check, which reads the ticket&rsquo;s pull requests against its
          criteria and lists them itself, so its count can differ from the summary&rsquo;s. Without a check the card shows how many
          criteria the ticket has; when it names none, {name} works them out from the description. Italics mean the check was made
          before the pull requests last changed.
        </li>
        <li>
          <strong>Refresh</strong> reads the sprint from your tracker now. It also checks up to three tickets that have pull
          requests and no current check, on your own {name}. The board also updates itself within a minute when the sprint
          changes, while it is open.
        </li>
        <li>
          <strong>Arrows</strong> run from the ticket waited on to the one that waits. Hover an arrow or its number to see why. A
          number on an arrow is explained under the board.
        </li>
      </ul>
    </>
  );
}

/**
 * Which agentic pass the header names, if any. Briefs first (with "N of M"), then themes, then the
 * critical paths. `passes` is absent on an older server: then pending briefs stand for a run.
 * Exported for tests.
 */
export function sprintAiPass(
  data: Pick<SprintGraphResponse, 'aiEnabled' | 'briefs' | 'passes' | 'pathsStatus'>,
): { stage: string; count: { done: number; total: number } | null } | null {
  if (!data.aiEnabled) return null;
  const briefsRunning = data.passes?.briefsRunning ?? data.briefs.pending > 0;
  if (briefsRunning && data.briefs.pending > 0) {
    const total = data.briefs.current + data.briefs.pending;
    return { stage: 'Summarising tickets', count: { done: data.briefs.current, total } };
  }
  if (data.passes?.themesRunning === true) return { stage: 'Grouping tickets into themes', count: null };
  if (pathsWriting(data.aiEnabled, data.pathsStatus)) return { stage: 'Working out the critical paths', count: null };
  return null;
}

/** The line said briefly after a Refresh about the ticket checks it started; null = say nothing (none
 *  needed one, or the server does not run them — cloud, AI off). Exported for tests. */
export function ticketChecksNote(c: SprintRefreshTicketChecks | undefined, name = 'Claude'): string | null {
  if (c == null) return null;
  if (c.skipped === 'no_credential') return `Ticket checks need ${name} set up first.`;
  if (c.started <= 0) return null;
  return c.started === 1 ? 'Checking 1 ticket against its pull requests.' : `Checking ${c.started} tickets against their pull requests.`;
}

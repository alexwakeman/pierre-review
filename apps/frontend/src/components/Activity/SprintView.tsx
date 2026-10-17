import { useCallback, useEffect, useState } from 'react';
import { SPRINT_GHOST_MAX, SPRINT_TICKETS_MAX, sprintSourceTitle, type SprintGraphNode } from '@pierre-review/shared';
import { useSprintAiOn, useSprintGraph, useSprintRefresh, useSprintRefreshing } from '../../hooks/useSprintStories.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import type { SprintBoardView } from '../../lib/laneBoard.js';
import { useFilters } from '../../store/filters.js';
import { GearIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintAskPanel } from './SprintAskPanel.js';
import { SprintPathsView, SprintPeopleView, SprintThemesView } from './SprintBoards.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { pathsWriting, sprintDatesLine, sprintProgress } from './sprintPathsModel.js';
import { SprintStatusSettings } from './SprintStatusSettings.js';

// This Sprint (its own rail line, FREE) — THE SPRINT (GET /api/sprint-graph; the route keeps its name):
// the toolbar (title + ⓘ, dates, Ask Claude, the status buckets behind the gear, Refresh), the page's
// progress bar, and ONE of three views on the lane board (SprintBoards.tsx): Critical path, Theme or
// People — `view`, the rail's DERIVED sub-tab. A ticket clicked anywhere opens its STORY VIEW
// (`useOpenStory`, the ticket tab with its Story section open). Every state of the page is one short
// sentence. ⚠ Nothing here ranks tickets or people.

const MUTED = 'text-gray-600 dark:text-gray-300';
const TOOL_BUTTON =
  'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** After Refresh, how often the sprint is re-read while the sprint read runs, and when to stop waiting. */
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

export function SprintView({ view }: { view: SprintBoardView }): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError, isFetching, refetch } = useSprintGraph(workspaceId);
  const refresh = useSprintRefresh(workspaceId);
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
  const openStory = useOpenStory();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const open = useCallback(
    (n: SprintGraphNode): void => openStory({ ident: n.ident, key: n.key, title: n.title !== '' ? n.title : null }),
    [openStory],
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
  const startRefresh = (): void => {
    setAwaitRead({ checkedAt: data.read.checkedAt, since: Date.now() });
    refresh.mutate();
  };

  return (
    <div data-testid="sprint-view" data-view={view} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          {title}
          <InfoButton title="Reading this sprint">
            <BoardInfo />
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
      {progress != null && <SprintProgressBar progress={progress} className="h-[3px] w-full rounded-full" />}
      {settingsOpen && data.statusLayout != null && <SprintStatusSettings workspaceId={data.workspaceId} layout={data.statusLayout} />}
      {data.read.error != null && <p className="text-xs text-rose-700 dark:text-rose-400">{data.read.error}</p>}
      {(data.read.truncated || data.ghostsTruncated || (data.aiEnabled && data.briefs.pending > 0)) && (
        <p className={`text-xs ${MUTED}`}>
          {[
            data.read.truncated ? `Showing the first ${SPRINT_TICKETS_MAX} tickets.` : null,
            data.ghostsTruncated && view === 'paths' ? `Showing ${SPRINT_GHOST_MAX} tickets outside the sprint.` : null,
            data.aiEnabled && data.briefs.pending > 0 ? `Summarising ${plural(data.briefs.pending, 'ticket')}…` : null,
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
      {showAsk && askOpen && <SprintAskPanel workspaceId={data.workspaceId} nodes={data.nodes} onClose={() => setAskOpen(false)} />}

      {sprintCount === 0 ? (
        !reading && <p className={`text-sm ${MUTED}`}>No tickets in this sprint.</p>
      ) : view === 'themes' ? (
        <SprintThemesView data={data} onOpen={open} />
      ) : view === 'people' ? (
        <SprintPeopleView data={data} onOpen={open} />
      ) : (
        <SprintPathsView data={data} onOpen={open} />
      )}
    </div>
  );
}

function BoardInfo(): JSX.Element {
  return (
    <>
      <p>Three ways to read the same sprint. Click a ticket to open its story.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Critical path</strong>: the chains of tickets that most put the sprint at risk, one per row, with the pace above them
          and a count of every ticket below.
        </li>
        <li>
          <strong>Theme</strong>: one row per theme Claude named from the tickets; tickets in none sit in Other. &ldquo;Live&rdquo; is
          not Complete; &ldquo;merged&rdquo; is at least one pull request merged and none open.
        </li>
        <li>
          <strong>People</strong>: one row per person the tickets are assigned to, in alphabetical order, Unassigned last. Reviews
          waiting counts open pull requests in this workspace waiting on their review, where Limn knows their GitHub account. An
          arrow between two rows is a hand-off.
        </li>
        <li>
          <strong>Columns</strong> are your status buckets, in order (change them under Statuses). &ldquo;Merged, not signed
          off&rdquo; holds tickets still in progress or in review whose pull requests have all merged. Complete columns fold to a
          count; Show opens them.
        </li>
        <li>
          <strong>Borders</strong>: a thick red border is a ticket on a critical path; a dashed one is waiting on another unfinished
          ticket.
        </li>
        <li>
          <strong>Arrows</strong> run from the ticket waited on to the one that waits. A number on an arrow is explained under the
          board.
        </li>
      </ul>
    </>
  );
}

import { useCallback, useMemo, useState } from 'react';
import {
  SPRINT_PATH_RISK_LABEL,
  SPRINT_SIGNAL_LABEL,
  SPRINT_VISIT_GAP_MS,
  type SprintGraphNode,
  type SprintGraphResponse,
  type SprintPace,
  type SprintPathRisk,
  type SprintStage,
} from '@pierre-review/shared';
import {
  cellKey,
  collapsedColumns,
  countTable,
  layoutBoard,
  paceItems,
  pathsBoard,
  peopleBoard,
  themesBoard,
  ticketCardBorder,
  type BoardLayout,
  type LaneSegment,
  type SprintBoard,
  type SprintCardData,
  type SprintLaneData,
} from '../../lib/laneBoard.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { AiRunGate } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import { HoverPopover } from '../HoverPopover.js';
import { LaneBoard, useBoardObstacles } from '../LaneBoard.js';
import { TicketCard } from '../TicketCard.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { sprintPathsView } from './sprintPathsModel.js';

// ACTIVITY → THIS SPRINT: THE THREE VIEWS (docs/FRONTEND.md § Activity → This Sprint). Three independent
// angles on the same sprint, each a LANE BOARD (components/LaneBoard.tsx; layout lib/laneBoard.ts) over
// the SAME columns — the workspace's status buckets in order (Code review, Product review and the rest):
//   • CRITICAL PATH (the landing view) — CODE's pace strip, then one lane per stored critical path (the
//     sprint builder's; riskiest first, each with its risk as a word, its title and its one sentence of
//     advice), the call-outs (Claude's, then Limn's own), and a theme × column count of every ticket.
//   • THEME — one lane per theme, "No theme" last; each header carries Claude's sentence on what the
//     work involves (the themes pass), then CODE's line: tickets by column and pull-request presence.
//   • PEOPLE — one lane per assignee, alphabetical, Unassigned last; each header carries CODE's line.
// Theme and People lanes draw a colour bar of their tickets by column; hovering (or focusing) it shows
// the key. Under each board, a key to the card borders. Every card is a TicketCard: a click shows its
// story in place; its corner arrow opens the ticket's story view (`onOpen`). A Complete column's
// "n tickets" opens that lane's cell only.
//
// ⚠ PREP, NOT SCORING. The People view lists people ALPHABETICALLY — never by tickets, load or reviews
// waiting — and shows no comparison between them (the People report's guardrail, db/person-period.ts).

const MUTED = 'text-gray-600 dark:text-gray-300';

type OpenTicket = (node: SprintGraphNode) => void;

/** The Complete columns the reader opened (each view keeps its own). */
function useToggleSet(): [Set<string>, (id: string) => void] {
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setShown((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return [shown, toggle];
}

function SprintLaneBoard({
  board,
  label,
  laneWidth,
  show,
  onOpen,
}: {
  board: SprintBoard;
  label: string;
  laneWidth: string;
  show: 'initials' | 'theme';
  onOpen: OpenTicket;
}): JSX.Element {
  // The Complete columns the reader opened, and the single lane cells ("n tickets") opened in one.
  const [shown, toggle] = useToggleSet();
  const [cells, toggleCellKey] = useToggleSet();
  const toggleCell = useCallback((lane: string, column: string) => toggleCellKey(cellKey(lane, column)), [toggleCellKey]);
  const layout = useMemo(
    () => layoutBoard<SprintLaneData, SprintCardData>({ ...board, collapsed: collapsedColumns(board.columns, shown), expanded: cells }),
    [board, shown, cells],
  );
  const borders = useMemo(
    () => ({
      critical: layout.cards.some((c) => c.data.critical && !c.data.node.ghost),
      waiting: layout.cards.some((c) => c.data.waiting && !c.data.node.ghost),
      ghost: layout.cards.some((c) => c.data.node.ghost && !c.data.critical),
      ghostCritical: layout.cards.some((c) => c.data.node.ghost && c.data.critical),
    }),
    [layout.cards],
  );
  return (
    <LaneBoard
      label={label}
      layout={layout}
      laneWidth={laneWidth}
      onToggleColumn={toggle}
      onToggleCell={toggleCell}
      legend={<CardBorderKey {...borders} />}
      renderLane={(l) => <LaneHeader lane={l} />}
      renderCard={(c, ref) => (
        <TicketCard node={c.data.node} critical={c.data.critical} waiting={c.data.waiting} show={show} onOpen={onOpen} cardRef={ref} />
      )}
    />
  );
}

const RISK_CHIP: Record<SprintPathRisk, string> = {
  high: 'border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300',
  medium: 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300',
  low: 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-200',
};

function LaneHeader({ lane }: { lane: BoardLayout<SprintLaneData, SprintCardData>['lanes'][number] }): JSX.Element {
  const d = lane.data;
  const name = <h4 className="text-[12px] font-semibold leading-snug text-gray-900 dark:text-gray-50">{lane.label}</h4>;
  if (d.kind === 'path') {
    return (
      <div className="space-y-0.5">
        <span className={`inline-block rounded border px-1 text-[11px] font-medium ${RISK_CHIP[d.risk]}`}>{SPRINT_PATH_RISK_LABEL[d.risk]}</span>
        {name}
        <p className={`text-[12px] leading-snug ${MUTED}`}>{d.advice}</p>
      </div>
    );
  }
  if (d.kind === 'theme') {
    return (
      <div className="space-y-1">
        {name}
        {d.summary != null && <p className="text-[12px] leading-snug text-gray-700 dark:text-gray-200">{d.summary}</p>}
        <LaneLine progress={d.progress} code={d.code} />
        <SegmentBar segments={d.segments} lane={lane.label} />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {name}
      <p className={`text-[11px] ${MUTED}`}>
        {d.tickets} {d.tickets === 1 ? 'ticket' : 'tickets'}
        {/* null = no GitHub account mapped: say nothing, never 0. */}
        {d.reviewsWaiting != null && ` · ${d.reviewsWaiting} ${d.reviewsWaiting === 1 ? 'review' : 'reviews'} waiting`}
      </p>
      <LaneLine progress={d.progress} code={d.code} />
      <SegmentBar segments={d.segments} lane={lane.label} />
    </div>
  );
}

/** CODE's row line: the lane's tickets by column, then how many have a pull request. */
function LaneLine({ progress, code }: { progress: string; code: string }): JSX.Element | null {
  if (progress === '' && code === '') return null;
  return (
    <p className={`text-[11px] leading-snug ${MUTED}`}>
      {progress}
      {progress !== '' && code !== '' && <br />}
      {code}
    </p>
  );
}

const SEGMENT_FILL: Record<SprintStage | 'unknown', string> = {
  not_started: 'bg-gray-300 dark:bg-gray-600',
  in_progress: 'bg-sky-500',
  in_review: 'bg-amber-500',
  product_review: 'bg-emerald-400',
  done: 'bg-emerald-700 dark:bg-emerald-500',
  unknown: 'bg-gray-200 dark:bg-gray-700',
};

/** A lane's tickets per column, as one bar. Hovering or focusing it shows its key (each part's colour,
 *  column and count) beside it, clear of the cards where it can be. */
function SegmentBar({ segments, lane }: { segments: readonly LaneSegment[]; lane: string }): JSX.Element | null {
  const obstacles = useBoardObstacles();
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) return null;
  const words = segments.map((s) => `${s.count} ${s.name}`).join(', ');
  return (
    <HoverPopover
      label={`${lane}: ${words}`}
      obstacles={obstacles}
      testId="segment-bar"
      className="block w-full max-w-[9rem] py-1"
      content={
        <div data-testid="segment-key">
          <p className="font-semibold">Tickets by column</p>
          <ul className="mt-1 space-y-0.5">
            {segments.map((s) => (
              <li key={s.column} className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block h-2 w-3 shrink-0 rounded-sm ${SEGMENT_FILL[s.meaning ?? 'unknown']}`} />
                <span className="min-w-0 flex-1">{s.name}</span>
                <span className="tabular-nums">{s.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-gray-600 dark:text-gray-300">Each part is as wide as its share of the row&rsquo;s {total} tickets.</p>
        </div>
      }
    >
      <span aria-hidden className="flex h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        {segments.map((s) => (
          <span key={s.column} className={SEGMENT_FILL[s.meaning ?? 'unknown']} style={{ width: `${(100 * s.count) / total}%` }} />
        ))}
      </span>
    </HoverPopover>
  );
}

/** The key to the card borders, under a board: only the styles the board draws. */
function CardBorderKey({
  critical,
  waiting,
  ghost,
  ghostCritical,
}: {
  critical: boolean;
  waiting: boolean;
  ghost: boolean;
  ghostCritical: boolean;
}): JSX.Element | null {
  const items: Array<{ key: string; label: string; swatch: string }> = [];
  if (critical) items.push({ key: 'c', label: 'On a critical path', swatch: ticketCardBorder({ critical: true, waiting: false, ghost: false }) });
  if (waiting) items.push({ key: 'w', label: 'Waiting on another ticket', swatch: ticketCardBorder({ critical: false, waiting: true, ghost: false }) });
  if (critical && waiting) {
    items.push({ key: 'cw', label: 'On a path and waiting', swatch: ticketCardBorder({ critical: true, waiting: true, ghost: false }) });
  }
  if (ghost) items.push({ key: 'g', label: 'Outside the sprint', swatch: ticketCardBorder({ critical: false, waiting: false, ghost: true }) });
  if (ghostCritical) {
    items.push({ key: 'gc', label: 'Outside the sprint, on a path', swatch: ticketCardBorder({ critical: true, waiting: false, ghost: true }) });
  }
  if (items.length === 0) return null;
  return (
    <ul aria-label="Card borders" data-testid="card-border-key" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-gray-700 dark:text-gray-300">
      {items.map((it) => (
        <li key={it.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-3.5 w-6 rounded ${it.swatch}`} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ── Critical path ────────────────────────────────────────────────────────────────────────────────

export function SprintPathsView({ data, onOpen }: { data: SprintGraphResponse; onOpen: OpenTicket }): JSX.Element {
  const view = sprintPathsView({
    aiEnabled: data.aiEnabled,
    paths: data.paths,
    status: data.pathsStatus,
    sprintTickets: data.nodes.filter((n) => !n.ghost).length,
  });
  // 'none' with AI on: the one credential / set-up line when that is why, else no heading at all.
  const ai = useAiCapabilities();
  const gateLine = ai.enabled && (ai.runtime !== 'ready' || ai.auth === 'none');
  const heading = view.kind !== 'none' || gateLine;
  const paths = view.kind === 'paths' ? view.paths : null;
  const columns = data.statusLayout?.columns ?? null;
  const board = useMemo(() => pathsBoard({ nodes: data.nodes, edges: data.edges, paths, columns }), [data.nodes, data.edges, paths, columns]);
  const productReview = (columns ?? []).some((c) => c.meaning === 'product_review');
  const calm = paths != null && paths.paths.length === 0;
  return (
    <section aria-label="Critical path" className="space-y-3" data-testid="sprint-paths" data-state={data.pathsStatus.state}>
      {data.pace != null && <PaceStrip pace={data.pace} productReview={productReview} />}
      {heading && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-100">{calm ? 'No critical paths in this sprint.' : 'Critical paths'}</h4>
          <InfoButton title="Critical paths">
            <PathsInfo aiEnabled={data.aiEnabled} />
          </InfoButton>
          {view.kind === 'paths' && view.note?.kind === 'updating' && <span className={`text-xs ${MUTED}`}>Updating</span>}
          {view.kind === 'message' && (
            <span className={`inline-flex items-center gap-2 text-xs ${MUTED}`}>
              {view.writing && (
                <SprintProgressBar
                  progress={{ kind: 'busy', label: 'Working out the critical paths' }}
                  testId="sprint-paths-progress"
                  className="h-[3px] w-16 shrink-0 rounded-full"
                />
              )}
              {view.text}
            </span>
          )}
          {view.kind === 'off' && <span className={`text-xs ${MUTED}`}>Claude is off here, so there are no critical paths.</span>}
          {view.kind === 'none' && <AiRunGate>{null}</AiRunGate>}
        </div>
      )}
      {view.kind === 'paths' && view.note?.kind === 'failed' && <p className={`text-xs ${MUTED}`}>{view.note.text}</p>}
      {board.cards.length > 0 && <SprintLaneBoard board={board} label="Critical paths" laneWidth="minmax(9rem, 13rem)" show="initials" onOpen={onOpen} />}
      <Callouts data={data} onOpen={onOpen} />
      <CountTableView data={data} />
    </section>
  );
}

function PaceStrip({ pace, productReview }: { pace: SprintPace; productReview: boolean }): JSX.Element {
  const items = paceItems(pace, { productReview });
  return (
    <dl data-testid="sprint-pace" aria-label="Pace" className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-800">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className={`text-[11px] ${MUTED}`}>{it.label}</dt>
          <dd className="flex items-center gap-2 text-[13px] font-semibold text-gray-900 dark:text-gray-50">
            {it.value}
            {it.pct != null && (
              <span
                role="progressbar"
                aria-label="Time used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={it.pct}
                className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              >
                <span className="block h-full bg-gray-700 dark:bg-gray-300" style={{ width: `${Math.max(0, Math.min(100, it.pct))}%` }} />
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const GAP_MINUTES = Math.round(SPRINT_VISIT_GAP_MS / 60_000);

function PathsInfo({ aiEnabled }: { aiEnabled: boolean }): JSX.Element {
  return (
    <div className="space-y-2 text-sm">
      {aiEnabled && (
        <p>
          Claude picks up to five <strong>critical paths</strong> &mdash; the chains of tickets that most put the sprint at risk, riskiest
          first, each in the order the work must happen &mdash; and up to three call-outs, after a sprint read that changed something.
          Limn builds the map Claude reads and counts every number; Claude&rsquo;s words carry none.
        </p>
      )}
      <p>
        Each row is one path. Its tickets sit in their columns, and an arrow runs from the ticket waited on to the one that waits.
        A ticket outside the sprint sits faint, in &ldquo;Outside the sprint&rdquo;.
      </p>
      <p>
        <strong>Pace</strong>: the day of the sprint (today counts), then how many of its tickets have their code merged (at least one
        pull request merged and none open), sit in a Product review bucket, or are in a bucket that means Complete. Open
        dependencies counts the links from an unfinished ticket to another unfinished one.
      </p>
      <p>Limn writes some call-outs itself, from what it has stored:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Since you last looked</strong>: tickets that changed section, tickets added and pull requests merged since your last
          visit. A visit ends after {GAP_MINUTES} minutes away from this page.
        </li>
        <li>
          <strong>Out of step</strong>: the tracker and the code disagree &mdash; in code review with no open pull request, Complete with one
          still open, or Not started with one open.
        </li>
        <li>
          <strong>Blocked outside the sprint</strong>: sprint tickets waiting on an unfinished ticket outside the sprint.
        </li>
      </ul>
      <p>The table at the bottom counts every sprint ticket by theme and column.</p>
    </div>
  );
}

/** Claude's call-outs, then Limn's own (pace is the strip above, so it is not repeated). */
function Callouts({ data, onOpen }: { data: SprintGraphResponse; onOpen: OpenTicket }): JSX.Element | null {
  const byIdent = useMemo(() => new Map(data.nodes.map((n) => [n.ident, n])), [data.nodes]);
  const items = [
    ...(data.aiEnabled ? (data.paths?.callouts ?? []) : []).map((c, i) => ({ key: `c:${i}`, label: 'Call-out', title: c.title, sentence: null as string | null, idents: c.idents })),
    ...(data.signals ?? [])
      .filter((s) => s.kind !== 'pace')
      .map((s) => ({ key: `s:${s.kind}`, label: SPRINT_SIGNAL_LABEL[s.kind], title: s.title, sentence: s.sentence, idents: s.idents })),
  ];
  if (items.length === 0) return null;
  return (
    <ul aria-label="Call-outs" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((it) => {
        const tickets = it.idents.map((x) => byIdent.get(x)).filter((n): n is SprintGraphNode => n != null);
        return (
          <li key={it.key} className="space-y-0.5 rounded-md border border-gray-200 px-2.5 py-1.5 dark:border-gray-800">
            <p className={`text-[11px] font-medium ${MUTED}`}>{it.label}</p>
            <p className="text-xs font-semibold text-gray-800 dark:text-gray-100">{it.title}</p>
            {it.sentence != null && <p className={`text-xs ${MUTED}`}>{it.sentence}</p>}
            {tickets.length > 0 && (
              <p className="flex flex-wrap gap-1 pt-0.5">
                {tickets.map((n) => (
                  <button
                    key={n.ident}
                    type="button"
                    onClick={() => onOpen(n)}
                    aria-label={`${n.key}${n.title !== '' ? `: ${n.title}` : ''}, opens its story`}
                    className="rounded border border-gray-300 px-1 font-mono text-[11px] text-gray-800 hover:border-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-gray-700 dark:text-gray-100"
                  >
                    {n.key}
                  </button>
                ))}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CountTableView({ data }: { data: SprintGraphResponse }): JSX.Element | null {
  const t = useMemo(() => countTable(data.nodes, data.themes, data.statusLayout?.columns ?? null), [data.nodes, data.themes, data.statusLayout]);
  if (t.total === 0) return null;
  const cell = 'px-2 py-1 text-right tabular-nums';
  return (
    <div className="overflow-x-auto">
      <table data-testid="sprint-count-table" className="min-w-full text-[12px] text-gray-800 dark:text-gray-100">
        <caption className="pb-1 text-left text-xs font-medium text-gray-800 dark:text-gray-100">Every ticket, by theme and column</caption>
        <thead className={MUTED}>
          <tr className="border-b border-gray-200 dark:border-gray-800">
            <th scope="col" className="px-2 py-1 text-left font-medium">
              Theme
            </th>
            {t.columns.map((c) => (
              <th key={c.id} scope="col" className="px-2 py-1 text-right font-medium">
                {c.name}
              </th>
            ))}
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800/60">
              <th scope="row" className="px-2 py-1 text-left font-normal">
                {r.label}
              </th>
              {r.counts.map((n, i) => (
                <td key={t.columns[i]!.id} className={cell}>
                  {n}
                </td>
              ))}
              <td className={`${cell} font-semibold`}>{r.total}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="px-2 py-1 text-left font-semibold">
              Total
            </th>
            {t.totals.map((n, i) => (
              <td key={t.columns[i]!.id} className={`${cell} font-semibold`}>
                {n}
              </td>
            ))}
            <td className={`${cell} font-semibold`}>{t.total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Theme ────────────────────────────────────────────────────────────────────────────────────────

export function SprintThemesView({ data, onOpen }: { data: SprintGraphResponse; onOpen: OpenTicket }): JSX.Element {
  const columns = data.statusLayout?.columns ?? null;
  const board = useMemo(
    () => themesBoard({ nodes: data.nodes, edges: data.edges, paths: data.paths, columns, themes: data.themes }),
    [data.nodes, data.edges, data.paths, columns, data.themes],
  );
  const themesOn = data.themes != null && data.themes.length > 0;
  return (
    <section aria-label="By theme" className="space-y-2" data-testid="sprint-themes">
      {!themesOn && (
        <p className={`text-xs ${MUTED}`}>
          {data.aiEnabled ? 'Themes appear after Claude reads the sprint.' : 'Claude is off here, so the sprint has no themes.'}
        </p>
      )}
      <SprintLaneBoard board={board} label="Tickets by theme" laneWidth="minmax(8rem, 12rem)" show="initials" onOpen={onOpen} />
    </section>
  );
}

// ── People ───────────────────────────────────────────────────────────────────────────────────────

export function SprintPeopleView({ data, onOpen }: { data: SprintGraphResponse; onOpen: OpenTicket }): JSX.Element {
  const columns = data.statusLayout?.columns ?? null;
  // ⚠ Alphabetical, Unassigned last (lib/laneBoard.ts `peopleBoard`) — never sorted by load.
  const board = useMemo(
    () => peopleBoard({ nodes: data.nodes, edges: data.edges, paths: data.paths, columns, people: data.people }),
    [data.nodes, data.edges, data.paths, columns, data.people],
  );
  return (
    <section aria-label="By person" className="space-y-2" data-testid="sprint-people">
      <SprintLaneBoard board={board} label="Tickets by person" laneWidth="minmax(8rem, 11rem)" show="theme" onOpen={onOpen} />
    </section>
  );
}

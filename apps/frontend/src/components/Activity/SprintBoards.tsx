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
  cardFilterOn,
  cellKey,
  collapsedColumns,
  sprintCardFilter,
  countTable,
  layoutBoard,
  paceItems,
  pathsBoard,
  peopleBoard,
  themesBoard,
  hasLivePr,
  assigneeLabel,
  personIndex,
  ticketCardMarks,
  ticketCardSurface,
  TICKET_CARD_MARK_LABEL,
  type BoardLayout,
  type LaneSegment,
  type SprintBoard,
  type SprintCardData,
  type SprintCardFilter,
  type SprintLaneData,
} from '../../lib/laneBoard.js';
import { useSprintBoardFilter } from '../../store/sprintBoardFilter.js';
import { aiAuthFor, useAiCapabilities, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import { AiRunGate } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import { HoverPopover } from '../HoverPopover.js';
import { BorderKey, LaneBoard, useBoardObstacles, type BorderKeyItem } from '../LaneBoard.js';
import { TicketCard } from '../TicketCard.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { sprintPathsView } from './sprintPathsModel.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { CriticalPathIcon, PullRequestIcon, WaitingIcon, WarningIcon } from '../Icons.js';
import { cx, FOCUS_RING } from '../ui/cx.js';

// ACTIVITY → THIS SPRINT: THE THREE VIEWS (docs/FRONTEND.md § Activity → This Sprint). Three independent
// angles on the same sprint, each a LANE BOARD (components/LaneBoard.tsx; layout lib/laneBoard.ts) over
// the SAME columns — the workspace's status buckets in order (Code review, Product review and the rest):
//   • CRITICAL PATH (the landing view) — CODE's pace strip, then one lane per stored critical path (the
//     sprint builder's; riskiest first, each with its risk as a word, its title and its one sentence of
//     advice), the call-outs (Claude's, then Limn's own), and a theme × column count of every ticket.
//   • THEME — one lane per theme, "No theme" last; each header carries Claude's sentence on what the
//     work involves (the themes pass), then CODE's line: tickets by column and pull-request presence.
//   • PEOPLE — one lane per assignee, Unassigned last; each header carries CODE's line.
// Theme and People lanes draw a colour bar of their tickets by column; hovering (or focusing) it shows
// the key. Under each board, a key to the card borders (the shared `BorderKey`). Every card is a
// TicketCard: a click shows its story in the TRAY beside the board (`actions.onSelect`, as does a
// call-out's ticket key); its corner arrow opens the ticket's story tab (`actions.onOpen`). A Complete column's
// "n tickets" opens that lane's cell only.
//
// ROW ORDER: every view's rows are sorted by their pull request count, most first (lib/laneBoard.ts
// `byPrCount`; the owner's rule, 2026-10-26); each row header says its count. "No theme" and
// "Unassigned" stay last. FILTERS: the "Has PRs" / "Needs code" chips above the board
// (`SprintBoardFilters`, store/sprintBoardFilter.ts) drop cards on every view.

const MUTED = 'text-ui-mute';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The board's filters as a card test, and whether any is on. */
function useCardFilter(): { filter: SprintCardFilter; keep: ((n: SprintGraphNode) => boolean) | undefined } {
  const filter = useSprintBoardFilter((s) => s.filter);
  const keep = useMemo(() => (cardFilterOn(filter) ? sprintCardFilter(filter) : undefined), [filter]);
  return { filter, keep };
}

const CHIP = `inline-flex h-7 items-center gap-1.5 rounded-ui px-2.5 text-body touch:h-10 touch:px-3 motion-safe:transition-colors motion-safe:duration-ui-fast ${FOCUS_RING}`;
const CHIP_ON = 'bg-ui-sel font-medium text-ui-ink';
const CHIP_OFF = 'bg-ui-raise text-ui-mute hover:bg-ui-hover hover:text-ui-ink';

/** The board's two filter chips, above every view: "Has PRs" and "Needs code". With one on, how many
 *  sprint tickets show, of how many. */
export function SprintBoardFilters({ data }: { data: SprintGraphResponse }): JSX.Element {
  const name = useAiProviderName();
  const filter = useSprintBoardFilter((s) => s.filter);
  const toggle = useSprintBoardFilter((s) => s.toggle);
  const sprint = data.nodes.filter((n) => !n.ghost);
  const keep = sprintCardFilter(filter);
  const shown = sprint.filter(keep).length;
  const chip = (which: keyof SprintCardFilter, label: string) => (
    <button type="button" aria-pressed={filter[which]} onClick={() => toggle(which)} className={`${CHIP} ${filter[which] ? CHIP_ON : CHIP_OFF}`}>
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Filter tickets" data-testid="sprint-board-filters" className="flex flex-wrap items-center gap-1.5">
      {chip('hasPrs', 'Has PRs')}
      {chip('needsCode', 'Needs code')}
      <InfoButton title="Filters">
        <div className="space-y-2 text-body">
          <p>
            <strong>Has PRs</strong>: tickets with at least one pull request, open, merged or closed.
          </p>
          <p>
            <strong>Needs code</strong>: tickets with a pull request, plus Not started tickets that will most likely need code.
            {data.aiEnabled
              ? ` ${name} judges each of those from its text once, after the sprint is read, and again only when the text changes. A ticket not judged yet still shows, marked "Not judged yet". Hover a card to see why.`
              : ' AI is off here, so it shows only tickets with a pull request.'}
          </p>
          <p>With both on, a ticket must pass both. Every view uses them.</p>
        </div>
      </InfoButton>
      {cardFilterOn(filter) && (
        <span data-testid="sprint-filter-count" className={`text-meta ${MUTED}`}>
          {shown} of {plural(sprint.length, 'ticket')}
        </span>
      )}
    </div>
  );
}

/** One line when the filters leave a board empty. */
function NoMatch(): JSX.Element {
  return <p className={`text-meta ${MUTED}`}>No tickets match these filters.</p>;
}

type OpenTicket = (node: SprintGraphNode) => void;

/** What a card click and its corner arrow do, and which card's story the tray shows. */
export interface SprintCardActions {
  /** Show the ticket's story in the tray beside the board (a card click, a call-out key). */
  onSelect: OpenTicket;
  /** Open the ticket's story TAB (the card's corner arrow). */
  onOpen: OpenTicket;
  /** The ticket whose story the tray shows; null = no tray. */
  selectedIdent: string | null;
  /** The tray's element id, for the open card's `aria-controls`. */
  trayId: string;
}

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
  people,
  actions,
  codeMarker,
}: {
  board: SprintBoard;
  label: string;
  laneWidth: string;
  show: 'person' | 'theme';
  people: SprintGraphResponse['people'];
  actions: SprintCardActions;
  /** The Needs code filter is on: a card not judged yet says so. */
  codeMarker: boolean;
}): JSX.Element {
  // ONE spelling per person on the page: the People lane's (lib/laneBoard.ts `assigneeLabel`).
  const personOfName = useMemo(() => personIndex(people ?? []), [people]);
  // The Complete columns the reader opened, and the single lane cells ("n tickets") opened in one.
  const [shown, toggle] = useToggleSet();
  const [cells, toggleCellKey] = useToggleSet();
  const toggleCell = useCallback((lane: string, column: string) => toggleCellKey(cellKey(lane, column)), [toggleCellKey]);
  const layout = useMemo(
    () => layoutBoard<SprintLaneData, SprintCardData>({ ...board, collapsed: collapsedColumns(board.columns, shown), expanded: cells }),
    [board, shown, cells],
  );
  // Every mark a card on this board actually draws — the same three facts `ticketCardMarks` reads,
  // so the key can neither miss a mark nor show one no card has.
  const borders = useMemo(
    () =>
      new Set<string>([
        ...layout.cards.flatMap((c) => ticketCardMarks({ critical: c.data.critical, waiting: c.data.waiting, ghost: c.data.node.ghost === true })),
        ...(layout.cards.some((c) => c.data.node.ghost !== true && hasLivePr(c.data.node)) ? [PR_KEY] : []),
      ]),
    [layout.cards],
  );
  return (
    <LaneBoard
      label={label}
      layout={layout}
      laneWidth={laneWidth}
      onToggleColumn={toggle}
      onToggleCell={toggleCell}
      legend={<BorderKey items={sprintBorderKeyItems(borders)} label="Card marks" testId="card-border-key" />}
      renderLane={(l) => <LaneHeader lane={l} />}
      renderCard={(c, ref) => (
        <TicketCard
          node={c.data.node}
          critical={c.data.critical}
          waiting={c.data.waiting}
          show={show}
          person={assigneeLabel(c.data.node, personOfName)}
          selected={actions.selectedIdent === c.data.node.ident}
          trayId={actions.trayId}
          onSelect={actions.onSelect}
          onOpen={actions.onOpen}
          cardRef={ref}
          codeMarker={codeMarker}
        />
      )}
    />
  );
}

// A path's risk is a WORD with a mark, never a coloured chip: high risk is an attention mark (warn ink +
// the warning icon), medium and low are plain words. It is not red — a risky path does not block.
const RISK_TONE: Record<SprintPathRisk, string> = {
  high: 'text-ui-warn',
  medium: 'text-ui-mute',
  low: 'text-ui-faint',
};

function LaneHeader({ lane }: { lane: BoardLayout<SprintLaneData, SprintCardData>['lanes'][number] }): JSX.Element {
  const d = lane.data;
  const name = <h4 className="text-body font-medium text-ui-ink">{lane.label}</h4>;
  // The rows are sorted by this count, so each row says it.
  const prs = (
    <p data-testid="lane-prs" className={`text-meta ${MUTED}`}>
      {plural(d.prs, 'PR')}
    </p>
  );
  if (d.kind === 'path') {
    return (
      <div className="space-y-0.5">
        <span data-risk={d.risk} className={`inline-flex items-center gap-1 text-meta font-medium ${RISK_TONE[d.risk]}`}>
          {d.risk === 'high' && <WarningIcon size={11} />}
          {SPRINT_PATH_RISK_LABEL[d.risk]}
        </span>
        {name}
        {prs}
        <p className={`text-meta leading-snug ${MUTED}`}>{d.advice}</p>
      </div>
    );
  }
  if (d.kind === 'theme') {
    return (
      <div className="space-y-1">
        {name}
        {prs}
        {d.summary != null && <p className="text-meta leading-snug text-ui-ink">{d.summary}</p>}
        <SegmentBar segments={d.segments} lane={lane.label} progress={d.progress} code={d.code} />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {name}
      <p className={`text-meta ${MUTED}`}>
        {d.tickets} {d.tickets === 1 ? 'ticket' : 'tickets'} · {plural(d.prs, 'PR')}
        {/* null = no GitHub account mapped: say nothing, never 0. */}
        {d.reviewsWaiting != null && ` · ${d.reviewsWaiting} ${d.reviewsWaiting === 1 ? 'review' : 'reviews'} waiting`}
      </p>
      <SegmentBar segments={d.segments} lane={lane.label} progress={d.progress} code={d.code} />
    </div>
  );
}

const SEGMENT_FILL: Record<SprintStage | 'unknown', string> = {
  not_started: 'bg-ui-faint',
  in_progress: 'bg-sky-500',
  in_review: 'bg-amber-500',
  product_review: 'bg-emerald-400',
  done: 'bg-emerald-700 dark:bg-emerald-500',
  unknown: 'bg-ui-line',
};

/** A lane's tickets per column, as one bar. Hovering or focusing it shows CODE's row lines (the
 *  lane's tickets by column, then how many have a pull request) and the bar's colour key beside it,
 *  clear of the cards where it can be. ⚠ Those lines live HERE ONLY, never inline under the row's
 *  name: the header carries the name (and a theme's summary), the popover carries the counts. */
function SegmentBar({
  segments,
  lane,
  progress,
  code,
}: {
  segments: readonly LaneSegment[];
  lane: string;
  progress: string;
  code: string;
}): JSX.Element | null {
  const obstacles = useBoardObstacles();
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) return null;
  const words = [progress || segments.map((s) => `${s.count} ${s.name}`).join(', '), code].filter((w) => w !== '').join('. ');
  return (
    <HoverPopover
      label={`${lane}: ${words}`}
      obstacles={obstacles}
      testId="segment-bar"
      className="block w-full max-w-[9rem] py-1"
      content={
        <div data-testid="segment-key">
          {progress !== '' && <p data-testid="lane-progress">{progress}</p>}
          {code !== '' && <p data-testid="lane-code">{code}</p>}
          <ul className="mt-1.5 space-y-0.5">
            {segments.map((s) => (
              <li key={s.column} className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block h-2 w-3 shrink-0 rounded-ui ${SEGMENT_FILL[s.meaning ?? 'unknown']}`} />
                <span className="min-w-0 flex-1">{s.name}</span>
                <span className="tabular-nums">{s.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ui-mute">Each part is as wide as its share of the row&rsquo;s {total} tickets.</p>
        </div>
      }
    >
      <span aria-hidden className="flex h-1.5 w-full overflow-hidden rounded-full bg-ui-raise">
        {segments.map((s) => (
          <span key={s.column} className={SEGMENT_FILL[s.meaning ?? 'unknown']} style={{ width: `${(100 * s.count) / total}%` }} />
        ))}
      </span>
    </HoverPopover>
  );
}

/** The key entry for the pull-request mark a card with an open or merged pull request wears (TicketCard). */
const PR_KEY = 'pr';

/** The key to the card marks, under a board: exactly the marks the board draws (the shared
 *  `BorderKey`), each with the card's own icon or ground. */
function sprintBorderKeyItems(present: ReadonlySet<string>): BorderKeyItem[] {
  const items: BorderKeyItem[] = [];
  if (present.has('critical'))
    items.push({ key: 'critical', label: TICKET_CARD_MARK_LABEL.critical, icon: <CriticalPathIcon size={12} className="text-ai-signal" /> });
  if (present.has('waiting')) items.push({ key: 'waiting', label: TICKET_CARD_MARK_LABEL.waiting, icon: <WaitingIcon size={12} className="text-ui-mute" /> });
  if (present.has('outside')) items.push({ key: 'outside', label: TICKET_CARD_MARK_LABEL.outside, swatch: ticketCardSurface({ ghost: true }) });
  if (present.has(PR_KEY)) items.push({ key: PR_KEY, label: 'Has a pull request', icon: <PullRequestIcon size={11} className="text-ui-mute" /> });
  return items;
}

// ── Critical path ────────────────────────────────────────────────────────────────────────────────

export function SprintPathsView({ data, actions }: { data: SprintGraphResponse; actions: SprintCardActions }): JSX.Element {
  // A failed pass ran on the active provider: its line names that provider, never always Claude.
  const providerName = useAiProviderName();
  const view = sprintPathsView({
    providerName,
    aiEnabled: data.aiEnabled,
    paths: data.paths,
    status: data.pathsStatus,
    sprintTickets: data.nodes.filter((n) => !n.ghost).length,
  });
  // 'none' with AI on: the one credential / set-up line when that is why, else no heading at all.
  const ai = useAiCapabilities();
  const gateLine = ai.enabled && (ai.runtime !== 'ready' || aiAuthFor(ai, 'sprint_paths').auth === 'none');
  const heading = view.kind !== 'none' || gateLine;
  const paths = view.kind === 'paths' ? view.paths : null;
  const columns = data.statusLayout?.columns ?? null;
  const { filter, keep } = useCardFilter();
  const board = useMemo(() => pathsBoard({ nodes: data.nodes, edges: data.edges, paths, columns, keep }), [data.nodes, data.edges, paths, columns, keep]);
  // Paths are stored but the filters hide every ticket on them.
  const filteredOut = keep != null && board.cards.length === 0 && (paths?.paths.length ?? 0) > 0;
  const productReview = (columns ?? []).some((c) => c.meaning === 'product_review');
  const calm = paths != null && paths.paths.length === 0;
  return (
    <section aria-label="Critical path" className="space-y-3" data-testid="sprint-paths" data-state={data.pathsStatus.state}>
      {data.pace != null && <PaceStrip pace={data.pace} productReview={productReview} />}
      {heading && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="text-body font-medium text-ui-ink">{calm ? 'No critical paths in this sprint.' : 'Critical paths'}</h4>
          <InfoButton title="Critical paths">
            <PathsInfo aiEnabled={data.aiEnabled} />
          </InfoButton>
          {view.kind === 'paths' && data.paths != null && <AiRunLabel provider={data.paths.provider} model={data.paths.model} />}
          {view.kind === 'paths' && view.note?.kind === 'updating' && <span className={`text-meta ${MUTED}`}>Updating</span>}
          {view.kind === 'message' && (
            <span className={`inline-flex items-center gap-2 text-meta ${MUTED}`}>
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
          {view.kind === 'off' && <span className={`text-meta ${MUTED}`}>AI is off here, so there are no critical paths.</span>}
          {view.kind === 'none' && <AiRunGate kind="sprint_paths">{null}</AiRunGate>}
        </div>
      )}
      {view.kind === 'paths' && view.note?.kind === 'failed' && <p className={`text-meta ${MUTED}`}>{view.note.text}</p>}
      {board.cards.length > 0 && (
        <SprintLaneBoard board={board} label="Critical paths" laneWidth="minmax(9rem, 13rem)" show="person" people={data.people} actions={actions} codeMarker={filter.needsCode} />
      )}
      {filteredOut && <NoMatch />}
      <Callouts data={data} onOpen={actions.onSelect} />
      <CountTableView data={data} />
    </section>
  );
}

function PaceStrip({ pace, productReview }: { pace: SprintPace; productReview: boolean }): JSX.Element {
  const items = paceItems(pace, { productReview });
  return (
    <dl data-testid="sprint-pace" aria-label="Pace" className="flex flex-wrap gap-x-8 gap-y-2 rounded-ui bg-ui-surface px-4 py-3">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className={`text-meta ${MUTED}`}>{it.label}</dt>
          <dd className="flex items-center gap-2 text-body font-semibold text-ui-ink">
            {it.value}
            {it.pct != null && (
              <span
                role="progressbar"
                aria-label="Time used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={it.pct}
                className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-ui-raise"
              >
                <span className="block h-full bg-ui-mute" style={{ width: `${Math.max(0, Math.min(100, it.pct))}%` }} />
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
  const name = useAiProviderName();
  return (
    <div className="space-y-2 text-body">
      {aiEnabled && (
        <p>
          {name} picks up to five <strong>critical paths</strong> &mdash; the chains of tickets that most put the sprint at risk, riskiest
          first, each in the order the work must happen &mdash; and up to three call-outs, after a sprint read that changed something.
          Limn builds the map {name} reads and counts every number; {name}&rsquo;s words carry none.
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
          <li key={it.key} className="space-y-0.5 rounded-ui bg-ui-surface px-3 py-2.5">
            <p className={`text-meta font-medium ${MUTED}`}>{it.label}</p>
            <p className="text-meta font-semibold text-ui-ink">{it.title}</p>
            {it.sentence != null && <p className={`text-meta ${MUTED}`}>{it.sentence}</p>}
            {tickets.length > 0 && (
              <p className="flex flex-wrap gap-1 pt-0.5">
                {tickets.map((n) => (
                  <button
                    key={n.ident}
                    type="button"
                    onClick={() => onOpen(n)}
                    aria-label={`${n.key}${n.title !== '' ? `: ${n.title}` : ''}, shows its story beside the board`}
                    className={`inline-flex h-6 items-center rounded-ui bg-ui-raise px-1.5 font-mono text-meta text-ui-ink hover:bg-ui-hover touch:h-10 touch:px-2.5 ${FOCUS_RING}`}
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
      <table data-testid="sprint-count-table" className="min-w-full text-meta text-ui-ink">
        <caption className="pb-1 text-left text-meta font-medium text-ui-ink">Every ticket, by theme and column</caption>
        <thead className={MUTED}>
          <tr className="border-b border-ui-line">
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
            <tr key={r.id} className="border-b border-ui-line/50">
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

export function SprintThemesView({ data, actions }: { data: SprintGraphResponse; actions: SprintCardActions }): JSX.Element {
  const aiName = useAiProviderName();
  const columns = data.statusLayout?.columns ?? null;
  const { filter, keep } = useCardFilter();
  const board = useMemo(
    () => themesBoard({ nodes: data.nodes, edges: data.edges, paths: data.paths, columns, themes: data.themes, keep }),
    [data.nodes, data.edges, data.paths, columns, data.themes, keep],
  );
  const themesOn = data.themes != null && data.themes.length > 0;
  return (
    <section aria-label="By theme" className="space-y-2" data-testid="sprint-themes">
      {!themesOn && (
        <p className={`text-meta ${MUTED}`}>
          {data.aiEnabled ? `Themes appear after ${aiName} reads the sprint.` : 'AI is off here, so the sprint has no themes.'}
        </p>
      )}
      {board.cards.length === 0 && keep != null ? (
        <NoMatch />
      ) : (
        <SprintLaneBoard board={board} label="Tickets by theme" laneWidth="minmax(8rem, 12rem)" show="person" people={data.people} actions={actions} codeMarker={filter.needsCode} />
      )}
    </section>
  );
}

// ── People ───────────────────────────────────────────────────────────────────────────────────────

export function SprintPeopleView({ data, actions }: { data: SprintGraphResponse; actions: SprintCardActions }): JSX.Element {
  const columns = data.statusLayout?.columns ?? null;
  // Alphabetical, Unassigned last — never by load (lib/laneBoard.ts `peopleBoard`).
  const { filter, keep } = useCardFilter();
  const board = useMemo(
    () => peopleBoard({ nodes: data.nodes, edges: data.edges, paths: data.paths, columns, people: data.people, keep }),
    [data.nodes, data.edges, data.paths, columns, data.people, keep],
  );
  return (
    <section aria-label="By person" className="space-y-2" data-testid="sprint-people">
      {board.cards.length === 0 && keep != null ? (
        <NoMatch />
      ) : (
        <SprintLaneBoard board={board} label="Tickets by person" laneWidth="minmax(8rem, 11rem)" show="theme" people={data.people} actions={actions} codeMarker={filter.needsCode} />
      )}
    </section>
  );
}

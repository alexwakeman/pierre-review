// THE LANE BOARD'S PURE FOLDS (test/laneBoard.test.ts; docs/FRONTEND.md § Activity → This Sprint).
//
// ONE board shape draws all three This Sprint views (components/LaneBoard.tsx): COLUMNS across (the
// workspace's status buckets in order — Code review, Product review and the rest), LANES down
// (a critical path, a theme or a person), one TicketCard per ticket in a padded slot, and right-angled
// arrows through the gaps (lib/designGrid.ts `routeArrow`, the design grid's router). The first half of
// this file is the generic layout (which grid row and column each card takes, which arrows can be
// drawn, the numbered key); the second half builds each view's lanes, cards and arrows from
// `SprintGraphResponse`.
//
//   COLUMNS   `statusLayout.columns`, verbatim. "Outside the sprint" is added at the LEFT only for the
//             Critical path view and only when a path names a ticket outside the sprint; "Status not
//             known" at the right only when a card has no column. A Complete column is COLLAPSED by
//             default (a count and "Show"), so a sprint with many done or won't-do tickets still fits;
//             a lane's own "n tickets" opens THAT lane's cell only (`expanded`, `cellKey`).
//   LANES     each lane is as many grid rows as its fullest cell; an empty lane is not drawn.
//   ARROWS    a `depends_on` edge, drawn FROM the ticket waited on TO the one that waits (the flow of
//             work). Only between two DRAWN cards — a card in a collapsed column draws no arrow. A
//             labelled arrow carries a number; arrows with the same words share one.
//
// ⚠ NOTHING HERE RANKS PEOPLE. The People view's lanes are alphabetical, Unassigned last — never by
// load, tickets or reviews (the People report's guardrail: prep, not scoring).
import {
  SPRINT_STAGE_LABEL,
  personNameKey,
  sprintLaneSummary,
  type SprintColumn,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintPace,
  type SprintPathRisk,
  type SprintPaths,
  type SprintPerson,
  type SprintStage,
  type SprintTheme,
} from '@pierre-review/shared';

// ── The generic board ────────────────────────────────────────────────────────────────────────────

export interface BoardColumn {
  id: string;
  name: string;
  /** The bucket's meaning; null for "Outside the sprint" and "Status not known". */
  meaning: SprintStage | null;
}

export interface BoardLaneDef<L> {
  id: string;
  label: string;
  data: L;
}

export interface BoardCardDef<C> {
  /** Unique on the board (a ticket on two paths is two cards). */
  id: string;
  lane: string;
  column: string;
  /** What a column's header count counts: cards sharing one (the same ticket on two paths) count once.
   *  Absent = the card's id. */
  unit?: string;
  /** The card's GROUP within its lane's cell: lower groups sit first (This Sprint: 0 = has a pull
   *  request). Absent = 0. The link-based ordering works WITHIN a group, never across one. */
  group?: number;
  data: C;
}

export interface BoardArrowDef {
  /** Card ids: the arrow runs from → to. */
  from: string;
  to: string;
  /** The words keyed under the board; null = an unnumbered arrow. */
  label: string | null;
  /** Drawn in the accent (on a critical path). */
  critical: boolean;
  /** How the arrow reads aloud (the sr-only list). */
  text: string;
}

export interface BoardLayout<L, C> {
  /** `widened`: a collapsed column with at least one lane's cell opened — it takes a full track. */
  columns: Array<BoardColumn & { index: number; collapsed: boolean; collapsible: boolean; count: number; widened: boolean }>;
  /** `row` is the lane's first grid row (0-based, header not counted); `span` its rows (≥ 1);
   *  `hidden` the lane's cards per collapsed column it has not opened; `opened` the collapsed columns
   *  whose cards this lane shows (with their counts, so the cell can offer "Hide"). */
  lanes: Array<BoardLaneDef<L> & { row: number; span: number; size: number; hidden: Map<string, number>; opened: Map<string, number> }>;
  cards: Array<BoardCardDef<C> & { row: number; col: number }>;
  arrows: Array<BoardArrowDef & { key: string; n: number | null }>;
  /** The numbered key under the board: one entry per distinct label, in first-seen order. */
  key: Array<{ n: number; label: string }>;
  rows: number;
}

/** A Complete bucket folds to a count (never a pseudo-column). */
export function isCollapsible(c: Pick<BoardColumn, 'meaning'>): boolean {
  return c.meaning === 'done';
}

/** The key of one lane's cell in one column (the per-lane "n tickets" toggle). */
export const cellKey = (laneId: string, columnId: string): string => `${laneId}|${columnId}`;

/** The collapsed columns: every collapsible column the reader has not asked to see. */
export function collapsedColumns(columns: ReadonlyArray<BoardColumn>, shown: ReadonlySet<string>): Set<string> {
  return new Set(columns.filter((c) => isCollapsible(c) && !shown.has(c.id)).map((c) => c.id));
}

/**
 * LINKED CARDS SIT NEAR EACH OTHER. Within a lane, the order of a column's cards is free (the column
 * is the status, the lane the group), so it is chosen to shorten the arrows: each card is placed by
 * the mean row of the cards it is linked to (a barycentre sweep, left to right then back, a few
 * times), a card with no links keeping its place. Stable, so with no arrows the input order stands.
 * ⚠ A card's `group` always wins over its links: the sort keys on (group, barycentre, place), so
 * This Sprint's cards with a pull request stay first in their cell whatever the arrows want.
 * Mutates the lists in `stacks` in place.
 */
function orderByLinks<C>(
  stacks: Array<{ start: number; cols: Map<string, Array<BoardCardDef<C>>> }>,
  arrows: ReadonlyArray<BoardArrowDef>,
  columnOrder: readonly string[],
): void {
  const links = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    const l = links.get(a);
    if (l == null) links.set(a, [b]);
    else l.push(b);
  };
  for (const a of arrows) {
    link(a.from, a.to);
    link(a.to, a.from);
  }
  if (links.size === 0) return;
  const rowOf = new Map<string, number>();
  const reindex = (): void => {
    for (const st of stacks) for (const list of st.cols.values()) list.forEach((c, k) => rowOf.set(c.id, st.start + k));
  };
  reindex();
  const sweep = [...columnOrder, ...[...columnOrder].reverse()];
  for (let round = 0; round < 4; round++) {
    for (const column of sweep) {
      for (const st of stacks) {
        const list = st.cols.get(column);
        if (list == null || list.length < 2) continue;
        const keyed = list.map((c, k) => {
          const rows = (links.get(c.id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r != null);
          const key = rows.length > 0 ? rows.reduce((x, y) => x + y, 0) / rows.length : st.start + k;
          return { c, key, k, g: c.group ?? 0 };
        });
        keyed.sort((a, b) => a.g - b.g || a.key - b.key || a.k - b.k);
        keyed.forEach((e, k) => {
          list[k] = e.c;
          rowOf.set(e.c.id, st.start + k);
        });
      }
    }
  }
}

/** A stable sort by `group` (absent = 0). */
function sortByGroup<C>(list: ReadonlyArray<BoardCardDef<C>>): Array<BoardCardDef<C>> {
  return list
    .map((c, k) => ({ c, k }))
    .sort((a, b) => (a.c.group ?? 0) - (b.c.group ?? 0) || a.k - b.k)
    .map((e) => e.c);
}

/** Where every card, lane and arrow goes. Pure. */
export function layoutBoard<L, C>(input: {
  columns: ReadonlyArray<BoardColumn>;
  lanes: ReadonlyArray<BoardLaneDef<L>>;
  cards: ReadonlyArray<BoardCardDef<C>>;
  arrows: ReadonlyArray<BoardArrowDef>;
  collapsed: ReadonlySet<string>;
  /** `cellKey(lane, column)`s of collapsed cells a reader opened: that lane's cards in that column are
   *  drawn; every other lane keeps its count. */
  expanded?: ReadonlySet<string>;
}): BoardLayout<L, C> {
  const expanded = input.expanded ?? new Set<string>();
  const colIndex = new Map(input.columns.map((c, i) => [c.id, i]));
  const known = input.cards.filter((c) => colIndex.has(c.column));
  // Distinct UNITS per column (a ticket drawn on two paths is one ticket in that column's count).
  const units = new Map<string, Set<string>>();
  for (const c of known) {
    const u = units.get(c.column) ?? new Set<string>();
    u.add(c.unit ?? c.id);
    units.set(c.column, u);
  }
  const count = new Map([...units].map(([k, v]) => [k, v.size] as const));
  const columns = input.columns.map((c, index) => ({
    ...c,
    index,
    collapsible: isCollapsible(c),
    collapsed: isCollapsible(c) && input.collapsed.has(c.id),
    count: count.get(c.id) ?? 0,
    widened: false,
  }));
  const isCollapsed = new Set(columns.filter((c) => c.collapsed).map((c) => c.id));
  const widened = new Set<string>();
  const byLane = new Map<string, Array<BoardCardDef<C>>>();
  for (const c of known) {
    const l = byLane.get(c.lane);
    if (l == null) byLane.set(c.lane, [c]);
    else l.push(c);
  }
  const lanes: BoardLayout<L, C>['lanes'] = [];
  const seen = new Set<string>();
  // Pass 1: each lane's cards per shown column (input order), its start row and its span.
  const stacks: Array<{ start: number; cols: Map<string, Array<BoardCardDef<C>>>; below: Set<string> }> = [];
  let row = 0;
  for (const lane of input.lanes) {
    const mine = (byLane.get(lane.id) ?? []).filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    if (mine.length === 0) continue;
    const hidden = new Map<string, number>();
    const opened = new Map<string, number>();
    const cols = new Map<string, Array<BoardCardDef<C>>>();
    for (const c of mine) {
      if (isCollapsed.has(c.column)) {
        if (!expanded.has(cellKey(lane.id, c.column))) {
          hidden.set(c.column, (hidden.get(c.column) ?? 0) + 1);
          continue;
        }
        opened.set(c.column, (opened.get(c.column) ?? 0) + 1);
        widened.add(c.column);
      }
      const list = cols.get(c.column);
      if (list == null) cols.set(c.column, [c]);
      else list.push(c);
    }
    // Lower groups first in every cell (stable: input order stands within a group).
    for (const [col, list] of cols) {
      if (list.some((c) => (c.group ?? 0) !== 0)) cols.set(col, sortByGroup(list));
    }
    // An opened cell's first row holds its "Hide" toggle; its cards sit below it.
    const span = Math.max(1, ...[...cols].map(([col, l]) => l.length + (opened.has(col) ? 1 : 0)));
    lanes.push({ ...lane, row, span, size: mine.length, hidden, opened });
    stacks.push({ start: row, cols, below: new Set(opened.keys()) });
    row += span;
  }
  for (const c of columns) c.widened = widened.has(c.id);
  orderByLinks(stacks, input.arrows, input.columns.map((c) => c.id));
  const cards: BoardLayout<L, C>['cards'] = [];
  for (const st of stacks) {
    for (const [column, list] of st.cols) {
      const off = st.below.has(column) ? 1 : 0;
      list.forEach((c, k) => cards.push({ ...c, row: st.start + k + off, col: colIndex.get(column)! }));
    }
  }
  const placed = new Set(cards.map((c) => c.id));
  const arrows: BoardLayout<L, C>['arrows'] = [];
  const numbers = new Map<string, number>();
  const key: BoardLayout<L, C>['key'] = [];
  const drawn = new Set<string>();
  for (const a of input.arrows) {
    if (a.from === a.to || !placed.has(a.from) || !placed.has(a.to)) continue;
    const k = `${a.from}>${a.to}`;
    if (drawn.has(k)) continue;
    drawn.add(k);
    let n: number | null = null;
    if (a.label != null) {
      n = numbers.get(a.label) ?? null;
      if (n == null) {
        n = numbers.size + 1;
        numbers.set(a.label, n);
        key.push({ n, label: a.label });
      }
    }
    arrows.push({ ...a, key: k, n });
  }
  return { columns, lanes, cards, arrows, key, rows: row };
}

// ── This Sprint's three views ────────────────────────────────────────────────────────────────────

export type SprintBoardView = 'paths' | 'themes' | 'people';

/** The pseudo-columns' ids (never a bucket id: SPRINT_BUCKET_ID_RE has no `_` lead pair). */
export const OUTSIDE_COLUMN_ID = '__outside';
export const UNKNOWN_COLUMN_ID = '__unknown';
export const OUTSIDE_COLUMN_LABEL = 'Outside the sprint';
export const UNKNOWN_COLUMN_LABEL = 'Status not known';

/** The column a ticket is drawn in: a ticket outside the sprint sits in "Outside the sprint" (the
 *  Critical path view only — the other views draw sprint tickets alone). */
export function columnOfNode(n: Pick<SprintGraphNode, 'ghost' | 'column'>, view: SprintBoardView): string {
  if (n.ghost && view === 'paths') return OUTSIDE_COLUMN_ID;
  return n.column ?? UNKNOWN_COLUMN_ID;
}

/** The board's columns: the layout's, with the two pseudo-columns only where a card needs one. */
export function sprintColumns(
  layoutColumns: ReadonlyArray<SprintColumn> | null | undefined,
  need: { outside: boolean; unknown: boolean },
): BoardColumn[] {
  const out: BoardColumn[] = [];
  if (need.outside) out.push({ id: OUTSIDE_COLUMN_ID, name: OUTSIDE_COLUMN_LABEL, meaning: null });
  for (const c of layoutColumns ?? []) out.push({ id: c.id, name: c.name, meaning: c.meaning });
  if (need.unknown) out.push({ id: UNKNOWN_COLUMN_ID, name: UNKNOWN_COLUMN_LABEL, meaning: null });
  return out;
}

const isFailingCi = (ci: SprintGraphNode['prs'][number]['ciState']): boolean => ci === 'failure' || ci === 'error';

/** Does a ticket have a pull request that counts — an open or merged one (a closed, unmerged one does
 *  not)? The same population as `ticketCardTags`' PR tag. Such a card is HIGHLIGHTED (a violet border
 *  and a soft glow, `ticketCardBorder`) and sits FIRST in its cell (`BoardCardDef.group`). */
export function hasLivePr(n: Pick<SprintGraphNode, 'prs'>): boolean {
  return n.prs.some((p) => p.state !== 'closed');
}

/** A TicketCard's acceptance-criteria line, or null when there is nothing to say.
 *   - a ticket CHECK (the ticket review) succeeded: "3 of 4 criteria met", from its own criteria list
 *     (`stale` when its pull requests moved since — the card dims it and says so aloud);
 *   - else the current brief counted criteria: "4 criteria" / "1 criterion";
 *   - else nothing.
 *  `running`: a check of this ticket is queued or running now (a spinner, no extra words). Pure. */
export function ticketCardCriteria(
  n: Pick<SprintGraphNode, 'brief' | 'check' | 'checkRunning'>,
): { text: string; stale: boolean; running: boolean } | null {
  const running = n.checkRunning === true;
  const c = n.check;
  if (c != null && c.total > 0) return { text: `${c.met} of ${c.total} ${c.total === 1 ? 'criterion' : 'criteria'} met`, stale: c.stale, running };
  const count = n.brief.criteriaCount;
  if (count > 0) return { text: `${count} ${count === 1 ? 'criterion' : 'criteria'}`, stale: false, running };
  return running ? { text: '', stale: false, running } : null;
}

/** A TicketCard's tags, as WORDS (never colour alone): "CI failing" (an open pull request's checks are
 *  red), "No PR" or "n PRs · m open" (open and merged ones; a closed, unmerged one does not count),
 *  "No owner" (a sprint ticket nobody is assigned). Pure. */
export function ticketCardTags(n: Pick<SprintGraphNode, 'prs' | 'assignee' | 'ghost'>): string[] {
  const tags: string[] = [];
  const live = n.prs.filter((p) => p.state !== 'closed');
  const open = live.filter((p) => p.state === 'open');
  if (open.some((p) => isFailingCi(p.ciState))) tags.push('CI failing');
  tags.push(live.length === 0 ? 'No PR' : `${live.length} ${live.length === 1 ? 'PR' : 'PRs'} · ${open.length} open`);
  if (!n.ghost && n.assignee == null) tags.push('No owner');
  return tags;
}

/** A TicketCard's border, by STYLE as well as colour: on a critical path = 2px solid accent; waiting
 *  on another unfinished ticket = dashed (accent and dashed when both); outside the sprint = a faint
 *  1px dashed border on a tinted ground, whatever else it is (a light accent when on a path).
 *  HAS A PULL REQUEST (`withPr`, an open or merged one — `hasLivePr`): a violet border (the merge
 *  family's hue) and a soft violet glow (`.ticket-card-pr`, index.css). A critical-path card KEEPS its
 *  orange 2px border and only adds the glow. A ticket outside the sprint never glows. */
export function ticketCardBorder(o: { critical: boolean; waiting: boolean; ghost: boolean; withPr?: boolean }): string {
  // A ticket outside the sprint is FAINT whatever else it is — on a path, its dashed border is the accent, lighter.
  if (o.ghost) {
    return `border border-dashed ${o.critical ? 'border-ai-signal-fill/60' : 'border-gray-300 dark:border-gray-700'} bg-gray-50 dark:bg-gray-900/60`;
  }
  const glow = o.withPr === true ? ' ticket-card-pr' : '';
  if (o.critical) return `border-2 ${o.waiting ? 'border-dashed' : 'border-solid'} border-ai-signal-fill bg-white dark:bg-gray-950${glow}`;
  if (o.withPr === true) {
    return `border ${o.waiting ? 'border-dashed' : 'border-solid'} border-violet-400 bg-white dark:border-violet-500/70 dark:bg-gray-950${glow}`;
  }
  if (o.waiting) return 'border border-dashed border-gray-500 bg-white dark:border-gray-400 dark:bg-gray-950';
  return 'border border-solid border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950';
}

/** Tickets waiting on another unfinished ticket: an unfinished ticket with a `depends_on` edge onto one
 *  that is not Complete (status not known counts as unfinished, as the pace's count does). */
export function waitingIdents(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'stage'>>,
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to' | 'kind'>>,
): Set<string> {
  const stage = new Map(nodes.map((n) => [n.ident, n.stage]));
  const out = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'depends_on' || !stage.has(e.from) || !stage.has(e.to)) continue;
    if (stage.get(e.from) !== 'done' && stage.get(e.to) !== 'done') out.add(e.from);
  }
  return out;
}

/** Every ticket on a stored critical path. */
export function criticalIdents(paths: SprintPaths | null | undefined): Set<string> {
  return new Set((paths?.paths ?? []).flatMap((p) => p.idents));
}

/** Two tickets next to each other on a critical path (either order) — the link between them is drawn
 *  in the accent. */
function criticalPairs(paths: SprintPaths | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of paths?.paths ?? []) {
    for (let i = 1; i < p.idents.length; i += 1) {
      out.add(`${p.idents[i - 1]}|${p.idents[i]}`);
      out.add(`${p.idents[i]}|${p.idents[i - 1]}`);
    }
  }
  return out;
}

/** What one card carries. */
export interface SprintCardData {
  node: SprintGraphNode;
  critical: boolean;
  waiting: boolean;
}

export type SprintLaneData =
  | { kind: 'path'; risk: SprintPathRisk; advice: string }
  | {
      kind: 'theme';
      other: boolean;
      live: number;
      merged: number;
      segments: LaneSegment[];
      /** Claude's one or two sentences on what the theme's work involves (the themes pass); null for
       *  "No theme" / "All tickets", or when the pass wrote none. */
      summary: string | null;
      /** CODE's row line (shared `sprintLaneSummary`): progress by column, then pull-request presence. */
      progress: string;
      code: string;
    }
  | {
      kind: 'person';
      unassigned: boolean;
      tickets: number;
      reviewsWaiting: number | null;
      segments: LaneSegment[];
      progress: string;
      code: string;
    };

/** One part of a lane's bar: its cards in one column. */
export interface LaneSegment {
  column: string;
  name: string;
  meaning: SprintStage | null;
  count: number;
}

/** A lane's bar parts: its cards per column, in column order, empty columns left out. */
function segmentsOf(columns: ReadonlyArray<BoardColumn>, mine: ReadonlyArray<BoardCardDef<SprintCardData>>): LaneSegment[] {
  return columns
    .map((c) => ({ column: c.id, name: c.name, meaning: c.meaning, count: mine.filter((m) => m.column === c.id).length }))
    .filter((s) => s.count > 0);
}

/** CODE's row line for a lane (shared `sprintLaneSummary`), over the cards it draws. The pseudo-column
 *  "Status not known" is left out of the column list, so its tickets read as "status unknown". */
function laneLine(columns: ReadonlyArray<BoardColumn>, mine: ReadonlyArray<BoardCardDef<SprintCardData>>): { progress: string; code: string } {
  const s = sprintLaneSummary(
    mine.map((c) => ({ column: c.column, prs: c.data.node.prs })),
    columns.filter((c) => c.id !== UNKNOWN_COLUMN_ID),
  );
  return { progress: s.progress, code: s.code };
}

export interface SprintBoard {
  columns: BoardColumn[];
  lanes: Array<BoardLaneDef<SprintLaneData>>;
  cards: Array<BoardCardDef<SprintCardData>>;
  arrows: BoardArrowDef[];
}

export const cardIdOf = (lane: string, ident: string): string => `${lane}|${ident}`;

const why = (e: Pick<SprintGraphEdge, 'why'>): string | null => {
  const w = e.why?.trim() ?? '';
  return w === '' ? null : w;
};

/** The sentence an arrow reads as: "ABC-2 waits on ABC-1: <why>". */
const arrowText = (waits: SprintGraphNode, on: SprintGraphNode, label: string | null): string =>
  `${waits.key} waits on ${on.key}${label != null ? `: ${label}` : ''}`;

interface BoardInput {
  nodes: ReadonlyArray<SprintGraphNode>;
  edges: ReadonlyArray<SprintGraphEdge>;
  paths: SprintPaths | null | undefined;
  /** `statusLayout.columns`. */
  columns: ReadonlyArray<SprintColumn> | null | undefined;
}

function cardsFor(nodes: ReadonlyArray<SprintGraphNode>, lane: string, view: SprintBoardView, critical: Set<string>, waiting: Set<string>): Array<BoardCardDef<SprintCardData>> {
  return nodes.map((node) => ({
    id: cardIdOf(lane, node.ident),
    lane,
    column: columnOfNode(node, view),
    unit: node.ident,
    // Cards with a pull request sit first in their cell (a ghost is never highlighted, so never grouped).
    group: !node.ghost && hasLivePr(node) ? 0 : 1,
    data:{ node, critical: critical.has(node.ident), waiting: waiting.has(node.ident) },
  }));
}

function needs(cards: ReadonlyArray<BoardCardDef<SprintCardData>>): { outside: boolean; unknown: boolean } {
  return {
    outside: cards.some((c) => c.column === OUTSIDE_COLUMN_ID),
    unknown: cards.some((c) => c.column === UNKNOWN_COLUMN_ID),
  };
}

/** CRITICAL PATH: one lane per stored path (riskiest first, as stored), its tickets in the path's
 *  order; a ticket outside the sprint sits in "Outside the sprint". Every arrow on it is critical. */
export function pathsBoard(i: BoardInput): SprintBoard {
  const byIdent = new Map(i.nodes.map((n) => [n.ident, n]));
  const critical = criticalIdents(i.paths);
  const waiting = waitingIdents(i.nodes, i.edges);
  const lanes: SprintBoard['lanes'] = [];
  const cards: SprintBoard['cards'] = [];
  const arrows: BoardArrowDef[] = [];
  (i.paths?.paths ?? []).forEach((p, idx) => {
    const id = `path:${idx}`;
    const mine = [...new Set(p.idents)].map((x) => byIdent.get(x)).filter((n): n is SprintGraphNode => n != null);
    // A path none of whose tickets is on today's map draws no lane (never a header-only board).
    if (mine.length === 0) return;
    lanes.push({ id, label: p.title, data: { kind: 'path', risk: p.risk, advice: p.advice } });
    cards.push(...cardsFor(mine, id, 'paths', critical, waiting));
    const here = new Set(mine.map((n) => n.ident));
    for (const e of i.edges) {
      if (e.kind !== 'depends_on' || !here.has(e.from) || !here.has(e.to)) continue;
      const label = why(e);
      arrows.push({
        from: cardIdOf(id, e.to),
        to: cardIdOf(id, e.from),
        label,
        critical: true,
        text: arrowText(byIdent.get(e.from)!, byIdent.get(e.to)!, label),
      });
    }
  });
  return { columns: sprintColumns(i.columns, needs(cards)), lanes, cards, arrows };
}

/** The `depends_on` arrows between two sprint tickets (Theme and People): critical when the two sit
 *  next to each other on a stored path. `labelOf` words the key. */
function sprintArrows(
  i: BoardInput,
  laneOf: Map<string, string>,
  labelOf: (waits: SprintGraphNode, on: SprintGraphNode, e: SprintGraphEdge) => string | null,
): BoardArrowDef[] {
  const byIdent = new Map(i.nodes.map((n) => [n.ident, n]));
  const pairs = criticalPairs(i.paths);
  const out: BoardArrowDef[] = [];
  for (const e of i.edges) {
    if (e.kind !== 'depends_on') continue;
    const lf = laneOf.get(e.from);
    const lt = laneOf.get(e.to);
    if (lf == null || lt == null) continue;
    const waits = byIdent.get(e.from)!;
    const on = byIdent.get(e.to)!;
    const label = labelOf(waits, on, e);
    out.push({
      from: cardIdOf(lt, e.to),
      to: cardIdOf(lf, e.from),
      label,
      critical: pairs.has(`${e.from}|${e.to}`),
      text: arrowText(waits, on, label),
    });
  }
  return out;
}

const sprintOnly = (nodes: ReadonlyArray<SprintGraphNode>): SprintGraphNode[] => nodes.filter((n) => !n.ghost);

/** "No theme" — the lane for tickets no theme holds; "All tickets" when there are no themes at all.
 *  ⚠ Not "Other": the theme prompt invites a catch-all theme of that name, and two lanes would share it. */
export const OTHER_THEME_LABEL = 'No theme';
export const ALL_TICKETS_LABEL = 'All tickets';

/** Has a ticket's code merged? At least one merged pull request and none open (the pace's rule). */
export const codeMerged = (n: Pick<SprintGraphNode, 'prs'>): boolean =>
  n.prs.some((p) => p.state === 'merged') && !n.prs.some((p) => p.state === 'open');

/** THEME: one lane per theme in the stored order (largest first), then "Other" for tickets no theme
 *  holds. With no themes, one "All tickets" lane. Sprint tickets only. */
export function themesBoard(i: BoardInput & { themes: ReadonlyArray<SprintTheme> | null | undefined }): SprintBoard {
  const nodes = sprintOnly(i.nodes);
  const critical = criticalIdents(i.paths);
  const waiting = waitingIdents(i.nodes, i.edges);
  const themes = i.themes ?? [];
  const names = new Set(themes.map((t) => t.name));
  const summaryOf = new Map(themes.map((t) => [t.name, t.summary ?? null]));
  const laneIdOf = (n: SprintGraphNode): string =>
    themes.length === 0 ? 'all' : n.theme != null && names.has(n.theme) ? `theme:${n.theme}` : 'other';
  const order: Array<{ id: string; label: string; other: boolean; summary: string | null }> =
    themes.length === 0
      ? [{ id: 'all', label: ALL_TICKETS_LABEL, other: true, summary: null }]
      : [
          ...themes.map((t) => ({ id: `theme:${t.name}`, label: t.name, other: false, summary: summaryOf.get(t.name) ?? null })),
          { id: 'other', label: OTHER_THEME_LABEL, other: true, summary: null },
        ];
  const laneOf = new Map(nodes.map((n) => [n.ident, laneIdOf(n)]));
  const cards = order.flatMap((l) => cardsFor(nodes.filter((n) => laneOf.get(n.ident) === l.id), l.id, 'themes', critical, waiting));
  const columns = sprintColumns(i.columns, needs(cards));
  const lanes: SprintBoard['lanes'] = order.map((l) => {
    const mine = cards.filter((c) => c.lane === l.id);
    return {
      id: l.id,
      label: l.label,
      data: {
        kind: 'theme',
        other: l.other,
        live: mine.filter((c) => c.data.node.stage !== 'done').length,
        merged: mine.filter((c) => codeMerged(c.data.node)).length,
        segments: segmentsOf(columns, mine),
        summary: l.summary,
        ...laneLine(columns, mine),
      },
    };
  });
  const arrows = sprintArrows(i, laneOf, (_w, _o, e) => why(e));
  return { columns, lanes, cards, arrows };
}

export const UNASSIGNED_LABEL = 'Unassigned';

/** PEOPLE: one lane per assignee, ALPHABETICAL, Unassigned last — ⚠ never ordered by load. A person is
 *  `SprintGraphResponse.people`'s (the shared Members identity), matched on the tracker spelling; an
 *  assignee it does not list gets a lane under the tracker's name. An arrow between two people's lanes
 *  is a hand-off, keyed "<person> waits on <person>"; one inside a lane keys the brief's why. */
export function peopleBoard(i: BoardInput & { people: ReadonlyArray<SprintPerson> }): SprintBoard {
  const nodes = sprintOnly(i.nodes);
  const critical = criticalIdents(i.paths);
  const waiting = waitingIdents(i.nodes, i.edges);
  const personOfName = new Map<string, SprintPerson>();
  for (const p of i.people) for (const name of p.names) personOfName.set(name, p);
  const lanesById = new Map<string, { id: string; label: string; person: SprintPerson | null; unassigned: boolean }>();
  const laneOf = new Map<string, string>();
  for (const n of nodes) {
    let lane: { id: string; label: string; person: SprintPerson | null; unassigned: boolean };
    if (n.assignee == null || n.assignee.name.trim() === '') lane = { id: 'unassigned', label: UNASSIGNED_LABEL, person: null, unassigned: true };
    else {
      const p = personOfName.get(n.assignee.name);
      lane =
        p != null
          ? { id: `person:${personNameKey(p.name)}`, label: p.name, person: p, unassigned: false }
          : { id: `person:${personNameKey(n.assignee.name)}`, label: n.assignee.name, person: null, unassigned: false };
    }
    if (!lanesById.has(lane.id)) lanesById.set(lane.id, lane);
    laneOf.set(n.ident, lane.id);
  }
  // Alphabetical, Unassigned last. Nothing about a person's tickets or reviews decides the order.
  const order = [...lanesById.values()].sort(
    (a, b) => Number(a.unassigned) - Number(b.unassigned) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  const cards = order.flatMap((l) => cardsFor(nodes.filter((n) => laneOf.get(n.ident) === l.id), l.id, 'people', critical, waiting));
  const columns = sprintColumns(i.columns, needs(cards));
  const lanes: SprintBoard['lanes'] = order.map((l) => {
    const mine = cards.filter((c) => c.lane === l.id);
    return {
      id: l.id,
      label: l.label,
      data: {
        kind: 'person',
        unassigned: l.unassigned,
        tickets: mine.length,
        reviewsWaiting: l.person?.reviewsWaiting ?? null,
        segments: segmentsOf(columns, mine),
        ...laneLine(columns, mine),
      },
    };
  });
  const labelOfLane = new Map(order.map((l) => [l.id, l.label]));
  const arrows = sprintArrows(i, laneOf, (waits, on, e) => {
    const a = laneOf.get(waits.ident)!;
    const b = laneOf.get(on.ident)!;
    return a === b ? why(e) : `${labelOfLane.get(a)} waits on ${labelOfLane.get(b)}`;
  });
  return { columns, lanes, cards, arrows };
}

// ── Under the Critical path board ────────────────────────────────────────────────────────────────

/** The pace strip's facts, every one with its denominator. The time bar is `timeUsedPct`. */
export interface PaceItem {
  label: string;
  value: string;
  /** 0–100 for the time bar; null otherwise. */
  pct: number | null;
}

/** `productReview`: the board has a Product review bucket (the count shows only then). */
export function paceItems(pace: SprintPace, o: { productReview: boolean }): PaceItem[] {
  const of = (n: number): string => `${n} of ${pace.tickets}`;
  const out: PaceItem[] = [];
  if (pace.daysElapsed != null && pace.daysTotal != null) {
    out.push({ label: 'Time used', value: `Day ${pace.daysElapsed} of ${pace.daysTotal}`, pct: pace.timeUsedPct });
  }
  out.push({ label: 'Code merged', value: of(pace.codeMerged), pct: null });
  if (o.productReview) out.push({ label: SPRINT_STAGE_LABEL.product_review, value: of(pace.productReview), pct: null });
  out.push({ label: SPRINT_STAGE_LABEL.done, value: of(pace.done), pct: null });
  out.push({
    label: 'Open dependencies',
    value:
      pace.chains > 0
        ? `${pace.openDependencies} in ${pace.chains} ${pace.chains === 1 ? 'chain' : 'chains'}`
        : `${pace.openDependencies}`,
    pct: null,
  });
  return out;
}

/** The theme × column count table under the Critical path board: every sprint ticket, once. */
export interface CountTable {
  columns: BoardColumn[];
  rows: Array<{ id: string; label: string; counts: number[]; total: number }>;
  totals: number[];
  total: number;
}

export function countTable(
  nodes: ReadonlyArray<SprintGraphNode>,
  themes: ReadonlyArray<SprintTheme> | null | undefined,
  layoutColumns: ReadonlyArray<SprintColumn> | null | undefined,
): CountTable {
  const board = themesBoard({ nodes, edges: [], paths: null, columns: layoutColumns, themes });
  const columns = board.columns;
  const rows = board.lanes
    .map((l) => {
      const mine = board.cards.filter((c) => c.lane === l.id);
      const counts = columns.map((c) => mine.filter((m) => m.column === c.id).length);
      return { id: l.id, label: l.label, counts, total: mine.length };
    })
    .filter((r) => r.total > 0);
  const totals = columns.map((_, i) => rows.reduce((s, r) => s + (r.counts[i] ?? 0), 0));
  return { columns, rows, totals, total: rows.reduce((s, r) => s + r.total, 0) };
}

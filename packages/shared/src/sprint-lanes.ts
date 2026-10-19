import type { SprintColumn } from './sprint-stories.js';

// ACTIVITY → THIS SPRINT — THE CODE-WRITTEN ROW SUMMARY of a Theme or People lane (docs/FRONTEND.md §
// Activity → This Sprint). PURE, no model, nothing stored: counted from the lane's tickets on the
// SAME `SprintGraphNode.column` the board draws, so the line and the cards cannot disagree.
//
//   • PROGRESS — the lane's tickets by column, in column (left-to-right) order, named by the column's
//     own name (the workspace's bucket names), columns with none left out; a ticket whose status is not
//     known is counted apart ("status unknown").
//   • CODE OR NOT — a ticket "has a pull request" when ≥ 1 is open or merged (closed unmerged ones do
//     not count). It is the one honest signal of development work the data carries; a ticket without
//     one may be design, analysis, content or config work, or code not opened yet — the line says
//     "without a pull request" and nothing more.
//
// ⚠ PREP, NOT SCORING. It says only what the data shows: no ranking, no adjective about a person or a
// theme, no comparison across lanes. The People lanes stay alphabetical.

/** What the helper reads off one ticket (a `SprintGraphNode` fits). */
export interface SprintLaneSummaryTicket {
  column: string | null;
  prs: ReadonlyArray<{ state: 'open' | 'merged' | 'closed' }>;
}

export interface SprintLaneSummary {
  tickets: number;
  /** Columns holding ≥ 1 of the lane's tickets, in column order. */
  byColumn: Array<{ columnId: string; name: string; count: number }>;
  /** Tickets whose column is not known (or names no listed column). */
  unknown: number;
  /** Tickets with ≥ 1 open or merged pull request, and the rest. */
  withPr: number;
  withoutPr: number;
  /** "1 Not started, 2 Code review, 1 Complete" ('' for an empty lane). */
  progress: string;
  /** "3 with a pull request, 1 without" / "All have a pull request" / "None has a pull request" ('' for
   *  an empty lane). */
  code: string;
}

const hasPr = (t: SprintLaneSummaryTicket): boolean => t.prs.some((p) => p.state === 'open' || p.state === 'merged');

/** The row summary of one lane. Pure. */
export function sprintLaneSummary(
  tickets: readonly SprintLaneSummaryTicket[],
  columns: ReadonlyArray<Pick<SprintColumn, 'id' | 'name'>>,
): SprintLaneSummary {
  const counts = new Map<string, number>();
  const known = new Set(columns.map((c) => c.id));
  let unknown = 0;
  let withPr = 0;
  for (const t of tickets) {
    if (t.column != null && known.has(t.column)) counts.set(t.column, (counts.get(t.column) ?? 0) + 1);
    else unknown += 1;
    if (hasPr(t)) withPr += 1;
  }
  const byColumn = columns
    .filter((c) => (counts.get(c.id) ?? 0) > 0)
    .map((c) => ({ columnId: c.id, name: c.name, count: counts.get(c.id)! }));
  const n = tickets.length;
  const withoutPr = n - withPr;
  const parts = byColumn.map((c) => `${c.count} ${c.name}`);
  if (unknown > 0) parts.push(`${unknown} status unknown`);
  const code =
    n === 0
      ? ''
      : withoutPr === 0
        ? n === 1
          ? 'Has a pull request'
          : 'All have a pull request'
        : withPr === 0
          ? n === 1
            ? 'No pull request'
            : 'None has a pull request'
          : `${withPr} with a pull request, ${withoutPr} without`;
  return { tickets: n, byColumn, unknown, withPr, withoutPr, progress: parts.join(', '), code };
}

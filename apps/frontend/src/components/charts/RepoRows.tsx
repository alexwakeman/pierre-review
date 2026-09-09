import { Fragment } from 'react';
import { Legend } from './common.js';

// A ROW LIST, NOT A BAR CHART — one row per repository, the name written out in full on the left
// and one horizontal bar per measure beside it.
//
// ── WHY THIS EXISTS AT ALL: THE NAME HAS TO BE READABLE ──────────────────────────────────────
//
// The per-repository charts this replaced were vertical `BarChart`s with `rotateLabels`, which
// reserves a FIXED 40px bottom band and clips past it with no warning. MEASURED on real data: an
// 8px label rotated −35° from a 13-character budget bottomed out 2-3px past the svg viewport, so
// six of seven real repositories rendered as "…tric-backend" — and the clipped glyph was the
// leading "…" that said the name had been shortened at all. A row label is plain left-aligned DOM
// text: it wraps, it never rotates, nothing clips it, and there is no character budget to spend.
// That is the whole reason this primitive exists; a `title=` tooltip is NOT the alternative,
// because it is unavailable on touch and to a keyboard.
//
// ── ONE SCALE PER COLUMN, AND THE RATIO NEVER LEAVES ITS COLUMN ──────────────────────────────
//
// ⚠ A DRAWN BAR LENGTH IS `value ÷ THIS COLUMN'S max`. It is a ratio WITHIN ONE COLUMN and is
// never a number the reader is invited to compare across columns — a PR count and a line count
// share nothing but a card. That division is the reason a reviewer might read this as the
// normalised composite index the codebase rejects in five places ("a number no PR resembles"), so
// it is worth being exact: nothing here is z-scored, weighted, summed across measures or ranked by
// a fused scalar. Each column carries its own origin and its own maximum, printed under it, and
// every row prints its own figures — the bar is a scan aid, the number is the fact.
//
// ⚠ UNKNOWN IS NOT ZERO. A `null` entry in `values` prints `unknownLabel` IN THAT ROW rather than
// drawing a zero-length bar, because an absent bar and a zero bar are the same pixels and neither
// is a disclosure.
//
// ── NOT CLICKABLE ────────────────────────────────────────────────────────────────────────────
//
// No row is a button and no cell has a handler. It is a table of numbers a reader looks at; adding
// N unlabelled keyboard stops to a picture costs every keyboard user and buys nothing. (The rail
// already owns per-repo navigation.)

export interface RepoRowSegment {
  key: string;
  label: string;
  /** A FILL, never a text colour. Each one is measured against both page grounds by its caller. */
  color: string;
}

export interface RepoRowColumn {
  key: string;
  /** The column heading, e.g. "PRs opened". */
  header: string;
  /** Stack order, left to right, IDENTICAL on every row — so position encodes the segment as well
   *  as hue does, which is what keeps the bar readable without colour. */
  segments: RepoRowSegment[];
  /** One entry per label, in `segments` order. ⚠ `null` = NOT MEASURED (see `unknownLabel`). */
  values: (readonly number[] | null)[];
  /** The words a `null` row prints where its bar would be — "size unknown", "no reading". */
  unknownLabel: string;
  format: (n: number) => string;
  /** `total` prints one figure after the bar (the segments' sum); `segments` prints one figure per
   *  segment, each under its own heading, for a column whose split IS the point. */
  valueMode: 'total' | 'segments';
  /** Column widths as percentages of the table, so the columns line up at any panel width without
   *  measuring anything. */
  barWidthPct: number;
  valueWidthPct: number;
}

function sum(values: readonly number[]): number {
  return values.reduce((n, v) => n + v, 0);
}

function valueCellCount(column: RepoRowColumn): number {
  return column.valueMode === 'segments' ? column.segments.length : 1;
}

const HEAD =
  'pb-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400';
const CELL = 'py-[3px] text-[11px]';

export function RepoRows({
  labels,
  columns,
  nameHeader = 'Repository',
  nameWidthPct = 30,
  noteFor,
}: {
  /** The row labels, in the order given — the caller owns the ranking. */
  labels: string[];
  columns: RepoRowColumn[];
  nameHeader?: string;
  nameWidthPct?: number;
  /** An extra muted line under row `i`'s name — for a per-row disclosure that belongs beside the
   *  repository it is about rather than in an aggregate footnote. */
  noteFor?: (index: number) => string | null;
}): JSX.Element {
  // ⚠ ONE MAXIMUM PER COLUMN, taken over that column alone. The RAW maximum, not a rounded one:
  // the leading repository then draws a full-width bar and the printed figure beside it IS the
  // scale's upper tick, so a reader can check the axis against a row rather than against a number
  // nothing on screen carries.
  const columnMax = columns.map((c) =>
    c.values.reduce<number>((m, v) => (v == null ? m : Math.max(m, sum(v))), 0),
  );

  // Every colour on the card, named once. The bar segments are the only colour-carried facts here,
  // and one of them (the automation orange) sits below 3:1 against the light page ground — the key
  // is the relief that obliges, so it is not optional decoration.
  const legendSeries = columns.flatMap((c) =>
    c.segments.map((s) => ({ label: s.label, color: s.color })),
  );

  return (
    <div>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: `${nameWidthPct}%` }} />
          {columns.map((c) => (
            <Fragment key={c.key}>
              <col style={{ width: `${c.barWidthPct}%` }} />
              {Array.from({ length: valueCellCount(c) }, (_, k) => (
                <col key={k} style={{ width: `${c.valueWidthPct}%` }} />
              ))}
            </Fragment>
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={`${HEAD} pr-2 text-left`}>
              {nameHeader}
            </th>
            {columns.map((c) =>
              c.valueMode === 'total' ? (
                <th key={c.key} scope="col" colSpan={2} className={`${HEAD} pr-2 text-left`}>
                  {c.header}
                </th>
              ) : (
                <Fragment key={c.key}>
                  <th scope="col" className={`${HEAD} pr-2 text-left`}>
                    {c.header}
                  </th>
                  {c.segments.map((s) => (
                    <th key={s.key} scope="col" className={`${HEAD} pr-2 text-right`}>
                      {s.label}
                    </th>
                  ))}
                </Fragment>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => {
            const note = noteFor?.(i) ?? null;
            return (
              <tr key={label}>
                <th scope="row" className={`${CELL} pr-2 text-left align-middle font-normal`}>
                  {/* ⚠ THE FULL `owner/name`, WRAPPING. Not truncated, not abbreviated, not hidden
                      behind a tooltip — a reader who cannot recover the name is looking at an
                      unlabelled bar. */}
                  <span className="break-words text-gray-700 dark:text-gray-200">{label}</span>
                  {note != null && (
                    <span className="block text-gray-500 dark:text-gray-400">{note}</span>
                  )}
                </th>
                {columns.map((c, ci) => {
                  const values = c.values[i] ?? null;
                  const max = columnMax[ci] ?? 0;
                  const cells: JSX.Element[] = [
                    <td key={`${c.key}-bar`} className={`${CELL} pr-2 align-middle`}>
                      {values == null ? (
                        <span className="text-gray-500 dark:text-gray-400">{c.unknownLabel}</span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-2 w-full overflow-hidden rounded-[2px] bg-gray-100 dark:bg-gray-800"
                        >
                          {c.segments.map((s, si) => {
                            const v = values[si] ?? 0;
                            if (v <= 0 || max <= 0) return null;
                            return (
                              <span
                                key={s.key}
                                // ⚠ A NON-ZERO VALUE ALWAYS PAINTS. 212 lines against a 29,000-line
                                // column is 0.7% of the track, which rounds to nothing — and an
                                // unpainted track is what "we did not measure this" looks like one
                                // row up. The minimum keeps the two apart; the printed figure is
                                // still the fact.
                                style={{
                                  width: `${(v / max) * 100}%`,
                                  minWidth: '1px',
                                  background: s.color,
                                }}
                              />
                            );
                          })}
                        </span>
                      )}
                    </td>,
                  ];
                  if (c.valueMode === 'total') {
                    cells.push(
                      <td
                        key={`${c.key}-total`}
                        className={`${CELL} pr-2 text-right align-middle tabular-nums text-gray-700 dark:text-gray-200`}
                      >
                        {values == null ? null : c.format(sum(values))}
                        {/* The bar is aria-hidden, so a column whose split is drawn but not
                            printed says it here rather than losing it to a screen reader. */}
                        {values != null && c.segments.length > 1 && (
                          <span className="sr-only">
                            {` (${c.segments
                              .map((s, si) => `${c.format(values[si] ?? 0)} ${s.label}`)
                              .join(', ')})`}
                          </span>
                        )}
                      </td>,
                    );
                  } else {
                    for (const [si, s] of c.segments.entries()) {
                      cells.push(
                        <td
                          key={`${c.key}-${s.key}`}
                          className={`${CELL} pr-2 text-right align-middle tabular-nums text-gray-700 dark:text-gray-200`}
                        >
                          {values == null ? null : c.format(values[si] ?? 0)}
                        </td>,
                      );
                    }
                  }
                  return <Fragment key={c.key}>{cells}</Fragment>;
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td />
            {columns.map((c, ci) => (
              <Fragment key={c.key}>
                {/* The scale, under its own column and nowhere near its neighbour's. */}
                <td className="border-t border-gray-200 pr-2 pt-1 dark:border-gray-800">
                  <span className="flex items-baseline justify-between text-[11px] text-gray-500 dark:text-gray-400">
                    <span>0</span>
                    <span className="tabular-nums">{c.format(columnMax[ci] ?? 0)}</span>
                  </span>
                </td>
                {Array.from({ length: valueCellCount(c) }, (_, k) => (
                  <td key={k} />
                ))}
              </Fragment>
            ))}
          </tr>
        </tfoot>
      </table>
      <Legend series={legendSeries} />
    </div>
  );
}

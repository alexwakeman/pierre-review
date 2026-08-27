// Shared bits for the Activity drill-down TABLES (open-PRs, bot-only-PRs, resolvable bot
// threads): a clickable column header, the sort-state shape, a compare fn, and the
// header-click reducer. Each table keeps its OWN column enum + per-column sort values +
// natural directions — only the generic mechanics live here so the three read identically.

import { CaretIcon } from '../Icons.js';

export type SortDir = 'asc' | 'desc';

export interface SortState<C extends string> {
  col: C;
  dir: SortDir;
}

// localeCompare for strings, numeric subtraction otherwise. ISO-8601 timestamps sort
// chronologically as strings, so a table can hand a timestamp string straight through.
export function compare(a: number | string, b: number | string): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return (a as number) - (b as number);
}

// The header-click reducer: toggle asc/desc on the active column, else activate a new column
// with its natural first-click direction.
export function nextSort<C extends string>(
  cur: SortState<C> | null,
  col: C,
  defaultDir: Record<C, SortDir>,
): SortState<C> {
  return cur?.col === col ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: defaultDir[col] };
}

// A clickable column header: toggles asc/desc on the active column, or activates a new one
// with its natural direction. The ▲/▼ indicator only shows on the active column.
export function SortHeader<C extends string>({
  col,
  label,
  sort,
  onSort,
  title,
}: {
  col: C;
  label: string;
  sort: SortState<C> | null;
  onSort: (col: C) => void;
  title?: string;
}): JSX.Element {
  const dir = sort != null && sort.col === col ? sort.dir : null;
  return (
    <th
      className="pb-1 pr-3 font-semibold"
      aria-sort={dir != null ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        title={title}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wide hover:text-gray-600 dark:hover:text-gray-300 ${
          dir != null ? 'text-gray-600 dark:text-gray-300' : ''
        }`}
      >
        {label}
        <span aria-hidden className={dir != null ? '' : 'invisible'}>
          <CaretIcon dir={dir === 'asc' ? 'up' : 'down'} />
        </span>
      </button>
    </th>
  );
}

import { STORY_CRITERIA_SOURCE_LABEL, STORY_TIME_CHART_ROWS, type StoryRow } from '@pierre-review/shared';

// Reports → Stories: the pure folds behind the tab. No renderer, no fetch — test/storiesModel.test.ts.
//
// ⚠ UNKNOWN IS NEVER ZERO. A story with no known size or no criteria count is LISTED beside the
// size chart, never plotted at the origin; the time chart only ranks a figure the server measured.

/** "PROJ-12 Add the export button" — the key and the title, written in full. */
export function storyLabel(s: Pick<StoryRow, 'key' | 'title'>): string {
  const t = (s.title ?? '').trim();
  return t === '' ? s.key : `${s.key} ${t}`;
}

/** Index the response's stories by ident. */
export function indexStories(stories: readonly StoryRow[]): Map<string, StoryRow> {
  return new Map(stories.map((s) => [s.ident, s]));
}

/** An ident list → its rows, in the list's order (an ident with no row is skipped). */
export function rowsFor(idents: readonly string[], byIdent: ReadonlyMap<string, StoryRow>): StoryRow[] {
  const out: StoryRow[] = [];
  for (const id of idents) {
    const r = byIdent.get(id);
    if (r != null) out.push(r);
  }
  return out;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/** Working hours as a reader holds them: hours under a working day, else working days. */
export function formatWorkingTime(hours: number, workingDayHours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0h';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const day = workingDayHours > 0 ? workingDayHours : 8;
  if (hours < day) return `${oneDp(hours)}h`;
  const d = hours / day;
  return `${oneDp(d)} working ${d === 1 ? 'day' : 'days'}`;
}

// ── Chart (a): time and pull requests ────────────────────────────────────────────────────────

export interface TimeRowsModel {
  labels: string[];
  idents: string[];
  hours: number[];
  prs: number[];
  /** Stories in the population not drawn (past the row cap). */
  more: number;
}

/** Top `cap` stories by working hours (ties: more PRs, then key), with what was cut stated. */
export function buildTimeRows(stories: readonly StoryRow[], cap = STORY_TIME_CHART_ROWS): TimeRowsModel {
  const ranked = [...stories].sort(
    (a, b) => b.workingHours - a.workingHours || b.prs.total - a.prs.total || a.key.localeCompare(b.key),
  );
  const top = ranked.slice(0, cap);
  return {
    labels: top.map(storyLabel),
    idents: top.map((s) => s.ident),
    hours: top.map((s) => s.workingHours),
    prs: top.map((s) => s.prs.total),
    more: Math.max(0, ranked.length - top.length),
  };
}

// ── Chart (b): size and criteria ─────────────────────────────────────────────────────────────

export interface SizePoint {
  ident: string;
  x: number;
  y: number;
  label: string;
  flagged: boolean;
}

export interface SizeModel {
  points: SizePoint[];
  /** Stories whose size is unknown (any merged PR unsized) — listed, never plotted at 0. */
  unsized: StoryRow[];
  /** Sized stories with no criteria count — listed, never plotted at 0. */
  noCriteria: StoryRow[];
}

export function buildSizeModel(stories: readonly StoryRow[], shortfall: readonly string[]): SizeModel {
  const flagged = new Set(shortfall);
  const points: SizePoint[] = [];
  const unsized: StoryRow[] = [];
  const noCriteria: StoryRow[] = [];
  for (const s of stories) {
    if (s.linesChanged == null) {
      unsized.push(s);
      continue;
    }
    if (s.criteria.count == null) {
      noCriteria.push(s);
      continue;
    }
    points.push({
      ident: s.ident,
      x: s.linesChanged,
      y: s.criteria.count,
      label: storyLabel(s),
      flagged: flagged.has(s.ident),
    });
  }
  return { points, unsized, noCriteria };
}

// ── Row text ─────────────────────────────────────────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The figures on a story row, each its own fact. Unknown size prints as such, never "0 lines". */
export function storyMetaParts(s: StoryRow, workingDayHours: number): string[] {
  const parts = [plural(s.prs.total, 'pull request', 'pull requests')];
  parts.push(`${formatWorkingTime(s.workingHours, workingDayHours)} to merge`);
  parts.push(s.linesChanged == null ? 'size unknown' : plural(s.linesChanged, 'line changed', 'lines changed'));
  if (s.criteria.count == null) parts.push('no criteria found');
  else {
    const src = STORY_CRITERIA_SOURCE_LABEL[s.criteria.source];
    parts.push(`${plural(s.criteria.count, 'criterion', 'criteria')} (${src.charAt(0).toLowerCase()}${src.slice(1)})`);
  }
  return parts;
}

/** "2 not met · 1 partly met · 1 missing" — only the non-zero shortfalls. */
export function reviewShortfallParts(s: StoryRow): string[] {
  const r = s.review;
  if (r == null) return [];
  const out: string[] = [];
  if (r.notMet > 0) out.push(`${r.notMet} not met`);
  if (r.partlyMet > 0) out.push(`${r.partlyMet} partly met`);
  if (r.missing > 0) out.push(`${r.missing} missing`);
  return out;
}

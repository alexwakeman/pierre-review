import type { DerivedState, PrFileDiffStatus, ThreadStateCounts } from '@pierre-review/shared';
import { MAX_HIGHLIGHT_LINES, highlightLines } from './hljsLines.js';

// A tiny pure parser for a single file's unified-diff `patch` string (as GitHub
// returns it on the REST `files` endpoint): header-less, starting at the first
// `@@ … @@` hunk header. It turns that into renderable rows, tracking old/new
// line numbers so the Changes tab can show gutters and anchor inline comments.

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'context';

export interface DiffRow {
  kind: DiffRowKind;
  // The raw line text, including its leading +/-/space marker for add/del/context
  // rows and the full `@@ … @@` header for hunk rows.
  text: string;
  // The line number in the OLD file (present on del + context rows).
  oldLine?: number;
  // The line number in the NEW file (present on add + context rows).
  newLine?: number;
  /**
   * `hunk` rows only: the unchanged lines GitHub's patch leaves out BEFORE this hunk, which the
   * Changes tab draws as a hunk expander in place of the `@@` header. `count` lines starting at
   * `oldFrom` / `newFrom` (equal-length on both sides — they are unchanged). `context` is the text
   * git prints after the second `@@` (usually the enclosing function), or '' when there is none.
   * `count` is 0 for a first hunk that starts at line 1 — no expander is drawn for it.
   */
  gap?: DiffGap;
}

export interface DiffGap {
  count: number;
  oldFrom: number;
  newFrom: number;
  context: string;
}

// Parse `@@ -oldStart,oldCount +newStart,newCount @@ ctx` → the starts, counts and the trailing
// context text. Returns null if the line isn't a hunk header. An omitted count is 1 (git's rule).
function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number; context: string } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] == null ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] == null ? 1 : Number(m[4]),
    context: (m[5] ?? '').trim(),
  };
}

// Turn a unified per-file patch into an ordered list of rows. Resilient to a
// null/empty patch (→ no rows) and to the occasional `\ No newline at end of
// file` marker GitHub emits (rendered as a context row, consuming no line number).
//
// ⚠ THE `hunk` ROWS STAY, though the Changes tab no longer prints the `@@` header: they carry the
// line-number resets, and thread anchoring and the reveal both address rows BY INDEX. The renderer
// draws a hunk expander (`row.gap`) in their place instead of dropping them.
export function parsePatch(patch: string | null | undefined): DiffRow[] {
  if (!patch) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  // The next line each side would reach with nothing hidden — 1 before the first hunk.
  let oldNext = 1;
  let newNext = 1;

  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = parseHunkHeader(text);
    if (header) {
      // Measure the gap on a side the hunk actually covers: a count-0 side's start names the line
      // BEFORE it (a pure insertion / deletion), so it is one short of the truth.
      const count =
        header.newCount > 0
          ? header.newStart - newNext
          : header.oldCount > 0
            ? header.oldStart - oldNext
            : 0;
      rows.push({
        kind: 'hunk',
        text,
        gap: { count: Math.max(0, count), oldFrom: oldNext, newFrom: newNext, context: header.context },
      });
      oldLine = header.oldStart;
      newLine = header.newStart;
      // A count-0 side starts AFTER the named line.
      oldNext = header.oldCount === 0 ? header.oldStart + 1 : header.oldStart;
      newNext = header.newCount === 0 ? header.newStart + 1 : header.newStart;
      continue;
    }
    const marker = text[0];
    if (marker === '+') {
      rows.push({ kind: 'add', text, newLine });
      newLine += 1;
      newNext = newLine;
    } else if (marker === '-') {
      rows.push({ kind: 'del', text, oldLine });
      oldLine += 1;
      oldNext = oldLine;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — annotation, not a real line.
      rows.push({ kind: 'context', text });
    } else {
      // A space-prefixed (or, defensively, otherwise unmarked) context line.
      rows.push({ kind: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldNext = oldLine;
      newNext = newLine;
    }
  }
  return rows;
}

/**
 * Where the patch STOPS on each side: the first line after the last hunk. The lines from here to
 * the end of the file are the trailing gap, whose size is knowable only once the file is loaded.
 */
export function patchEnd(rows: readonly DiffRow[]): { oldNext: number; newNext: number } {
  let oldNext = 1;
  let newNext = 1;
  for (const r of rows) {
    if (r.kind === 'hunk') {
      const m = parseHunkHeader(r.text);
      if (m) {
        oldNext = m.oldCount === 0 ? m.oldStart + 1 : m.oldStart;
        newNext = m.newCount === 0 ? m.newStart + 1 : m.newStart;
      }
      continue;
    }
    if (r.oldLine != null) oldNext = r.oldLine + 1;
    if (r.newLine != null) newNext = r.newLine + 1;
  }
  return { oldNext, newNext };
}

// ---- gap expansion (GitHub's hunk expander) ----
//
// A gap is drawn as GitHub draws a hunk line: arrow buttons in the line-number gutter and, in the
// code column, the hidden count and the enclosing function. Expansion is RENDER-SIDE ONLY — the
// rows `parsePatch` returns never change, so thread anchoring and the reveal, which address rows
// by index, cannot be moved by it. Each gap keeps its own `GapReveal`: how many lines the reader
// has revealed from its TOP (just after the code above, the down arrow) and from its BOTTOM (just
// before the code below, the up arrow).

/** Lines one arrow click reveals — GitHub's step. */
export const GAP_EXPAND_STEP = 20;

/**
 * Where a gap sits, which decides its arrows: `first` (before the first hunk — code only BELOW,
 * so one up arrow), `between` (two hunks — both arrows, or expand-all when it is small) and
 * `trailing` (after the last hunk — code only ABOVE, so one down arrow).
 */
export type GapPlace = 'first' | 'between' | 'trailing';

export type GapControl = 'down' | 'up' | 'all';

export interface GapReveal {
  /** Lines revealed from the top of the gap (the down arrow). */
  top: number;
  /** Lines revealed from the bottom of the gap (the up arrow). */
  bottom: number;
}

export const NO_REVEAL: GapReveal = { top: 0, bottom: 0 };

/** `first` for the hunk row with no hunk before it, else `between`. */
export function gapPlace(rows: readonly DiffRow[], index: number): GapPlace {
  for (let k = index - 1; k >= 0; k -= 1) {
    if (rows[k]?.kind === 'hunk') return 'between';
  }
  return 'first';
}

/**
 * The revealed lines actually drawn, clamped to the gap's size. `count` null is a trailing gap
 * whose file is not loaded yet: nothing can be drawn.
 */
export function clampReveal(count: number | null, r: GapReveal): GapReveal {
  if (count == null) return NO_REVEAL;
  const top = Math.min(Math.max(0, r.top), count);
  const bottom = Math.min(Math.max(0, r.bottom), count - top);
  return { top, bottom };
}

/** Lines still hidden — null while the gap's size is unknown (a trailing gap before the load). */
export function gapRemaining(count: number | null, r: GapReveal): number | null {
  if (count == null) return null;
  const c = clampReveal(count, r);
  return count - c.top - c.bottom;
}

/**
 * The arrows a gap offers, top to bottom. Nothing once it is fully revealed. Between two hunks a
 * gap that one click would empty gets the single expand-all control instead of two arrows, as on
 * GitHub. An unknown size (trailing, file not loaded) still offers its down arrow — the click is
 * what loads the file.
 */
export function gapControls(place: GapPlace, remaining: number | null): GapControl[] {
  if (remaining != null && remaining <= 0) return [];
  if (place === 'first') return ['up'];
  if (place === 'trailing') return ['down'];
  if (remaining != null && remaining <= GAP_EXPAND_STEP) return ['all'];
  return ['down', 'up'];
}

/** How many lines a control reveals: one step, or what is left if that is less. */
export function gapControlLines(control: GapControl, remaining: number | null): number {
  if (remaining == null) return GAP_EXPAND_STEP;
  return control === 'all' ? remaining : Math.min(GAP_EXPAND_STEP, remaining);
}

/** The reveal after one click. Expand-all grows the top so the lines read in file order. */
export function expandGapReveal(
  r: GapReveal,
  control: GapControl,
  count: number | null,
): GapReveal {
  const n = gapControlLines(control, gapRemaining(count, r));
  return control === 'up' ? { top: r.top, bottom: r.bottom + n } : { top: r.top + n, bottom: r.bottom };
}

/** The control's accessible name (and tooltip). */
export function gapControlLabel(control: GapControl, remaining: number | null): string {
  const n = gapControlLines(control, remaining);
  const lines = n === 1 ? 'line' : 'lines';
  if (control === 'all') return `Expand all ${n.toLocaleString()} ${lines}`;
  return `Expand ${n.toLocaleString()} ${lines} ${control}`;
}

/**
 * The muted text in the gap row's code column: the hidden count first, then the enclosing
 * function git names after the `@@` header — `20 hidden lines · function foo() {`. Just the count
 * when there is no context; just the context while the count is unknown.
 */
export function gapSummary(remaining: number | null, context: string): string {
  const parts: string[] = [];
  if (remaining != null) {
    parts.push(`${remaining.toLocaleString()} hidden ${remaining === 1 ? 'line' : 'lines'}`);
  }
  if (context !== '') parts.push(context);
  return parts.join(' · ');
}

/** `count` lines of a gap starting `offset` lines into it — the slice one side of a reveal draws. */
export function gapSlice(gap: DiffGap, offset: number, count: number): DiffGap {
  return {
    count,
    oldFrom: gap.oldFrom + offset,
    newFrom: gap.newFrom + offset,
    context: gap.context,
  };
}

/** The context lines GitHub's patches carry around each change (git's default `-U3`). */
const PATCH_CONTEXT_LINES = 3;

/**
 * Does the patch provably run to the END of the file, so there is no trailing gap to offer before
 * the file is loaded? True when it carries git's `\ No newline at end of file`, or when its last
 * change is followed by fewer than three context lines — git always prints three when the file has
 * them. False means "unknown": the down arrow is offered, and the load says how many lines follow
 * (possibly none, and then the row goes away).
 */
export function patchReachesEnd(rows: readonly DiffRow[]): boolean {
  if (rows.length === 0) return true;
  let trailingContext = 0;
  for (let k = rows.length - 1; k >= 0; k -= 1) {
    const r = rows[k];
    if (r == null) continue;
    if (isNoNewlineRow(r)) return true;
    if (r.kind === 'context') {
      trailingContext += 1;
      continue;
    }
    // The first add/del from the end (or a hunk header with no change after it, which a real
    // patch never has) closes the count.
    break;
  }
  return trailingContext < PATCH_CONTEXT_LINES;
}

/**
 * The line a review thread's ANCHOR HUNK points at, reconstructed from the hunk itself.
 *
 * WHY THIS EXISTS. `review_threads` stores exactly one positional column, `line`, and that is
 * GitHub's LIVE line — it goes NULL the moment the anchor drifts out of the current diff. There
 * is no `original_line`, no `start_line` and no `diff_side` column, and the sync's GraphQL walk
 * never asks for them, so for an outdated thread there is nothing stored to navigate to at all.
 * Measured on a real workspace: 5,572 of 6,195 outdated threads (90%) have a NULL line, while a
 * non-outdated thread ALWAYS has one.
 *
 * GitHub's `diffHunk` convention is that the hunk ENDS at the commented line, which is already
 * how `CodeAnchor` renders it (`lines.at(-1)` is the anchor). So the last real row of the parsed
 * hunk gives back the thread's original line AND its side. Spot-checked against 25 live
 * non-outdated threads: 23 matched the stored `line` exactly and the 2 that did not were genuine
 * moved anchors (177 vs 181, 475 vs 477) — i.e. the disagreement is the drift, not a parse bug.
 *
 * ⚠ APPROXIMATE, and the caller must say so. This is the line in the commit the comment was
 * WRITTEN against, not in the PR's current head, so it can land a few lines off (or, if the
 * region was rewritten, on unrelated code). It is the best available answer for a thread whose
 * live line is gone; it is never better than a non-null `thread.line`, which the caller must
 * prefer.
 */
export function anchorLineFromHunk(
  hunk: string | null | undefined,
): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  const rows = parsePatch(hunk);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r == null || r.kind === 'hunk') continue;
    // A deletion only exists on the LEFT; an addition only on the RIGHT; a context row is on
    // both, and RIGHT is the side GitHub pins an inline thread to.
    // `> 0` and not just non-null: a body with no `@@` header (a truncated hunk, or text that is
    // not a diff at all) leaves both counters at 0, and 0 is never a valid diff line. Returning it
    // would hand the caller a confident-looking target that matches no row — better to return null
    // and let it fall to the next rung, which reveals the file.
    if (r.kind === 'del') {
      if (r.oldLine != null && r.oldLine > 0) return { line: r.oldLine, side: 'LEFT' };
      continue;
    }
    if (r.newLine != null && r.newLine > 0) return { line: r.newLine, side: 'RIGHT' };
    if (r.oldLine != null && r.oldLine > 0) return { line: r.oldLine, side: 'LEFT' };
  }
  return null;
}

/**
 * Does a whole file (as loaded for a gap expansion) agree with the patch it is filling in? Every
 * line the patch shows on that side — context, plus add (head) or del (base) — must sit at its own
 * line number in `lines`. False means the file was read at a different commit than the patch (a
 * push landed between the two reads), and splicing its lines into the gaps would show code that is
 * not there; the block says so instead.
 */
export function patchMatchesFile(
  rows: readonly DiffRow[],
  lines: readonly string[],
  side: 'head' | 'base',
): boolean {
  for (const row of rows) {
    if (row.kind === 'hunk' || isNoNewlineRow(row)) continue;
    if (side === 'head' && row.kind === 'del') continue;
    if (side === 'base' && row.kind === 'add') continue;
    const n = side === 'head' ? row.newLine : row.oldLine;
    if (n == null) continue;
    const body = splitDiffMarker(row).body.replace(/\r$/, '');
    if (lines[n - 1] !== body) return false;
  }
  return true;
}

// ---- syntax highlighting a diff (every surface in the app that renders one) ----

/**
 * The `\ No newline at end of file` annotation GitHub emits. `parsePatch` classifies it as a
 * CONTEXT row with no line numbers, so it is not a marked diff line and it is not code: slicing its
 * first character would hand the lexer " No newline at end of file". A real context line always
 * carries its leading space, so it can never start with a backslash.
 */
export function isNoNewlineRow(row: DiffRow): boolean {
  return row.kind === 'context' && row.text.startsWith('\\');
}

/**
 * A diff row split into its leading +/-/space MARKER and the source line underneath it.
 *
 * ⚠ THE MARKER IS NOT CODE AND MUST NEVER REACH THE LEXER. It is diff notation: a `-` in front of a
 * line is not a minus operator, and highlighting it as one colours a deletion's first token wrong
 * on every row. Renderers colour `body`; the Changes tab no longer prints `marker` at all (the row tint says it).
 *
 * ⚠ A CONTEXT ROW IS STRIPPED ONLY WHEN IT ACTUALLY HAS A LEADING SPACE. `parsePatch` classifies
 * ANY unmarked line as context — a truncated hunk that opens on real code, or a body that is not a
 * diff at all — and an unconditional `slice(1)` there silently eats the line's first character.
 * `hunk` headers and the no-newline annotation are returned whole, with no marker.
 */
export function splitDiffMarker(row: DiffRow): { marker: string; body: string } {
  if (row.kind === 'hunk' || isNoNewlineRow(row)) return { marker: '', body: row.text };
  if (row.kind === 'add' || row.kind === 'del') {
    return { marker: row.text.slice(0, 1), body: row.text.slice(1) };
  }
  return row.text.startsWith(' ')
    ? { marker: ' ', body: row.text.slice(1) }
    : { marker: '', body: row.text };
}

/**
 * Highlighted HTML per diff row — one entry per input row, `null` on the rows that are not code,
 * or `null` overall when a gate says render the whole thing plain.
 *
 * ⚠ TWO PASSES, BECAUSE A UNIFIED DIFF IS NOT VALID SOURCE. Consecutive `-` and `+` lines are two
 * versions of ONE line. Feed them to one lexer pass and a del/add pair that opens a string or a
 * block comment on one side only leaves the lexer in a state no version of the file was ever in,
 * and everything after it is mis-coloured — the same failure `hljsLines.ts` forbids for line-by-line
 * highlighting, in a new disguise. So the OLD side (context + del) and the NEW side (context + add)
 * are reconstructed and highlighted separately, then each row takes its own side's entry. A context
 * row takes the new side; the two agree on it by construction.
 *
 * ⚠ AN EMPTY SIDE IS NOT A FAILURE. A newly-added file has no old side at all, and
 * `highlightLines([])` returns null by its own gate — treating that as a refusal would leave every
 * added file uncoloured. A side with no lines has nothing to get wrong.
 *
 * ⚠ ONE SIDE REFUSING REFUSES BOTH. Half a coloured file reads as a rendering bug, not as a
 * deliberate limit.
 *
 * ⚠ AND ONE LEX PER HUNK, NEVER ACROSS HUNKS. Two hunks are not adjacent source: the lines between
 * them are not in the patch, so joining hunk A's tail to hunk B's head is text no version of the
 * file ever contained. MEASURED on a real PR: hunk 2 ended on a context `/**` whose `*\/` sat in
 * the hidden gap, the joined lex never closed the comment, and EVERY row of hunk 3 came out as one
 * flat comment colour — which reads as "no highlighting". So the lexer starts fresh at every `@@`.
 * (A hunk that OPENS inside a comment still lexes its first lines as code; only the whole file can
 * fix that, and the gap expansion highlights from the whole file.)
 *
 * ⚠ ONE HUNK REFUSING BLANKS ONLY THAT HUNK. The "never half a file" rule above is about the two
 * SIDES of one stretch of code disagreeing; separate hunks are separate stretches already.
 *
 * `maxLines` is the line gate PER SIDE over the WHOLE FILE (every hunk's side lines summed),
 * checked before any lexing; only the Changes tab raises it (`MAX_FILE_DIFF_HIGHLIGHT_LINES`).
 * Over it, the whole file renders plain.
 */
export function highlightDiffRows(
  rows: readonly DiffRow[],
  language: string | null,
  maxLines: number = MAX_HIGHLIGHT_LINES,
): (string | null)[] | null {
  if (language == null || rows.length === 0) return null;
  // The whole-file gate first: count each side across every hunk.
  let oldTotal = 0;
  let newTotal = 0;
  for (const row of rows) {
    if (row.kind === 'hunk' || isNoNewlineRow(row)) continue;
    if (row.kind !== 'add') oldTotal += 1;
    if (row.kind !== 'del') newTotal += 1;
  }
  if (oldTotal > maxLines || newTotal > maxLines) return null;

  const out: (string | null)[] = rows.map(() => null);
  let coloured = false;
  let segStart = 0;
  const flush = (end: number): void => {
    if (end > segStart) {
      const html = highlightSegment(rows, segStart, end, language, maxLines);
      if (html != null) {
        coloured = true;
        for (let i = segStart; i < end; i += 1) out[i] = html[i - segStart] ?? null;
      }
    }
  };
  rows.forEach((row, i) => {
    if (row.kind !== 'hunk') return;
    flush(i);
    segStart = i + 1;
  });
  flush(rows.length);
  return coloured ? out : null;
}

/** The two-pass lex (see `highlightDiffRows`) over `rows[from, to)` — ONE hunk. Null = refused. */
function highlightSegment(
  rows: readonly DiffRow[],
  from: number,
  to: number,
  language: string,
  maxLines: number,
): (string | null)[] | null {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  // Per row: where its text sits in each side's array, or null when that side has no such line.
  const oldAt: (number | null)[] = [];
  const newAt: (number | null)[] = [];
  for (let i = from; i < to; i += 1) {
    const row = rows[i]!;
    if (row.kind === 'hunk' || isNoNewlineRow(row)) {
      oldAt.push(null);
      newAt.push(null);
      continue;
    }
    const { body } = splitDiffMarker(row);
    if (row.kind === 'add') oldAt.push(null);
    else {
      oldAt.push(oldLines.length);
      oldLines.push(body);
    }
    if (row.kind === 'del') newAt.push(null);
    else {
      newAt.push(newLines.length);
      newLines.push(body);
    }
  }
  if (oldLines.length === 0 && newLines.length === 0) return null;
  const oldHtml = oldLines.length === 0 ? [] : highlightLines(oldLines, language, maxLines);
  const newHtml = newLines.length === 0 ? [] : highlightLines(newLines, language, maxLines);
  if (oldHtml == null || newHtml == null) return null;
  return oldAt.map((_x, k) => {
    const n = newAt[k];
    if (n != null) return newHtml[n] ?? null;
    const o = oldAt[k];
    if (o != null) return oldHtml[o] ?? null;
    return null;
  });
}

// Total number of patch lines (used by the collapse-by-default size heuristic).
export function patchLineCount(patch: string | null | undefined): number {
  if (!patch) return 0;
  return patch.replace(/\n$/, '').split('\n').length;
}

// Find the row a (line, side) pair addresses — the "reveal this line" primitive behind
// FileDiffView's `focus` prop (the Changes-tab file tree and the Claude-Review finding
// deep-link both drive it). Deliberately NOT `commentTarget`/`anchorIndexFor` below:
// those map a CONTEXT row to the RIGHT side only, because that is where an
// inline comment must be anchored — which silently loses every LEFT-side target sitting on
// an unchanged line. Here the side is known, so match it honestly on both sides. Prefer the
// LAST match (line numbers are unique per side within one file's patch, so this only matters
// for malformed input).
export function lineRowIndex(
  rows: DiffRow[],
  line: number,
  side: 'LEFT' | 'RIGHT',
): number | null {
  let match: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null) continue;
    if (side === 'RIGHT') {
      if ((row.kind === 'add' || row.kind === 'context') && row.newLine === line) match = i;
    } else if (row.kind === 'del' || row.kind === 'context') {
      if (row.oldLine === line) match = i;
    }
  }
  return match;
}

// Which side/line an inline comment on this row anchors to: RIGHT for context rows on
// purpose — the new-file side is where a NEW inline comment must be anchored (GitHub's
// rule). Lives here (not FileDiffView) so `anchorRowFor` below can share it.
export function commentTarget(row: DiffRow): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (row.kind === 'add' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'context' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'del' && row.oldLine != null) return { line: row.oldLine, side: 'LEFT' };
  return null;
}

// A thread carries (path, line) but no side. Anchor it to the LAST row whose target line
// matches, preferring the new (RIGHT) side — that's where GitHub pins an inline thread.
function anchorIndexFor(rows: DiffRow[], line: number | null): number | null {
  if (line == null) return null;
  let right: number | null = null;
  let left: number | null = null;
  rows.forEach((row, i) => {
    const t = commentTarget(row);
    if (!t || t.line !== line) return;
    if (t.side === 'RIGHT') right = i;
    else left = i;
  });
  return right ?? left;
}

/**
 * Where a review thread anchors inside a file's parsed diff — the SAME ladder PrDetail's
 * `openInChangesFor` jump uses, so the inline pill's rendered position and the "In Changes ~"
 * scroll target agree instead of the jump landing on a bare line while the thread sits
 * elsewhere. One known asymmetry on rung 1: the jump has no side and no parsed rows, so it
 * assumes RIGHT for any live line — a live line matching only a LEFT (del) row anchors the
 * pill at that row here while the jump's line lookup misses and falls back to the file
 * header (the pill still opens + rings; only the scroll target diverges):
 *   1. a live `thread.line` → last matching row, RIGHT side preferred (GitHub pins inline
 *      threads to the new side). Never approximate — and never falls through to the hunk:
 *      a live line absent from the visible patch means the hunks moved on, and a hunk
 *      reconstruction would contradict the stored truth.
 *   2. `line == null` → reconstruct from the anchor hunk (`anchorLineFromHunk`) and match it
 *      honestly on its own side (`lineRowIndex`). APPROXIMATE — the line in the commit the
 *      comment was written against — and the caller must hedge it (the `~` glyph).
 *   3. no hit → null; the caller renders the thread at FILE grain. A thread never disappears.
 */
export function anchorRowFor(
  rows: DiffRow[],
  thread: { line: number | null; comments: readonly { diffHunk: string | null }[] },
): { index: number; approximate: boolean } | null {
  if (thread.line != null) {
    const idx = anchorIndexFor(rows, thread.line);
    return idx == null ? null : { index: idx, approximate: false };
  }
  const derived = anchorLineFromHunk(thread.comments[0]?.diffHunk);
  if (derived == null) return null;
  const idx = lineRowIndex(rows, derived.line, derived.side);
  return idx == null ? null : { index: idx, approximate: true };
}

/**
 * Fold a PR's review threads into per-RENDERED-file buckets — keyed on the CURRENT path,
 * the identity FileDiffView keys its blocks on and the tree keys its rows on. A thread
 * whose path matches no current file but does match a file's `previousPath` was written
 * before a rename and is re-homed under the current path (previously it was invisible in
 * Changes: the fold keyed on `t.path` while blocks looked up `f.path`). A thread matching
 * neither stays out of the map — a file not loaded yet (past the pages shown) renders only in the
 * Threads tab, and the tab-header count reads `pr.threads` so the aggregate never lies.
 */
export function indexThreadsByPath<T extends { path: string }>(
  threads: readonly T[],
  files: readonly { path: string; previousPath?: string | null }[],
): Map<string, T[]> {
  const current = new Set<string>();
  const renamedFrom = new Map<string, string>(); // previousPath → current path
  for (const f of files) {
    current.add(f.path);
    if (f.previousPath != null && f.previousPath !== '' && !renamedFrom.has(f.previousPath)) {
      renamedFrom.set(f.previousPath, f.path);
    }
  }
  const out = new Map<string, T[]>();
  for (const t of threads) {
    // An exact current-path match always wins over a previousPath re-home: with a COPY
    // (old path still in the diff), the thread belongs to the file that literally has it.
    const key = current.has(t.path) ? t.path : renamedFrom.get(t.path);
    if (key == null) continue;
    const bucket = out.get(key) ?? [];
    bucket.push(t);
    out.set(key, bucket);
  }
  return out;
}

/**
 * Whether an inline review-thread pill in the Changes tab starts OPEN — the ONE place that decides.
 *
 * The reader's own decision, remembered per thread id (`DiffThreadContext.openMemory`, owned by
 * PrDetail), wins in BOTH directions. A thread nobody has decided about starts from its CURRENT
 * state: OPEN unless resolved. `untouched`, `replied_unresolved` and `likely_addressed` are live
 * discussion — the last is a heuristic, so its card (with the confidence badge) is exactly what a
 * reader should see — and GitHub's own Files-changed view opens unresolved conversations and folds
 * resolved ones the same way. Only DECISIONS are ever recorded, never this default, so a thread
 * resolved elsewhere comes back shut.
 */
export function inlineThreadStartsOpen(
  thread: { id: number; derivedState: DerivedState },
  decided?: ReadonlyMap<number, boolean> | null,
): boolean {
  return decided?.get(thread.id) ?? thread.derivedState !== 'resolved';
}

/**
 * Whether a reveal (`DiffFocusTarget`) landing in a file block must scroll that block's HEADER —
 * the fallback for when nothing inside the block will scroll itself. Two things do: the diff row
 * the reveal addresses (`focusRow`, DiffLine's own effect), and the TARGET THREAD's inline pill,
 * which scrolls its own header when the reveal names it (`focus.threadId`) — at a row, at file
 * grain, or in the no-textual-diff list.
 *
 * ⚠ WHEN THE PILL IS THE TARGET, THE PILL OWNS THE SCROLL. Both are smooth `scrollIntoView` calls,
 * a later one cancels an earlier one, and React runs passive effects CHILD-FIRST — so the block's
 * header scroll ran after the pill's and won. That was invisible while every pill started shut
 * (~26px each above the target). With unresolved pills starting OPEN (~300px each) the reader
 * landed on the file header while the ringed target flashed below the fold: MEASURED on a PR with
 * four file-grain threads, the fourth one's header sat 1,274px under the top of a 297px pane.
 *
 * `renderedThreads` must be the threads the block actually renders as pills — none without a
 * thread context — or a reveal would scroll nothing at all.
 */
export function revealScrollsFileHeader(
  focus: { threadId?: number | null },
  focusRow: number | null,
  renderedThreads: readonly { id: number }[],
): boolean {
  if (focusRow != null) return false;
  const target = focus.threadId;
  return target == null || !renderedThreads.some((t) => t.id === target);
}

// ---- changed-file tree (the Changes tab's navigation rail) ----

// The minimum a file needs to appear in the tree. Deliberately structural, not the wire
// type: it is satisfied by both `PrFileDiff` (the patched list) and `PrFileChange` (the
// lean metadata fallback), so one tree serves both branches of the Changes tab.
export interface FileTreeEntry {
  path: string;
  additions: number;
  deletions: number;
  status?: PrFileDiffStatus;
  previousPath?: string | null;
  // Per-state review-thread rollup for this file (`rollupCounts` over its indexed threads).
  // Optional: the AI-Fix changeset and the metadata fallback have no threads to count.
  threadCounts?: ThreadStateCounts;
}

export interface FileTreeNode {
  kind: 'dir' | 'file';
  // The row's label. For a directory this may be a COLLAPSED chain of segments
  // ("src/api/routes") — see below.
  name: string;
  // Full path from the root: the directory path, or the file path (which is also the
  // identity FileDiffView keys its blocks on).
  path: string;
  children: FileTreeNode[];
  // Subtree rollups (a file counts as itself).
  fileCount: number;
  additions: number;
  deletions: number;
  // Subtree thread-state rollup, summed per directory exactly like additions/deletions
  // (all-zero when the entries carry no counts, e.g. the AI-Fix changeset).
  threadCounts: ThreadStateCounts;
  // Files only.
  entry: FileTreeEntry | null;
}

function zeroThreadCounts(): ThreadStateCounts {
  return { untouched: 0, replied_unresolved: 0, likely_addressed: 0, resolved: 0 };
}

function addThreadCounts(into: ThreadStateCounts, from: ThreadStateCounts): void {
  into.untouched += from.untouched;
  into.replied_unresolved += from.replied_unresolved;
  into.likely_addressed += from.likely_addressed;
  into.resolved += from.resolved;
}

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: Map<string, FileTreeEntry>;
}

function newDir(): MutableDir {
  return { dirs: new Map(), files: new Map() };
}

// Byte-ish ordering, not `localeCompare` — the tree is a machine listing of paths and its
// order must be stable across locales (and reproducible in a unit test).
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirToNodes(dir: MutableDir, prefix: string): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];
  // Directories before files at every level (the convention every file explorer uses).
  for (const name of [...dir.dirs.keys()].sort(byName)) {
    const child = dir.dirs.get(name);
    if (child) nodes.push(dirToNode(name, child, prefix));
  }
  for (const name of [...dir.files.keys()].sort(byName)) {
    const entry = dir.files.get(name);
    if (!entry) continue;
    nodes.push({
      kind: 'file',
      name,
      path: entry.path,
      children: [],
      fileCount: 1,
      additions: entry.additions,
      deletions: entry.deletions,
      threadCounts: entry.threadCounts ?? zeroThreadCounts(),
      entry,
    });
  }
  return nodes;
}

function dirToNode(name: string, dir: MutableDir, prefix: string): FileTreeNode {
  // COLLAPSE SINGLE-CHILD DIRECTORY CHAINS into one row ("apps/frontend/src" rather than
  // three nested rows). On a monorepo's own paths this is the difference between a readable
  // rail and a staircase; it never hides a decision, because a chain with one child offers
  // no choice.
  let label = name;
  let path = prefix === '' ? name : `${prefix}/${name}`;
  let cur = dir;
  while (cur.files.size === 0 && cur.dirs.size === 1) {
    const childName = [...cur.dirs.keys()][0];
    const childDir = childName == null ? undefined : cur.dirs.get(childName);
    if (childName == null || childDir == null) break;
    label = `${label}/${childName}`;
    path = `${path}/${childName}`;
    cur = childDir;
  }
  const children = dirToNodes(cur, path);
  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  const threadCounts = zeroThreadCounts();
  for (const c of children) {
    fileCount += c.fileCount;
    additions += c.additions;
    deletions += c.deletions;
    addThreadCounts(threadCounts, c.threadCounts);
  }
  return {
    kind: 'dir',
    name: label,
    path,
    children,
    fileCount,
    additions,
    deletions,
    threadCounts,
    entry: null,
  };
}

// Fold a flat changed-file list into its real project directory hierarchy. Pure (no React)
// so it can be unit-tested. Keyed on the NEW path — `previousPath` is display-only, exactly
// as FileDiffView keys its blocks (`key={f.path}`).
export function buildFileTree(entries: readonly FileTreeEntry[]): FileTreeNode[] {
  const root = newDir();
  for (const entry of entries) {
    const segments = entry.path.split('/').filter((s) => s !== '');
    const basename = segments.pop();
    if (basename == null) continue; // defensive: a path that is only slashes
    let cur = root;
    for (const seg of segments) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = newDir();
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.set(basename, entry);
  }
  return dirToNodes(root, '');
}

// Machine-generated language lock files, by exact basename (case-sensitive, matching
// what git records). Used by the Changes/AI-Fix collapse-by-default heuristic — these
// files are all noise, so they ALWAYS start collapsed regardless of size. Deliberately
// NOT a broad `*.lock` suffix match (that would catch real sources). The backend keeps
// a broader noise list for a different purpose (review routing) in
// apps/backend/src/review/prepare.ts (NOISE_GLOBS) — the two are not meant to agree.
const LOCK_FILE_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'Package.resolved',
  'gradle.lockfile',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
]);

// Basename match so nested paths work (…/xcshareddata/swiftpm/Package.resolved). The
// `.lockfile` suffix arm covers Gradle's per-project locks (gradle/dependency-locks/*.lockfile).
export function isLockFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return LOCK_FILE_BASENAMES.has(basename) || basename.endsWith('.lockfile');
}

// ---- full `git diff` splitter (for the AI Fix changeset) ----
// The AI-Fix agent's captured patch is a WHOLE `git diff --cached --binary` blob (many
// files, with `diff --git`/`index`/`---`/`+++` headers). This splits it into per-file
// units whose header-less `patch` starts at the first `@@` — the exact shape parsePatch
// and the shared FileDiffView already consume — so the fix diff renders like the
// Changes tab. `patch` is null for binary files.

export interface ParsedGitFile {
  path: string;
  previousPath: string | null;
  status: PrFileDiffStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

function stripDiffPath(raw: string): string | null {
  let p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGitLine(line: string): { oldPath: string | null; newPath: string | null } {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!m) return { oldPath: null, newPath: null };
  return { oldPath: m[1] ?? null, newPath: m[2] ?? null };
}

export function parseGitPatch(patch: string | null | undefined): ParsedGitFile[] {
  if (!patch) return [];
  const all = patch.replace(/\n$/, '').split('\n');
  const n = all.length;
  const files: ParsedGitFile[] = [];

  let i = 0;
  while (i < n && !(all[i] ?? '').startsWith('diff --git ')) i++;

  while (i < n) {
    const header = parseDiffGitLine(all[i] ?? '');
    i++;
    let status: PrFileDiffStatus = 'modified';
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let binary = false;
    const hunkLines: string[] = [];
    let inHunks = false;

    for (; i < n; i++) {
      const line = all[i] ?? '';
      if (line.startsWith('diff --git ')) break; // next file section
      if (inHunks) {
        hunkLines.push(line);
        continue;
      }
      if (line.startsWith('@@')) {
        inHunks = true;
        hunkLines.push(line);
      } else if (line.startsWith('new file mode')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        status = 'removed';
      } else if (line.startsWith('rename from ')) {
        status = 'renamed';
        renameFrom = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) {
        status = 'renamed';
        renameTo = line.slice('rename to '.length);
      } else if (line.startsWith('copy from ')) {
        status = 'copied';
        renameFrom = line.slice('copy from '.length);
      } else if (line.startsWith('copy to ')) {
        status = 'copied';
        renameTo = line.slice('copy to '.length);
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        binary = true;
      } else if (line.startsWith('--- ')) {
        oldPath = stripDiffPath(line.slice(4));
      } else if (line.startsWith('+++ ')) {
        newPath = stripDiffPath(line.slice(4));
      }
    }

    const path =
      newPath || renameTo || header.newPath || header.oldPath || oldPath || '(unknown)';
    const previousPath =
      status === 'renamed' || status === 'copied'
        ? renameFrom || oldPath || header.oldPath
        : null;

    let additions = 0;
    let deletions = 0;
    for (const l of hunkLines) {
      if (l.startsWith('+') && !l.startsWith('+++')) additions++;
      else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
    }

    files.push({
      path,
      previousPath,
      status,
      additions,
      deletions,
      patch: binary ? null : hunkLines.join('\n'),
    });
  }
  return files;
}

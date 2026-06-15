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
}

// Parse `@@ -oldStart,oldCount +newStart,newCount @@ …` → the two start lines.
// Returns null if the line isn't a hunk header.
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

// Turn a unified per-file patch into an ordered list of rows. Resilient to a
// null/empty patch (→ no rows) and to the occasional `\ No newline at end of
// file` marker GitHub emits (rendered as a context row, consuming no line number).
export function parsePatch(patch: string | null | undefined): DiffRow[] {
  if (!patch) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = parseHunkHeader(text);
    if (header) {
      oldLine = header.oldStart;
      newLine = header.newStart;
      rows.push({ kind: 'hunk', text });
      continue;
    }
    const marker = text[0];
    if (marker === '+') {
      rows.push({ kind: 'add', text, newLine });
      newLine += 1;
    } else if (marker === '-') {
      rows.push({ kind: 'del', text, oldLine });
      oldLine += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — annotation, not a real line.
      rows.push({ kind: 'context', text });
    } else {
      // A space-prefixed (or, defensively, otherwise unmarked) context line.
      rows.push({ kind: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

// Total number of patch lines (used by the collapse-by-default size heuristic).
export function patchLineCount(patch: string | null | undefined): number {
  if (!patch) return 0;
  return patch.replace(/\n$/, '').split('\n').length;
}

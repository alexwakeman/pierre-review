// Pure unified-diff anchoring helpers, shared between the Claude-review posting
// path (review/post-review.ts) and the on-demand Changes-tab / inline-comment
// path (the PR write actions). All functions here are side-effect-free string
// parsers — no GitHub I/O, no DB — so they're trivially testable and reusable.

// Lines a GitHub review comment can anchor to, per file. For the RIGHT side
// (the head/new file) GitHub accepts comments on added (`+`) and context lines;
// for the LEFT side (the base/old file) it accepts deleted (`-`) and context
// lines. We record both so a finding's (path, line, side) can be validated.
export interface FileAnchors {
  right: Set<number>;
  left: Set<number>;
  // The file's FIRST added (`+`, RIGHT) and removed (`-`, LEFT) line numbers — the
  // fallback anchor for a finding whose own line isn't in the diff (see
  // `fallbackAnchor`). null when the file has no added / no removed lines.
  firstAdded: number | null;
  firstRemoved: number | null;
}

export type AnchorIndex = Map<string, FileAnchors>;

export const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Parse a unified diff into per-file maps of addable line numbers. We track the
// new-file line counter (RIGHT) and old-file line counter (LEFT) as we walk each
// hunk: context lines advance both, `+` advances RIGHT, `-` advances LEFT.
export function buildAnchorIndex(diff: string): AnchorIndex {
  const index: AnchorIndex = new Map();
  let current: FileAnchors | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      current = null;
      continue;
    }
    // `+++ b/path` names the new-side file; strip the `b/` prefix. GitHub keys
    // comments by this path. `/dev/null` (deletions) yields no anchors.
    if (raw.startsWith('+++ ')) {
      const path = parseDiffPath(raw.slice(4));
      if (path) {
        current = {
          right: new Set(),
          left: new Set(),
          firstAdded: null,
          firstRemoved: null,
        };
        index.set(path, current);
      } else {
        current = null;
      }
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (marker === '+') {
      current.right.add(newLine);
      if (current.firstAdded == null) current.firstAdded = newLine;
      newLine += 1;
    } else if (marker === '-') {
      current.left.add(oldLine);
      if (current.firstRemoved == null) current.firstRemoved = oldLine;
      oldLine += 1;
    } else if (marker === ' ') {
      current.right.add(newLine);
      current.left.add(oldLine);
      newLine += 1;
      oldLine += 1;
    }
    // `\ No newline at end of file` and blank trailing lines advance nothing.
  }
  return index;
}

// Parse a SINGLE GitHub REST per-file patch into its FileAnchors. REST per-file
// patches (from `GET /pulls/{n}/files`) are header-LESS — they start straight at
// the first `@@ … @@` hunk, with no `diff --git` / `+++ b/path` line that
// `buildAnchorIndex` keys on. We synthesize that `+++ b/<filename>` header so the
// shared walker produces an index, then pull the one entry back out.
//
// A null/empty patch (binary files, or files with no textual diff) yields empty
// anchor sets so callers treat every line as unanchorable.
export function buildFileAnchors(filename: string, patch: string | null): FileAnchors {
  const empty: FileAnchors = {
    right: new Set(),
    left: new Set(),
    firstAdded: null,
    firstRemoved: null,
  };
  if (!patch) return empty;
  const synthesized = `+++ b/${filename}\n${patch}`;
  // The synthesized diff has exactly one file, so take the sole entry rather than
  // looking it up by `filename` — buildAnchorIndex may trim the key, which would
  // miss for a filename with surrounding whitespace.
  const [only] = buildAnchorIndex(synthesized).values();
  return only ?? empty;
}

// `+++ b/src/foo.ts` → `src/foo.ts`; `+++ /dev/null` → null. Trailing tab-info
// (rename/mode) is already excluded by GitHub's diff format on this line.
function parseDiffPath(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed === '/dev/null') return null;
  return trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}

export interface FileDiff {
  path: string;
  text: string;
}

// Split a unified diff into per-file segments (each starting at a `diff --git`
// header). The path prefers the new-side (`+++ b/…`) name, falling back to the
// header. Used to drop noise files before the agent sees the diff.
export function splitDiffByFile(diff: string): FileDiff[] {
  const segments: FileDiff[] = [];
  let curLines: string[] = [];
  let curPath: string | null = null;
  const flush = (): void => {
    if (curLines.length > 0 && curPath) {
      segments.push({ path: curPath, text: curLines.join('\n') });
    }
    curLines = [];
    curPath = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      curLines = [line];
      curPath = parseGitHeaderPath(line);
    } else {
      if (line.startsWith('+++ ')) {
        const p = parseDiffPath(line.slice(4));
        if (p) curPath = p;
      }
      curLines.push(line);
    }
  }
  flush();
  return segments;
}

// `diff --git a/foo b/foo` → `foo` (new path). Null if unparseable.
function parseGitHeaderPath(line: string): string | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return m ? (m[2] ?? null) : null;
}

// A finding is anchorable inline only if its (path, line, side) lands on an
// addable diff line for that side.
export function isFindingAnchored(
  index: AnchorIndex,
  path: string,
  line: number | null,
  side: 'LEFT' | 'RIGHT',
): boolean {
  if (line == null) return false;
  const anchors = index.get(path);
  if (!anchors) return false;
  return side === 'LEFT' ? anchors.left.has(line) : anchors.right.has(line);
}

// Where to anchor a finding whose own (line, side) isn't addable: the file's
// FIRST added line (RIGHT), preferred over its first removed line (LEFT). null
// when the file isn't in the diff at all (nothing to attach to → stays skipped).
export function fallbackAnchor(
  index: AnchorIndex,
  path: string,
): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  const anchors = index.get(path);
  if (!anchors) return null;
  if (anchors.firstAdded != null) return { line: anchors.firstAdded, side: 'RIGHT' };
  if (anchors.firstRemoved != null) return { line: anchors.firstRemoved, side: 'LEFT' };
  return null;
}

// Extract a small unified-diff window around a finding's (path, line, side), to
// show the covered code in context. Walks the diff like buildAnchorIndex,
// tracking new/old line counters, then slices ±ctx body lines around the match
// and prepends the containing hunk header. Returns null if the line isn't found.
export function extractHunk(
  diff: string,
  path: string,
  line: number | null,
  side: 'LEFT' | 'RIGHT',
  ctx = 3,
): string | null {
  if (line == null) return null;
  let inFile = false;
  let newLine = 0;
  let oldLine = 0;
  let hunkHeader = '';
  let targetHunkHeader = '';
  const body: string[] = [];
  let targetIdx = -1;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inFile = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      inFile = parseDiffPath(raw.slice(4)) === path;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (!inFile) continue;
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunkHeader = raw;
      continue;
    }
    const marker = raw[0];
    let matches = false;
    if (marker === '+') matches = side === 'RIGHT' && newLine === line;
    else if (marker === '-') matches = side === 'LEFT' && oldLine === line;
    else if (marker === ' ') {
      matches =
        (side === 'RIGHT' && newLine === line) ||
        (side === 'LEFT' && oldLine === line);
    }
    body.push(raw);
    if (matches && targetIdx === -1) {
      targetIdx = body.length - 1;
      targetHunkHeader = hunkHeader;
    }
    if (marker === '+') newLine += 1;
    else if (marker === '-') oldLine += 1;
    else if (marker === ' ') {
      newLine += 1;
      oldLine += 1;
    }
  }

  if (targetIdx === -1) return null;
  const start = Math.max(0, targetIdx - ctx);
  const end = Math.min(body.length, targetIdx + ctx + 1);
  return [targetHunkHeader, ...body.slice(start, end)].filter(Boolean).join('\n');
}

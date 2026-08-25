import type { PrFileDiffStatus, ThreadStateCounts } from '@pierre-review/shared';

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
 * neither stays out of the map — a file beyond the diff's 100-file cap renders only in the
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

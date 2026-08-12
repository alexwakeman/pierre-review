import type { PrFileDiffStatus } from '@pierre-review/shared';

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

import type { PrDetail, PrFileDiff, PrFilesResponse, ThreadDetail } from '@pierre-review/shared';
import { prDetailFor } from './mock-api.js';

// A LARGE PR for the Changes tab: `fileCount` TypeScript files, each two ~90-line hunks (so every
// file stays under the 250-patch-line collapse heuristic and starts EXPANDED — the worst case for
// the tab's first paint), with an unresolved thread on every third file (unresolved threads start
// OPEN, a full ThreadCard each) and a resolved one on every fifth. The LAST file carries the
// `targetThreadId` thread, deep in its second hunk: the thread-jump spec addresses it while its
// file is far below the fold. Used by `changes-lazy.spec.ts` (the regression checks and the
// before/after measurement).

const now = Date.now();
const iso = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString();

const HUNK_LINES = 90;
export const LOCK_INDEX = 50;

interface Built {
  patch: string;
  /** New-side line numbers of the context rows, per hunk — where a thread may sit. */
  contextLines: number[][];
  additions: number;
  deletions: number;
  /** The whole file at the head — what the gap expander reads (`/files/content`). */
  head: string[];
}

function buildPatch(fileIndex: number): Built {
  const out: string[] = [];
  const contextLines: number[][] = [];
  let additions = 0;
  let deletions = 0;
  const head: string[] = Array.from({ length: 460 }, (_x, k) => `// filler line ${k + 1}`);
  for (const [h, start] of [10, 300].entries()) {
    const body: string[] = [];
    const ctx: number[] = [];
    let oldN = 0;
    let newN = 0;
    for (let j = 0; j < HUNK_LINES; j += 1) {
      const code = `  const value${j} = compute(${fileIndex}, ${j}); // keep the line long enough to look like code`;
      if (j % 10 === 3) {
        body.push(`-${code.replace('compute', 'legacyCompute')}`);
        oldN += 1;
        deletions += 1;
      } else if (j % 10 === 4) {
        body.push(`+${code.replace('compute', 'computeFast')}`);
        head[start + newN - 1] = code.replace('compute', 'computeFast');
        newN += 1;
        additions += 1;
      } else {
        ctx.push(start + newN);
        head[start + newN - 1] = code;
        body.push(` ${code}`);
        oldN += 1;
        newN += 1;
      }
    }
    out.push(`@@ -${start},${oldN} +${start},${newN} @@ export function section${h}() {`, ...body);
    contextLines.push(ctx);
  }
  return { patch: out.join('\n'), contextLines, additions, deletions, head };
}

function thread(
  id: number,
  prId: number,
  path: string,
  line: number,
  resolved: boolean,
  body: string,
): ThreadDetail {
  return {
    id,
    prId,
    path,
    line,
    isResolved: resolved,
    isOutdated: false,
    derivedState: resolved ? 'resolved' : 'untouched',
    addressedConfidence: 'low',
    addressedReason: null,
    originalCommenterId: 3,
    createdAt: iso(1),
    comments: [
      { id: id * 10, authorId: 3, body, diffHunk: null, createdAt: iso(1), url: null },
    ],
    url: null,
    limnSeverity: null,
  };
}

export interface BigDiff {
  detail: PrDetail;
  files: PrFilesResponse;
  targetThreadId: number;
  targetPath: string;
  threadCount: number;
  totalRows: number;
  /** Each file's head lines, for the `/files/content` route. */
  heads: Map<string, string[]>;
}

export function bigDiff(prId: number, fileCount = 100): BigDiff {
  const base = prDetailFor(prId);
  const files: PrFileDiff[] = [];
  const threads: ThreadDetail[] = [];
  let totalRows = 0;
  let targetThreadId = 0;
  let targetPath = '';
  const heads = new Map<string, string[]>();
  for (let i = 0; i < fileCount; i += 1) {
    // One lock file mid-PR: it always starts collapsed, threads or not.
    const path = i === LOCK_INDEX ? 'pnpm-lock.yaml' : `src/module${String(i).padStart(3, '0')}/handler${i}.ts`;
    const built = buildPatch(i);
    totalRows += built.patch.split('\n').length;
    heads.set(path, built.head);
    files.push({
      path,
      status: 'modified',
      additions: built.additions,
      deletions: built.deletions,
      patch: built.patch,
      githubUrl: `${base.githubUrl}/files#diff-${i}`,
      blobUrl: `https://github.com/acme/web/blob/deadbeef/${path}`,
    });
    const first = built.contextLines[0]!;
    const second = built.contextLines[1]!;
    if (i % 3 === 0) {
      threads.push(thread(70_000 + i, prId, path, first[5]!, false, `Should this handle the empty case in handler ${i}?`));
    }
    if (i % 5 === 0) {
      threads.push(thread(80_000 + i, prId, path, first[20]!, true, `Nit: rename value in handler ${i}.`));
    }
    if (i === fileCount - 1) {
      targetThreadId = 99_001;
      targetPath = path;
      threads.push(
        thread(targetThreadId, prId, path, second[60]!, false, 'The target thread: deep in the last file.'),
      );
    }
  }
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  const detail: PrDetail = {
    ...base,
    additions,
    deletions,
    changedFilesCount: files.length,
    files: files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      githubUrl: f.githubUrl,
    })),
    threads,
  };
  return {
    detail,
    files: { files, truncated: false, nextPage: null, headSha: base.headSha },
    targetThreadId,
    targetPath,
    threadCount: threads.length,
    totalRows,
    heads,
  };
}

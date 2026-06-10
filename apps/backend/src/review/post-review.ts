import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ClaudeFinding,
  ClaudeReviewVerdict,
  PostReviewComment,
  PostReviewPreview,
  SkippedFinding,
} from '@pierre-review/shared';
import { ghRestGet, ghRestPost } from '../github/client.js';

const execFileAsync = promisify(execFile);

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

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

// Drop files matched by `isNoise` (lockfiles/generated) from the diff, returning
// the stripped diff + the excluded paths (recorded on the run).
export function stripNoiseFromDiff(
  diff: string,
  isNoise: (path: string) => boolean,
): { diff: string; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const seg of splitDiffByFile(diff)) {
    if (isNoise(seg.path)) excluded.push(seg.path);
    else kept.push(seg.text);
  }
  return { diff: kept.join('\n'), excluded };
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

// Appended to a comment placed on a fallback line, so PR readers know the inline
// position is approximate (the finding's real line isn't part of this diff).
export const FALLBACK_ANCHOR_NOTE =
  '_The line this refers to isn’t part of the PR’s diff, so it’s anchored to the file’s first change._';

// The wire-facing preview plus the finding ids that became inline comments (so a
// successful post can stamp exactly those findings).
export interface BuiltReview {
  preview: PostReviewPreview;
  postedFindingIds: number[];
}

// Build the exact `{ body, event, comments }` GitHub review payload from the
// user's authored body/verdict plus the findings they ticked. Ticked findings
// that don't anchor are reported (not injected) so the UI can flag them.
export function buildReview(input: {
  commitId: string;
  body: string;
  event: ClaudeReviewVerdict;
  includedFindings: ClaudeFinding[];
  diff: string;
}): BuiltReview {
  const index = buildAnchorIndex(input.diff);
  const comments: PostReviewComment[] = [];
  const skippedUnanchored: SkippedFinding[] = [];
  const postedFindingIds: number[] = [];
  for (const f of input.includedFindings) {
    if (f.line != null && isFindingAnchored(index, f.path, f.line, f.side)) {
      comments.push({
        path: f.path,
        line: f.line,
        side: f.side,
        body: findingCommentBody(f),
      });
      postedFindingIds.push(f.id);
      continue;
    }
    // The finding's own line isn't an addable diff position — anchor it to the
    // file's first change (added preferred) so it can still post inline. Only when
    // the file itself isn't in the diff is there nowhere to attach it → skip.
    const fb = fallbackAnchor(index, f.path);
    if (fb) {
      comments.push({
        path: f.path,
        line: fb.line,
        side: fb.side,
        body: findingCommentBody(f, { fallbackNote: true }),
      });
      postedFindingIds.push(f.id);
    } else {
      skippedUnanchored.push({ findingId: f.id, path: f.path, title: f.title });
    }
  }
  return {
    preview: {
      commitId: input.commitId,
      body: input.body,
      event: input.event,
      comments,
      skippedUnanchored,
    },
    postedFindingIds,
  };
}

// A finding's inline comment body: the user's reworded text if they wrote one,
// else Claude's wording — with an optional fenced ```suggestion block appended
// (GitHub renders it as an applyable suggestion). Takes a minimal shape so it
// works for both the wire ClaudeFinding and a raw DB row.
//
// `fallbackNote` is set when the comment is posted on a fallback line (the
// finding's real line isn't in the diff). Then we (a) append FALLBACK_ANCHOR_NOTE
// and (b) render any suggestion as a PLAIN code block rather than ```suggestion —
// an applyable suggestion on the wrong line would offer to corrupt that line.
export function findingCommentBody(
  f: {
    body: string;
    editedBody: string | null;
    suggestion: string | null;
  },
  opts?: { fallbackNote?: boolean },
): string {
  const body = f.editedBody && f.editedBody.trim() ? f.editedBody : f.body;
  const parts = [body];
  if (f.suggestion && f.suggestion.trim()) {
    parts.push(
      opts?.fallbackNote
        ? `\`\`\`\n${f.suggestion}\n\`\`\``
        : `\`\`\`suggestion\n${f.suggestion}\n\`\`\``,
    );
  }
  if (opts?.fallbackNote) parts.push(FALLBACK_ANCHOR_NOTE);
  return parts.join('\n\n');
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

interface GhPull {
  head: { sha: string };
}

// The PR's current head SHA (to detect head-moved before posting).
export async function fetchCurrentHeadSha(
  owner: string,
  name: string,
  prNumber: number,
): Promise<string> {
  const pull = await ghRestGet<GhPull>(`/repos/${owner}/${name}/pulls/${prNumber}`);
  return pull.head.sha;
}

// The PR's unified diff, via the gh CLI (matches GitHub's 3-dot view and reuses
// the gh auth/SSO already required by the app). Bounded so a huge PR can't hang.
export async function fetchPrDiff(
  owner: string,
  name: string,
  prNumber: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'diff', String(prNumber), '--repo', `${owner}/${name}`],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  return stdout;
}

interface GhReviewResponse {
  id: number;
  html_url?: string;
}

// POST a single PR review with inline comments + body + verdict. Inline comments
// REQUIRE this REST endpoint. `commit_id` pins the review to the head SHA.
export async function submitGithubReview(input: {
  owner: string;
  name: string;
  prNumber: number;
  commitId: string;
  body: string;
  event: ClaudeReviewVerdict;
  comments: PostReviewComment[];
}): Promise<{ reviewId: string }> {
  const res = await ghRestPost<GhReviewResponse>(
    `/repos/${input.owner}/${input.name}/pulls/${input.prNumber}/reviews`,
    {
      commit_id: input.commitId,
      body: input.body,
      event: input.event,
      comments: input.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    },
  );
  return { reviewId: String(res.id) };
}

interface GhCommentResponse {
  id: number;
  html_url?: string;
}

// Post a SINGLE standalone inline review comment (not part of a review draft).
// `commit_id` pins it to the head SHA; the line must be addable on that side.
export async function submitGithubComment(input: {
  owner: string;
  name: string;
  prNumber: number;
  commitId: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}): Promise<{ commentId: string }> {
  const res = await ghRestPost<GhCommentResponse>(
    `/repos/${input.owner}/${input.name}/pulls/${input.prNumber}/comments`,
    {
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      side: input.side,
    },
  );
  return { commentId: String(res.id) };
}

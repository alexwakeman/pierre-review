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
import {
  type AnchorIndex,
  buildAnchorIndex,
  fallbackAnchor,
  isFindingAnchored,
  splitDiffByFile,
} from '../github/diff-anchor.js';

const execFileAsync = promisify(execFile);

// The pure unified-diff anchoring helpers now live in github/diff-anchor.ts (so
// they're reusable by the on-demand PR write-action paths). Re-export them here
// so existing importers (agent.ts, routing.ts, claude-review.ts, the review
// tests) keep their `./post-review.js` import path unchanged.
export {
  type AnchorIndex,
  type FileAnchors,
  type FileDiff,
  buildAnchorIndex,
  buildFileAnchors,
  extractHunk,
  fallbackAnchor,
  HUNK_RE,
  isFindingAnchored,
  splitDiffByFile,
} from '../github/diff-anchor.js';

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

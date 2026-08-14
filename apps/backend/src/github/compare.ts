// Two-sha COMPARE primitive (CORE). One REST call to
// `GET /repos/{owner}/{name}/compare/{base}...{head}` returning the per-file unified patches
// between two commits, optionally narrowed to a set of paths.
//
// WHY IT LIVES IN CORE. Every diff primitive does, by standing policy (see the PreparedReview
// note in src/pro/contract.ts): the plugin holds no GitHub token and must never assemble
// patches itself. This module is the one the `addressed` annotation is grounded on — "what
// actually changed between the commit the thread was last discussed at and the PR head" — and
// it is reached from the plugin through `ProContext.github.fetchCompareDiff`.
//
// IT NEVER THROWS. A missing/forbidden/rate-limited compare must degrade the judgement that
// asked for it to "no diff evidence available", never turn a working feature into an error.
// Every failure comes back as `{ ok: false, reason }`.
//
// KNOWN GITHUB LIMITS, all modelled rather than hidden:
//   * `files[]` is capped at 300 entries — past that a path's ABSENCE is not proof it was
//     untouched, hence `filesTruncated`;
//   * `patch` is OMITTED for binary and oversized files (the entry still appears with its
//     add/delete counts), hence a `null` patch with a real `status`;
//   * a sha that has been force-pushed away 404s — an ordinary outcome, not an error;
//   * 403/429 are classified through `isRateLimitError` (the SEPARATE classifier — do NOT
//     widen `isRetryableGithubError`, whose 403/429 exclusion is pinned by a test) and fed to
//     the per-account budget so the rest of the process backs off too.
import { ghRestGetFor, isRateLimitError, withGithubRetry } from './client.js';
import { noteLimited } from './rate-budget.js';

/** Per-file clamp on the returned patch. A grounding hunk, not a whole-file dump. */
export const DEFAULT_MAX_PATCH_CHARS = 20_000;

/** GitHub's own ceiling on `files[]` in one compare response. */
const GITHUB_COMPARE_FILE_CAP = 300;

/** Shas arrive from stored data; keep them out of the URL path unless they look like shas. */
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

export interface CompareFileDiff {
  /** The file's path at `headSha` (GitHub's `filename`). */
  path: string;
  /** For a rename, the path it had at `baseSha`; null otherwise. */
  previousPath: string | null;
  /** GitHub's `status`: added | modified | removed | renamed | copied | changed | unchanged. */
  status: string;
  additions: number;
  deletions: number;
  /**
   * The unified patch, header-LESS exactly as GitHub returns it (it starts at the first
   * `@@ … @@`), clamped to `maxPatchChars`. NULL when GitHub omitted it — a binary file, or one
   * whose diff was too large to inline.
   */
  patch: string | null;
  /** True when the patch above was cut by the clamp. */
  patchTruncated: boolean;
}

export interface CompareDiffResult {
  ok: boolean;
  baseSha: string;
  headSha: string;
  /** The changed files, narrowed to `paths` when the caller passed one. */
  files: CompareFileDiff[];
  /** How many changed files GitHub reported in total (before any path narrowing). */
  filesChanged: number;
  /** GitHub's 300-file cap was hit: a path missing from `files` may still have changed. */
  filesTruncated: boolean;
  /**
   * Why there is nothing to show. `null` on a normal answer.
   *   'identical'    — base === head, so nothing can have changed (no request was made)
   *   'bad_sha'      — a sha that does not look like a sha (nothing was requested)
   *   'not_found'    — 404: a sha is unreachable (force-pushed away) or the repo is gone
   *   'forbidden'    — 403 that is not a rate limit (the token cannot read this repo)
   *   'rate_limited' — classified through isRateLimitError; the account budget was told
   *   'error'        — anything else
   */
  reason: string | null;
}

interface RestCompareFile {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
}

interface RestCompare {
  files?: RestCompareFile[];
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function empty(
  baseSha: string,
  headSha: string,
  reason: string | null,
  ok: boolean,
): CompareDiffResult {
  return { ok, baseSha, headSha, files: [], filesChanged: 0, filesTruncated: false, reason };
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * The per-file patches between two commits of one repo.
 *
 * `paths` narrows the RESULT, not the request — GitHub's compare endpoint has no server-side
 * path filter, so the whole file list comes back either way and is filtered here. That is also
 * why one call covers every path a caller cares about: coalesce by (baseSha, headSha) rather
 * than issuing one request per file.
 *
 * A file that was RENAMED matches on either name, so a thread anchored to the old path still
 * finds its change.
 */
export async function fetchCompareDiff(
  token: string,
  args: {
    owner: string;
    name: string;
    baseSha: string;
    headSha: string;
    /** Narrow the returned files to these paths (matched against new AND previous name). */
    paths?: readonly string[];
    maxPatchChars?: number;
    /** When known, a rate-limited failure is fed to this account's budget. */
    accountId?: number;
  },
): Promise<CompareDiffResult> {
  const { owner, name, baseSha, headSha } = args;
  const maxPatchChars = args.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;

  if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
    return empty(baseSha, headSha, 'bad_sha', false);
  }
  // Nothing can have changed between a commit and itself — and a request would still cost a
  // point of GitHub quota to say so.
  if (baseSha === headSha) return empty(baseSha, headSha, 'identical', true);

  let raw: RestCompare;
  try {
    raw = await withGithubRetry(() =>
      ghRestGetFor<RestCompare>(
        token,
        `/repos/${owner}/${name}/compare/${baseSha}...${headSha}`,
      ),
    );
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited) {
      if (args.accountId != null) noteLimited(args.accountId, rl.resumeAt);
      return empty(baseSha, headSha, 'rate_limited', false);
    }
    const status = statusOf(err);
    const reason = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'error';
    return empty(baseSha, headSha, reason, false);
  }

  const all = Array.isArray(raw.files) ? raw.files : [];
  const want = args.paths != null ? new Set(args.paths) : null;
  const files: CompareFileDiff[] = [];
  for (const f of all) {
    const path = asString(f.filename);
    if (path == null) continue;
    const previousPath = asString(f.previous_filename);
    if (want != null && !want.has(path) && !(previousPath != null && want.has(previousPath))) {
      continue;
    }
    const patchRaw = asString(f.patch);
    const patchTruncated = patchRaw != null && patchRaw.length > maxPatchChars;
    files.push({
      path,
      previousPath,
      status: asString(f.status) ?? 'modified',
      additions: asCount(f.additions),
      deletions: asCount(f.deletions),
      patch: patchRaw == null ? null : patchTruncated ? patchRaw.slice(0, maxPatchChars) : patchRaw,
      patchTruncated,
    });
  }

  return {
    ok: true,
    baseSha,
    headSha,
    files,
    filesChanged: all.length,
    filesTruncated: all.length >= GITHUB_COMPARE_FILE_CAP,
    reason: null,
  };
}

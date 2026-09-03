import type { PreparedReview, ReviewFileMetric } from '../pro/contract.js';
import { config } from '../config.js';
import {
  capDiff,
  fetchPrDiff,
  splitDiffByFile,
  stripNoiseFromDiff,
} from './post-review.js';

// Core diff-prep for the Claude Review seam (ctx.review.prepareReview). Everything that
// touches the diff lives in CORE so the mode-routing metrics the plugin consumes and the
// run-time/post-time line-anchoring all derive from the SAME noise-stripped diff (anchoring
// drift would corrupt inline comments). The plugin gets DATA back (a PreparedReview) and
// only runs the pure routing decision + prompt formatting. (The noise matcher moved here
// from prompt.ts and analyzeDiff from routing.ts — both were CORE-only helpers.)

// ---- Noise-file matcher (lockfiles / generated / vendored artifacts) ----
// Globs for files whose diffs are noise to a human reviewer: stripped from the diff so the
// agent spends its budget on real code, not a 4000-line lockfile churn. Only the three glob
// shapes below are supported (exact basename, `*.ext` suffix, `**​/segment/**` path segment).
//
// ⚠ THIS LIST IS A PAID AGENT'S DIFF BUDGET — DO NOT WIDEN IT FOR ANOTHER FEATURE. It deliberately
// keeps `.md`, `.yml`, `.json` and `docs/` IN the diff, because a review agent reading a config
// change is doing its job. The large-PR flag needs a much broader "is this code?" answer, and it
// has its OWN classifier for exactly that reason: `isNonCodeFile` in `db/code-loc.ts`, which
// documents how the two (and the frontend's narrower `isLockFile`) relate. Editing this list to
// satisfy that feature would silently change what Claude Review reviews, with no test to catch it.
export const NOISE_GLOBS: string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  '*.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/__snapshots__/**',
];

function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

function basename(path: string): string {
  const p = normalizePath(path);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function matchesGlob(glob: string, fullPath: string, base: string): boolean {
  const segMatch = /^\*\*\/(.+)\/\*\*$/.exec(glob);
  if (segMatch) {
    const segment = segMatch[1];
    if (!segment) return false;
    const needle = `/${segment}/`;
    return fullPath === segment || fullPath.startsWith(`${segment}/`) || fullPath.includes(needle);
  }
  if (glob.startsWith('*.')) {
    const suffix = glob.slice(1);
    return base.length > suffix.length && base.endsWith(suffix);
  }
  return base === glob;
}

// True if `path` looks like a lockfile / generated / vendored artifact to hide from review.
export function isNoiseFile(path: string): boolean {
  const full = normalizePath(path);
  const base = basename(full);
  for (const glob of NOISE_GLOBS) {
    if (matchesGlob(glob, full, base)) return true;
  }
  return false;
}

// ---- Per-file diff analysis (feeds the plugin's decideReviewMode via PreparedReview) ----
// Path shapes that ARE an interface/contract definition (editing one is very likely a
// cross-cutting change whose consumers live outside the diff). Matched on the path.
export const API_PATH_PATTERNS: RegExp[] = [
  /\.(proto|thrift|graphql|gql)$/i,
  /\.d\.ts$/i,
  /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i,
  /(^|\/)migrations?\//i,
];

// Markers that, on a REMOVED or MODIFIED diff line, indicate a change to an exported/public
// symbol (a signature/removal — the risky case). Over-matching only over-routes (safe).
export const EXPORT_MARKERS: RegExp[] = [
  /\bexport\b/,
  /\bmodule\.exports\b|\bexports\.\w/,
  /\bpub(\s+|\()/,
  /\b(public|protected)\s+\w/,
  /\bfunc\b\s*(\([^)]*\)\s*)?[A-Z]\w*\s*\(/,
  /\b(type|const|var)\s+[A-Z]\w*/,
  /\b__all__\b/,
];

function lineTouchesApi(content: string): boolean {
  return EXPORT_MARKERS.some((re) => re.test(content));
}

function pathTouchesApi(path: string): boolean {
  return API_PATH_PATTERNS.some((re) => re.test(path));
}

// Walk one noise-stripped unified diff into per-file change metrics. Header lines
// (diff/index/---/+++/@@/mode/rename/binary) are skipped; only real body +/- lines count.
export function analyzeDiff(diff: string): ReviewFileMetric[] {
  const out: ReviewFileMetric[] = [];
  for (const seg of splitDiffByFile(diff)) {
    let additions = 0;
    let deletions = 0;
    let isNew = false;
    let apiTouch = pathTouchesApi(seg.path);
    let inHunk = false;
    for (const line of seg.text.split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (
          line.startsWith('new file mode') ||
          (line.startsWith('--- ') && line.slice(4).trim() === '/dev/null')
        ) {
          isNew = true;
        }
        continue;
      }
      const marker = line[0];
      if (marker === '+') {
        additions += 1;
      } else if (marker === '-') {
        deletions += 1;
        if (!apiTouch && lineTouchesApi(line.slice(1))) apiTouch = true;
      }
    }
    out.push({ path: seg.path, additions, deletions, isNew, apiTouch });
  }
  return out;
}

// ctx.review.prepareReview — fetch the PR's diff (gh CLI), strip noise, analyze per-file
// metrics, and cap the prompt diff. Returns everything the plugin needs to route + prompt
// WITHOUT any diff primitive leaving core.
export async function prepareReview(args: {
  owner: string;
  name: string;
  prNumber: number;
}): Promise<PreparedReview> {
  const rawDiff = await fetchPrDiff(args.owner, args.name, args.prNumber);
  const { diff: strippedDiff, excluded } = stripNoiseFromDiff(rawDiff, isNoiseFile);
  const fileMetrics = analyzeDiff(strippedDiff);
  const changedFiles = fileMetrics.map((f) => f.path);

  // Diff-size cap (feature-flagged): shrink only the PROMPT's diff body at a whole-file
  // boundary. Routing ran on the full stripped diff and anchoring still uses it.
  let promptDiff = strippedDiff;
  let omittedFiles: string[] = [];
  let diffCapped = false;
  if (config.reviewDiffCapEnabled) {
    const capped = capDiff(strippedDiff, config.reviewDiffCapChars);
    promptDiff = capped.diff;
    omittedFiles = capped.omittedFiles;
    diffCapped = capped.capped;
  }

  return {
    strippedDiff,
    promptDiff,
    changedFiles,
    excludedFiles: excluded,
    omittedFiles,
    fileMetrics,
    diffBytes: strippedDiff.length,
    diffCapped,
  };
}

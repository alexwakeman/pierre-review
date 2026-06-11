/**
 * The deterministic review router: decide, BEFORE the agent runs, whether a PR
 * can be reviewed from its diff alone (fast, tool-less, no worktree) or needs the
 * full cloned worktree as explorable context — or has nothing substantive to
 * review at all.
 *
 * This is a pure, language-agnostic function over the (already noise-stripped)
 * unified diff. It computes a handful of size/spread/kind metrics and applies the
 * CONSERVATIVE gate in config.reviewRouting: a change stays `diff_only` only if it
 * is within every ceiling AND touches no exported/public contract; anything else
 * (and any ambiguity) routes to `worktree`. The user can override the decision per
 * run (see RequestedReviewMode); a forced mode bypasses the gate but the metrics
 * are still recorded for audit.
 *
 * Why custom and not a library: no mature LANGUAGE-AGNOSTIC complexity tool exists
 * on npm (the AST-based ones are JS/TS-only; the real complexity binaries are
 * Go/Python). Operating on the diff text keeps this polyglot and dependency-free —
 * it reuses the diff splitter the post-review path already owns.
 */
import type { RequestedReviewMode, ReviewMode, ReviewRouteReason } from '@pierre-review/shared';
import { config } from '../config.js';
import { splitDiffByFile } from './post-review.js';

// ---- Contract-touch detection (the load-bearing "needs broad context" signal) ----

// Path shapes that ARE an interface/contract definition: editing one is very likely
// a cross-cutting change whose consumers live outside the diff. Language-agnostic
// (matched on the path, not the contents). Kept tight on purpose — broad matches
// (e.g. every file under `routes/`) would over-route too much to be useful.
export const API_PATH_PATTERNS: RegExp[] = [
  /\.(proto|thrift|graphql|gql)$/i, // IDL / schema definition languages
  /\.d\.ts$/i, // TypeScript ambient/type declarations (public type surface)
  /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i, // OpenAPI / Swagger specs
  /(^|\/)migrations?\//i, // DB schema migrations (a stored contract)
];

// Markers that, on a REMOVED or MODIFIED diff line, indicate a change to an
// exported/public symbol (a signature/removal — the risky case; a brand-new export
// is only an addition and is intentionally not flagged here). One small curated set
// across the mainstream languages; over-matching only over-routes (safe), and a
// missed exotic syntax is backstopped by the diff-only prompt's self-escalation.
export const EXPORT_MARKERS: RegExp[] = [
  /\bexport\b/, // JS/TS: export function/const/default/type, re-exports
  /\bmodule\.exports\b|\bexports\.\w/, // CommonJS
  /\bpub(\s+|\()/, // Rust: pub fn/struct/…, pub(crate)
  /\b(public|protected)\s+\w/, // Java/C#/Kotlin/Swift/PHP/TS class members
  /\bfunc\b\s*(\([^)]*\)\s*)?[A-Z]\w*\s*\(/, // Go: exported function OR method (capitalized name, optional receiver)
  /\b(type|const|var)\s+[A-Z]\w*/, // Go: exported type/const/var
  /\b__all__\b/, // Python: public-surface declaration
];

// NOTE (intentional limitation): for languages where members are PUBLIC BY DEFAULT
// with no export keyword (Python/Ruby/Kotlin/PHP top-level/plain C), a signature
// change has no cheap, precise marker — flagging every function edit would route
// essentially all changes in those languages to worktree and defeat diff-only. Those
// rely on the size/spread ceilings plus the diff-only prompt's self-escalation.

function lineTouchesApi(content: string): boolean {
  return EXPORT_MARKERS.some((re) => re.test(content));
}

function pathTouchesApi(path: string): boolean {
  return API_PATH_PATTERNS.some((re) => re.test(path));
}

// ---- Per-file diff analysis ----

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  // A brand-new file (`new file mode` / old side is /dev/null) — purely additive.
  isNew: boolean;
  // A modified/removed exported-or-public symbol, or a contract-definition path.
  apiTouch: boolean;
}

// Walk one noise-stripped unified diff into per-file change metrics. Header lines
// (diff/index/---/+++/@@/mode/rename/binary) are skipped; only real body `+`/`-`
// lines count toward additions/deletions.
export function analyzeDiff(diff: string): FileChange[] {
  const out: FileChange[] = [];
  for (const seg of splitDiffByFile(diff)) {
    let additions = 0;
    let deletions = 0;
    let isNew = false;
    let apiTouch = pathTouchesApi(seg.path);
    // The `--- `/`+++ ` FILE headers only appear BEFORE the first `@@` hunk. Once in
    // the hunk body, every `+`/`-` line is real content — including one whose source
    // text begins with `-- `/`++ ` (e.g. a SQL/Lua comment), which a naive per-line
    // prefix match would mis-skip as a header and undercount. Track hunk state so we
    // never miscount (mirrors buildAnchorIndex's per-hunk gating in post-review.ts).
    let inHunk = false;
    for (const line of seg.text.split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        // Pre-hunk metadata (diff/index/mode/rename + the two file headers). A new
        // file is marked by `new file mode` or an old side of `/dev/null`.
        if (
          line.startsWith('new file mode') ||
          (line.startsWith('--- ') && line.slice(4).trim() === '/dev/null')
        ) {
          isNew = true;
        }
        continue;
      }
      // Hunk body: the first char is the change marker (`+`/`-`/` `/`\`).
      const marker = line[0];
      if (marker === '+') {
        additions += 1;
      } else if (marker === '-') {
        deletions += 1;
        if (!apiTouch && lineTouchesApi(line.slice(1))) apiTouch = true;
      }
      // ' ' context and '\ No newline at end of file' advance nothing.
    }
    out.push({ path: seg.path, additions, deletions, isNew, apiTouch });
  }
  return out;
}

/** Directory of a path (`a/b/c.ts` → `a/b`; `c.ts` → `.`). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

/** Top-level subsystem of a path (`a/b/c.ts` → `a`; `c.ts` → `c.ts`). */
function subsystemOf(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? path : path.slice(0, i);
}

export interface ReviewDecision {
  mode: ReviewMode;
  reason: ReviewRouteReason;
}

export interface RoutingThresholds {
  maxFiles: number;
  maxLines: number;
  maxDirs: number;
  maxSubsystems: number;
}

/**
 * Decide the review mode for a PR from its noise-stripped diff.
 *
 *  - A forced `requested` mode ('diff_only' | 'worktree') is honoured as-is (the
 *    metrics are still computed + recorded; decidedBy = 'user').
 *  - 'auto' runs the gate: nothing textual to review → 'skip'; within every ceiling
 *    and no API touch → 'diff_only'; otherwise → 'worktree'. Ties favour 'worktree'.
 */
export function decideReviewMode(input: {
  diff: string;
  requested: RequestedReviewMode;
  thresholds?: RoutingThresholds;
}): ReviewDecision {
  const t = input.thresholds ?? config.reviewRouting;
  const files = analyzeDiff(input.diff);

  const changedFiles = files.length;
  const linesChanged = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const dirsTouched = new Set(files.map((f) => dirOf(f.path))).size;
  const subsystems = new Set(files.map((f) => subsystemOf(f.path))).size;
  const apiTouch = files.some((f) => f.apiTouch);
  const allFilesNew = changedFiles > 0 && files.every((f) => f.isNew);
  const modifyingFraction =
    linesChanged > 0 ? Math.round((totalDeletions / linesChanged) * 100) / 100 : 0;

  const metrics = {
    changedFiles,
    linesChanged,
    dirsTouched,
    subsystems,
    apiTouch,
    modifyingFraction,
    allFilesNew,
  };

  // Forced overrides bypass the gate (metrics still recorded for audit).
  if (input.requested === 'diff_only') {
    return {
      mode: 'diff_only',
      reason: { ...metrics, requested: input.requested, decidedBy: 'user', trippedBy: null },
    };
  }
  if (input.requested === 'worktree') {
    return {
      mode: 'worktree',
      reason: { ...metrics, requested: input.requested, decidedBy: 'user', trippedBy: null },
    };
  }

  // requested === 'auto' → the router decides.
  // No textual changes (empty after noise-strip, binary-only, or rename/mode-only)
  // → nothing substantive to review; skip without spending an agent turn.
  if (linesChanged === 0) {
    return {
      mode: 'skip',
      reason: { ...metrics, requested: 'auto', decidedBy: 'router', trippedBy: null },
    };
  }

  // The conservative gate: stay diff_only only if within EVERY ceiling and the
  // change touches no exported/public contract. The first ceiling tripped is
  // recorded so misroutes can be diagnosed.
  let trippedBy: string | null = null;
  if (changedFiles > t.maxFiles) trippedBy = 'files';
  else if (linesChanged > t.maxLines) trippedBy = 'lines';
  else if (dirsTouched > t.maxDirs) trippedBy = 'dirs';
  else if (subsystems > t.maxSubsystems) trippedBy = 'subsystems';
  else if (apiTouch) trippedBy = 'apiTouch';

  return {
    mode: trippedBy ? 'worktree' : 'diff_only',
    reason: { ...metrics, requested: 'auto', decidedBy: 'router', trippedBy },
  };
}

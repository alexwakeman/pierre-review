import type { BlastSurface } from '@pierre-review/shared';
import type { ReviewFileMetric } from '../platform/contract.js';
import { isTestFile, surfacesForPath } from '../db/blast-radius.js';
import { isNonCodeFile } from '../db/code-loc.js';
import { splitDiffByFile } from '../github/diff-anchor.js';

// Impact-ranked diff cap — ONLY for Claude Review's `prepareReview` (and so its chat).
//
// `capDiff` keeps whole files greedily in DIFF order (alphabetical on GitHub), so on a big PR
// which files the reviewer sees was effectively alphabetical: a late `migrations/` file could be
// dropped while early, low-impact files were kept. This picks the files to KEEP by impact rank,
// then EMITS them in their original diff order, so the only thing that changes is WHICH files are
// included. Under budget it returns the diff unchanged (prompt byte-identical).
//
// ⚠ This is NOT the reverted review plan (docs/CLAUDE-REVIEW.md § Measuring reviews): no file
// order, no plan section, no per-file report. And it does not make reviews deterministic.
// ⚠ No new path classifier (docs/BLAST-RADIUS.md): the score reads only `surfacesForPath`,
// `isTestFile`, `isNonCodeFile` and the per-file metrics `analyzeDiff` already computed.

// Contract surfaces whose consumers live outside the diff. `ci` and `deps` are deliberately NOT
// here (BlastSurface: ci is medium only, deps is narration only).
const CONTRACT_SURFACES: ReadonlySet<BlastSurface> = new Set<BlastSurface>([
  'db_migration',
  'db_schema',
  'sql',
  'public_types',
  'idl',
  'openapi',
  'infra',
  'auth',
]);

// Lower tier = higher impact.
//   0 contract file (whatever its size) · 1 code · 2 test · 3 non-contract non-code
export function impactTier(path: string): number {
  if (surfacesForPath(path).some((s) => CONTRACT_SURFACES.has(s))) return 0;
  if (isTestFile(path)) return 2;
  if (isNonCodeFile(path)) return 3;
  return 1;
}

interface Ranked {
  index: number;
  path: string;
  tier: number;
  apiTouch: boolean;
  churn: number;
}

// Total order: tier, then API-touching first, then more changed lines first, then path. Ties
// break on path (then diff index), so the same diff always gives the same selection.
export function rankFiles(paths: string[], metrics: ReviewFileMetric[]): number[] {
  const byPath = new Map(metrics.map((m) => [m.path, m]));
  const rows: Ranked[] = paths.map((path, index) => {
    const m = byPath.get(path);
    return {
      index,
      path,
      tier: impactTier(path),
      apiTouch: m?.apiTouch ?? false,
      churn: m ? m.additions + m.deletions : 0,
    };
  });
  rows.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.apiTouch) - Number(a.apiTouch) ||
      b.churn - a.churn ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.index - b.index,
  );
  return rows.map((r) => r.index);
}

// Same shape as `capDiff`. Walks files in RANK order, keeping each that fits the budget and
// skipping each that does not. ⚠ The one-huge-file case: `capDiff` always keeps the FIRST file it
// considers; here that would let one oversized top-ranked file (a generated schema dump) use the
// whole budget and push out everything else. So an oversized file is skipped like any other, and
// the top-ranked file is kept alone ONLY when nothing fits at all (a single huge file still gets
// reviewed). `omittedFiles` stays in diff order.
export function capDiffRanked(
  diff: string,
  maxChars: number,
  metrics: ReviewFileMetric[],
): { diff: string; capped: boolean; omittedFiles: string[]; totalBytes: number } {
  const totalBytes = diff.length;
  if (totalBytes <= maxChars) {
    return { diff, capped: false, omittedFiles: [], totalBytes };
  }
  const segs = splitDiffByFile(diff);
  const order = rankFiles(
    segs.map((s) => s.path),
    metrics,
  );
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    const cost = segs[i]!.text.length + 1; // +1 for the '\n' join
    if (used + cost <= maxChars) {
      keep.add(i);
      used += cost;
    }
  }
  if (keep.size === 0 && order.length > 0) keep.add(order[0]!);
  const kept: string[] = [];
  const omittedFiles: string[] = [];
  segs.forEach((seg, i) => {
    if (keep.has(i)) kept.push(seg.text);
    else omittedFiles.push(seg.path);
  });
  return {
    diff: kept.join('\n'),
    capped: omittedFiles.length > 0,
    omittedFiles,
    totalBytes,
  };
}

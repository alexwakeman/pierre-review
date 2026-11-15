// THE CRITERIA MAP'S LAYOUT — the pure half of components/Activity/CriteriaMap.tsx (test/criteriaMap.test.ts).
// The fold itself (which criterion each card line names) is shared `criteriaMap`; this file only
// places what it returns.
import type { CriteriaMap, CriteriaMapPr } from '@pierre-review/shared';

/** The container width (px) from which the map is drawn as two columns joined by lines; under it,
 *  a stacked list (each criterion names its pull requests in words). */
export const CRITERIA_MAP_TWO_COLUMN_MIN_PX = 560;

/**
 * The pull requests in drawing order: each at the mean position of the criteria it links to, so lines
 * cross less; a PR with no link keeps the check's order after the linked ones, and a PR with no current
 * description goes last. Stable. Pure.
 */
export function orderMapPrs(map: CriteriaMap): CriteriaMapPr[] {
  const mean = new Map<number, number>();
  const sum = new Map<number, { total: number; n: number }>();
  map.rows.forEach((r, i) => {
    for (const l of r.links) {
      const s = sum.get(l.prId) ?? { total: 0, n: 0 };
      s.total += i;
      s.n += 1;
      sum.set(l.prId, s);
    }
  });
  for (const [id, s] of sum) mean.set(id, s.total / s.n);
  const rank = (p: CriteriaMapPr): number => (!p.hasCard ? 2 : mean.has(p.prId) ? 0 : 1);
  return map.prs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || (mean.get(a.p.prId) ?? 0) - (mean.get(b.p.prId) ?? 0) || a.i - b.i)
    .map((x) => x.p);
}

/** Where the k-th of n lines enters a box `top..top+height` (spread over its middle half). */
export function entryY(top: number, height: number, k: number, n: number): number {
  if (n <= 1) return top + height / 2;
  const span = height / 2;
  return top + height / 4 + (span * k) / (n - 1);
}

/** A smooth line from (x1, y1) to (x2, y2), leaving and entering horizontally. */
export function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(12, (x2 - x1) / 2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${r(x1)} ${r(y1)} C ${r(x1 + dx)} ${r(y1)}, ${r(x2 - dx)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

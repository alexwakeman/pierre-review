import type { BotVolumeSizeBucketStat } from '@pierre-review/shared';

// Series selection for the Behaviour tab's "PR size vs bot comment volume" card (CORE, free,
// deterministic — no severity-api, no AI, nothing feeding `botVerdict`).
//
// The card draws the SERVER's five size-bucket means from `/api/bot-analytics/volume/scatter`
// (`BotVolumeSizeBucketStat`). Like `botVolume.ts`, NOTHING HERE COMPUTES A NUMBER: the averages,
// the densities and the per-bucket PR counts all arrive folded from the one merged-PR scan that
// also feeds the ROI column and its drill-down, precisely so the three surfaces cannot disagree.
// These functions only decide which buckets are DRAWABLE and how an existing number reads.
//
// ⚠ THE ONE DISTINCTION THIS FILE EXISTS FOR: `prs: 0` and `avgComments: 0` are different findings
// that draw IDENTICALLY. BarChart skips any value ≤ 0, so an empty bucket ("no merged PR of this
// size in this window") and a real zero ("3 PRs of this size merged and the bots said nothing")
// both render as blank space — and the second is a genuine, interesting measurement. Measured
// live on this dev corpus, workspace 7 has BOTH at once in one window: `200–600` is `prs: 3,
// avgComments: 0` while `600–2k` and `2k+` are `prs: 0, avgComments: null`. So the empty buckets
// are lifted OUT of the drawn series and named in a disclosure line, leaving every band that is
// still on the axis a band with real PRs behind it.
//
// ⚠ THE BUCKET EDGES ARE NEVER RE-SPELLED HERE. `label`, `minLoc` and `maxLoc` ride the wire from
// the ONE runtime table (backend `db/bot-volume.ts` `SIZE_BUCKETS`); this file sorts on `minLoc`
// rather than on a hardcoded `['xs','s','m','l','xl']` order so a change to that table cannot
// leave the SPA drawing the buckets in an order the backend no longer uses.

/** One drawable band: a size bucket with at least one sized merged PR behind it. */
export interface SizeBucketRow {
  /** The wire's own label ('<50', '50–200', …) — the x-axis tick, never re-derived from the edges. */
  label: string;
  /** Sized merged PRs in this bucket. Always ≥ 1 (that is what makes the row drawable). */
  prs: number;
  /**
   * Mean bot comments per merged PR of this size. Typed nullable even though the wire contract
   * says a bucket with `prs > 0` always carries one: a violated contract must render as a GAP,
   * not as a fabricated 0, which would read as "the bots ignore PRs this size".
   */
  avg: number | null;
  /** Bot comments per 100 lines, aggregated over the whole bucket — the sublinearity readout. */
  density: number | null;
}

export interface SizeBucketSeries {
  /** Drawable bands, ascending by size. */
  rows: SizeBucketRow[];
  /**
   * Labels of the buckets that had NO merged PR of that size in the window, in size order.
   *
   * ⚠ DISCLOSED, NEVER SILENTLY DROPPED. Dropping `600–2k` and `2k+` from the axis without saying
   * so leaves a reader looking at a three-band chart with no way to tell "nobody opened a big PR
   * this month" from "big PRs are not measured here".
   */
  emptyLabels: string[];
  /**
   * Did ANY drawn bucket record a bot comment? A boolean gate, not a displayed figure — the card
   * shows an explicit empty state rather than five flat bands when the answer is no (which is the
   * honest reading of a workspace whose bots are silent on everything that merged).
   */
  hasComments: boolean;
}

/**
 * Split the wire's DENSE five-bucket array into the bands worth drawing and the ones worth naming.
 *
 * The input is dense by contract (every bucket present even at `prs: 0`) so that a gap in the
 * curve is a gap in the DATA; this turns that density into the two things a chart needs — a series
 * with no phantom bands, and an explicit list of what was left off.
 */
export function sizeBucketSeries(buckets: BotVolumeSizeBucketStat[]): SizeBucketSeries {
  const ordered = [...buckets].sort((a, b) => a.minLoc - b.minLoc);
  const rows: SizeBucketRow[] = [];
  const emptyLabels: string[] = [];
  let hasComments = false;
  for (const b of ordered) {
    if (b.prs <= 0) {
      emptyLabels.push(b.label);
      continue;
    }
    if (b.comments > 0) hasComments = true;
    rows.push({ label: b.label, prs: b.prs, avg: b.avgComments, density: b.commentsPer100Loc });
  }
  return { rows, emptyLabels, hasComments };
}

/**
 * A bucket mean as the bar tooltip prints it: one decimal.
 *
 * The two ends are the interesting ones and both must survive `toFixed`: an exact 0 is a REAL
 * measurement ("PRs this size merged and drew nothing") and prints as "0", while anything under
 * 0.05 prints "<0.1" rather than rounding to "0.0" and impersonating that zero. Same rule, and the
 * same reason, as `botVolume.ts`'s `formatAvg`.
 */
export function formatBucketAvg(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  if (v > 0 && v < 0.05) return '<0.1';
  return v.toFixed(1);
}

/**
 * A per-100-lines density as the tooltip prints it.
 *
 * Precision SHRINKS with magnitude because this series spans two orders of magnitude inside one
 * chart — measured on erxes over 90d it runs 30.56 on the smallest bucket to 0.27 on the largest.
 * At a fixed 1dp the top of that range reads as false precision and the bottom collapses to "0.3"
 * for everything below half a comment per 100 lines; at a fixed 2dp the top reads "30.56", a
 * precision a mean over ~100 PRs does not have.
 */
export function formatBucketDensity(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  if (v > 0 && v < 0.01) return '<0.01';
  if (v < 1) return v.toFixed(2);
  if (v < 10) return v.toFixed(1);
  return String(Math.round(v));
}

/**
 * "116 PRs" / "1 PR" — the per-bucket count that has to be legible beside every mean.
 *
 * Not cosmetic: on this corpus one workspace's `<50` bucket holds 268 of its 283 sized merged PRs,
 * so four of the five bars are means over a handful of PRs sitting at the same visual weight as a
 * mean over 268. Without the counts the chart reads as five equally-supported findings.
 */
export function bucketPrCount(prs: number): string {
  return `${prs.toLocaleString()} PR${prs === 1 ? '' : 's'}`;
}

/**
 * The unsized-PR disclosure, or null when every merged PR in scope had an observed size.
 *
 * ⚠ MUST BE RENDERED WHEN NON-NULL. Under lean storage a PR whose detail never hydrated has all
 * three size columns at 0, which the server reads as "size unknown" and drops from `points` and
 * from every bucket (135 of mrdoob/three.js's 796 merged PRs, measured). Undisclosed, the eye
 * reads the remaining corpus as the whole one.
 */
export function unsizedNote(sizedPrs: number, unsizedPrs: number): string | null {
  if (unsizedPrs <= 0) return null;
  const total = sizedPrs + unsizedPrs;
  return `${unsizedPrs.toLocaleString()} of ${total.toLocaleString()} merged PRs had no recorded size and are excluded from every bucket.`;
}

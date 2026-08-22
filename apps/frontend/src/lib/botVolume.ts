import type {
  BotVolumeBaselineKind,
  BotVolumeBot,
  BotVolumePrRow,
  BotVolumePrSort,
} from '@pierre-review/shared';

// Pure formatting + lookup helpers for the bot-comment-VOLUME surfaces (the ROI table's
// "avg bot comments per PR" column and its PR drill-down). CORE/free, no AI.
//
// ⚠ NOTHING HERE COMPUTES A NUMBER. Every count, average, expectation and ratio arrives from
// `/api/bot-analytics/volume*`, which folds the column, the list and the chart from ONE scan
// precisely so they cannot disagree — a client-side re-derivation would be a second opinion about
// the same window, which is the failure this whole surface was specced against. These functions
// only decide how an existing number READS, and each one exists because the obvious rendering of
// its input is a lie:
//   • an average of 0.04 must not print as "0.0" (it would read as "this bot says nothing");
//   • a null `loc` is "we never observed this PR's size", NOT zero LOC;
//   • a null `ratio` is "no baseline", NOT 1.0× and NOT 0×.

/**
 * Index a volume response's bots by their `u<userId>` key — the SAME key spelling
 * `BotVendorAnalytics.key` uses, which is what lets the ROI table join this onto the row it
 * already renders.
 *
 * ⚠ A BOT WITH NO COMMENTS IN THE WINDOW IS ABSENT FROM THE RESPONSE (unlike the ROI table's
 * dormant rows, which survive on their 12-week trend). So a miss here means "this bot said nothing
 * in this window", and the cell must render a DASH, never a 0 — the ROI table dashes every other
 * dormant metric for exactly that reason.
 */
export function volumeByKey(bots: BotVolumeBot[] | undefined): Map<string, BotVolumeBot> {
  return new Map((bots ?? []).map((b) => [b.key, b]));
}

/**
 * A per-PR average, as the column prints it.
 *
 * ONE decimal place: the wire carries 2dp, but a table cell reading "16.89" invites a precision
 * this number does not have (it moves with every merge). The interesting cases are the ends:
 *   • exactly 0 → "0" (a real, flat answer: this bot commented on PRs but said nothing here —
 *     unreachable today, since a bot with no comments is omitted entirely, but it must not print
 *     as an empty cell if it ever does);
 *   • 0 < v < 0.05 → "<0.1", because `toFixed(1)` would round it to "0.0" and the reader cannot
 *     tell that apart from silence. Measured: mrdoob/three.js's per-scope-PR averages sit near
 *     this floor precisely because 656 of its 796 merged PRs drew nothing.
 * `null` (no denominator — the bot commented on nothing, or the scope has no merged PRs) is the
 * caller's dash, not a zero.
 */
export function formatAvg(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  if (v > 0 && v < 0.05) return '<0.1';
  return v.toFixed(1);
}

/**
 * The bucket-relative multiplier, as the drill-down prints it. `null` ⇔ there is no baseline —
 * rendered as words, NEVER as "1.0×" (which claims the PR is exactly average) and never as "0×"
 * (which claims the bots ignored it). The two are different findings and the distinction is
 * load-bearing: a null arrives when the PR's size was never observed, or when its repo has too few
 * merged PRs in the window for any average to mean anything.
 */
export function formatRatio(ratio: number | null, baseline?: BotVolumeBaselineKind): string {
  // ⚠ TWO DIFFERENT REASONS FOR A NULL RATIO, and "no baseline" is only one of them. A
  // `low_expectation` row HAS a baseline — a well-sampled one — it is just too near zero to
  // divide by, and telling the reader "no baseline" would send them looking for missing data
  // that is in fact present and on screen beside this cell.
  if (ratio == null) return baseline === 'low_expectation' ? 'too quiet' : 'no baseline';
  return `${ratio.toFixed(1)}×`;
}

/** The server's BASELINE_MIN_EXPECTED, mirrored for COPY ONLY — never for a client-side decision.
 *  Every suppression is the server's (`baseline: 'low_expectation'`); this number only lets the
 *  caption say which floor was applied. */
export const LOW_EXPECTATION_FLOOR = 3;

/** `additions + deletions`, or a dash when the size was never observed. ⚠ NEVER "0" — under lean
 *  storage an unhydrated PR is indistinguishable from a genuinely empty one, so the server sends
 *  null rather than fabricating a zero that would drop the PR into the `xs` bucket. */
export function formatLoc(loc: number | null): string {
  return loc == null ? '—' : loc.toLocaleString();
}

/**
 * What the ratio was compared AGAINST, in words — the caption that must sit beside every
 * multiplier.
 *
 * ⚠ `'repo'` MUST NOT SAY "PRs this size". It is the fallback taken when the PR's own size bucket
 * held fewer PRs than the small-sample floor, so the repo's whole merged population stood in — a
 * comparison that is NOT size-conditioned. Captioning it as if it were would turn "this repo's
 * PRs average 4 comments" into a false claim about PRs of this size.
 */
export function baselineCaption(baseline: BotVolumeBaselineKind, baselinePrs: number): string {
  switch (baseline) {
    case 'bucket':
      return `vs PRs this size in this repo (${baselinePrs.toLocaleString()} merged)`;
    case 'repo':
      // Says "NOT matched on size" in as many words. Naming the size bucket at all — even to
      // explain why it was skipped — leaves a caption a skimming reader parses as the comparison
      // that was actually made, which is the one thing this arm is not.
      return `vs this repo's overall average across ${baselinePrs.toLocaleString()} merged PRs — NOT matched on size, because too few comparable PRs merged in this window`;
    case 'low_expectation':
      // A DIFFERENT FACT FROM 'none', and the caption must not blur them. There were plenty of
      // comparable PRs; they simply average near zero, so a multiplier here would amplify noise
      // rather than measure anything. Name the expectation so the reader can judge it themselves.
      return `Too quiet to compare: PRs this size in this repo average under ${LOW_EXPECTATION_FLOOR} bot comments (${baselinePrs.toLocaleString()} merged). A multiplier off an expectation that small reports chance, not a finding.`;
    case 'none':
      return 'No baseline: this PR’s size was never observed, or the repo has too few merged PRs in this window.';
  }
}

/**
 * The full "N× · expected E over B PRs" line.
 *
 * ⚠ `expected` AND `baselinePrs` RIDE WITH THE MULTIPLIER, never behind a tooltip. A near-zero
 * expectation inflates the ratio without inflating the finding: measured on this corpus,
 * bevyengine/bevy #24971 reads 42.9× off 3 bot comments against an expectation of 0.07 (over 61
 * PRs), while erxes #7802's 3.7× is 25 comments against 6.80. Both multipliers are arithmetically
 * right; only one is a PR worth opening, and only the surrounding numbers say which.
 */
export function ratioDetail(row: BotVolumePrRow): string | null {
  // ⚠ GATED ON `expected`, NOT ON `ratio`. A `low_expectation` row has no multiplier but DOES
  // have a well-sampled expectation, and that expectation is the whole explanation for why the
  // multiplier is missing — withholding it would leave "too quiet" looking like missing data
  // instead of the measured fact it is.
  if (row.expected == null) return null;
  return `expected ${row.expected.toFixed(1)} over ${row.baselinePrs.toLocaleString()} PRs`;
}

/**
 * The colour band for a multiplier. Deliberately blunt (three bands, wide thresholds): this is an
 * ADVISORY reading of a mean that can itself be tiny, so a fine-grained scale would dress noise up
 * as precision. Null (no baseline) is muted — the absence of a comparison is not a low score.
 */
export function ratioTone(ratio: number | null): string {
  if (ratio == null) return 'text-gray-400';
  if (ratio >= 3) return 'text-red-600 dark:text-red-400';
  if (ratio >= 1.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-500 dark:text-gray-400';
}

/**
 * The two sort orders, named and explained on screen.
 *
 * ⚠ THE SECOND ONE EXISTS BECAUSE THE FIRST MOSTLY RANKS BY SIZE, and that has to be discoverable
 * or the screen has quietly shipped a size ranking. Measured on this corpus: log10(LOC+1) against
 * bot-comment count correlates 0.615 (go-redis) / 0.539 (erxes), and comments per 100 LOC FALL
 * monotonically across the size buckets (erxes 57.65 → 8.99 → 4.46 → 2.23 → 0.83), i.e. size is
 * sublinear in comments. The PR that proves it: erxes #7802 is 17 LOC across 1 file and drew 25
 * bot comments — 3.68× its bucket's expectation — yet ranks 123rd of 686 under "most comments"
 * and 8th under "most vs expected".
 */
export const VOLUME_SORTS: { key: BotVolumePrSort; label: string; help: string }[] = [
  {
    key: 'comments',
    label: 'Most comments',
    help: 'The raw number of bot comments on the PR. Mostly ranks by size — big PRs draw more comments.',
  },
  {
    key: 'ratio',
    label: 'Most vs expected',
    help: 'How far above this repo’s usual for a PR of this size. Surfaces the small PR a bot tore apart, which the raw count buries.',
  },
];

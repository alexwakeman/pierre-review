import type { BotVendorComment, MlSeverity } from '@pierre-review/shared';

// The pure filter/sort layer behind the bot drill-down's COMMENTS view — "everything one bot said
// in the window", narrowed by severity and by whether the bot's own badge contradicts ours.
//
// It lives here rather than inline in BotPrsDetail.tsx because every rule below has a wrong
// version that compiles and renders a plausible list:
//   • a summary or a praise row counted as a `major` finding (the phantom-severity trap the
//     backend rollups spell out in db/ml-labels.ts)
//   • "the vendor disagrees" evaluated against a null vendor claim, which is most rows
//   • an "oldest" sort that reverses ties the server had already ordered
// Each one gets a test in test/botComments.test.ts.
//
// ⚠ NOTHING HERE MAY DERIVE OUR SEVERITY FROM THE VENDOR'S. `MlLabel.vendorSeverity` is the bot's
// own claim and the LESS accurate of the two numbers on the object (0.474 exact vs our 0.700 on the
// adjudicated gold-300); it is displayed, and here it is FILTERED ON, but it never corrects,
// overrides or seeds `severity`.

/**
 * The five filter pills. `praise` is not a severity — it is the v2 non-finding CATEGORY (the bot
 * acknowledging a fix, withdrawing a concern, saying thanks), and it sits in the same row because
 * from the reader's side "show me only the praise" is the same kind of question as "show me only
 * the criticals".
 */
export type SeverityPillKey = MlSeverity | 'praise';

/** Worst-first, praise last — the order the pills render in. */
export const SEVERITY_PILLS: SeverityPillKey[] = ['critical', 'major', 'minor', 'nit', 'praise'];

export type CommentSort = 'newest' | 'oldest' | 'severity';

/**
 * Which pill a row belongs to, or `null` for a row no pill can select — unlabelled (not scored
 * yet, or a deployment with no scoring service) and plain summaries.
 *
 * ⚠ PRAISE IS TESTED BEFORE `isSummary`, which is the one place this deliberately differs from
 * the backend rollups (`getBotSeverityRollup` buckets a praise-flavoured walkthrough as a
 * SUMMARY). These are different jobs: a rollup must not double-count a row across two
 * mutually-exclusive buckets, whereas the Praise pill's promise to the reader is "show me the
 * rows where this bot was being nice" and a walkthrough that is pure praise is one of them.
 *
 * Everything else follows the rollup exactly: a summary's severity is NOT a finding's severity
 * (a walkthrough scored `major` outranking real findings is the worstSeverity trap), so a
 * summary matches no severity pill.
 */
export function pillOf(c: BotVendorComment): SeverityPillKey | null {
  const l = c.mlLabel;
  if (!l) return null;
  if (l.categories.includes('praise')) return 'praise';
  if (l.isSummary) return null;
  return l.severity;
}

/**
 * Whether the bot's own declared severity CONTRADICTS ours.
 *
 * ⚠ ONLY SEVERITY. Vendors declare no machine-readable category, so there is no category claim to
 * disagree with and none may be inferred — a row where we say `security` and the vendor's prose
 * mentions performance is not a disagreement, it is us reading and them not saying.
 *
 * A null claim is not a disagreement: `vendorSeverity` is null both when the bot declared nothing
 * (the common case) and when the deployed severity-api is too old to report it, and neither is
 * evidence of anything.
 */
export function vendorDisagrees(c: BotVendorComment): boolean {
  const l = c.mlLabel;
  return l != null && l.vendorSeverity != null && l.vendorSeverity !== l.severity;
}

export interface CommentFacetCounts {
  /** Per-pill row counts. Every key is present, zero included. */
  counts: Record<SeverityPillKey, number>;
  /** Rows where the vendor's own badge contradicts ours. */
  disagreements: number;
  /** Rows carrying any ML label at all — what decides whether the filter row is worth drawing. */
  labelled: number;
}

const emptyCounts = (): Record<SeverityPillKey, number> => ({
  critical: 0,
  major: 0,
  minor: 0,
  nit: 0,
  praise: 0,
});

/**
 * Facet counts over the FULL fetched list — deliberately pre-filter, like ThreadList's state pills
 * and the feed's whole-stream counts, so a pill's badge doesn't drop to 0 the moment another pill
 * is pressed and leave the reader unable to see where else to go.
 */
export function commentFacetCounts(rows: readonly BotVendorComment[]): CommentFacetCounts {
  const counts = emptyCounts();
  let disagreements = 0;
  let labelled = 0;
  for (const c of rows) {
    if (c.mlLabel) labelled += 1;
    const pill = pillOf(c);
    if (pill) counts[pill] += 1;
    if (vendorDisagrees(c)) disagreements += 1;
  }
  return { counts, disagreements, labelled };
}

export interface CommentFilter {
  /** Empty = no severity narrowing (unlabelled rows and summaries stay visible). */
  severities: ReadonlySet<SeverityPillKey>;
  /** Keep only rows where the bot's own badge contradicts ours. ANDs with `severities`. */
  disagreesOnly: boolean;
}

/**
 * Apply the pills. Two rules that look arbitrary and are not:
 *
 *  • An EMPTY selection is "no filter", not "nothing matches" — the list opens showing everything,
 *    including the unlabelled and the summaries.
 *  • With ANY pill active, unlabelled rows and summaries DISAPPEAR. A severity filter is a claim
 *    about the model's judgement, and a row it never judged cannot satisfy or refute one; leaving
 *    them in would mean "Critical" quietly returned a page of unscored comments.
 */
export function filterComments(
  rows: readonly BotVendorComment[],
  filter: CommentFilter,
): BotVendorComment[] {
  const { severities, disagreesOnly } = filter;
  if (severities.size === 0 && !disagreesOnly) return [...rows];
  return rows.filter((c) => {
    if (severities.size > 0) {
      const pill = pillOf(c);
      if (pill == null || !severities.has(pill)) return false;
    }
    return disagreesOnly ? vendorDisagrees(c) : true;
  });
}

// ISO-8601 UTC strings compare correctly as strings, which is how every other createdAt ordering
// in this app is spelled. Returns the usual -1/0/1 on the ASCENDING axis.
const byCreatedAtAsc = (a: BotVendorComment, b: BotVendorComment): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/**
 * Sort a filtered list.
 *
 *  'newest'   — the server's own order, returned untouched. The route already answers
 *               newest-first; re-sorting it here would only add a way for the two to disagree.
 *  'oldest'   — a STABLE ascending sort, not `.reverse()`. Rows sharing a timestamp (a review
 *               body and its inline comments are posted in the same instant) keep the server's
 *               relative order in both directions rather than flipping between them.
 *  'severity' — worst first, with summaries and unscored rows SUNK to the bottom (a walkthrough
 *               scored `major` must not outrank real findings), newest breaking ties.
 */
export function sortComments(
  rows: readonly BotVendorComment[],
  sort: CommentSort,
): BotVendorComment[] {
  if (sort === 'newest') return [...rows];
  if (sort === 'oldest') return [...rows].sort(byCreatedAtAsc);
  const ord = (c: BotVendorComment): number =>
    c.mlLabel && !c.mlLabel.isSummary ? c.mlLabel.severityOrd : -1;
  return [...rows].sort((a, b) => ord(b) - ord(a) || -byCreatedAtAsc(a, b));
}

/** Filter then sort — the one call the component makes. */
export function selectComments(
  rows: readonly BotVendorComment[],
  filter: CommentFilter,
  sort: CommentSort,
): BotVendorComment[] {
  return sortComments(filterComments(rows, filter), sort);
}

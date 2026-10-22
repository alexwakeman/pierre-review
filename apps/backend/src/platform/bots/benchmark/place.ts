import type {
  BotBenchmarkMetric,
  BotBenchmarkPlacementRefusalReason,
} from '@pierre-review/shared';
import { isObject, type LoadedArtifactOk, type RawJson } from './artifact.js';
import { percentileOf } from './percentile.js';

// BAND PLACEMENT — putting the customer's own repository into the cohort's activity stratum, and
// REFUSING when it does not belong to one.
//
// Definitions: `packages/ml/docs/METRIC-CONTRACT.md` §4 and §5. Every case below is pinned by the
// golden fixture's generated `band_placement` block (122 cases across the seven vendors).

/** The 14-day window the cohort's activity axis is measured over (`frame_2026-02-05_14d`). */
export const ACTIVITY_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
export const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_DAYS * DAY_MS;

/** The corpus's per-repository pull-request cap. */
const PR_WALK_CAP = 150;

/**
 * The per-repository pull-request budget the walk enforced: the customer folds over the
 * `walkBudget` MOST-RECENTLY-UPDATED pull requests, not their whole history.
 *
 * ⚠ THIS IS THE ONE RULE IN THE CONTRACT THAT IS A FIDELITY CHOICE RATHER THAN A DEFINITION, and
 * the most likely thing in it to be wrong. It is here because the alternative — no cap — is
 * CERTAINLY wrong in a known direction: a customer folding over years of history measures older
 * threads, so higher overdue rates and lower reply rates than any cell describes. On the shipped
 * corpus the cap actually bound in 85.5 % of live repositories in the median cell.
 *
 * MEASURED, not assumed: `min(150, round(p * 90 / 14))` reproduces `walk_budget` on all 2,204
 * corpus repository rows with zero mismatches; the two nearest factors (6.40, 6.475) miss 398 and
 * 541 rows.
 *
 * ⚠ Python's `round` is banker's rounding and JavaScript's `Math.round` is half-up, so they
 * disagree at exactly `.5`. They cannot disagree HERE: `p * 90 / 14 = p * 45 / 7` is a half-integer
 * only when `90p = 7m` for odd `m`, which forces `7 | p` and hence `m = 90(p/7)` — always even. The
 * argument is written down because "it works on the values we tried" is not the same claim.
 */
export function walkBudgetFor(mergedPrsPerPeriod: number): number {
  if (!Number.isFinite(mergedPrsPerPeriod) || mergedPrsPerPeriod <= 0) return 0;
  return Math.min(PR_WALK_CAP, Math.round((mergedPrsPerPeriod * 90) / 14));
}

/**
 * THE PLACEMENT RULE: the LOWEST index `b` whose published `panel_prs_per_period` HIGH edge is at
 * least the customer's value; when the value exceeds every high edge, the LAST band. **The LOW
 * EDGES ARE NEVER READ.**
 *
 * ⚠ "THE BAND WHOSE INTERVAL CONTAINS THE VALUE" IS NOT A FUNCTION. The ranges OVERLAP at ties
 * because the cut is by RANK over a list full of small integers — CodeRabbit's band 0 is `2..2` and
 * band 1 is `2..3`; Copilot's band 0 is `2..3` and band 1 is `3..4`. A value of 2 is inside two
 * intervals.
 *
 * WHY THE LOW EDGES LOSE THE TIE (proved, not asserted). The fitter places a repository that did
 * not define the cut by rank: `bands[bisect_left(keys, (value, repo))]` over the support units'
 * `(panel_prs_per_period, repo)` order. A customer is not in that order and ITS REPOSITORY NAME
 * MUST NOT DECIDE ITS COHORT, so its key is `(value, "")` — the empty string sorts below every
 * name, which is `bisect_left`'s own tie behaviour taken to its limit. `bisect_left` returns the
 * first index whose value is ≥ the customer's, whose band `b*` therefore satisfies
 * `value ≤ high(b*)`; every band below `b*` holds only strictly smaller values, so `high(b) < value`
 * there. `b* = min{b : value ≤ high(b)}` exactly. The high edges are monotone non-decreasing
 * because the cut is a rank cut over a sorted list, so the scan is well defined, and gaps between
 * bands resolve upward under BOTH readings — which is why only the tie case distinguishes them.
 *
 * The alternative reading — the LAST band whose LOW edge is ≤ the value — agrees everywhere except
 * at ties and disagrees on 2 and 3, the two most common activity values in the corpus.
 * `test/benchmark-metric-contract.test.ts` implements it and pins the disagreement, so the choice
 * cannot be quietly reversed.
 *
 * Below every low edge → band 0. Above every high edge → the last band. Both fall out with no
 * special case and match `_place_unbanded`'s own clamping, and NEITHER IS A REFUSAL: the bands span
 * the vendor's whole measured range and the outermost ones are open in the direction they face.
 */
export function bandForValue(value: number, highEdges: readonly number[]): number {
  if (highEdges.length === 0) {
    // A vendor with no bands forms no cell — refuse, never place. Reaching this is a caller bug:
    // `resolvePlacement` answers `vendor_unstratifiable` long before here.
    throw new Error('cannot place a value into a vendor with no published bands');
  }
  for (let b = 0; b < highEdges.length; b += 1) {
    if (value <= (highEdges[b] as number)) return b;
  }
  return highEdges.length - 1;
}

// ── Cohort resolution ───────────────────────────────────────────────────────────────────────────

export interface CohortBand {
  band: number;
  low: number;
  high: number;
  /** Support repositories in this band — the ones that DEFINED the cut. */
  repos: number;
}

export interface VendorBanding {
  vendor: string;
  nBands: number;
  reposBandSupport: number;
  /** Ascending by band. */
  bands: CohortBand[];
}

/** The vendor's bands, ascending, or `null` when the artifact publishes none for it. */
export function vendorBanding(loaded: LoadedArtifactOk, vendor: string): VendorBanding | null {
  return loaded.vendorBands.get(vendor) ?? null;
}

export interface PlacedCell {
  status: 'placed';
  band: number;
  nBands: number;
  /** ⚠ RIDES EVERY RENDERED PERCENTILE. "Upper fifth" is honest at 5 bands and a
   *  misrepresentation at 10, so the denominator travels with the rank. */
  bandLabel: string;
  bandRange: [number, number];
  /** Repositories the cut placed in this band. */
  cohortRepos: number;
  /** Set only when the customer's activity exceeds the top band's own high edge — a real caveat
   *  about the outermost band, readable off the published range. NOT a refusal. */
  aboveTopBandBy: number | null;
  cell: RawJson;
}

export interface RefusedPlacement {
  status: 'refused';
  reason: BotBenchmarkPlacementRefusalReason;
  message: string;
  /** R2 only: how far short the vendor fell, straight off the artifact's own refusal block. */
  observed?: Record<string, number>;
  required?: Record<string, number>;
}

export type PlacementResult = PlacedCell | RefusedPlacement;

/**
 * One `(vendor, activity)` pair → a cell, or one of the four structural refusals.
 *
 * ⚠ A REFUSAL IS A FIRST-CLASS OUTPUT, NOT A DEGRADED STATE, and the four arms are FOUR DIFFERENT
 * SENTENCES. Collapsing them gives every one of them the same unhelpful "no peer data":
 *
 *  * `vendor_not_in_corpus_vocabulary` — "we have never measured this bot". DeepSource is the live
 *    example: a real, popular product the corpus has never seen and plausibly a customer's biggest
 *    reviewer. *Refusal, not a pooled "AI reviewer" cohort*, because a cross-vendor headline is
 *    forbidden AT ANY n: an approval-only summariser and a line-by-line critic are not two samples
 *    of one population, and a pooled percentile is a number about no product that exists.
 *  * `vendor_unfittable` — the corpus's own catch-all strings (`in_house`, `unknown`, `''`). A
 *    vendor string that names no product; `in_house` alone is 959 repositories and 117,339
 *    review-bot comments in the shipped corpus, blending three unrelated reviewers plus everything
 *    fronted by `github-actions[bot]`.
 *  * `vendor_unstratifiable` — "we have too little of this bot". The corpus MEASURED it and then
 *    declined to cut it into two bands of thirty. *Refusal, not one giant band*, because one band
 *    is not a coarse stratification — it is the ABSENCE of one, published in a slot whose name
 *    promises a stratum.
 *  * `cell_not_in_corpus` — the vendor has cells; this band is not among them. *Refusal, not the
 *    nearest band*, because a neighbouring band answers a question about a DIFFERENT activity
 *    population without saying so.
 */
export function resolvePlacement(
  loaded: LoadedArtifactOk,
  vendor: string,
  activityValue: number,
): PlacementResult {
  const unfittable = loaded.unfittable.get(vendor);
  if (unfittable != null) {
    return {
      status: 'refused',
      reason: 'vendor_unfittable',
      message:
        'This reviewer resolves to a vendor string that names no product, so the corpus forms no ' +
        'cohort for it at any size — a cell keyed on it would pool unrelated reviewers.',
    };
  }
  const unstratifiable = loaded.unstratifiable.get(vendor);
  if (unstratifiable != null) {
    const refusal = isObject(unstratifiable['refusal']) ? unstratifiable['refusal'] : {};
    const message = typeof refusal['message'] === 'string' ? refusal['message'] : '';
    return {
      status: 'refused',
      reason: 'vendor_unstratifiable',
      message:
        message === ''
          ? 'The corpus measured this vendor but could not cut its repositories into strata, so ' +
            'there is no activity band to compare against.'
          : message,
      observed: numTally(refusal['observed']),
      required: numTally(refusal['required']),
    };
  }
  const banding = vendorBanding(loaded, vendor);
  const bands = loaded.cells.get(vendor);
  if (banding == null || banding.bands.length === 0 || bands == null) {
    return {
      status: 'refused',
      reason: 'vendor_not_in_corpus_vocabulary',
      message:
        'The corpus has never observed this reviewer. It may be a product the walk has not seen, ' +
        'or a name this build spells differently from the fitter.',
    };
  }
  const highs = banding.bands.map((b) => b.high);
  const band = bandForValue(activityValue, highs);
  const chosen = banding.bands[band] as CohortBand;
  const cell = bands.get(chosen.band);
  if (cell == null) {
    return {
      status: 'refused',
      reason: 'cell_not_in_corpus',
      message:
        'The corpus holds cells for this vendor, but none in this activity band — no repository ' +
        'running it landed in that stratum.',
    };
  }
  const top = banding.bands[banding.bands.length - 1] as CohortBand;
  return {
    status: 'placed',
    band: chosen.band,
    nBands: banding.nBands,
    bandLabel: `${chosen.band + 1} of ${banding.nBands}`,
    bandRange: [chosen.low, chosen.high],
    cohortRepos: chosen.repos,
    aboveTopBandBy:
      chosen.band === banding.bands.length - 1 && activityValue > top.high
        ? activityValue - top.high
        : null,
    cell,
  };
}

function numTally(v: unknown): Record<string, number> {
  if (!isObject(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number') out[k] = n;
  return out;
}

// ── Percentile against the placed cell ──────────────────────────────────────────────────────────

/** Where the customer's value sits in the cell's fitted distribution, 0-100 — or `null` when the
 *  cohort REFUSED this metric. ⚠ `null` is not 0 and not a plausible small number: reading a
 *  percentile off a refusal must yield nothing, and the discriminated union is what guarantees it. */
export function percentileIn(metric: BotBenchmarkMetric, value: number): number | null {
  return percentileOf(metric, value);
}

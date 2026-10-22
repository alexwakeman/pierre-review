import type {
  BotBenchmarkAbsentMetric,
  BotBenchmarkBand,
  BotBenchmarkVendorBands,
  BotBenchmarkCellFitted,
  BotBenchmarkCellKey,
  BotBenchmarkCellRefused,
  BotBenchmarkCohort,
  BotBenchmarkCoverage,
  BotBenchmarkDerivation,
  BotBenchmarkDirection,
  BotBenchmarkManifest,
  BotBenchmarkMetric,
  BotBenchmarkMetricSpec,
  BotBenchmarkRefusal,
  BotBenchmarkShape,
  BotBenchmarkStaleness,
  BotBenchmarkUnfittableVendor,
} from '@pierre-review/shared';
import { isObject, type LoadedArtifactOk, type RawJson } from './artifact.js';

// snake_case artifact → camelCase wire.
//
// ── THE ONE NAMING RULE, AND IT IS NOT "CAMELISE EVERYTHING" ────────────────────────────────────
// FIELD names camelise (house style). VOCABULARY TOKENS DO NOT — metric names (`acted_on_rate`),
// exclusion reasons (`vendor_silent`), refusal rules (`cell_floor`), population names, row kinds,
// band keys and vendor strings all reach the wire EXACTLY as the fitter spells them. They are
// data, not fields: `metric_specs`' keys and `cell.metrics`' keys must stay joinable, a metric's
// `excluded` tally must stay joinable to `exclusion_reasons`, and a metric is RENAMED rather than
// redefined in place — a projection that rewrote those names would put the wire and the fitter in
// two different vocabularies and make the next rename undetectable.
//
// ⚠ NEVER NORMALISE A REFUSAL INTO A DISTRIBUTION SHAPE. `_refusal()` in fit.py omits
// `n_repos`/`quantiles`/`grid` deliberately, so that reading a percentile off a refusal raises
// instead of returning a plausible small number. The discriminated union is the TypeScript
// equivalent, and this mapper is the single place it could be lost: emitting
// `{ quantiles: null, nRepos: 0 }` for a refused metric turns "we refuse to answer" into "the
// answer is low", and no test that only checks `status` would catch it.

const DIRECTIONS = new Set<string>(['higher_is_better', 'lower_is_better', 'neutral']);
const DERIVATIONS = new Set<string>(['code', 'model']);
const STALENESS = new Set<string>(['fresh', 'aging', 'stale', 'expired']);

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const direction = (v: unknown): BotBenchmarkDirection =>
  typeof v === 'string' && DIRECTIONS.has(v) ? (v as BotBenchmarkDirection) : 'neutral';
const derivation = (v: unknown): BotBenchmarkDerivation =>
  typeof v === 'string' && DERIVATIONS.has(v) ? (v as BotBenchmarkDerivation) : 'code';

/** A `{token: count}` tally. ⚠ Built with `Object.fromEntries`, which DEFINES own properties, so a
 *  `__proto__` key from a hostile file becomes an own property instead of moving the prototype. */
function numTally(v: unknown): Record<string, number> {
  if (!isObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'),
  );
}

function strTally(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function thresholds(v: unknown): { aging: number; stale: number; expired: number } {
  const o = isObject(v) ? v : {};
  return { aging: num(o['aging']), stale: num(o['stale']), expired: num(o['expired']) };
}

// ── metrics ─────────────────────────────────────────────────────────────────────────────────────

/** ⚠ THE GUARANTEE IS THAT THE SPA CAN ALWAYS RENDER A SENTENCE, so `message` is never allowed to
 *  come back empty — including on the degenerate path where a future artifact hands us a shape
 *  this build does not recognise and we fail closed into a refusal. */
function mapRefusal(v: unknown, fallbackMessage: string): BotBenchmarkRefusal {
  const o = isObject(v) ? v : {};
  const message = str(o['message']);
  return {
    rule: str(o['rule'], 'unknown'),
    message: message === '' ? fallbackMessage : message,
    observed: numTally(o['observed']),
    required: numTally(o['required']),
  };
}

function mapShape(v: unknown): BotBenchmarkShape {
  const o = isObject(v) ? v : {};
  return {
    n: num(o['n']),
    family: strOrNull(o['family']),
    familyReason: str(o['family_reason']),
    zeroShare: numOrNull(o['zero_share']),
    skew: numOrNull(o['skew']),
    excessKurtosis: numOrNull(o['excess_kurtosis']),
    iqrOverMedian: numOrNull(o['iqr_over_median']),
  };
}

function mapCiMedian95(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lo, hi] = v;
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  return [lo, hi];
}

export function mapMetric(raw: RawJson): BotBenchmarkMetric {
  const common = {
    derivation: derivation(raw['derivation']),
    population: str(raw['population']),
    excluded: numTally(raw['excluded']),
    reposConsidered: num(raw['repos_considered']),
  };
  // Anything that is not positively `fitted` — including a shape this build does not recognise —
  // is served as a refusal. Failing CLOSED here is the whole point: the alternative is emitting a
  // distribution-shaped object with missing knots.
  if (raw['status'] !== 'fitted' || !isObject(raw['grid'])) {
    return {
      ...common,
      status: 'refused',
      refusal: mapRefusal(
        raw['refusal'],
        'No distribution was emitted for this metric in this cohort.',
      ),
    };
  }
  const grid = raw['grid'];
  return {
    ...common,
    status: 'fitted',
    nRepos: num(raw['n_repos']),
    quantiles: numTally(raw['quantiles']),
    grid: { p: numArray(grid['p']), v: numArray(grid['v']) },
    mean: num(raw['mean']),
    sd: numOrNull(raw['sd']),
    min: num(raw['min']),
    max: num(raw['max']),
    ciMedian95: mapCiMedian95(raw['ci_median_95']),
    shape: mapShape(raw['shape']),
  };
}

// ── cells ───────────────────────────────────────────────────────────────────────────────────────

function mapCoverage(v: unknown): BotBenchmarkCoverage {
  const o = isObject(v) ? v : {};
  const observed = isObject(o['observed_at']) ? o['observed_at'] : null;
  return {
    // ⚠ An OPEN map, camelised key by key rather than a hand-listed struct: a new disclosure
    // counter in the fitter must reach the SPA without a mapper edit, because a counter the
    // artifact states and the wire drops is a silent under-disclosure.
    counts: Object.fromEntries(
      Object.entries(o)
        .filter((e): e is [string, number] => typeof e[1] === 'number')
        .map(([k, n]) => [camel(k), n]),
    ),
    observedAt:
      observed && typeof observed['min'] === 'string' && typeof observed['max'] === 'string'
        ? { min: observed['min'], max: observed['max'] }
        : null,
  };
}

function mapCohort(v: unknown, vendor: string, band: number): BotBenchmarkCohort {
  const o = isObject(v) ? v : {};
  const range = numArray(o['panel_prs_per_period']);
  return {
    vendor: str(o['vendor'], vendor),
    activityBand: num(o['activity_band'], band),
    pooledOver: Array.isArray(o['pooled_over']) ? strArray(o['pooled_over']) : null,
    widenedFrom: strOrNull(o['widened_from']),
    // ⚠ THE DENOMINATOR OF EVERY RENDERED PERCENTILE. Band counts are per vendor (10/10/9/7/4/3/2),
    // so "upper fifth" is honest at 5 bands and a misrepresentation at 10. Carried onto the wire
    // rather than left in the manifest for a caller to join back, because the join is exactly what
    // a renderer forgets.
    nBands: num(o['n_bands']),
    bandLabel: str(o['band_label']),
    panelPrsPerPeriod:
      range.length === 2 ? [range[0] as number, range[1] as number] : null,
    reposBandSupport: num(o['repos_band_support']),
  };
}

export function mapCell(
  raw: RawJson,
  vendor: string,
  band: number,
): BotBenchmarkCellFitted | BotBenchmarkCellRefused {
  const metricsRaw = isObject(raw['metrics']) ? raw['metrics'] : {};
  const metrics: Record<string, BotBenchmarkMetric> = Object.fromEntries(
    Object.entries(metricsRaw)
      .filter((e): e is [string, RawJson] => isObject(e[1]))
      // Metric NAMES are vocabulary — untouched, so `manifest.metricSpecs[i].name` and this key
      // are the same string.
      .map(([name, m]) => [name, mapMetric(m)]),
  );
  const present = {
    vendor: str(raw['vendor'], vendor),
    activityBand: num(raw['activity_band'], band),
    cohort: mapCohort(raw['cohort'], vendor, band),
    coverage: mapCoverage(raw['coverage']),
    metrics,
    metricsFitted: num(raw['metrics_fitted']),
    metricsRefused: num(raw['metrics_refused']),
    metricsTotal: num(raw['metrics_total']),
  };
  if (raw['status'] === 'fitted') return { ...present, status: 'fitted' };
  const refusal = isObject(raw['refusal']) ? raw['refusal'] : {};
  const message = str(refusal['message']);
  return {
    ...present,
    status: 'refused',
    refusal: {
      rule: str(refusal['rule'], 'cell_floor'),
      // Never empty — see mapRefusal: the SPA must always have a sentence to render.
      message:
        message === ''
          ? 'No metric in this cohort cleared the repository floor; see each metric for which rule dropped which repository.'
          : message,
    },
  };
}

// ── the manifest ────────────────────────────────────────────────────────────────────────────────

function mapMetricSpec(name: string, v: unknown): BotBenchmarkMetricSpec {
  const o = isObject(v) ? v : {};
  return {
    name,
    definition: str(o['definition']),
    numerator: str(o['numerator']),
    denominator: str(o['denominator']),
    population: str(o['population']),
    derivation: derivation(o['derivation']),
    direction: direction(o['direction']),
    minUnits: num(o['min_units']),
    unit: str(o['unit']),
  };
}

function mapAbsentMetric(v: unknown): BotBenchmarkAbsentMetric {
  const o = isObject(v) ? v : {};
  return {
    name: str(o['name']),
    definition: str(o['definition']),
    derivation: derivation(o['derivation']),
    direction: direction(o['direction']),
    unit: str(o['unit']),
    reason: str(o['reason']),
    note: str(o['note']),
    requires: strTally(o['requires']),
  };
}

export function mapUnfittableVendor(vendor: string, v: unknown): BotBenchmarkUnfittableVendor {
  const o = isObject(v) ? v : {};
  return {
    vendor,
    reason: str(o['reason'], 'unfittable'),
    repos: num(o['repos']),
    reviewBotComments: num(o['review_bot_comments']),
  };
}

/**
 * ⚠ PER VENDOR (fit v2), READ FROM THE LOADER'S ALREADY-PARSED MAP rather than re-walking the raw
 * object. Two parsers over one shape is where a band table and the placement that reads it drift
 * apart, and the placement is the half nobody would notice was wrong.
 *
 * A fit v1 artifact published ONE flat, vendor-agnostic table; the loader drops it (see
 * `readVendorBands`) and this returns `[]`. That is the honest degrade: a stratum cut over every
 * vendor at once is not the stratum any single vendor's cell describes, and placement refuses on it
 * rather than answering a question about a different population.
 */
function mapVendorBands(loaded: LoadedArtifactOk): BotBenchmarkVendorBands[] {
  const out: BotBenchmarkVendorBands[] = [];
  for (const [vendor, entry] of loaded.vendorBands) {
    out.push({
      vendor,
      nBands: entry.nBands,
      reposBandSupport: entry.reposBandSupport,
      bands: entry.bands.map((b) => ({
        band: b.band,
        panelPrsPerPeriod: [b.low, b.high] as [number, number],
        repos: b.repos,
      })),
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor));
}

function staleState(v: unknown): BotBenchmarkStaleness {
  return typeof v === 'string' && STALENESS.has(v) ? (v as BotBenchmarkStaleness) : 'expired';
}

/**
 * ⚠ STALENESS IS RECOMPUTED, NEVER COPIED. The stored `corpus_age_days`/`state` pair is as-of
 * `generated_at` and DECAYS ON DISK — the explicit inverse of the walk's frozen-age rule, and
 * fit.py says so on the artifact itself. Passing the stored value through ships a corpus that
 * reports "fresh" forever. It is one subtraction against `corpus.observed_at_max`, and it must
 * happen per request.
 */
function recomputeStaleness(
  raw: RawJson,
  nowMs: number,
): BotBenchmarkManifest['staleness'] {
  const stored = isObject(raw['staleness']) ? raw['staleness'] : {};
  const corpus = isObject(raw['corpus']) ? raw['corpus'] : {};
  const observedMax =
    strOrNull(corpus['observed_at_max']) ?? str(stored['corpus_observed_at_max']);
  const t = Date.parse(observedMax);
  const th = thresholds(stored['thresholds_days']);
  const ageDays = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 86_400_000) : Number.NaN;
  const state: BotBenchmarkStaleness = !Number.isFinite(ageDays)
    ? // An unparseable stamp is not "fresh". The corpus cannot vouch for its own age, so it takes
      // the worst class rather than the most flattering one.
      staleState(undefined)
    : ageDays >= th.expired
      ? 'expired'
      : ageDays >= th.stale
        ? 'stale'
        : ageDays >= th.aging
          ? 'aging'
          : 'fresh';
  return {
    asOf: new Date(nowMs).toISOString(),
    corpusObservedAtMax: observedMax,
    corpusAgeDays: Number.isFinite(ageDays) ? Math.round(ageDays * 1e6) / 1e6 : 0,
    state,
    thresholdsDays: th,
    note: str(stored['note']),
  };
}

export function mapManifest(loaded: LoadedArtifactOk, nowMs: number): BotBenchmarkManifest {
  const raw = loaded.raw;
  const corpus = isObject(raw['corpus']) ? raw['corpus'] : {};
  const scoring = isObject(raw['scoring']) ? raw['scoring'] : {};
  const params = isObject(raw['params']) ? raw['params'] : {};
  const axes = isObject(raw['cohort_axes']) ? raw['cohort_axes'] : {};
  const summary = isObject(raw['summary']) ? raw['summary'] : {};
  const specs = isObject(raw['metric_specs']) ? raw['metric_specs'] : {};

  const available: BotBenchmarkCellKey[] = [];
  for (const [vendor, bands] of loaded.cells) {
    for (const [band, cell] of bands) {
      available.push({
        vendor,
        band,
        status: cell['status'] === 'fitted' ? 'fitted' : 'refused',
        metricsFitted: num(cell['metrics_fitted']),
        metricsTotal: num(cell['metrics_total']),
      });
    }
  }
  available.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.band - b.band);

  return {
    fitKey: str(raw['fit_key']),
    fitVersion: num(raw['fit_version']),
    generatedAt: str(raw['generated_at']),
    corpus: {
      corpusVersion: str(corpus['corpus_version']),
      benchmarkCorpusVersion: num(corpus['benchmark_corpus_version']),
      panelSha256: str(corpus['panel_sha256']),
      walkIds: strArray(corpus['walk_ids']),
      observedAtMin: str(corpus['observed_at_min']),
      observedAtMax: str(corpus['observed_at_max']),
      rows: numTally(corpus['rows']),
      reposTotal: num(corpus['repos_total']),
      reposOk: num(corpus['repos_ok']),
      reposAbsent: numTally(corpus['repos_absent']),
    },
    scoring: {
      state: str(scoring['state'], 'unscored'),
      modelVersion: strOrNull(scoring['model_version']),
      backend: strOrNull(scoring['backend']),
      scoredComments: num(scoring['scored_comments']),
      note: str(scoring['note']),
    },
    staleness: recomputeStaleness(raw, nowMs),
    params: {
      minReposPerCell: num(params['min_repos_per_cell']),
      settleHours: num(params['settle_hours']),
      overdueGraceHours: numArray(params['overdue_grace_hours']),
      quantileGrid: numArray(params['quantile_grid']),
      quantileMethod: str(params['quantile_method']),
      bootstrapSamples: num(params['bootstrap_samples']),
      bootstrapSeed: num(params['bootstrap_seed']),
      shapeMinN: num(params['shape_min_n']),
      stalenessThresholdsDays: thresholds(params['staleness_thresholds_days']),
    },
    cohortAxes: { vendor: str(axes['vendor']), activityBand: str(axes['activity_band']) },
    activityBands: mapVendorBands(loaded),
    // ⚠ IN FULL, AND NEVER TRIMMED AS "JUST DOCS". This prose is what stops the placement step
    // from plotting the app's own `actedOnPct` against `acted_on_rate`'s grid — two columns with
    // the same name and different denominators. It is the mitigation for the biggest correctness
    // risk in the feature, and it is the first thing a well-meaning size optimisation deletes.
    metricSpecs: Object.entries(specs)
      .map(([name, spec]) => mapMetricSpec(name, spec))
      .sort((a, b) => a.name.localeCompare(b.name)),
    absentMetrics: Array.isArray(raw['absent_metrics'])
      ? raw['absent_metrics'].map(mapAbsentMetric)
      : [],
    populations: strTally(raw['populations']),
    unfittableVendors: [...loaded.unfittable]
      .map(([vendor, entry]) => mapUnfittableVendor(vendor, entry))
      .sort((a, b) => a.vendor.localeCompare(b.vendor)),
    exclusionReasons: strTally(raw['exclusion_reasons']),
    coverageNote: str(raw['coverage_note']),
    available,
    summary: {
      vendors: strArray(summary['vendors']),
      cellsTotal: num(summary['cells_total']),
      cellsFitted: num(summary['cells_fitted']),
      cellsRefused: num(summary['cells_refused']),
      metricCellsTotal: num(summary['metric_cells_total']),
      metricCellsFitted: num(summary['metric_cells_fitted']),
      metricCellsRefusedByRule: numTally(summary['metric_cells_refused_by_rule']),
      units: num(summary['units']),
    },
  };
}

/** `repos_in_cell` → `reposInCell`. FIELD names only — never applied to a vocabulary token. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

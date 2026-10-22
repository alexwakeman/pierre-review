import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BotBenchmarkUnavailableReason } from '@pierre-review/shared';

// Loading the bundled peer-benchmark artifact (`bot_monitor.benchmark_fit`, produced by
// `packages/ml`'s `bot_monitor.panel.fit`).
//
// ── WHY THE ARTIFACT IS BUNDLED ─────────────────────────────────────────────────────────────────
// It is the ONE body of data in the system that is IDENTICAL FOR EVERY ACCOUNT: quantiles, counts
// and refusals, no repository and no actor named anywhere. So it is not database data, and it ships
// as a file beside the code.
//
// ⚠ THE PATH: `data/` sits beside this module tree — `src/platform/data/benchmark/` in the source,
// `dist/platform/data/benchmark/` in the release build (scripts/build-release.mjs copies it). The
// URL below is relative to this file, so it resolves the same way under tsx and under `node dist`.
//
// ⚠ IDENTITY LIVES INSIDE THE FILE, NOT IN ITS NAME. The filename is fixed — never
// `fit_<date>.json`, no directory scan, no newest-by-mtime. `fit_key`
// (`fit-v1+corpus-v3+panel-…+model-unscored+params-…`) is the whole identity, it is already in the
// file, and it rides every response. A filename that encodes identity is a second source of truth
// that will eventually disagree with the one inside.

/** Absolute-path override. TWO uses: pointing dev straight at a freshly-fitted
 *  `packages/ml/data/benchmark/fit_*.json` without copying, and an ops escape hatch if a volume
 *  ever exists. OVERRIDE ONLY — the bundled sibling is the contract. */
const PATH_ENV = 'PRO_BENCHMARK_FIT_PATH';

/**
 * The `fit_version`s this projection understands.
 *
 * ⚠ THIS SET IS THE LOADER'S WHOLE CONTRACT WITH THE FITTER, and getting it wrong is SILENT: a
 * refused artifact answers `available: false` on a 200 to every caller, forever, and the pro test
 * suite stays green because its own fixture is a different version. That is exactly what happened
 * between fit v1 and v2 — the bundled artifact moved and this constant did not.
 *
 * WHY v2 IS READABLE, argued rather than assumed. The v1 comment here said a newer artifact must
 * be refused because "v2 starts emitting model-derived metrics into cells, at which point
 * `absent_metrics` stops protecting the renderer structurally". The shipped v2 does NOT:
 * `scoring.state` is still `unscored`, every cell's `metrics` block holds exactly the thirteen
 * code-derived names, and `absent_metrics` still carries the three model ones. What v2 actually
 * changed is additive and is handled below — `activity_bands` became PER VENDOR, cells gained
 * `selection` provenance and `cohort.n_bands`/`band_label`/`repos_band_support`.
 *
 * ⚠ THE DAY `scoring.state` BECOMES `scored`, THIS DECISION IS BACK ON THE TABLE. Structural
 * absence is what keeps a model-derived figure and a code-derived one from being rendered
 * indistinguishably; once cells carry model metrics, the per-metric `derivation` field is the only
 * thing left doing that job and every consumer must be reading it.
 *
 * v1 stays supported because a v1 artifact is still a coherent, readable cohort — it simply
 * publishes no per-vendor banding, so `vendorBands` is empty and PLACEMENT REFUSES on it rather
 * than inventing a stratum. That is the honest degrade.
 */
export const SUPPORTED_FIT_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

export type RawJson = Record<string, unknown>;

/** One vendor's published activity stratification (fit v2's `activity_bands[vendor]`). */
export interface ArtifactVendorBands {
  vendor: string;
  nBands: number;
  reposBandSupport: number;
  /** Ascending by band. `low`/`high` are the SUPPORT units' observed `panel_prs_per_period` range
   *  — the interval the rank cut actually drew, not the range over all members. */
  bands: Array<{ band: number; low: number; high: number; repos: number }>;
}

export interface LoadedArtifactOk {
  ok: true;
  path: string;
  raw: RawJson;
  /** ⚠ A MAP, NOT THE PARSED `cells` OBJECT. `?cells=` is caller-controlled, and
   *  `parsed.cells[vendor][band]` on a plain object is reachable with `vendor='__proto__'` or
   *  `'constructor'`. Re-keying at parse time makes the lookup total and the vocabulary closed. */
  cells: Map<string, Map<number, RawJson>>;
  /** Vendor strings the fitter REFUSED to form any cell for, with what the refusal dropped. */
  unfittable: Map<string, RawJson>;
  /** Vendors the corpus MEASURED and then declined to stratify (`unstratifiable_vendors`). ⚠ A
   *  DIFFERENT refusal from `unfittable`, and a different sentence: "we have too little of this
   *  bot" versus "this is not a product". Each entry carries the vendor's full coverage block at
   *  `coverage_grain: "vendor"`, so a consumer can say HOW FAR SHORT. */
  unstratifiable: Map<string, RawJson>;
  /** Per-vendor activity bands (fit v2). EMPTY on a v1 artifact, which published one flat,
   *  vendor-agnostic band table — and placement refuses rather than reading a stratum that does
   *  not describe the vendor it is being asked about. */
  vendorBands: Map<string, ArtifactVendorBands>;
}

export interface LoadedArtifactErr {
  ok: false;
  path: string;
  reason: BotBenchmarkUnavailableReason;
  message: string;
}

export type LoadedArtifact = LoadedArtifactOk | LoadedArtifactErr;

export function benchmarkArtifactPath(): string {
  const override = process.env[PATH_ENV];
  if (override != null && override.trim() !== '') return override.trim();
  return fileURLToPath(new URL('../../data/benchmark/benchmark-fit.json', import.meta.url));
}

let cached: LoadedArtifact | null = null;

/**
 * The artifact, parsed once and memoised for the process lifetime.
 *
 * ⚠ LOADED AT FIRST REQUEST, NOT AT `register()`. A missing or corrupt file must never delay or
 * fail boot — a build whose `data/` copy step was forgotten is a build-configuration fact,
 * answered with `available: false` on a 200, not a 500.
 *
 * The FAILURE is memoised too: the file is bundled beside the code, so "it appeared later" is not
 * a state that happens without a restart, and re-stat-ing on every request would turn a
 * misconfiguration into per-request disk I/O.
 */
export function loadBenchmarkArtifact(): LoadedArtifact {
  if (cached != null) return cached;
  cached = readArtifact(benchmarkArtifactPath());
  return cached;
}

/** Test-only: drop the memo so a suite can point PRO_BENCHMARK_FIT_PATH somewhere else. */
export function resetBenchmarkArtifactCache(): void {
  cached = null;
}

function readArtifact(path: string): LoadedArtifact {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {
      ok: false,
      path,
      reason: 'artifact_missing',
      message:
        'No peer-benchmark corpus is bundled in this build. Set PRO_BENCHMARK_FIT_PATH to read ' +
        'one from elsewhere.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      path,
      reason: 'artifact_unreadable',
      message: 'The bundled peer-benchmark corpus is not valid JSON.',
    };
  }

  if (!isObject(parsed) || parsed['artifact'] !== 'bot_monitor.benchmark_fit') {
    return {
      ok: false,
      path,
      reason: 'artifact_unreadable',
      message: 'The file at the peer-benchmark path is not a bot_monitor.benchmark_fit artifact.',
    };
  }

  const fitVersion = parsed['fit_version'];
  if (typeof fitVersion !== 'number' || !SUPPORTED_FIT_VERSIONS.has(fitVersion)) {
    const supported = [...SUPPORTED_FIT_VERSIONS].sort((a, b) => a - b).join(', ');
    return {
      ok: false,
      path,
      reason: 'fit_version_unsupported',
      message:
        `This build reads fit_version ${supported} artifacts; the bundled one is ` +
        `fit_version ${String(fitVersion)}. Refusing to half-read it.`,
    };
  }

  const cells = new Map<string, Map<number, RawJson>>();
  const rawCells = parsed['cells'];
  if (isObject(rawCells)) {
    for (const [vendor, bands] of Object.entries(rawCells)) {
      if (!isObject(bands)) continue;
      const byBand = new Map<number, RawJson>();
      for (const [bandKey, cell] of Object.entries(bands)) {
        const band = Number.parseInt(bandKey, 10);
        if (!Number.isInteger(band) || !isObject(cell)) continue;
        byBand.set(band, cell);
      }
      cells.set(vendor, byBand);
    }
  }

  const unfittable = readVendorMap(parsed['unfittable_vendors']);
  const unstratifiable = readVendorMap(parsed['unstratifiable_vendors']);

  return {
    ok: true,
    path,
    raw: parsed,
    cells,
    unfittable,
    unstratifiable,
    vendorBands: readVendorBands(parsed['activity_bands']),
  };
}

function readVendorMap(raw: unknown): Map<string, RawJson> {
  const out = new Map<string, RawJson>();
  if (!isObject(raw)) return out;
  for (const [vendor, entry] of Object.entries(raw)) {
    if (isObject(entry)) out.set(vendor, entry);
  }
  return out;
}

/**
 * `activity_bands` → per-vendor bands, ascending.
 *
 * ⚠ SHAPE-DETECTED, NOT VERSION-DETECTED, and the two shapes are not variants of one thing. fit v2
 * publishes `{vendor: {n_bands, repos_band_support, bands: {band: {...}}}}`; fit v1 published a
 * FLAT `{band: {...}}` covering every vendor at once. A v1 table is silently dropped here rather
 * than being fanned out across the vendors, because a stratum cut over all vendors together is not
 * the stratum any single vendor's cell describes — and placement's whole job is to refuse rather
 * than answer a question about a different population.
 *
 * ⚠ A MAP, NOT THE PARSED OBJECT: vendor strings are caller-adjacent, and
 * `parsed.activity_bands['__proto__']` on a plain object is reachable.
 */
function readVendorBands(raw: unknown): Map<string, ArtifactVendorBands> {
  const out = new Map<string, ArtifactVendorBands>();
  if (!isObject(raw)) return out;
  for (const [vendor, entry] of Object.entries(raw)) {
    if (!isObject(entry) || !isObject(entry['bands'])) continue;
    const bands: ArtifactVendorBands['bands'] = [];
    for (const [key, band] of Object.entries(entry['bands'])) {
      const index = Number.parseInt(key, 10);
      if (!Number.isInteger(index) || !isObject(band)) continue;
      const range = band['panel_prs_per_period'];
      if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
        continue;
      }
      bands.push({
        band: index,
        low: range[0],
        high: range[1],
        repos: typeof band['repos'] === 'number' ? band['repos'] : 0,
      });
    }
    if (bands.length === 0) continue;
    // Numerically, so a ten-band artifact does not read 0, 1, 10, 2 — and the placement scan
    // REQUIRES ascending order, since it reads the first high edge that admits the value.
    bands.sort((a, b) => a.band - b.band);
    out.set(vendor, {
      vendor,
      nBands: typeof entry['n_bands'] === 'number' ? entry['n_bands'] : bands.length,
      reposBandSupport:
        typeof entry['repos_band_support'] === 'number' ? entry['repos_band_support'] : 0,
      bands,
    });
  }
  return out;
}

export function isObject(value: unknown): value is RawJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

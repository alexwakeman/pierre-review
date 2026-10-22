// The peer-cohort benchmark: the loader, the snake→camel projection, and the route's four
// answer shapes.
//
// ⚠ REFUSALS ARE THE PRODUCT HERE, WHICH IS WHY MOST OF THIS FILE ASSERTS ABSENCE. Today's real
// bundled artifact is 8 repositories against a floor of 30, so EVERY cell and every one of its 234
// metric entries refuses. That is correct output, not a degraded state, and it is the state that
// ships first — so it is the state with the most coverage below.
//
// The single easiest thing to lose in a mapper is rule 1: `_refusal()` in fit.py omits
// `n_repos`/`quantiles`/`grid` DELIBERATELY, so that reading a percentile off a refusal raises
// rather than returning a plausible small number. A mapper that emits `{ quantiles: null,
// nRepos: 0 }` turns "we refuse to answer" into "the answer is low", and a test that only checks
// `status` would not notice. Hence the explicit `not.toHaveProperty` assertions.
//
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// ⚠ A VALUE import, deliberately, and only here. Production code in this package `import type`s
// from @pierre-review/shared (the release build greps `release/dist` and FAILS on a real one), so
// the plugin's own cap is an inlined mirror — and a test, which may import the original, is the
// only place the two can be compared. Same shape as chat-budget.test.ts and SPRINT_CHAT_MAX_TURNS.
import { BOT_BENCHMARK_MAX_CELLS } from '@pierre-review/shared';
import type {
  BotBenchmarkCellEntry,
  BotBenchmarkManifest,
  BotBenchmarkResponse,
} from '@pierre-review/shared';
const FIXTURE = fileURLToPath(new URL('./fixtures/benchmark-fit-smoke.json', import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
let appOn: any;
let loadBenchmarkArtifact: typeof import('../bots/benchmark/artifact.js').loadBenchmarkArtifact;
let resetCache: typeof import('../bots/benchmark/artifact.js').resetBenchmarkArtifactCache;
let benchmarkArtifactPath: typeof import('../bots/benchmark/artifact.js').benchmarkArtifactPath;
let mapManifest: typeof import('../bots/benchmark/map.js').mapManifest;

/** The bundled corpus, read through the DEFAULT path — i.e. the sibling-of-`src`/`dist` resolution
 *  that has to work identically under tsx, under `node dist` and in the release image. */
function bundled(): BotBenchmarkManifest {
  delete process.env.PRO_BENCHMARK_FIT_PATH;
  resetCache();
  const loaded = loadBenchmarkArtifact();
  if (!loaded.ok) throw new Error(`bundled artifact did not load: ${loaded.message}`);
  return mapManifest(loaded, Date.parse('2026-08-30T18:00:00Z'));
}

async function get(app: any, url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  const artifact = await import('../bots/benchmark/artifact.js');
  loadBenchmarkArtifact = artifact.loadBenchmarkArtifact;
  resetCache = artifact.resetBenchmarkArtifactCache;
  benchmarkArtifactPath = artifact.benchmarkArtifactPath;
  mapManifest = (await import('../bots/benchmark/map.js')).mapManifest;

  const { registerBotBenchmarkRoutes } = await import('../bots/benchmark-routes.js');
  const { default: Fastify } = await import('fastify');
  appOn = Fastify({ logger: false });
  // The route reads nothing off ProContext — no db, no schema, no accountIdOf. That is the point:
  // nothing about the caller reaches the response.
  registerBotBenchmarkRoutes(appOn, {} as any);
  await appOn.ready();
});

afterEach(() => {
  delete process.env.PRO_BENCHMARK_FIT_PATH;
  resetCache();
});

afterAll(async () => {
  await appOn?.close();
});

describe('the bundled artifact resolves without an env override', () => {
  it('lives in the platform module tree, beside the code that reads it', () => {
    delete process.env.PRO_BENCHMARK_FIT_PATH;
    // src/platform/data/… under tsx; dist/platform/data/… in the release build.
    expect(benchmarkArtifactPath()).toMatch(/\/platform\/data\/benchmark\/benchmark-fit\.json$/);
    expect(existsSync(benchmarkArtifactPath())).toBe(true);
  });

  it('is overridden by PRO_BENCHMARK_FIT_PATH, absolute', () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    expect(benchmarkArtifactPath()).toBe(FIXTURE);
  });
});

describe("today's real state: a fitted corpus that still refuses two cells and one vendor", () => {
  // ⚠ THIS BLOCK USED TO ASSERT `cellsFitted === 0` AGAINST AN 8-REPOSITORY SMOKE CORPUS, and it
  // went red the day the real 2,204-repository artifact was bundled — CORRECTLY, because it was
  // describing a state of the DATA and the data moved. What it was really protecting is one rank
  // below that: `cellsFitted` is a first-class field with the reason distribution beside it, a
  // refused cell has no distribution keys at all, and a stated refusal is never a silent drop.
  // Those are re-asserted here against whatever the bundled artifact actually holds, so this block
  // can survive the next refit without lying about the one before it.
  it('reports the fitted/refused split as first-class fields, with the reason distribution beside it', () => {
    const m = bundled();
    // The SPA renders ONE banner off these rather than n identical refusal paragraphs per cell.
    expect(m.summary.cellsTotal).toBe(m.summary.cellsFitted + m.summary.cellsRefused);
    expect(m.summary.cellsTotal).toBe(m.available.length);
    expect(m.summary.metricCellsTotal).toBe(m.summary.cellsTotal * 13);
    // ⚠ The rule key is VOCABULARY and reaches the wire exactly as the fitter spells it — the
    // tally is per RULE, never one number called "refused".
    const refusedByRule = Object.values(m.summary.metricCellsRefusedByRule).reduce(
      (a, b) => a + b,
      0,
    );
    expect(m.summary.metricCellsFitted + refusedByRule).toBe(m.summary.metricCellsTotal);
    expect(Object.keys(m.summary.metricCellsRefusedByRule)).toContain('cell_floor');
    expect(m.params.minReposPerCell).toBe(30);
    expect(m.corpus.reposOk).toBeGreaterThan(0);
    expect(m.corpus.reposOk).toBeLessThanOrEqual(m.corpus.reposTotal);
  });

  it('lists every (vendor, band) the artifact holds, with each key stating its own status', () => {
    const m = bundled();
    expect(m.available.length).toBeGreaterThan(0);
    for (const key of m.available) {
      expect(key.metricsTotal, `${key.vendor}:${key.band}`).toBe(13);
      expect(key.metricsFitted).toBeLessThanOrEqual(13);
      // A REFUSED cell key must not advertise fitted metrics, and a FITTED one must have at least
      // one — `status: 'fitted'` means AT LEAST ONE cleared the floor, never all thirteen.
      if (key.status === 'refused') expect(key.metricsFitted).toBe(0);
      else expect(key.metricsFitted).toBeGreaterThan(0);
    }
    // Sorted, so the picker is stable across redeploys of the same corpus.
    expect(m.available[0]?.vendor).toBe('coderabbit');
    expect([...m.available].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.band - b.band)).toEqual(
      m.available,
    );
  });

  it('names the vendor it refused to form ANY cell for, with what the refusal dropped', () => {
    const m = bundled();
    const inHouse = m.unfittableVendors.find((v) => v.vendor === 'in_house');
    expect(inHouse).toBeDefined();
    // ⚠ A refusal the artifact does not state is a silent drop; a 0 here would be a claim.
    expect(inHouse?.repos).toBeGreaterThan(0);
    expect(inHouse?.reviewBotComments).toBeGreaterThan(0);
    expect(inHouse?.reason).toMatch(/catch-all/);
  });

  it('serves a refused metric with NO distribution keys at all', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = benchmarkArtifactPath();
    // A cell the bundled artifact genuinely refuses. Located rather than hard-coded: the point is
    // the SHAPE of a refusal, and pinning a vendor:band would re-break on the next refit.
    const m = bundled();
    const refusedKey = m.available.find((k) => k.status === 'refused');
    expect(refusedKey, 'the bundled artifact holds at least one refused cell').toBeDefined();
    process.env.PRO_BENCHMARK_FIT_PATH = benchmarkArtifactPath();
    const { body } = await get(
      appOn,
      `/api/pro/bot-benchmark?cells=${refusedKey?.vendor}:${refusedKey?.band}`,
    );
    const cell = (body as BotBenchmarkResponse).cells?.[0] as BotBenchmarkCellEntry;
    expect(cell.status).toBe('refused');
    if (cell.status !== 'refused') throw new Error('unreachable');
    expect(cell.metricsFitted).toBe(0);
    expect(cell.metricsTotal).toBe(13);
    expect(cell.refusal.rule).toBe('cell_floor');
    for (const [name, metric] of Object.entries(cell.metrics)) {
      expect(metric.status, name).toBe('refused');
      if (metric.status !== 'refused') throw new Error('unreachable');
      // ⚠ RULE 1, STRUCTURALLY. Not "these are null" — these keys DO NOT EXIST.
      expect(metric, name).not.toHaveProperty('grid');
      expect(metric, name).not.toHaveProperty('quantiles');
      expect(metric, name).not.toHaveProperty('nRepos');
      expect(metric, name).not.toHaveProperty('ciMedian95');
      // …and the numbers the SPA writes its sentence from, rather than inventing one.
      expect(metric.refusal.required['contributing_repos']).toBe(30);
      expect(typeof metric.refusal.observed['contributing_repos']).toBe('number');
      expect(metric.refusal.message.length).toBeGreaterThan(40);
    }
    // The per-metric exclusion tally survives, and it is NOT one number called "excluded":
    // `vendor_silent` and `below_min_units` mean opposite things about whether a blind spot exists.
    const anyMetric = Object.values(cell.metrics)[0];
    if (anyMetric?.status !== 'refused') throw new Error('unreachable');
    expect(Object.keys(anyMetric.excluded).length).toBeGreaterThan(0);
  });

  it('carries the PER-VENDOR activity bands fit v2 publishes, ascending and monotone', () => {
    // The banding axis is per vendor now (10/10/9/7/4/3/2), which is what makes a placement's
    // `bandLabel` honest — "upper fifth" at 5 bands is a misrepresentation at 10. A v1 artifact's
    // flat, vendor-agnostic table is deliberately DROPPED rather than fanned out.
    const m = bundled();
    expect(m.activityBands.length).toBeGreaterThan(0);
    for (const vendor of m.activityBands) {
      expect(vendor.bands.length, vendor.vendor).toBe(vendor.nBands);
      let previousHigh = -Infinity;
      for (const [i, band] of vendor.bands.entries()) {
        expect(band.band, vendor.vendor).toBe(i);
        expect(band.panelPrsPerPeriod[1] >= previousHigh, vendor.vendor).toBe(true);
        previousHigh = band.panelPrsPerPeriod[1];
      }
    }
  });
});

describe('the manifest ships the definitions in full', () => {
  it('carries numerator / denominator / population / minUnits for all thirteen', () => {
    const m = bundled();
    // ⚠ NEVER TRIMMED AS "JUST DOCS". This prose is the mitigation for the feature's biggest
    // correctness risk: the app's own `actedOnPct` folds in the `likely_addressed` commit
    // heuristic and divides by every in-window thread, while the cohort's `acted_on_rate` divides
    // by SETTLED, FULLY-READ threads. Same name, different columns.
    expect(m.metricSpecs).toHaveLength(13);
    for (const spec of m.metricSpecs) {
      expect(spec.numerator.length, spec.name).toBeGreaterThan(10);
      expect(spec.denominator.length, spec.name).toBeGreaterThan(5);
      expect(m.populations[spec.population], spec.name).toBeTruthy();
      expect(spec.minUnits, spec.name).toBeGreaterThan(0);
      expect(['higher_is_better', 'lower_is_better', 'neutral']).toContain(spec.direction);
    }
    const actedOn = m.metricSpecs.find((s) => s.name === 'acted_on_rate');
    expect(actedOn?.denominator).toBe('settled, fully-read vendor threads');
    expect(m.params.settleHours).toBe(72);
  });

  it('passes the three model-derived metrics through as STRUCTURALLY ABSENT', () => {
    const m = bundled();
    // Not empty and not zero: no cell holds them at all while the corpus is unscored. Passing
    // them through is what lets the SPA say "severity comparison arrives when the corpus is
    // scored" instead of showing nothing and explaining nothing.
    expect(m.scoring.state).toBe('unscored');
    expect(m.absentMetrics.map((a) => a.name).sort()).toEqual([
      'distinct_category_count',
      'high_severity_share',
      'nit_share',
    ]);
    for (const absent of m.absentMetrics) {
      expect(absent.derivation).toBe('model');
      expect(absent.reason).toBe('not_scored');
      expect(Object.keys(absent.requires).length).toBeGreaterThan(0);
    }
    // The absent names must not ALSO appear as cell metrics — that would be the collision the
    // structural absence exists to prevent.
    for (const absent of m.absentMetrics) {
      expect(m.metricSpecs.map((s) => s.name)).not.toContain(absent.name);
    }
  });

  it('keeps the exclusion legend joinable to the per-metric tallies', () => {
    const m = bundled();
    // Vocabulary tokens are NOT camelised, precisely so this join holds.
    expect(Object.keys(m.exclusionReasons)).toContain('denominator_empty');
    expect(Object.keys(m.exclusionReasons)).toContain('vendor_silent');
    expect(m.coverageNote).toMatch(/never sum/i);
  });
});

describe('staleness is RECOMPUTED, never copied', () => {
  it('re-ages the stored corpus against observedAtMax at read time', () => {
    delete process.env.PRO_BENCHMARK_FIT_PATH;
    resetCache();
    const loaded = loadBenchmarkArtifact();
    if (!loaded.ok) throw new Error('bundled artifact did not load');
    const observedMax = Date.parse(
      (loaded.raw['corpus'] as Record<string, string>)['observed_at_max'] as string,
    );
    // The stored block says "fresh" and 0.003 days — as of generated_at, decaying on disk.
    const stored = loaded.raw['staleness'] as Record<string, unknown>;
    expect(stored['state']).toBe('fresh');

    // ⚠ THE INVERSE OF THE WALK'S FROZEN-AGE RULE. Read 200 days later and it is EXPIRED. The
    // obvious implementation passes the stored value through and reports "fresh" forever.
    const later = mapManifest(loaded, observedMax + 200 * 86_400_000);
    expect(later.staleness.state).toBe('expired');
    expect(later.staleness.corpusAgeDays).toBeCloseTo(200, 3);
    expect(later.staleness.corpusObservedAtMax).toBe(stored['corpus_observed_at_max']);

    // …and every threshold in between, so a single hard-coded branch cannot pass this.
    expect(mapManifest(loaded, observedMax + 1 * 86_400_000).staleness.state).toBe('fresh');
    expect(mapManifest(loaded, observedMax + 45 * 86_400_000).staleness.state).toBe('aging');
    expect(mapManifest(loaded, observedMax + 120 * 86_400_000).staleness.state).toBe('stale');
    expect(later.staleness.thresholdsDays).toEqual({ aging: 30, stale: 90, expired: 180 });
  });
});

describe('a FITTED cell (the fixture — the bundled corpus has none)', () => {
  const fitted = (): BotBenchmarkManifest => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const loaded = loadBenchmarkArtifact();
    if (!loaded.ok) throw new Error('fixture did not load');
    return mapManifest(loaded, Date.parse('2026-08-30T18:00:00Z'));
  };

  it('emits the whole distribution, including the interval that says how much it could move', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const { body } = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:5');
    const cell = (body as BotBenchmarkResponse).cells?.[0] as BotBenchmarkCellEntry;
    expect(cell.status).toBe('fitted');
    if (cell.status !== 'fitted') throw new Error('unreachable');

    const metric = cell.metrics['acted_on_rate'];
    expect(metric?.status).toBe('fitted');
    if (metric?.status !== 'fitted') throw new Error('unreachable');
    expect(metric.nRepos).toBe(30);
    expect(metric.grid.p).toHaveLength(21);
    expect(metric.grid.v).toHaveLength(21);
    // The headline five are READ OUT OF THE GRID, so the two can never disagree.
    expect(metric.quantiles['p50']).toBe(metric.grid.v[10]);
    expect(metric.quantiles['p90']).toBe(metric.grid.v[18]);
    // ⚠ THE ONLY THING ON A FITTED CELL THAT SAYS HOW MUCH THE MEDIAN COULD MOVE. At the 30-repo
    // floor a rate's median CI routinely spans 20 points — here it is [0.05, 0.25], i.e. a 20-point
    // band around a 15% median. "Your 41% vs the cohort's 38%" without it is noise as a gap.
    expect(metric.ciMedian95).toEqual([0.05, 0.25]);
    expect(metric.shape.family).toBeNull();
    expect(metric.shape.familyReason).toMatch(/shape_min_n/);
    expect(metric.derivation).toBe('code');
  });

  it("still says twelve of thirteen refused — `status: 'fitted'` means AT LEAST ONE", async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const { body } = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:5');
    const cell = (body as BotBenchmarkResponse).cells?.[0] as BotBenchmarkCellEntry;
    if (cell.status !== 'fitted') throw new Error('expected a fitted cell');
    // ⚠ A card gated on the cell status alone can be drawn for a cell where twelve metrics
    // refused, and the status would not say so — which is why the counts ride beside it.
    expect(cell.metricsFitted).toBe(1);
    expect(cell.metricsRefused).toBe(12);
    const refusedInside = Object.values(cell.metrics).filter((m) => m.status === 'refused');
    expect(refusedInside).toHaveLength(12);
    for (const m of refusedInside) expect(m).not.toHaveProperty('grid');
  });

  it('lists the fitted cell in the manifest so the picker needs no cell fetch', () => {
    const m = fitted();
    expect(m.summary.cellsFitted).toBe(1);
    expect(m.available.find((k) => k.band === 5)).toEqual({
      vendor: 'coderabbit',
      band: 5,
      status: 'fitted',
      metricsFitted: 1,
      metricsTotal: 13,
    });
  });

  it('camelises coverage FIELD names while leaving every vocabulary token verbatim', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const { body } = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:5');
    const cell = (body as BotBenchmarkResponse).cells?.[0] as BotBenchmarkCellEntry;
    if (cell.status === 'absent') throw new Error('unreachable');
    // Coverage keys are a flattened STRUCT — field names, so they camelise…
    expect(cell.coverage.counts).toHaveProperty('reposInCell');
    expect(cell.coverage.counts).toHaveProperty('mergedPrsEligible');
    expect(cell.coverage.counts).not.toHaveProperty('repos_in_cell');
    expect(cell.coverage.observedAt?.max).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // …while every VOCABULARY token stays exactly as the fitter spells it, because each one is
    // half of a join: metric names ↔ metricSpecs, excluded ↔ exclusionReasons, rules ↔ the
    // summary tally. Camelising these would put the wire and the fitter in two vocabularies.
    expect(Object.keys(cell.metrics)).toContain('acted_on_rate');
    expect(Object.keys(cell.metrics)).not.toContain('actedOnRate');
    const refused = Object.values(cell.metrics).find((m) => m.status === 'refused');
    if (refused?.status !== 'refused') throw new Error('unreachable');
    expect(refused.excluded).toHaveProperty('vendor_silent');
    expect(refused.refusal.rule).toBe('cell_floor');
    expect(refused.refusal.observed).toHaveProperty('contributing_repos');
  });
});

describe('the route: four answer shapes, and never an empty object', () => {
  it('returns the manifest and NO cells when ?cells= is omitted', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const { status, body } = await get(appOn, '/api/pro/bot-benchmark');
    expect(status).toBe(200);
    const res = body as BotBenchmarkResponse;
    expect(res.available).toBe(true);
    expect(res.manifest?.fitKey).toMatch(/^fit-v1\+corpus-v3\+panel-/);
    // Absent, not an empty array: "you did not ask for cells" is not "there are no cells".
    expect(res).not.toHaveProperty('cells');
  });

  it('treats a REPEATED ?cells= key as more cells, never a 500', async () => {
    // ⚠ Fastify's default query parser hands back a string[] the moment a key repeats, so a
    // `Querystring` generic saying `string` is an assertion nothing honoured: `raw.trim()` threw,
    // and a caller who wrote `?cells=a&cells=b` — the same thing they meant by `?cells=a,b` — got
    // a 500 where the honest answers are 200 or 400. Both spellings must reach the same answer.
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const repeated = await get(
      appOn,
      '/api/pro/bot-benchmark?cells=coderabbit:1&cells=copilot:2',
    );
    const comma = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:1,copilot:2');
    expect(repeated.status).toBe(200);
    // `cells`, not the whole body: the manifest's staleness is RECOMPUTED per request against
    // Date.now() (see the staleness block above), so two calls milliseconds apart legitimately
    // differ there. Comparing bodies would make this test fail for a reason it is not about.
    expect((repeated.body as BotBenchmarkResponse).cells).toEqual(
      (comma.body as BotBenchmarkResponse).cells,
    );
    expect((repeated.body as BotBenchmarkResponse).cells).toHaveLength(2);

    // A malformed member is still a 400 through the array path: the union widened the INPUT
    // spelling, it did not relax the closed vocabulary.
    const bad = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:1&cells=NOT A CELL');
    expect(bad.status).toBe(400);
  });

  it('answers each requested key IN REQUEST ORDER', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const { body } = await get(appOn, '/api/pro/bot-benchmark?cells=coderabbit:5,coderabbit:1');
    const cells = (body as BotBenchmarkResponse).cells ?? [];
    expect(cells.map((c) => c.status)).toEqual(['fitted', 'refused']);
  });

  it('400s over the cap rather than truncating', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    const many = Array.from({ length: 25 }, (_, i) => `coderabbit:${i}`).join(',');
    const { status, body } = await get(appOn, `/api/pro/bot-benchmark?cells=${many}`);
    // ⚠ A truncated cell list reads to the consumer as "those cohorts do not exist", which is the
    // one claim this feature must never make by accident. And the cap is what makes the rate
    // tier's arithmetic true.
    expect(status).toBe(400);
    expect(body.error).toMatch(/at most 24/);
    // Exactly at the cap is fine.
    const atCap = Array.from({ length: 24 }, (_, i) => `coderabbit:${i}`).join(',');
    expect((await get(appOn, `/api/pro/bot-benchmark?cells=${atCap}`)).status).toBe(200);
  });

  it('400s a malformed selector — the vocabulary is closed', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    for (const q of ['coderabbit', 'coderabbit:x', ':1', 'CodeRabbit:1', 'coderabbit:1234']) {
      const { status } = await get(appOn, `/api/pro/bot-benchmark?cells=${encodeURIComponent(q)}`);
      expect(status, q).toBe(400);
    }
  });

  it('cannot be walked into Object.prototype through the vendor key', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = FIXTURE;
    resetCache();
    // `__proto__` never even parses (the vendor charset requires a leading alphanumeric)…
    expect((await get(appOn, '/api/pro/bot-benchmark?cells=__proto__:1')).status).toBe(400);
    // …and `constructor`, which DOES parse, resolves through a Map, so it is simply a vendor the
    // corpus has never seen rather than a function reached off a parsed object's prototype.
    const { status, body } = await get(appOn, '/api/pro/bot-benchmark?cells=constructor:1');
    expect(status).toBe(200);
    const cell = (body as BotBenchmarkResponse).cells?.[0];
    expect(cell?.status).toBe('absent');
    if (cell?.status !== 'absent') throw new Error('unreachable');
    expect(cell.reason).toBe('vendor_not_in_corpus_vocabulary');
  });

  it('distinguishes the THREE absences — they are three different sentences', async () => {
    delete process.env.PRO_BENCHMARK_FIT_PATH;
    resetCache();
    const { body } = await get(
      appOn,
      '/api/pro/bot-benchmark?cells=in_house:1,coderabbit:99,codeant:1',
    );
    const cells = (body as BotBenchmarkResponse).cells ?? [];
    expect(cells.map((c) => (c.status === 'absent' ? c.reason : c.status))).toEqual([
      // "Your bot's cohort is structurally impossible" — a catch-all over unrelated reviewers.
      'vendor_unfittable',
      // "This stratum is empty."
      'cell_not_in_corpus',
      // "We have never seen this vendor." ⚠ REACHABLE FROM A VOCABULARY MISMATCH, not a data gap:
      // packages/ml knows `codeant`, the host's REVIEW_BOT_KINDS does not, and the host knows
      // `github_code_quality`/`pierre`/`vendor`, which the fitter has never seen. A naive join
      // renders "no peer data" where the truth is "these are different vocabularies".
      'vendor_not_in_corpus_vocabulary',
    ]);
    const unfittable = cells[0];
    if (unfittable?.status !== 'absent') throw new Error('unreachable');
    expect(unfittable.unfittable?.repos).toBeGreaterThan(0);
    for (const c of cells) expect(c).not.toHaveProperty('metrics');
  });

  it('200s with available:false when no corpus is bundled — a build fact, not a fault', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = '/nonexistent/benchmark-fit.json';
    resetCache();
    const { status, body } = await get(appOn, '/api/pro/bot-benchmark');
    // ⚠ 200, NOT 500. A 500 pages someone for a build-configuration fact, and "peer benchmarking
    // isn't available in this build" is a DIFFERENT sentence from "there isn't enough peer data".
    expect(status).toBe(200);
    const res = body as BotBenchmarkResponse;
    expect(res.available).toBe(false);
    expect(res.reason).toBe('artifact_missing');
    expect(res.message?.length).toBeGreaterThan(20);
    expect(res.manifest).toBeUndefined();
  });
});

describe('registration', () => {
  it('registers ONLY under /api/pro/ — the path the SPA calls', async () => {
    const { registerBotBenchmarkRoutes } = await import('../bots/benchmark-routes.js');
    const { default: Fastify } = await import('fastify');
    const probe = Fastify({ logger: false });
    const paths: string[] = [];
    probe.addHook('onRoute', (r) => void paths.push(r.path));
    registerBotBenchmarkRoutes(probe, {} as any);
    await probe.ready();

    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith('/api/pro/')).toBe(true);
    expect(paths).toContain('/api/pro/bot-benchmark');
    await probe.close();
  });

  it('mirrors the shared cell cap, so the two spellings cannot drift apart', async () => {
    const { MAX_CELLS } = await import('../bots/benchmark-routes.js');
    // The plugin's MAX_CELLS is a copy of BOT_BENCHMARK_MAX_CELLS by necessity, not by choice.
    // Without this line "keep in step" is a comment, and the failure it prevents is quiet in both
    // directions: raise the shared one and the SPA batches a request the plugin 400s; raise the
    // plugin's and the documented contract understates what the route accepts.
    expect(MAX_CELLS).toBe(BOT_BENCHMARK_MAX_CELLS);
  });

});

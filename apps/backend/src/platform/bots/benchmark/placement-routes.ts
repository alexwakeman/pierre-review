import type { FastifyInstance } from 'fastify';
import type {
  BotBenchmarkAbsentMetric,
  BotBenchmarkPlacementCohort,
  BotBenchmarkPlacementCounters,
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementResponse,
  BotBenchmarkPlacementUnit,
  BotBenchmarkStaleness,
  BotBenchmarkWorkspaceRollup,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../../contract.js';
import { resolveRequestScope } from '../../insights/workspace-request.js';
import { isObject, loadBenchmarkArtifact, type LoadedArtifactOk } from './artifact.js';
import { mapMetric } from './map.js';
import { anomaliesFor } from './anomalies.js';
import {
  buildRepoInput,
  actorIdsOf,
  fetchRepoData,
  reposInScope,
  resolveAutomation,
  type CollectedRepo,
  type VendorSpan,
  type WorkspaceAutomation,
} from './collect.js';
import {
  evaluateUnit,
  foldRepo,
  type FoldParams,
  type FoldUnit,
  type MetricOutcome,
} from './fold.js';
import { ACTIVITY_WINDOW_DAYS, resolvePlacement } from './place.js';
import { percentileOf } from './percentile.js';
import {
  COST_WINDOW_DAYS,
  resolveSpan,
  resolveUnitPrice,
  type ActedThreadCounts,
  type ResolvedUnitPrice,
} from './cost.js';
import { buildWorkspaceRollup, type RollupRepoFacts } from './rollup.js';

// GET /api/pro/bot-benchmark/placement — THE CUSTOMER SIDE of "how does our bot compare".
//
// `GET /api/pro/bot-benchmark` serves the COHORT and makes no claim about any caller. This route
// computes the caller's OWN metric vector over the corpus's populations, places each
// (repository, vendor) pair in its activity band, reads a percentile off the cell, and emits the
// anomalies that survive both a share and a magnitude gate. They stayed TWO ROUTES because they are
// two decisions with two costs, and mixing them is how a benchmark starts comparing two columns
// that share a name and nothing else.
//
// ⚠ THIS RESPONSE IS TENANT DATA. Unlike the cohort route it is workspace-scoped, echoes
// `workspaceId`, and every read below is account-scoped: `resolveRequestScope` resolves an absent /
// unparseable / foreign `?workspace=` to the account's DEFAULT workspace (never a 404 — no existence
// oracle), and `?repoIds=` survives as DATA NARROWING ONLY, intersected with that workspace's
// membership so the `repoIds ⊆ membership` invariant `BotScopeWire` requires cannot be broken by a
// query parameter.
//
// ENTITLEMENT, three layers (the standard /api/pro/* stack, the bot-behaviour precedent verbatim):
//  1. Registration — the route exists only when the plugin loads; a pure-OSS checkout has no route.
//  2. Self-gate — `botDepth` maps to the paid summary tier (PRO_DIGEST_ENABLED), so a flag-less
//     local run 404s a direct hit instead of leaking the fold.
//  3. Cloud per-account entitlement — the host's AUTOMATIC /api/pro/* 402 gate
//     (api/plugins/auth.ts `registerAuthGate`/`isProPath`). Staying under the `/api/pro/` prefix is
//     the entire reason that is automatic; moving this route out from under it silently makes the
//     benchmark free.
//
// ⚠ THE RATE TIER WAS RE-DECIDED IN THIS CHANGE, which is the standing invariant the cohort route's
// own tier comment wrote down before this fold existed: "if this route ever grows a customer-side
// PLACEMENT leg, the tier must be re-decided IN THAT SAME CHANGE". It is spelled explicitly in
// `apps/backend/src/api/plugins/rate-limit.ts` — NOT inherited from the `/api/pro/` catch-all's
// GET→read branch, which is the 600/min blanket bucket and the wrong answer for a fold that reads
// up to twelve repositories' pull requests, threads and comments per request.

/** ⚠ MIRRORED from `@pierre-review/shared`'s `BOT_BENCHMARK_MAX_PLACEMENT_REPOS` (the plugin only
 *  `import type`s from that package — the AI_CREDITS_PER_USD mirror pattern). Keep in step. */
export const MAX_PLACEMENT_REPOS = 12;

/** Comma-separated positive-int list → number[] | null (null = "no narrowing"). Its result is
 *  NEVER a scope, only the narrow set — see `resolveRequestScope` above. */
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

/** The fold's parameters, READ FROM THE ARTIFACT and never inlined. A build whose `settleHours`
 *  disagreed with the cell it divides against would compare two different questions. */
function foldParamsFrom(loaded: LoadedArtifactOk, nowMs: number): FoldParams {
  const params = isObject(loaded.raw['params']) ? loaded.raw['params'] : {};
  const grace = numArray(params['overdue_grace_hours']);
  return {
    settleHours: num(params['settle_hours'], 72),
    overdueGraceHours: grace.length > 0 ? grace : [72, 168],
    // ⚠ THE ONE PARAM THAT IS NOT THE ARTIFACT'S, AND IT IS NOT READ FROM IT. `COST_WINDOW_DAYS` is
    // the app's own calendar month for the rollup's money; the corpus has no such window and would
    // have nothing to publish here. It is anchored on the REQUEST clock so the window and the
    // thread ages it is compared against come from one instant — `nowMs` is the same value
    // `buildRepoInput` computes `ageSeconds` with.
    costWindow: { fromMs: nowMs - COST_WINDOW_DAYS * 86_400_000, toMs: nowMs },
  };
}

interface MetricSpecLite {
  direction: 'higher_is_better' | 'lower_is_better' | 'neutral';
  unit: string;
  minUnits: number;
}

function metricSpecsFrom(loaded: LoadedArtifactOk): Map<string, MetricSpecLite> {
  const out = new Map<string, MetricSpecLite>();
  const specs = isObject(loaded.raw['metric_specs']) ? loaded.raw['metric_specs'] : {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!isObject(spec)) continue;
    const direction = spec['direction'];
    out.set(name, {
      direction:
        direction === 'higher_is_better' || direction === 'lower_is_better'
          ? direction
          : 'neutral',
      unit: typeof spec['unit'] === 'string' ? spec['unit'] : '',
      minUnits: num(spec['min_units']),
    });
  }
  return out;
}

/** The four sentences a metric can be withheld under, spelled once. */
const EXCLUSION_MESSAGE: Readonly<Record<string, string>> = {
  repo_not_walked:
    'This repository could not be read, so nothing about it is being claimed. (Not reachable ' +
    'from the host, which holds no rows for a repository it cannot read.)',
  // ⚠ THE SCOPE IS PART OF THE CLAIM. This says nothing about the repository as a whole: the fold
  // reads only the `walkBudget` most-recently-updated pull requests, because that is the population
  // the cohort was built from and comparability depends on reading the same slice. The contract
  // measured that cap BINDING in 85.5% of live repositories in the median cell — so a sentence
  // saying "anywhere in this repository" would be an unverified claim about the unread remainder in
  // most cases it fires. It was that sentence, and a reviewer with 20 real findings on older pull
  // requests read as having left none.
  //
  // The fourth cause is the one the original three omitted, and it is the most common: the comments
  // exist and sit outside the window we read.
  vendor_silent:
    'This reviewer left no comment on the pull requests examined here — the most recently ' +
    'updated ones, the same slice the peer cohort was built from — so every rate over it is ' +
    'undefined. Four causes are indistinguishable from here: not installed, scoped to other ' +
    'paths, category-suppressed, or active only on older pull requests outside this window. All ' +
    'four differ from "it commented and was ignored".',
  vendor_absent_from_population:
    'This reviewer is demonstrably live here, but left nothing inside the population this metric ' +
    'measures — typically comments that all sit on pull requests that have not merged.',
  denominator_empty:
    'This reviewer is live in this population and the population itself is empty — a summariser ' +
    'that opens no review threads has no thread-outcome rate.',
  below_min_units:
    'Too small a sample to compare. A per-repository rate over a handful of threads is noise ' +
    'wearing a percentage sign, and the cohort excluded repositories like this one, so there is ' +
    'no distribution this value would have joined.',
  body_unobserved:
    'At least one of this reviewer’s comments has no stored body, so it cannot be told apart ' +
    'from a silent approval. Counting it either way would be a guess.',
};

export function registerBotBenchmarkPlacementRoutes(app: FastifyInstance, ctx: ProContext): void {
  app.get<{ Querystring: { workspace?: string; repoIds?: string } }>(
    '/api/pro/bot-benchmark/placement',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const resolved = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const narrow = parseIntList(req.query.repoIds);
      const scope: BotScopeWire =
        narrow == null
          ? resolved
          : {
              workspaceId: resolved.workspaceId,
              repoIds: resolved.repoIds.filter((id) => narrow.includes(id)),
            };

      const loaded = loadBenchmarkArtifact();
      if (!loaded.ok) {
        // ⚠ 200 AND ONE BANNER, not a 500 and not n identical paragraphs. "No corpus is bundled in
        // this build" is a build-configuration fact, and its sentence is a DIFFERENT sentence from
        // "there isn't enough peer data yet".
        const body: BotBenchmarkPlacementResponse = {
          available: false,
          reason: loaded.reason,
          message: loaded.message,
          workspaceId: scope.workspaceId,
        };
        return body;
      }

      const nowMs = Date.now();
      // ⚠ `narrow != null` IS THE ONE FACT `buildPlacement` CANNOT RECOVER FROM `scope`. A narrowed
      // request and an un-narrowed one against a single-repository workspace produce the SAME scope,
      // and only the first of them may be denied the money. It travels as its own argument for that
      // reason — see `buildPlacement`'s rollup gate.
      const body = await buildPlacement(ctx, accountId, scope, narrow != null, loaded, nowMs);
      return body;
    },
  );
}

async function buildPlacement(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  narrowed: boolean,
  loaded: LoadedArtifactOk,
  nowMs: number,
): Promise<BotBenchmarkPlacementResponse> {
  const params = foldParamsFrom(loaded, nowMs);
  const specs = metricSpecsFrom(loaded);

  const allRepos = await reposInScope(ctx, accountId, scope);
  const repos = allRepos.slice(0, MAX_PLACEMENT_REPOS);

  // PHASE 1 — raw rows for every repository in this request, so the automation resolver sees every
  // actor at once. A per-repository resolver would let one login read as a bot in one repository
  // and a person in the next.
  const raw = [];
  for (const repo of repos) raw.push(await fetchRepoData(ctx, accountId, repo, nowMs));

  const actorIds = new Set<number>();
  for (const data of raw) for (const id of actorIdsOf(data)) actorIds.add(id);
  const automation = await resolveAutomation(ctx, accountId, scope.workspaceId, actorIds);

  // The DECLARED lineup, workspace-wide: a reviewer the workspace runs but that says nothing in
  // THIS repository is `vendor_silent` here, which is a real answer and not an absence.
  const declaredKeys = [...automation.byKey.keys()].sort();

  // ⚠ THE FOLD UNIT'S KEY TRAVELS BESIDE THE WIRE UNIT. The emitted unit carries `vendor`, which is
  // NULL for an unbranded reviewer the corpus has never seen — so it cannot be used to look the
  // price back up. The key is what `automation.byKey` is keyed on, and an unbranded bot's price is
  // exactly as real as a branded one's.
  const built: BuiltUnit[] = [];
  for (const data of raw) {
    const collected: CollectedRepo = buildRepoInput(data, automation, declaredKeys, nowMs);
    for (const foldUnit of foldRepo(collected.input, params)) {
      built.push({
        unit: placeUnit(collected, foldUnit, automation, loaded, specs, params),
        key: foldUnit.vendor,
        // ⚠ THE ROLLUP'S WORK-MEASUREMENT WINDOW, KEYED THE SAME WAY THE UNIT IS. It carries NO
        // money — it annualises this reviewer's throughput IN THIS REPOSITORY so a per-month rate
        // can be stated at today's price, and the estate's pace is the SUM of those per-repository
        // rates rather than a count over a union of these stretches (`rollup.ts` rule 2).
        // `vendorSpans` accumulates in `buildRepoInput`'s own comment loop, so the stretch and the
        // work counted within it are read from one pass over one set of rows.
        span: collected.vendorSpans.get(foldUnit.vendor) ?? null,
        // ⚠ TAKEN OFF THE FOLD UNIT, NOT OFF `unit.counters` — that block is
        // `Record<string, number>` on the wire, so reading it back would need a `?? 0` on the
        // denominator of every money figure on this card. These are `acted_on_rate`'s OWN numerator
        // and denominator, which is why the derived rate agrees with the metric row by construction
        // rather than by coincidence.
        threads: {
          acted: foldUnit.outcome.threadsSettledCompleteActed,
          settled: foldUnit.outcome.threadsSettledComplete,
        },
        // ⚠ THE SAME PAIR INSIDE THE COST WINDOW — the fold's OWN `costWindow` block, produced by
        // the same loop and the same gates one predicate narrower, never a second count taken over
        // the same rows here. This is what the money divides by.
        windowThreads: {
          acted: foldUnit.costWindow.acted,
          settled: foldUnit.costWindow.settled,
        },
        // ⚠ UNROUNDED, unlike `unit.activity.repoHeldDays` (2 dp, for display). It is a THRESHOLD
        // input — a repository held 30.435 days would round up past a 30.44-day gate it fails.
        repoHeldDays: collected.heldDays,
      });
    }
  }
  const truncated = allRepos.length > repos.length;
  // ⚠ THE ROLLUP IS THE ONLY PLACE MONEY TRAVELS, AND A NARROWED REQUEST NEVER BUILDS ONE. This is
  // the STRUCTURAL half of "no money in a repo-grained view": the per-repository cost block is gone
  // from the wire type, and the estate-grained one is not COMPUTED when the caller asked about a
  // subset of repositories. A Workspace price divided by a subset's work is the same upper-bound-
  // wearing-the-grammar-of-a-fact the old `unit.cost` was, so the guarantee has to be "there is no
  // figure in the payload to find" rather than "every present and future renderer declines to draw
  // the one that is". The SPA's per-repository view is exactly a `?repoIds=<one id>` call.
  //
  // ⚠ AND IT IS THE NARROWING THAT DECIDES, NOT THE RESULTING REPOSITORY COUNT. A workspace that
  // genuinely holds one repository gets its rollup: the price and the work then describe the same
  // population, which is the whole test. `?repoIds=` against that same workspace does not, because
  // the caller has told us it is asking a per-repository question.
  const rollup = narrowed
    ? null
    : await buildRollups(ctx, accountId, scope.workspaceId, automation, built, {
        reposConsidered: repos.length,
        truncated,
      });

  // ── DORMANT VENDORS ARE DROPPED HERE, AT EMISSION, AND NOWHERE EARLIER ──────────────────────
  //
  // ⚠ THE POSITION OF THIS FILTER IS THE DESIGN, AND IT IS WHERE THE MONEY IS. `rollup.ts`'s
  // `isLive` decides a card's REPOSITORY POPULATION, which is the denominator of `perMergedPr` and
  // the base of every pooled counter; the fold above therefore runs over the complete declared
  // lineup exactly as it did before this gate existed, and only WHOLE vendor cards and their own
  // units are removed afterwards. Nothing here reaches into the per-repository population of a
  // vendor that IS live, so no surviving card's denominator, spread or expectation moves by a
  // single unit. Filtering `declaredKeys` before the fold would have been the same output today
  // and a trap tomorrow.
  //
  // ⚠ AND IT IS A HIDE, NOT A REFUSAL. `vendor_silent` remains the right answer for a live vendor
  // that said nothing IN ONE REPOSITORY — that refusal is the product. Dormancy is the different
  // claim that the reviewer said nothing ANYWHERE in the workspace for a month, which the Bots ROI
  // table already reports; showing it a cohort percentile while the table calls it dormant was the
  // contradiction. A hidden vendor is ABSENT: no card, no unit, no zero drawn in its place.
  const dormantKeys = await dormantVendorKeys(ctx, accountId, scope.workspaceId, automation);
  const units = built.filter((b) => !dormantKeys.has(b.key)).map((b) => b.unit);
  const visibleRollup = rollup?.filter((card) => !dormantKeys.has(card.key)) ?? null;

  const body: BotBenchmarkPlacementResponse = {
    available: true,
    workspaceId: scope.workspaceId,
    fitKey: typeof loaded.raw['fit_key'] === 'string' ? loaded.raw['fit_key'] : '',
    staleness: staleness(loaded, nowMs),
    params: {
      settleHours: params.settleHours,
      overdueGraceHours: [...params.overdueGraceHours],
      activityWindowDays: ACTIVITY_WINDOW_DAYS,
    },
    units,
    // ⚠ STRUCTURAL ABSENCE, PASSED THROUGH VERBATIM. `high_severity_share` / `nit_share` /
    // `distinct_category_count` are model-derived, the corpus is `unscored`, and they appear in NO
    // cell. It matters most here because the host ALREADY HAS these numbers — ML severity is a
    // shipped free feature — so the temptation is to render the customer's severity distribution
    // against nothing, or against a placeholder.
    absentMetrics: absentMetrics(loaded),
    disclosures: [...DISCLOSURES],
    truncated,
  };
  // ⚠ ABSENT, NEVER `[]`, ON A NARROWED REQUEST — the wire type distinguishes them: `[]` says the
  // fold ran and no vendor was live anywhere in the estate, the missing key says it did not run.
  // A workspace whose only live vendors are dormant lands on `[]`, which is the correct half of
  // that distinction: the fold ran, and there is nothing to show.
  if (visibleRollup != null) body.rollup = visibleRollup;
  return body;
}

/**
 * ONE (repository, vendor) PAIR, WITH THE TWO FACTS THE WIRE UNIT DOES NOT CARRY.
 *
 * ⚠ THE FOLD UNIT'S KEY TRAVELS BESIDE THE WIRE UNIT because `unit.vendor` is `null` for every
 * brand the corpus has never seen, so it can neither look a price back up nor identify a rollup
 * card. `key` is what `automation.byKey` is keyed on, and an unbranded bot's price is exactly as
 * real as a branded one's.
 */
interface BuiltUnit {
  unit: BotBenchmarkPlacementUnit;
  key: string;
  span: VendorSpan | null;
  threads: ActedThreadCounts;
  /** The same two counts inside `COST_WINDOW_DAYS` — a SUBSET of `threads` by construction. */
  windowThreads: ActedThreadCounts;
  /** Unrounded days held, the cost window's own completeness threshold. */
  repoHeldDays: number;
}

/**
 * THE WORKSPACE ROLLUP — one card per vendor, folded over every repository this request read.
 *
 * It is a SECOND PASS over the whole response and has to be, for the same reason the cost pass
 * before it was: a per-vendor answer cannot be produced while the (repository, vendor) units are
 * still being built one repository at a time.
 *
 * ⚠ THE GRAIN IS THE POINT, AND IT IS WHY THE PER-REPOSITORY COST BLOCK IS GONE. The price lives on
 * ONE `workspace_reviewers` row per (account, WORKSPACE, actor), while a unit is one (repository,
 * vendor) pair — so one $120/month subscription over six repositories used to emit SIX blocks each
 * carrying $120, each an upper bound, under a "do not add these up" caveat. That caveat was
 * compensating for a grain mismatch. Folding to the vendor removes the mismatch instead: one card,
 * one price, one population, and double-counting is not something a reader can do.
 *
 * ⚠ THE SEAT COUNT IS ONE QUERY PER REQUEST, NOT ONE PER UNIT OR ONE PER CARD. `per_seat`
 * multiplies on read by the workspace's derived human seat count — a fixed-window aggregate over
 * the workspace's membership — and it is the SAME number for every reviewer in the response. It is
 * fetched only when some reviewer in this workspace actually carries a per-seat price, so the
 * common all-flat (and the very common no-price) workspace pays nothing for this feature at all.
 *
 * ⚠ "LIVE" IS NOT DECIDED HERE. `buildWorkspaceRollup` owns that predicate — see its header — and
 * this pass hands it EVERY repository's facts, silent ones included, so there is exactly one
 * definition of which repositories a card's sums are over.
 */
async function buildRollups(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  automation: WorkspaceAutomation,
  built: readonly BuiltUnit[],
  response: { reposConsidered: number; truncated: boolean },
): Promise<BotBenchmarkWorkspaceRollup[]> {
  // ⚠ `unitMonthlyUsd != null` IS THE GATE, NOT TRUTHINESS. A per-seat price of 0 is a real price
  // and still needs a seat count to be read as $0 rather than as "unresolved".
  const needsSeats = automation.reviewers.some(
    (r) => r.unitMonthlyUsd != null && r.costModel === 'per_seat',
  );
  let seats: number | null = null;
  if (needsSeats) {
    // ⚠ OPTIONAL SEAM (apiVersion stays 21). Absent ⇒ a per-seat price is UNRESOLVABLE, and
    // `resolveUnitPrice` drops it and counts it rather than reading the per-developer unit as the
    // monthly figure — which would understate the cost by the seat count, silently.
    const answer = await ctx.queries.workspaceHumanSeatCount?.(accountId, workspaceId);
    seats = typeof answer === 'number' && Number.isFinite(answer) ? answer : null;
  }

  // ⚠ ONE PER-SEAT MULTIPLY, THROUGH `resolveUnitPrice` AND NOWHERE ELSE — and now once per VENDOR
  // rather than once per (repository, vendor), which is the grain the price was always stored at.
  const priceFor = (key: string): ResolvedUnitPrice | null =>
    resolveUnitPrice(
      (automation.byKey.get(key) ?? []).map((r) => ({
        unitMonthlyUsd: r.unitMonthlyUsd,
        costModel: r.costModel,
      })),
      seats,
    );

  // Grouped in the order the units were built — repository-major — so a card's evidence table reads
  // in the same order the repositories were folded. The CARDS are sorted by key below, which is the
  // order `declaredKeys` already puts the workspace's lineup in.
  const byKey = new Map<string, RollupRepoFacts[]>();
  for (const b of built) {
    const facts = byKey.get(b.key) ?? [];
    facts.push(factsOf(b));
    byKey.set(b.key, facts);
  }

  const out: BotBenchmarkWorkspaceRollup[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const first = automation.byKey.get(key)?.[0] ?? null;
    const card = buildWorkspaceRollup({
      key,
      vendor: first?.vendor ?? null,
      botKind: first?.kind ?? null,
      reviewers: (automation.byKey.get(key) ?? []).map((r) => ({
        userId: r.userId,
        login: r.login,
        label: r.label,
      })),
      repos: byKey.get(key) ?? [],
      reposConsidered: response.reposConsidered,
      price: priceFor(key),
      windowDays: ACTIVITY_WINDOW_DAYS,
      truncated: response.truncated,
    });
    // ⚠ NO CARD AT ALL FOR A VENDOR THAT SAID NOTHING ANYWHERE — absent, never an empty card. The
    // workspace's DECLARED lineup emits a unit for every reviewer in every repository, so a bot
    // nobody has installed yet arrives here with n all-zero units; a card for it would be a column
    // of zeros about a reviewer that has not been given the chance to do anything, which is the
    // "missing thing rendered as a zero" this whole tab exists to refuse. The per-repository unit
    // still ships and still says `vendor_silent`, which is where that answer belongs.
    if (card.liveInRepos > 0) out.push(card);
  }
  return out;
}

/**
 * ONE UNIT'S FACTS, LIFTED — never re-derived.
 *
 * ⚠ EVERY FIELD IS READ OFF THE UNIT THE ROUTE ALREADY BUILT, so the estate card and the
 * repository's own card cannot disagree about a number they both display. The two exceptions are
 * the two things the wire unit does not carry, and both are read through the module that owns them:
 * `spanDays` through `cost.ts`'s `resolveSpan` (a second span rule that agreed on two of its three
 * guards would put an Infinity on one card and a refusal on the other), and the thread counts off
 * the FOLD unit rather than off `unit.counters`, which is `Record<string, number>` on the wire and
 * would need a `?? 0` on the denominator of every money figure.
 */
function factsOf(b: BuiltUnit): RollupRepoFacts {
  return {
    repoId: b.unit.repoId,
    repoOwner: b.unit.repoOwner,
    repoName: b.unit.repoName,
    // ⚠ THE BANDING AXIS, ANY AUTHOR — the same number the placement used, so the money and the
    // placement cannot disagree about how busy the fortnight was.
    mergedPrsLast14d: b.unit.activity.mergedPrsLast14d,
    // Carries the `repo_window_incomplete` refusal the rollup keeps out of its merge sum, and the
    // band the evidence row prints.
    placement: b.unit.placement,
    counters: b.unit.counters,
    actedOnRateMetric: b.unit.metrics[ACTED_ON_RATE],
    repoHeldDays: b.repoHeldDays,
    // ⚠ A DISCLOSURE NOW, NOT A DIVISOR. Still read through `cost.ts`'s `resolveSpan` — one span
    // rule, one place — but the money on the card no longer divides by it; it is the evidence
    // table's observation-period column.
    spanDays: resolveSpan(b.span)?.days ?? null,
    // ⚠ THE REAL COUNTS, NOT A PROJECTION — `cost.ts` rule 5, and they are `acted_on_rate`'s OWN
    // numerator and denominator, so the pooled rate agrees with the metric rows by construction.
    settled: b.threads.settled,
    acted: b.threads.acted,
    // ⚠ THE MONEY'S OWN PAIR. Same gates, one calendar month narrower.
    settledInWindow: b.windowThreads.settled,
    actedInWindow: b.windowThreads.acted,
  };
}

/** The fitter's own name for the one metric the rollup reads. Spelled identically in `cost.ts` and
 *  `rollup.ts`, so a withheld-rate refusal stays joinable to the metric row it is about. */
const ACTED_ON_RATE = 'acted_on_rate';

/** Caveats that are NOT refusals — every one is a limit of the comparison, disclosed rather than
 *  used to withhold it. */
const DISCLOSURES: readonly string[] = [
  'The cohort’s activity window is a fixed historical fortnight; yours is the last fourteen ' +
    'days. Comparable in length, not in calendar position — seasonality is not modelled.',
  'The corpus is built from GH Archive, which sees PUBLIC repositories only. A private repository ' +
    'is still placed; the peer group it is placed against is public.',
  'Your pull-request set is capped the way the corpus walk capped its own: the most recently ' +
    'updated pull requests, budgeted from the repository’s merge rate. Folding over your whole ' +
    'history instead would measure older threads than any cohort describes.',
  'Thread ages are computed against the request clock, while the corpus froze them at observation. ' +
    'Both ask "was this thread at least 72 hours old when we looked", but your history is deeper, ' +
    'so your overdue and resolved rates read slightly worse for that reason alone.',
];

function staleness(
  loaded: LoadedArtifactOk,
  nowMs: number,
): { corpusAgeDays: number; state: BotBenchmarkStaleness } {
  // ⚠ RECOMPUTED, NEVER COPIED. The stored `corpus_age_days`/`state` pair is as-of `generated_at`
  // and DECAYS ON DISK; passing it through ships a corpus that reports "fresh" forever.
  const corpus = isObject(loaded.raw['corpus']) ? loaded.raw['corpus'] : {};
  const stored = isObject(loaded.raw['staleness']) ? loaded.raw['staleness'] : {};
  const th = isObject(stored['thresholds_days']) ? stored['thresholds_days'] : {};
  const t = Date.parse(typeof corpus['observed_at_max'] === 'string' ? corpus['observed_at_max'] : '');
  if (!Number.isFinite(t)) return { corpusAgeDays: 0, state: 'expired' };
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  const state: BotBenchmarkStaleness =
    ageDays >= num(th['expired'], 180)
      ? 'expired'
      : ageDays >= num(th['stale'], 90)
        ? 'stale'
        : ageDays >= num(th['aging'], 30)
          ? 'aging'
          : 'fresh';
  return { corpusAgeDays: Math.round(ageDays * 1e6) / 1e6, state };
}

function absentMetrics(loaded: LoadedArtifactOk): BotBenchmarkAbsentMetric[] {
  const raw = loaded.raw['absent_metrics'];
  if (!Array.isArray(raw)) return [];
  const out: BotBenchmarkAbsentMetric[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    out.push({
      name: typeof entry['name'] === 'string' ? entry['name'] : '',
      definition: typeof entry['definition'] === 'string' ? entry['definition'] : '',
      derivation: entry['derivation'] === 'model' ? 'model' : 'code',
      direction:
        entry['direction'] === 'higher_is_better' || entry['direction'] === 'lower_is_better'
          ? entry['direction']
          : 'neutral',
      unit: typeof entry['unit'] === 'string' ? entry['unit'] : '',
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
      note: typeof entry['note'] === 'string' ? entry['note'] : '',
      requires: Object.fromEntries(
        Object.entries(isObject(entry['requires']) ? entry['requires'] : {}).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      ),
    });
  }
  return out;
}

function countersOf(unit: FoldUnit): BotBenchmarkPlacementCounters {
  return {
    volume: {
      commentsObserved: unit.volume.commentsObserved,
      mergedEligible: unit.volume.mergedEligible,
      findingComments: unit.volume.findingComments,
      emptyBodyComments: unit.volume.emptyBodyComments,
      prsWithFinding: unit.volume.prsWithFinding,
      threads: unit.volume.threads,
    },
    outcome: {
      commentsObserved: unit.outcome.commentsObserved,
      threadsSettled: unit.outcome.threadsSettled,
      threadsSettledResolved: unit.outcome.threadsSettledResolved,
      threadsSettledOutdated: unit.outcome.threadsSettledOutdated,
      threadsSettledComplete: unit.outcome.threadsSettledComplete,
      threadsSettledCompleteReplied: unit.outcome.threadsSettledCompleteReplied,
      threadsSettledCompleteFollowed: unit.outcome.threadsSettledCompleteFollowed,
      threadsSettledCompleteActed: unit.outcome.threadsSettledCompleteActed,
      threadsSettledCompleteActedOutdated: unit.outcome.threadsSettledCompleteActedOutdated,
      threadsTruncated: unit.outcome.threadsTruncated,
      anchoredThreads: unit.outcome.anchoredThreads,
      anchoredOverlapping: unit.outcome.anchoredOverlapping,
      repliedThreads: unit.outcome.replyHours.length,
    },
    overdueEligible: { ...unit.outcome.overdueEligible },
    overdueUntouched: { ...unit.outcome.overdueUntouched },
    repository: {
      mergedMachineAuthored: unit.repositoryDisclosure.mergedMachineAuthored,
      prsDetailUnobserved: unit.repositoryDisclosure.prsDetailUnobserved,
      prsObserved: unit.repositoryDisclosure.prsObserved,
    },
  };
}

function placeUnit(
  collected: CollectedRepo,
  foldUnit: FoldUnit,
  automation: WorkspaceAutomation,
  loaded: LoadedArtifactOk,
  specs: Map<string, MetricSpecLite>,
  params: FoldParams,
): BotBenchmarkPlacementUnit {
  const reviewers = (automation.byKey.get(foldUnit.vendor) ?? []).map((r) => ({
    userId: r.userId,
    login: r.login,
    label: r.label,
  }));
  const first = automation.byKey.get(foldUnit.vendor)?.[0] ?? null;
  const vendor = first?.vendor ?? null;

  const evaluated = evaluateUnit(foldUnit, params);
  const placement = cohortFor(collected, vendor, loaded);

  const metrics: Record<string, BotBenchmarkPlacementMetric> = {};
  const cellMetrics =
    placement.status === 'placed' && isObject(placement.cell['metrics'])
      ? placement.cell['metrics']
      : {};
  for (const [name, outcome] of Object.entries(evaluated)) {
    metrics[name] = compare(name, outcome, cellMetrics, specs);
  }

  return {
    repoId: collected.repoId,
    repoOwner: collected.owner,
    repoName: collected.name,
    reviewers,
    vendor,
    botKind: first?.kind ?? null,
    activity: {
      mergedPrsLast14d: collected.mergedPrsLast14d,
      walkBudget: collected.walkBudget,
      prsConsidered: collected.prsConsidered,
      repoHeldDays: Math.round(collected.heldDays * 100) / 100,
    },
    placement: placement.wire,
    counters: countersOf(foldUnit),
    metrics,
    anomalies:
      placement.status === 'placed'
        ? anomaliesFor(metrics, {
            cohortRepos: placement.cohortRepos,
            bandLabel: placement.bandLabel,
            // The brand name the card is already headed with. `null` for an unbranded account,
            // where every action sentence falls back to "This reviewer" and still reads.
            reviewerName: first?.label ?? null,
          })
        : [],
  };
}

type CohortResolution =
  | {
      status: 'placed';
      wire: BotBenchmarkPlacementCohort;
      cell: Record<string, unknown>;
      cohortRepos: number;
      bandLabel: string;
    }
  | { status: 'refused'; wire: BotBenchmarkPlacementCohort };

function cohortFor(
  collected: CollectedRepo,
  vendor: string | null,
  loaded: LoadedArtifactOk,
): CohortResolution {
  // ⚠ THE ONE REFUSAL ABOUT THE CUSTOMER RATHER THAN THE CORPUS, AND IT IS FIRST. A repository the
  // host has held for less than the activity window has a PARTIAL window, so its merged-PR count
  // is an undercount and would place it too LOW — silently, and in the direction that flatters
  // nobody in particular, which is why it has to be a refusal rather than a caveat.
  if (collected.heldDays < ACTIVITY_WINDOW_DAYS) {
    return {
      status: 'refused',
      wire: {
        status: 'refused',
        reason: 'repo_window_incomplete',
        message:
          `This repository has been tracked for ${collected.heldDays.toFixed(1)} days, less than ` +
          `the ${ACTIVITY_WINDOW_DAYS}-day activity window the cohort is banded on. Its merge ` +
          'count is an undercount, which would place it in a quieter band than it belongs to.',
        observed: { repoHeldDays: Math.round(collected.heldDays * 100) / 100 },
        required: { repoHeldDays: ACTIVITY_WINDOW_DAYS },
      },
    };
  }
  // ⚠ AND ITS SIBLING: A FULL WINDOW THE REPOSITORY SIMPLY DID NOT USE. `walkBudget` is derived
  // from the merge count, so zero merges in the window means the fold reads ZERO pull requests —
  // and every reviewer then comes back `vendor_silent`, "said nothing here", no matter how much it
  // actually wrote. Reproduced: a repository with 20 merged pull requests carrying 20 CodeRabbit
  // findings, all merged 40 days ago, reported all thirteen metrics as silence.
  //
  // That is not a measurement of the reviewer, it is an empty read being described as one. The
  // distinction is the whole feature: an empty read must refuse, never resolve to a claim about a
  // bot. Placed BEFORE the vendor check because it is a fact about the repository and holds
  // whatever the reviewer turns out to be.
  if (collected.mergedPrsLast14d <= 0) {
    return {
      status: 'refused',
      wire: {
        status: 'refused',
        reason: 'repo_inactive_in_window',
        message:
          `This repository merged nothing in the ${ACTIVITY_WINDOW_DAYS}-day window the cohort is ` +
          'banded on, so there is no slice of work to read and nothing here is a statement about ' +
          'any reviewer. Older activity is not measured: the cohort is built from recent work, ' +
          'and reading further back would compare this repository against a window no peer used.',
        observed: { mergedPrsLast14d: collected.mergedPrsLast14d },
        required: { mergedPrsLast14d: 1 },
      },
    };
  }
  if (vendor == null) {
    return {
      status: 'refused',
      wire: {
        status: 'refused',
        reason: 'vendor_not_in_corpus_vocabulary',
        message:
          'The corpus has never measured this reviewer. It may be a product the walk has not ' +
          'seen, or an unbranded reviewer with no vendor identity at all.',
      },
    };
  }
  const result = resolvePlacement(loaded, vendor, collected.mergedPrsLast14d);
  if (result.status === 'refused') {
    const wire: BotBenchmarkPlacementCohort = {
      status: 'refused',
      reason: result.reason,
      message: result.message,
    };
    if (result.observed != null) wire.observed = result.observed;
    if (result.required != null) wire.required = result.required;
    return { status: 'refused', wire };
  }
  return {
    status: 'placed',
    wire: {
      status: 'placed',
      activityBand: result.band,
      nBands: result.nBands,
      bandLabel: result.bandLabel,
      bandRange: result.bandRange,
      cohortRepos: result.cohortRepos,
      aboveTopBandBy: result.aboveTopBandBy,
    },
    cell: result.cell,
    cohortRepos: result.cohortRepos,
    bandLabel: result.bandLabel,
  };
}

/**
 * One metric: the customer's own outcome, met with the cohort's.
 *
 * ⚠ THREE ARMS, AND THEY ARE NOT INTERCHANGEABLE. A metric the CUSTOMER cannot report is
 * `excluded` with the gate that fired; a metric the customer HAS but the COHORT refused is
 * `uncompared` and carries the value with no percentile; only a metric both sides fitted is
 * `compared`. Reading a percentile off either of the first two must be impossible at compile time,
 * which is what the discriminated union buys — the alternative (`percentile: 0`) turns "we refuse
 * to answer" into "the answer is the worst in the cohort".
 */
function compare(
  name: string,
  outcome: MetricOutcome,
  cellMetrics: Record<string, unknown>,
  specs: Map<string, MetricSpecLite>,
): BotBenchmarkPlacementMetric {
  if (outcome.status === 'excluded') {
    return {
      status: 'excluded',
      reason: outcome.reason,
      message: EXCLUSION_MESSAGE[outcome.reason] ?? 'Withheld.',
    };
  }
  const rawCell = cellMetrics[name];
  const spec = specs.get(name);
  if (!isObject(rawCell) || spec == null) {
    return {
      status: 'uncompared',
      value: outcome.value,
      units: outcome.units,
      reason: 'cohort_metric_refused',
      cohortRefusal: {
        rule: 'cell_absent',
        message: 'No cohort is available for this metric at this key.',
      },
    };
  }
  const cohortMetric = mapMetric(rawCell);
  if (cohortMetric.status !== 'fitted') {
    return {
      status: 'uncompared',
      value: outcome.value,
      units: outcome.units,
      reason: 'cohort_metric_refused',
      cohortRefusal: {
        rule: cohortMetric.refusal.rule,
        message: cohortMetric.refusal.message,
      },
    };
  }
  const percentile = percentileOf(cohortMetric, outcome.value);
  if (percentile == null) {
    return {
      status: 'uncompared',
      value: outcome.value,
      units: outcome.units,
      reason: 'cohort_metric_refused',
      cohortRefusal: {
        rule: 'grid_unreadable',
        message: 'The cohort published no readable distribution for this metric.',
      },
    };
  }
  return {
    status: 'compared',
    value: outcome.value,
    units: outcome.units,
    percentile,
    cohort: {
      nRepos: cohortMetric.nRepos,
      quantiles: cohortMetric.quantiles,
      ciMedian95: cohortMetric.ciMedian95,
      direction: spec.direction,
      minUnits: spec.minUnits,
      unit: spec.unit,
    },
  };
}

/**
 * THE WORKSPACE'S DORMANT FOLD KEYS — vendors this tab must not draw at all.
 *
 * ⚠ ONE PREDICATE, AND IT LIVES IN CORE. `ctx.queries.dormantBotUserIds` is core's
 * `db/bot-dormancy.ts`: of the candidate reviewer ids we hand it, the ones with NO review thread,
 * review comment or submitted review anywhere in this WORKSPACE over a FIXED trailing 30 days —
 * the same evidence union the Bots ROI table calls a reviewer `dormant` on. Recomputing it here
 * would be a second sentence about the same bot, which is exactly the contradiction this removes.
 *
 * ⚠ THE WINDOW IS NOT THE ROI TABLE'S CHIP. That control is a reader affordance about the current
 * view; this is a fact about the reviewer, and a peer placement that vanished because somebody
 * flipped a window selector on another tab would be worse than the contradiction it fixed.
 *
 * ⚠ A KEY IS DORMANT ONLY WHEN EVERY LOGIN UNDER IT IS. Two accounts the workspace classifies as
 * one vendor are ONE card (`byKey` is an array on purpose), so one live login keeps the vendor —
 * the conservative direction, and the only one that cannot hide observed work.
 *
 * ⚠ THE ROLE ASYMMETRY IS NOT A BUG. This lineup is `role === 'review'` only, while the ROI table
 * computes every role and splits linters into their own section — so a dormant quality check has no
 * card here to hide, and this returns keys rather than user ids for exactly that reason: there is
 * no 1:1 mapping between an ROI row and a benchmark unit.
 *
 * ⚠ THE SEAM IS OPTIONAL (apiVersion stays 21). An older host has no `dormantBotUserIds`, and the
 * honest degradation is to hide NOTHING — the tab then behaves exactly as it did before this gate,
 * which is a known-good state, rather than guessing at dormancy from the fold's own counters.
 */
async function dormantVendorKeys(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  automation: WorkspaceAutomation,
): Promise<Set<string>> {
  const out = new Set<string>();
  const resolve = ctx.queries.dormantBotUserIds;
  if (resolve == null || automation.reviewers.length === 0) return out;
  const candidates = automation.reviewers.map((r) => r.userId);
  let dormant: Set<number>;
  try {
    dormant = new Set(await resolve.call(ctx.queries, accountId, workspaceId, candidates));
  } catch (err) {
    // A dormancy read that failed must not take the whole placement with it: the tab's job is the
    // comparison, and hiding is a refinement of it. Show everything and say so in the log.
    ctx.log.warn({ err }, 'bot-benchmark: dormancy resolution failed; hiding nothing');
    return out;
  }
  for (const [key, reviewers] of automation.byKey) {
    if (reviewers.length > 0 && reviewers.every((r) => dormant.has(r.userId))) out.add(key);
  }
  return out;
}

// THE CUSTOMER'S OWN METRIC VECTOR, per (repository, vendor) — the TypeScript half of the
// cross-language metric contract.
//
// Definitions: `packages/ml/docs/METRIC-CONTRACT.md`. Reference implementation:
// `bot_monitor.panel.fit`'s `read_corpus` fold + `evaluate_metric`. Proof that the two agree:
// `test/benchmark-metric-contract.test.ts` drives the golden fixture
// (`test/fixtures/metric-contract-v1.json`, emitted by the REAL Python fold) through this module
// and compares every counter and every value with `===`.
//
// ⚠ THIS FILE IMPLEMENTS THE CORPUS'S DEFINITIONS, NOT THE APP'S. The host already has columns
// with these names and they are DIFFERENT COLUMNS: `getBotAnalytics.actedOnPct` folds the
// `likely_addressed` commit heuristic into its numerator and divides by every in-window thread;
// `overdueUntouched` uses a fixed 36 h grace; `overlapPct` clusters anchors within ±3 lines.
// Plotting any of those against a cohort grid fitted on the definitions below compares two
// questions and renders the difference as a finding. Nothing in this file may be "simplified" by
// reaching for an existing app fold.
//
// ⚠ THE ONE EXCEPTION IS NAMED, FENCED AND FEEDS NO METRIC: `FoldParams.costWindow` and
// `FoldUnit.costWindow`. They narrow the settled/acted pair to a chosen calendar month for the
// Workspace rollup's money and are absent from `OutcomeCounters`, from `countersOf` and from every
// metric in the table below — so the golden fixture drives this fold to the same numbers with the
// param unset. They live here rather than in `collect.ts` because they must share this pass's
// gates exactly; see `FoldUnit.costWindow`.
//
// ── THE FIVE THINGS A PORT GETS WRONG ───────────────────────────────────────────────────────────
//  1. `thread_resolved_rate` divides by ALL settled threads INCLUDING TRUNCATED ONES. Every other
//     outcome metric divides by the complete-only set. Copying one denominator across the family
//     is the likeliest single error in the whole port, and it is wrong only on repositories with
//     long threads — i.e. the busy ones.
//  2. The OVERDUE family does not chain through `settleHours`. It is evaluated BEFORE the settle
//     guard, deliberately, so that one parameter cannot silently redefine another under an
//     unchanged name.
//  3. The live gate (`commentsObserved`) and the numerator must be read off THE SAME population
//     object. Reading the gate over the wider population while dividing in the narrower one is a
//     defect that already shipped in fit.py and fitted a demonstrably live vendor as a hard 0.0.
//  4. A truncated thread's human-side facts are UNKNOWN, not false. Counting one as "not replied"
//     manufactures an overdue-untouched rate out of paging.
//  5. On an EVEN sample the median is the MEAN OF THE TWO MIDDLE VALUES (Python's
//     `statistics.median`). The lower-median convention disagrees and is invisible until it
//     matters.

/** `settle_hours` and `overdue_grace_hours` are read from the artifact's own `params`, never
 *  inlined at a call site. These are the shapes they arrive in. */
export interface FoldParams {
  settleHours: number;
  overdueGraceHours: readonly number[];
  /**
   * ⚠ THE APP'S OWN WINDOW, AND THE ONE THING IN THIS FILE THE CORPUS DOES NOT DEFINE. Everything
   * else here is `packages/ml/docs/METRIC-CONTRACT.md` ported; this is a CHOSEN calendar month that
   * only the money on the Workspace rollup reads (`cost.ts`'s `COST_WINDOW_DAYS`). It rides the
   * fold rather than a second pass over the same rows because the alternative — re-deciding the
   * settle gate, the completeness gate, the outcome population and the acted-on definition in
   * `collect.ts` — is four chances to disagree with the counters the same threads produce two
   * lines up. `null`/absent ⇒ `costWindow` counts stay 0 and NOTHING ELSE MOVES, which is what
   * keeps the golden fixture (`test/fixtures/metric-contract-v1.json`) driving this fold unchanged.
   */
  costWindow?: { fromMs: number; toMs: number } | null;
}

// ── The neutral input rows ──────────────────────────────────────────────────────────────────────
//
// Deliberately the golden fixture's own schema, which names no column of either side. The host
// adapter (`collect.ts`) builds these from `ctx.schema`; the fixture test feeds them in verbatim.
// A shape that named host columns would make the fixture untestable without a database, and a
// shape that named corpus columns would make the collector read like a translation of a file
// format it never sees.

export interface FoldPull {
  number: number;
  merged: boolean;
  /** ANY automation, not "a review vendor" — see `collect.ts`'s machine set. */
  authorIsMachine: boolean;
  /** Host-side always true (the host syncs detail for every PR it holds); the corpus can say no. */
  detailObserved: boolean;
}

export interface FoldThread {
  id: string;
  pr: number;
  /** The distinct corpus-vendor strings over this thread's comments' authors. A thread two
   *  vendors touched counts for BOTH — the question is what each generated. */
  vendors: readonly string[];
  path: string | null;
  /** ⚠ `null` ⇒ NO ANCHOR. An anchorless thread leaves BOTH halves of the overlap rate rather
   *  than counting as non-overlapping. */
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  /** `false` ⇒ the comment tail was not read to exhaustion; every human-side fact below is null. */
  tailComplete: boolean;
  humanReplied: boolean | null;
  humanFollowedLastBot: boolean | null;
  ageSeconds: number | null;
  secondsToFirstHumanReply: number | null;
  /** ⚠ ABSOLUTE, AND OPTIONAL BECAUSE THE CORPUS FIXTURE HAS NO SUCH COLUMN. `ageSeconds` is the
   *  corpus's own shape (an age frozen at observation) and cannot answer "did this thread settle
   *  INSIDE a named calendar window" without smuggling the request clock back in. Read ONLY by the
   *  `costWindow` pass; absent ⇒ that pass counts nothing for this thread. */
  createdAtMs?: number | null;
}

export interface FoldComment {
  pr: number;
  /** The corpus vendor string this comment is attributed to; `null` when unattributed. */
  vendor: string | null;
  /** The corpus's `is_review_bot`: this comment is a recognised review vendor's. */
  isVendorComment: boolean;
  /** ⚠ THREE STATES. `> 0` a finding · `0` a silent approval (proves the vendor ran, never a
   *  finding) · `null` UNOBSERVED — host-side only, where `body` and `excerpt` are both null on a
   *  legacy lean-window row. A null is not a zero: the unit refuses the two body-reading volume
   *  metrics rather than guessing. */
  bodyChars: number | null;
}

export interface FoldRepoInput {
  repo: string;
  /** `'ok'` or a walk failure. Host-side ALWAYS `'ok'` — a repository the host cannot read has no
   *  rows at all — but the guard ships because its ORDER is load-bearing: `repo_not_walked` is
   *  tested before `vendor_silent`, so a partially-read repository is never read as a quiet bot. */
  walkStatus: string;
  /** The vendor lineup DECLARED for this repository. Seeds a unit per vendor so `vendor_silent`
   *  has something to report; corpus-side it is `panel_vendors`, host-side the workspace's
   *  review-role automated reviewers. Threads and comments create units for anything else. */
  declaredVendors: readonly string[];
  pulls: readonly FoldPull[];
  threads: readonly FoldThread[];
  comments: readonly FoldComment[];
}

// ── The counters ────────────────────────────────────────────────────────────────────────────────
//
// ⚠ PUBLISHED IN FULL AND COMPARED FIRST. A metric value that disagrees with the fixture says
// something is wrong; a counter that disagrees says WHICH population, WHICH gate and WHICH row.
// The names are the Python attribute names verbatim, camelised, so a reader can grep
// `bot_monitor.panel.fit` for any of them and land on the line that increments it.

export interface VolumeCounters {
  commentsObserved: number;
  mergedEligible: number;
  findingComments: number;
  emptyBodyComments: number;
  prsWithFinding: number;
  threads: number;
}

export interface OutcomeCounters {
  commentsObserved: number;
  threadsSettled: number;
  threadsSettledResolved: number;
  threadsSettledOutdated: number;
  threadsSettledComplete: number;
  threadsSettledCompleteReplied: number;
  threadsSettledCompleteFollowed: number;
  threadsSettledCompleteActed: number;
  threadsSettledCompleteActedOutdated: number;
  threadsTruncated: number;
  /** grace hours → count. Keyed by the number as a STRING so it survives JSON verbatim. */
  overdueEligible: Record<string, number>;
  overdueUntouched: Record<string, number>;
  /** ASCENDING. Sorted once at the end of the fold — the median needs it and the fixture
   *  publishes it sorted, so there is no second ordering to keep in step. */
  replyHours: number[];
  anchoredThreads: number;
  anchoredOverlapping: number;
}

/** Repository-level disclosure. Belongs to no vendor's population and is never a numerator. */
export interface RepositoryDisclosure {
  mergedMachineAuthored: number;
  prsDetailUnobserved: number;
  prsObserved: number;
}

export interface FoldUnit {
  repo: string;
  vendor: string;
  walkStatus: string;
  volume: VolumeCounters;
  outcome: OutcomeCounters;
  repositoryDisclosure: RepositoryDisclosure;
  /** ⚠ CUSTOMER-SIDE ONLY, and it has no corpus counterpart. At least one of this vendor's
   *  comments inside the VOLUME population could not be classified as a finding or an approval
   *  (body and excerpt both null). The two body-reading volume metrics refuse rather than guess. */
  volumeBodyUnobserved: boolean;
  /**
   * ⚠ THE SAME THREADS AS `threadsSettledComplete` / `threadsSettledCompleteActed`, NARROWED TO A
   * CHOSEN CALENDAR MONTH — and DELIBERATELY NOT A MEMBER OF `OutcomeCounters`.
   *
   * `countersOf` publishes that block onto the wire and `test/benchmark-metric-contract.test.ts`
   * compares it against the Python fold key by key; a customer-side window has no corpus
   * counterpart, so putting it there would either fail that comparison or force the fixture to
   * carry a column `bot_monitor.panel.fit` does not compute. It is a sibling instead: same loop,
   * same gates, no metric reads it, and a build with no `costWindow` param leaves it at 0/0.
   *
   * `settled` is `acted`'s denominator, on ONE population, so a rate off these two agrees with the
   * counts printed beside it by construction — `cost.ts`'s "the metric is the gate and the counters
   * are the value", one window in.
   */
  costWindow: { settled: number; acted: number };
}

function emptyVolume(): VolumeCounters {
  return {
    commentsObserved: 0,
    mergedEligible: 0,
    findingComments: 0,
    emptyBodyComments: 0,
    prsWithFinding: 0,
    threads: 0,
  };
}

function emptyOutcome(graceHours: readonly number[]): OutcomeCounters {
  const eligible: Record<string, number> = {};
  const untouched: Record<string, number> = {};
  for (const h of graceHours) {
    eligible[String(h)] = 0;
    untouched[String(h)] = 0;
  }
  return {
    commentsObserved: 0,
    threadsSettled: 0,
    threadsSettledResolved: 0,
    threadsSettledOutdated: 0,
    threadsSettledComplete: 0,
    threadsSettledCompleteReplied: 0,
    threadsSettledCompleteFollowed: 0,
    threadsSettledCompleteActed: 0,
    threadsSettledCompleteActedOutdated: 0,
    threadsTruncated: 0,
    overdueEligible: eligible,
    overdueUntouched: untouched,
    replyHours: [],
    anchoredThreads: 0,
    anchoredOverlapping: 0,
  };
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

interface PullFacts {
  volumePopulation: boolean;
  outcomePopulation: boolean;
  machineAuthored: boolean;
  detailUnobserved: boolean;
  merged: boolean;
}

function pullFacts(pull: FoldPull): PullFacts {
  const observed = pull.detailObserved;
  const machine = pull.authorIsMachine;
  return {
    volumePopulation: pull.merged && observed && !machine,
    outcomePopulation: observed && !machine,
    machineAuthored: machine,
    detailUnobserved: !observed,
    merged: pull.merged,
  };
}

/**
 * One repository's rows → one `FoldUnit` per (repository, vendor), in `vendor` order.
 *
 * Mirrors `read_corpus`'s pass order exactly: pulls, then the anchor index, then threads, then
 * comments, then the repository-level denominators. The order is not cosmetic — the anchor index
 * is built over EVERY thread in the repository regardless of population (pass 3a in fit.py has no
 * population gate), so a thread on a machine-authored pull request still proves that two vendors
 * touched a line.
 */
export function foldRepo(input: FoldRepoInput, params: FoldParams): FoldUnit[] {
  const grace = params.overdueGraceHours;
  const settleSeconds = params.settleHours * 3600;
  const costWindow = params.costWindow ?? null;
  const units = new Map<string, FoldUnit>();

  const unitFor = (vendor: string): FoldUnit => {
    const existing = units.get(vendor);
    if (existing != null) return existing;
    const created: FoldUnit = {
      repo: input.repo,
      vendor,
      walkStatus: input.walkStatus,
      volume: emptyVolume(),
      outcome: emptyOutcome(grace),
      repositoryDisclosure: {
        mergedMachineAuthored: 0,
        prsDetailUnobserved: 0,
        prsObserved: 0,
      },
      volumeBodyUnobserved: false,
      costWindow: { settled: 0, acted: 0 },
    };
    units.set(vendor, created);
    return created;
  };

  // The DECLARED lineup gets a unit whether or not it is ever observed — that is what gives
  // `vendor_silent` something to report instead of the vendor simply not appearing.
  for (const vendor of input.declaredVendors) unitFor(vendor);

  // -- pass 1: pull requests. Builds the eligibility map every later pass filters on. -----------
  const pulls = new Map<number, PullFacts>();
  const disclosure: RepositoryDisclosure = {
    mergedMachineAuthored: 0,
    prsDetailUnobserved: 0,
    prsObserved: 0,
  };
  let mergedEligible = 0;
  for (const pull of input.pulls) {
    const facts = pullFacts(pull);
    pulls.set(pull.number, facts);
    disclosure.prsObserved += 1;
    if (facts.volumePopulation) mergedEligible += 1;
    if (facts.merged && facts.machineAuthored) disclosure.mergedMachineAuthored += 1;
    if (facts.detailUnobserved) disclosure.prsDetailUnobserved += 1;
  }

  // -- pass 2: the anchor index, over EVERY thread. ---------------------------------------------
  // ⚠ NO POPULATION GATE HERE, matching fit.py. Two vendors on one line is a fact about the line,
  // not about the pull request's eligibility, and narrowing this index would under-report overlap
  // exactly where the second bot only reviews bumps.
  const anchorVendors = new Map<string, Set<string>>();
  for (const thread of input.threads) {
    const key = anchorKey(thread);
    if (key == null) continue;
    let set = anchorVendors.get(key);
    if (set == null) {
      set = new Set<string>();
      anchorVendors.set(key, set);
    }
    for (const vendor of thread.vendors) set.add(vendor);
  }

  // -- pass 3: thread outcomes. ------------------------------------------------------------------
  for (const thread of input.threads) {
    const pr = pulls.get(thread.pr);
    if (pr == null || !pr.outcomePopulation) continue;
    const age = thread.ageSeconds;
    const complete = thread.tailComplete;
    const key = anchorKey(thread);
    for (const vendor of thread.vendors) {
      const unit = unitFor(vendor);
      if (pr.volumePopulation) unit.volume.threads += 1;
      if (!complete) unit.outcome.threadsTruncated += 1;
      const outcome = unit.outcome;

      // ⚠ THE OVERDUE FAMILY CARRIES ITS OWN GRACE WINDOW AND DOES NOT PASS THROUGH `settleHours`.
      // Chaining them lets `settleHours` silently redefine `overdue_untouched_rate_72h` into a
      // rate over threads older than the SETTLE window, under an unchanged name. Its own pass.
      if (age != null && complete) {
        for (const hours of grace) {
          if (age >= hours * 3600) {
            const k = String(hours);
            outcome.overdueEligible[k] = (outcome.overdueEligible[k] ?? 0) + 1;
            // `humanReplied === false` STRICTLY — a null (truncated) tail is unknown, not false.
            // Unreachable under `complete`, and spelled as the reference implementation spells it.
            if (!thread.resolved && thread.humanReplied === false) {
              outcome.overdueUntouched[k] = (outcome.overdueUntouched[k] ?? 0) + 1;
            }
          }
        }
      }

      // The settle gate. `>=` is INCLUSIVE at exactly 72 h.
      if (age == null || age < settleSeconds) continue;
      outcome.threadsSettled += 1;
      if (thread.resolved) outcome.threadsSettledResolved += 1;
      if (thread.outdated) outcome.threadsSettledOutdated += 1;
      // ⚠ ANCHORS ARE COUNTED ABOVE THE COMPLETENESS GATE. `(path, line)` is observable on a
      // truncated thread, exactly as `isResolved` is.
      if (key != null) {
        outcome.anchoredThreads += 1;
        if ((anchorVendors.get(key)?.size ?? 0) > 1) outcome.anchoredOverlapping += 1;
      }
      // ⚠ EVERY REMAINING FACT IS NULL ON A TRUNCATED THREAD, so it must not enter a denominator
      // either. Counting it as "not replied" is precisely how an overdue rate is invented.
      if (!complete) continue;
      outcome.threadsSettledComplete += 1;
      const replied = thread.humanReplied === true;
      const followed = thread.humanFollowedLastBot === true;
      if (replied) outcome.threadsSettledCompleteReplied += 1;
      if (followed) outcome.threadsSettledCompleteFollowed += 1;
      if (thread.resolved || followed) outcome.threadsSettledCompleteActed += 1;
      if (thread.resolved || thread.outdated || followed) {
        outcome.threadsSettledCompleteActedOutdated += 1;
      }

      // ── THE COST WINDOW ─────────────────────────────────────────────────────────────────────
      //
      // ⚠ THE SAME TWO COUNTS, INSIDE A CHOSEN CALENDAR MONTH. It sits HERE, after every gate the
      // unwindowed pair passed, so the windowed counts can only ever be a SUBSET of them — the
      // outcome population, the settle gate, the completeness gate and the acted-on definition are
      // read once, not re-decided. A second pass in the collector would be four chances to differ.
      //
      // ⚠ THE SETTLE POINT IS THE EVENT, NOT THE THREAD'S BIRTH. A thread becomes measurable at
      // `created + settleHours`; that is the instant this window is about, and it is the only one
      // for which every thread inside the window has had its full settle period. Windowing on
      // creation instead admits the last `settleHours` of threads that CANNOT yet be acted on and
      // reports them as un-acted — a denominator inflated by the calendar.
      //
      // ⚠ TWO-SIDED AND HALF-OPEN, `[from, to)` — the app's standing window-purity rule, `<` and
      // never `<=`. The upper bound is not redundant: the settle gate proves `settleAt <= now`,
      // which is `<=`, and a request whose `to` is `now` must not admit the instant it is made.
      if (costWindow != null && thread.createdAtMs != null) {
        const settleAtMs = thread.createdAtMs + settleSeconds * 1000;
        if (settleAtMs >= costWindow.fromMs && settleAtMs < costWindow.toMs) {
          unit.costWindow.settled += 1;
          if (thread.resolved || followed) unit.costWindow.acted += 1;
        }
      }
      const seconds = thread.secondsToFirstHumanReply;
      if (seconds != null) outcome.replyHours.push(seconds / 3600);
    }
  }

  // -- pass 4: comments. --------------------------------------------------------------------------
  const prsWithFinding = new Map<string, Set<number>>();
  for (const comment of input.comments) {
    if (!comment.isVendorComment) continue;
    const vendor = comment.vendor;
    if (vendor == null || vendor === '') continue;
    const pr = pulls.get(comment.pr);
    // ⚠ EACH POPULATION GATES ITSELF, which is why this loop increments TWO counters rather than
    // one. The outcome population is the wider and is entered first: a vendor reviewing busily in
    // a repository that merged nothing is NOT `vendor_silent` for its thread-outcome metrics. The
    // volume metrics divide inside the NARROWER population, so they are gated inside it too — a
    // vendor whose every comment sits on an unmerged pull request has no per-merged-PR figure at
    // all, and reporting that as a measured 0.0 is rule 4's own failure mode.
    if (pr == null || !pr.outcomePopulation) continue;
    const unit = unitFor(vendor);
    unit.outcome.commentsObserved += 1;
    if (!pr.volumePopulation) continue;
    unit.volume.commentsObserved += 1;
    if (comment.bodyChars == null) {
      // UNKNOWN. Neither a finding nor an approval — the two body-reading volume metrics refuse.
      unit.volumeBodyUnobserved = true;
      continue;
    }
    if (comment.bodyChars <= 0) {
      unit.volume.emptyBodyComments += 1;
      continue;
    }
    unit.volume.findingComments += 1;
    let set = prsWithFinding.get(vendor);
    if (set == null) {
      set = new Set<number>();
      prsWithFinding.set(vendor, set);
    }
    set.add(comment.pr);
  }

  // -- the repository-level denominators, onto every unit. ---------------------------------------
  for (const unit of units.values()) {
    unit.volume.mergedEligible = mergedEligible;
    unit.volume.prsWithFinding = prsWithFinding.get(unit.vendor)?.size ?? 0;
    unit.repositoryDisclosure = { ...disclosure };
    unit.outcome.replyHours.sort((a, b) => a - b);
  }

  return [...units.values()].sort((a, b) => (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0));
}

/** `pr:path:line`, or `null` when the thread has no anchor. A thread whose line GitHub no longer
 *  reports cannot be matched against another vendor's, and bucketing every such thread under a
 *  null line would make two unrelated outdated threads on one file look like an overlap. */
function anchorKey(thread: FoldThread): string | null {
  if (thread.path == null || thread.path === '' || thread.line == null) return null;
  return `${thread.pr} ${thread.path} ${thread.line}`;
}

// ── The metric table ────────────────────────────────────────────────────────────────────────────

export type MetricPopulation = 'volume' | 'outcome';

/** The corpus's own exclusion vocabulary, plus the one customer-side addition. Spelled exactly as
 *  the artifact's `exclusion_reasons` spells them so a refusal stays joinable to the legend. */
export type MetricExclusionReason =
  | 'repo_not_walked'
  | 'vendor_silent'
  | 'vendor_absent_from_population'
  | 'denominator_empty'
  | 'below_min_units'
  /** ⚠ CUSTOMER-SIDE ONLY. The corpus has no such state — its bodies were always read. */
  | 'body_unobserved'
  /** ⚠ CUSTOMER-SIDE ONLY, and it OUTRANKS `vendor_silent`. Zero merges in the activity window
   *  means a zero walk budget, so the fold reads no pull requests and every counter is 0 — which
   *  would otherwise be reported as the reviewer having said nothing. */
  | 'no_prs_in_window';

export type MetricOutcome =
  | { status: 'value'; value: number; units: number }
  | { status: 'excluded'; reason: MetricExclusionReason };

interface MetricDef {
  name: string;
  population: MetricPopulation;
  minUnits: number;
  /** `[numerator, denominator]`; the denominator IS the metric's `units`. */
  compute: (unit: FoldUnit, params: FoldParams) => { value: number; units: number };
  /** ⚠ Only the two metrics that classify a comment BODY. The others are unaffected by a null
   *  body — a thread outcome does not read one, and `threads_per_merged_pr` counts threads. */
  readsBody?: true;
}

const rate = (numerator: number, denominator: number): { value: number; units: number } => ({
  value: denominator === 0 ? 0 : numerator / denominator,
  units: denominator,
});

/** Python's `statistics.median`: on an EVEN sample the MEAN OF THE TWO MIDDLE VALUES, no rounding
 *  first. The lower-median convention silently disagrees on every even sample. */
export function medianOf(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  if (n % 2 === 1) return sortedAscending[mid] as number;
  return ((sortedAscending[mid - 1] as number) + (sortedAscending[mid] as number)) / 2;
}

/** The thirteen code-derived metrics. ⚠ ORDER IS REPORTING ORDER ONLY — every consumer keys by
 *  name, because a metric is RENAMED rather than redefined in place. */
export const METRIC_DEFS: readonly MetricDef[] = [
  {
    name: 'findings_per_merged_pr',
    population: 'volume',
    minUnits: 5,
    readsBody: true,
    compute: (u) => rate(u.volume.findingComments, u.volume.mergedEligible),
  },
  {
    name: 'threads_per_merged_pr',
    population: 'volume',
    minUnits: 5,
    compute: (u) => rate(u.volume.threads, u.volume.mergedEligible),
  },
  {
    name: 'pr_comment_coverage',
    population: 'volume',
    minUnits: 5,
    readsBody: true,
    compute: (u) => rate(u.volume.prsWithFinding, u.volume.mergedEligible),
  },
  {
    // ⚠ THE ONE OUTCOME METRIC WHOSE DENOMINATOR IS NOT THE COMPLETE-ONLY SET. `isResolved` is a
    // thread-level scalar observable even under truncation, so excluding truncated threads here
    // would discard a fact that WAS read.
    name: 'thread_resolved_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) => rate(u.outcome.threadsSettledResolved, u.outcome.threadsSettled),
  },
  {
    name: 'thread_outdated_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) => rate(u.outcome.threadsSettledOutdated, u.outcome.threadsSettled),
  },
  {
    name: 'human_reply_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) => rate(u.outcome.threadsSettledCompleteReplied, u.outcome.threadsSettledComplete),
  },
  {
    name: 'human_followed_last_bot_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) =>
      rate(u.outcome.threadsSettledCompleteFollowed, u.outcome.threadsSettledComplete),
  },
  {
    name: 'acted_on_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) => rate(u.outcome.threadsSettledCompleteActed, u.outcome.threadsSettledComplete),
  },
  {
    name: 'acted_on_rate_with_outdated',
    population: 'outcome',
    minUnits: 5,
    compute: (u) =>
      rate(u.outcome.threadsSettledCompleteActedOutdated, u.outcome.threadsSettledComplete),
  },
  // The overdue family is generated from `params.overdueGraceHours` below, so the tuple and the
  // metric names cannot drift apart.
  {
    name: 'median_hours_to_first_human_reply',
    population: 'outcome',
    // ⚠ 3, NOT 5. The other floor on the same repository, and a fixture with one floor would not
    // notice the other.
    minUnits: 3,
    compute: (u) => ({
      value: medianOf(u.outcome.replyHours),
      units: u.outcome.replyHours.length,
    }),
  },
  {
    name: 'cross_bot_overlap_rate',
    population: 'outcome',
    minUnits: 5,
    compute: (u) => rate(u.outcome.anchoredOverlapping, u.outcome.anchoredThreads),
  },
];

function overdueDef(hours: number): MetricDef {
  const key = String(hours);
  return {
    name: `overdue_untouched_rate_${hours}h`,
    population: 'outcome',
    minUnits: 5,
    compute: (u) =>
      rate(u.outcome.overdueUntouched[key] ?? 0, u.outcome.overdueEligible[key] ?? 0),
  };
}

/** Every metric this build computes, for these params. ⚠ Each overdue WINDOW IS ITS OWN METRIC
 *  NAME — changing the tuple renames the metrics rather than redefining them, which is what keeps
 *  a v1 row and a v2 row from being subtracted under one key. */
export function metricDefsFor(params: FoldParams): MetricDef[] {
  const overdue = params.overdueGraceHours.map(overdueDef);
  // Reporting order copies fit.py's METRIC_SPECS: the overdue family sits after
  // `acted_on_rate_with_outdated` and before the median.
  const head = METRIC_DEFS.slice(0, 9);
  const tail = METRIC_DEFS.slice(9);
  return [...head, ...overdue, ...tail];
}

/**
 * `evaluate_metric`, ported. ⚠ THE ORDER OF THE GUARDS IS THE RULE.
 *
 *  * a repository the walk never read is not silent — it is a survivorship loss;
 *  * a repository with no trace of the vendor is not a zero — it is UNDEFINED;
 *  * a repository where the vendor is live but emitted nothing INSIDE THIS METRIC'S POPULATION is
 *    not a zero either — it is still a real reviewer;
 *  * a repository where the vendor IS live in the population but the population is empty is not a
 *    zero either — a summariser that opens no review threads has no thread-outcome rate;
 *  * a repository where the vendor is live in the population and DID emit but found nothing worth
 *    saying is a REAL zero and falls through to be reported as one.
 *
 * ⚠ THE GATE AND THE NUMERATOR READ THE SAME POPULATION OBJECT. Do not reach past `counters` to
 * the unit: the one line that did (a wide gate over a narrow numerator) fitted a demonstrably live
 * vendor as a hard 0.0 with full weight.
 */
export function evaluateMetric(def: MetricDef, unit: FoldUnit, params: FoldParams): MetricOutcome {
  if (unit.walkStatus !== 'ok') return { status: 'excluded', reason: 'repo_not_walked' };
  // ⚠ AN EMPTY READ IS NOT SILENCE, AND THIS GATE MUST PRECEDE THE ONE BELOW. `walkBudget` is
  // derived from the repository's merge count in the activity window, so a repository that merged
  // nothing recently has a budget of zero and the fold reads NO pull requests at all. Every counter
  // is then 0 — including `outcome.commentsObserved` — and the next line would report the reviewer
  // as `vendor_silent`, "said nothing here".
  //
  // Reproduced before this existed: a repository whose twenty merged pull requests carried twenty
  // real CodeRabbit findings, all merged 40 days ago, returned all thirteen metrics as silence.
  // That is a false statement about a bot, manufactured out of an empty read — the precise defect
  // this whole feature exists to avoid, arriving from inside the fold rather than from the corpus.
  //
  // ⚠ NOT `repo_not_walked`: the walk succeeded and the repository is healthy. Nothing was read
  // because there was nothing IN THE WINDOW to read, which is a fact about the repository's recent
  // activity and not about our access to it. Two causes, two sentences.
  if (unit.repositoryDisclosure.prsObserved === 0) {
    return { status: 'excluded', reason: 'no_prs_in_window' };
  }
  // "Any trace at all" is DELIBERATELY the outcome population's gate, not a third counter: the
  // outcome population is the widest the fold admits, so "seen anywhere here" and "seen in the
  // outcome population" are the same fact, and deriving it keeps them from drifting apart.
  if (unit.outcome.commentsObserved === 0) return { status: 'excluded', reason: 'vendor_silent' };
  const counters = def.population === 'volume' ? unit.volume : unit.outcome;
  if (counters.commentsObserved === 0) {
    return { status: 'excluded', reason: 'vendor_absent_from_population' };
  }
  // ⚠ CUSTOMER-SIDE ONLY, and it sits HERE for a reason: an unclassifiable body is a comment that
  // was observed, so `vendor_silent` and `vendor_absent_from_population` are both already false by
  // the time it can fire, and it must precede the floors so an unknowable numerator never reaches
  // a division. The corpus has no equivalent state and this arm is unreachable on its rows.
  if (def.readsBody === true && unit.volumeBodyUnobserved) {
    return { status: 'excluded', reason: 'body_unobserved' };
  }
  const { value, units } = def.compute(unit, params);
  // ⚠ A VOLUME `denominator_empty` IS UNREACHABLE BY CONSTRUCTION — a comment only enters the
  // volume population from a pull request that is already a member of `mergedEligible`. Modelled
  // as unreachable, not as an untested branch: the reachable case is the outcome side (a
  // summariser that opens no review threads).
  if (units === 0) return { status: 'excluded', reason: 'denominator_empty' };
  if (units < def.minUnits) return { status: 'excluded', reason: 'below_min_units' };
  return { status: 'value', value, units };
}

/**
 * Does this unit count toward its vendor's BAND COUNT — walked, and the vendor observed in EVERY
 * declared population.
 *
 * ⚠ METRIC-INDEPENDENT ON PURPOSE, and the independence is the point: a band count read off the
 * metrics couples the cell key to the metric table (a fourteenth metric would silently re-band
 * every vendor) and can ERASE a vendor whose output is legitimately concentrated in one
 * population. Customer-side it is not used to band anything — the customer's band comes off its
 * merged-PR count — but it is the corpus's own membership predicate, so it is pinned by the
 * fixture and reported as a disclosure: a unit without band support is one the cohort would not
 * have counted.
 */
export function hasBandSupport(unit: FoldUnit): boolean {
  if (unit.walkStatus !== 'ok') return false;
  return unit.volume.commentsObserved > 0 && unit.outcome.commentsObserved > 0;
}

/** Every metric for one unit, keyed by name. */
export function evaluateUnit(
  unit: FoldUnit,
  params: FoldParams,
): Record<string, MetricOutcome> {
  const out: Record<string, MetricOutcome> = {};
  for (const def of metricDefsFor(params)) out[def.name] = evaluateMetric(def, unit, params);
  return out;
}

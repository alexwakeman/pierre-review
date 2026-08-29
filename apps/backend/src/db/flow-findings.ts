// ── BOTTLENECKS: where human review time goes (CORE, deterministic, NO MODEL) ────────────────
//
// The Bots rail answers "is this bot worth its seat". This answers the twin question: WHERE DOES
// HUMAN REVIEW TIME GO, and what keeps costing it. It is the Bot Tuning Advisor's machinery
// (`getAdvisorFindings` in queries.ts) pointed at the human lane — evidence CELLS over stored
// rows, sample FLOORS that a cell must clear before it is allowed to make a claim, and a NAMED
// REFUSAL for a kind that cannot clear one.
//
// ⚠ EVERY SENTENCE IN THIS FILE IS TEMPLATED. No model, no plugin, no AI import, no narration
// seam. Same discipline `packages/pro/test/llm-isolation.test.ts` pins for the advisor, and for
// the same reason: an EM makes staffing decisions off this screen, and a generated headline would
// launder an unverified figure into it.
//
// ⚠ THE SUBJECT OF A FINDING IS THE FLOW, NEVER A PERSON — a directory, a repo, a size band.
// People appear only as `actorIds` INSIDE a row, as evidence for a claim about the flow. The
// moment a row's subject becomes an engineer this is a performance dashboard, which is a
// different product with a much worse reason to exist. `round_trips` deliberately emits NO
// actorIds at all (see its emitter).
//
// ── WHAT IT REUSES, AND WHY IT MUST ──────────────────────────────────────────────────────────
//   • `loadFirstHumanReviewHours` (db/period-metrics.ts) is THE ONE FOLD for "time until a person
//     reviewed it". Its own header records the shipped bug where two folds disagreed on one
//     screen (18.16h vs 18.27h). Its `samplesOut` sink hands back {prId, atMs} for EXACTLY the
//     PRs whose hours entered the median, POSITIONALLY aligned with the returned array — which is
//     what lets this file attribute one fold's numbers to buckets without writing a second one.
//   • `pathBucket` (db/queries.ts) is the advisor's `<seg>/**` grain, so the Bots panel and this
//     one name the same directories.
//   • `resolveActorLanes` (db/actor-lanes.ts) is the human/automation split. "Human" here means
//     the lane resolver's UNION said so — never `automatedReviewerUserIds` alone, which misses
//     the second row of a duplicated identity (`dependabot` vs `dependabot[bot]`).
//   • `resolveWorkspaceScope` is the only constructor of the `BotScope` this takes.
//
// ⚑ ITS OWN FILE, NOT queries.ts — the period-metrics.ts precedent verbatim: that file is 13k
// lines and CONTAINS LITERAL NUL BYTES around offset 132k, so every search tool silently
// under-reports matches inside it. Nothing imports this file back, so importing queries.ts here
// creates no cycle.
//
// ⚠ WINDOW PURITY: every predicate is TWO-SIDED and HALF-OPEN, `>= from AND < to`
// (docs/PERIOD-REPORTING.md). The one deliberate exception is the "approved and still OPEN right
// now" count inside `approval_parked`, which is a SNAPSHOT by definition and is carried in the
// templated `detail` sentence rather than in `value` — a snapshot must never enter a figure that
// is compared against a baseline.
import { and, desc, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import type {
  FlowCoverage,
  FlowFinding,
  FlowFindingKind,
  FlowFindingPrRef,
  FlowFindingRefusal,
  FlowFindingsResponse,
  StoredPrFile,
  User,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes, type ActorLanes } from './actor-lanes.js';
import { pathBucket, type BotScope } from './queries.js';
import {
  loadFirstHumanReviewHours,
  type ReviewFoldTruncation,
  type ReviewSampleRef,
} from './period-metrics.js';
import { computeApprovalInfoByPr, READY_MERGE_STATES } from './triage.js';

const { pullRequests, repos, reviewComments, reviews, reviewThreads, users } = schema;

// ── Window ───────────────────────────────────────────────────────────────────────────────────
export const FLOW_DEFAULT_WINDOW_DAYS = 30;
// Clamped, not merely defaulted. The floor keeps a one-week window from producing medians over
// three observations; the ceiling is the RETROACTIVE COVERAGE BIAS rule
// (docs/PERIOD-REPORTING.md) — over a longer span a workspace that onboarded repos shows a
// "trend" that is entirely onboarding, and `coverage.reposWithData` is the only defence a reader
// has against it.
export const FLOW_MIN_WINDOW_DAYS = 7;
export const FLOW_MAX_WINDOW_DAYS = 90;

// ── Scan caps ────────────────────────────────────────────────────────────────────────────────
// Every scan is bounded, and hitting ANY of them sets `coverage.truncated`. A silent truncation
// reads as "we covered everything", which is a stronger claim than any figure here can support.
const FLOW_MERGED_PR_CAP = 3_000; // approval_parked's merged population
const FLOW_OPEN_PR_CAP = 3_000; // the "approved and still open" snapshot
const FLOW_THREAD_PATH_CAP = 40_000; // thread paths on the measured PRs (single_reviewer_path)
const FLOW_REVIEW_SCAN_CAP = 40_000; // in-window human reviews on the measured PRs
const FLOW_APPROVAL_SCAN_CAP = 40_000; // approving reviews on the merged population
const FLOW_THREAD_COMMENT_CAP = 60_000; // round_trips' comment scan
// `inArray` bind parameters per statement. SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766
// and Postgres caps at 65535, so 900 is far inside both — the chunking exists so a cap raise
// upstream can never turn into a runtime "too many SQL variables".
const ID_CHUNK = 900;

// ── Sample floors (the advisor's ADVISOR_MIN_CELL_* family, aimed at humans) ──────────────────
// A cell below its floor is REFUSED BY NAME, never drawn as a zero and never quietly dropped.
/** PRs with a measured first human review that a (repo, directory) cell needs. */
const FLOW_MIN_BUCKET_PRS = 8;
/** In-window human reviews that same cell needs before "one person owns this" is sayable. */
const FLOW_MIN_BUCKET_REVIEWS = 12;
/** Approved-then-merged PRs a repo needs before its approve→merge median is a number. */
const FLOW_MIN_REPO_APPROVED = 6;
/** PRs with an OBSERVED diff size a band needs before its median is a number. */
const FLOW_MIN_BAND_PRS = 6;
/** Review threads opened in the window that a (repo, directory) cell needs. */
const FLOW_MIN_BUCKET_THREADS = 10;
/** Sized PRs an author needs before "their changes run large" is evidence rather than an anecdote. */
const FLOW_MIN_AUTHOR_PRS = 4;

// ── Emission thresholds ──────────────────────────────────────────────────────────────────────
// Every comparison is BOTH a ratio and an absolute delta. A ratio alone emits "12 minutes against
// 5 minutes, 2.4× worse!"; an absolute alone emits on a workspace where everything is slow.
/** Share of a directory's human reviews taken by its busiest reviewer. */
const FLOW_CONCENTRATION_SHARE = 0.6;
const FLOW_LATENCY_RATIO = 1.5;
const FLOW_LATENCY_MIN_DELTA_HOURS = 4;
const FLOW_PARKED_MIN_DELTA_HOURS = 6;
const FLOW_SIZE_RATIO = 1.6;
/** A ratio this large tells its own story regardless of the absolute scale, so it waives the
 *  minimum-delta gate. Shared by every kind so "three times longer" means one thing here. */
const FLOW_STRONG_RATIO = 3;
const FLOW_ROUND_TRIP_RATIO = 1.5;
/** Comments that make a thread a NEGOTIATION rather than a question and an answer. */
const FLOW_ROUND_TRIP_DEEP_COMMENTS = 3;
/** Below this share, an area's threads essentially never need a second pass — no comparison
 *  against the workspace makes that a finding. */
const FLOW_ROUND_TRIP_MIN_RATE = 0.12;
const FLOW_ROUND_TRIP_MIN_DELTA_RATE = 0.05;
/** An author's median PR size, as a multiple of the workspace's, before they are row evidence. */
const FLOW_BIG_AUTHOR_RATIO = 2;

// ── Output caps ──────────────────────────────────────────────────────────────────────────────
const FLOW_EVIDENCE_CAP = 5; // the advisor's ADVISOR_SAMPLE_CAP
const FLOW_ACTOR_CAP = 5;
/** Rows per kind. A bottleneck list nobody can read is not a worklist. */
const FLOW_FINDINGS_PER_KIND_CAP = 3;

// ⚠ THE 100-FILE TRUNCATION. `pull_requests.files` is capped at 100 entries by the sync GraphQL
// query, and that truncation lands hardest on exactly the big PRs a review-flow feature cares
// about. Above this share of the file-attributed population we REFUSE `single_reviewer_path`
// rather than compute a directory picture from a systematically biased sample; below it we still
// set `coverage.truncated`. `round_trips` is unaffected — it buckets `review_threads.path`, which
// has no cap.
const FLOW_FILES_TRUNCATED_REFUSE_SHARE = 0.25;
/** The sync query's own `files(first: 100)` limit, mirrored here so the count is explainable. */
const FLOW_STORED_FILES_CAP = 100;

// ── The size bands ───────────────────────────────────────────────────────────────────────────
// Half-open `[min, max)` in additions+deletions, so a PR lands in exactly one. The labels ARE the
// `subject` string rendered verbatim on the row.
interface SizeBand {
  label: string;
  min: number;
  max: number;
}
const SIZE_BANDS: SizeBand[] = [
  { label: 'under 50 lines', min: 0, max: 50 },
  { label: '50-199 lines', min: 50, max: 200 },
  { label: '200-499 lines', min: 200, max: 500 },
  { label: '500-999 lines', min: 500, max: 1000 },
  { label: '1000+ lines', min: 1000, max: Number.POSITIVE_INFINITY },
];

function bandIndexFor(loc: number): number {
  for (let i = SIZE_BANDS.length - 1; i >= 0; i--) {
    const b = SIZE_BANDS[i];
    if (b && loc >= b.min) return i;
  }
  return 0;
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Even-length medians take the MEAN of the two middles — the same definition period-metrics.ts
 *  uses, so a figure here and a figure there describe the same statistic. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * The ONE emission predicate every kind goes through: materially worse means BOTH a real
 * absolute gap and a real proportional one.
 *
 * ⚠ A ZERO BASELINE IS NOT AN INFINITE RATIO. A workspace whose median first read is 0h (every
 * PR reviewed within the same minute) would make every ratio undefined; there the absolute delta
 * is the whole test, which is the conservative reading.
 */
/**
 * ⚠ A RATIO *AND* AN ABSOLUTE DELTA — except that a LARGE ENOUGH ratio stands on its own.
 *
 * Requiring both was blinding fast workspaces entirely. Measured: `erxes` reported
 * "Large changes are picked up about as quickly as small ones here (2.9h against 0.4h)" — a
 * SEVENFOLD difference, suppressed because 2.5h fell under the 4h minimum, and then described to
 * the reader as "about as quickly", which is simply false. `cdp` did the same at 19 min against
 * 7 min. The absolute floor exists to stop "12 minutes against 5 minutes, 2.4x worse!" on a team
 * that reviews in minutes, and that is still worth having — but it must not swallow a 7x gap.
 *
 * So: the ratio gate ALWAYS applies; the absolute delta is waived once the ratio reaches
 * `strongRatio`, which is a "several times longer" story a reader will recognise regardless of the
 * absolute scale.
 */
function materiallyWorse(
  value: number,
  baseline: number,
  ratio: number,
  minDelta: number,
  strongRatio: number,
): boolean {
  if (baseline <= 0) return value > 0;
  const observed = value / baseline;
  if (observed < ratio) return false;
  if (observed >= strongRatio) return true;
  return value - baseline >= minDelta;
}

// ── The bucket grain, and the paths that are noise ────────────────────────────────────────────
//
// ⚠ DELIBERATELY NOT `pathBucket` (db/queries.ts), which stays exactly as it is: it is the BOTS
// advisor's grain and its comment requires the two panels to name the same directories. This is a
// third bucket in the codebase (db/person-period.ts already has its own two-segment one), and it
// exists because the shared single-segment grain produced garbage HERE specifically:
//
//   • A ROOT-LEVEL FILE BECAME A "DIRECTORY". `seg === path` returns the path itself, so real
//     output read "One reviewer takes 95% of the reviews in `command.go`" and called a file a
//     directory. Root files now aggregate into ONE honest cell per repo.
//   • ONE SEGMENT IS TOO COARSE FOR A MONOREPO. Measured on bevy: every finding collapsed onto a
//     single `crates/**` covering 1,195 threads. At two segments the same data separates into
//     `crates/bevy_ecs/**` (252), `crates/bevy_render/**` (113), `crates/bevy_pbr/**` (71) — the
//     areas a maintainer would actually name.
//   • ⚠ BUT TWO SEGMENTS IS NOT SIMPLY BETTER. On a flat docs repo (`cdp`) it took the qualifying
//     bucket count from 1 to ZERO. So BOTH grains are emitted as candidate cells and the
//     evidence-overlap dedup below keeps whichever one actually earned a finding, preferring the
//     more specific. The grain is chosen by the data, per repo, not asserted up front.
const FLOW_BUCKET_ROOT = '(repository root)';
const FLOW_BUCKET_DEPTHS = [1, 2] as const;

function flowBucket(path: string, depth: number): string {
  const segs = path.split('/');
  if (segs.length <= 1) return FLOW_BUCKET_ROOT;
  return `${segs.slice(0, Math.min(depth, segs.length - 1)).join('/')}/**`;
}

/** How specific a bucket is, for the dedup's preference. The root cell is the least specific. */
function bucketDepth(bucket: string): number {
  if (bucket === FLOW_BUCKET_ROOT) return 0;
  return bucket.split('/').length - 1;
}

// ⚠ PATHS WHERE ONE REVIEWER IS NORMAL, NOT A BOTTLENECK. Lockfiles and manifests are touched by
// every dependency bump and skimmed rather than reviewed; CI config is owned by whoever owns CI.
// Measured: these filled THREE of three `single_reviewer_path` rows on one workspace and two of
// three on another, crowding out real signal — and `package.json` and `package-lock.json` cited
// BYTE-IDENTICAL evidence, because every bump touches both.
//
// They are excluded from `single_reviewer_path` ONLY. A protracted argument in `.github/**` is a
// real round trip, so `round_trips` still sees them.
const FLOW_LOCKFILE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.lock$/;
const FLOW_MANIFEST_RE =
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|Gemfile|composer\.json|requirements[^/]*\.txt)$/;
const FLOW_CI_CONFIG_RE = /^\.(github|circleci|gitlab|buildkite|husky)\//;

/** True for a path whose review concentration carries no signal. See the block above. */
function isRoutinePath(path: string): boolean {
  return (
    FLOW_LOCKFILE_RE.test(path) || FLOW_MANIFEST_RE.test(path) || FLOW_CI_CONFIG_RE.test(path)
  );
}

/**
 * Drop candidates that are RESTATEMENTS of one already kept, judged by their evidence.
 *
 * ⚠ THIS IS NOT COSMETIC. Real output, verbatim, from two workspaces:
 *
 *     package.json       prs=[57, 58, 59, 62, 63]
 *     package-lock.json  prs=[57, 58, 59, 62, 63]      ← identical
 *
 *     command.go     prs=[3942, 3955, 3960, 3961, 3995]
 *     osscluster.go  prs=[3942, 3960, 3161, 3964, 3990]
 *     .github/**     prs=[3942, 3960, 3961, 3964, 3967]  ← one fact, three rows
 *
 * The per-kind cap of three was being filled with the same finding restated, so a board that
 * looked full was carrying one fact. Two cells whose evidence overlaps this heavily ARE one
 * finding: the same pull requests, seen through two paths they both touch.
 *
 * Candidates arrive already ordered strongest-first, so the walk keeps the strongest of a
 * colliding group — and among near-equals prefers the MORE SPECIFIC bucket, which is what makes
 * the dual-depth emission above resolve to one grain per repo.
 */
const FLOW_DEDUPE_OVERLAP = 0.6;

function dedupeByEvidence(candidates: FlowFinding[]): FlowFinding[] {
  const kept: { finding: FlowFinding; prs: Set<number> }[] = [];
  for (const c of candidates) {
    const prs = new Set(c.evidence.map((e) => e.prId));
    if (prs.size === 0) {
      kept.push({ finding: c, prs });
      continue;
    }
    const collision = kept.find((k) => {
      if (k.finding.repoId !== c.repoId) return false;
      let shared = 0;
      for (const id of prs) if (k.prs.has(id)) shared += 1;
      return shared / Math.min(prs.size, k.prs.size) >= FLOW_DEDUPE_OVERLAP;
    });
    if (collision == null) {
      kept.push({ finding: c, prs });
      continue;
    }
    // Same fact. Keep the more specific SUBJECT when the two are describing it equally well —
    // `crates/bevy_ecs/**` tells a maintainer where to look; `crates/**` does not.
    if (bucketDepth(c.subject) > bucketDepth(collision.finding.subject)) {
      collision.finding = c;
      collision.prs = prs;
    }
  }
  return kept.map((k) => k.finding);
}

/** Severity for the per-kind ordering. Never rendered — `value`/`baseline` are what a reader sees. */
function severityOf(value: number, baseline: number): number {
  return baseline > 0 ? value / baseline : value;
}

// Prose renderings. The WIRE carries raw numbers plus `unit` and the UI formats them; these exist
// only for the templated sentences, which are prose and read badly as "22.416666 hours".
/** One decimal at most, and never a bare `.0` — "4.0h" reads like a measurement precision this
 *  file cannot support. */
function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}
function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 10) return `${oneDp(h)}h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${oneDp(h / 24)} days`;
}

/**
 * A headline that compares two durations must express BOTH IN ONE UNIT.
 *
 * ⚠ This shipped wrong and was caught on screen: "An approved pull request in bevyengine/bevy waits
 * 2.6 days to land, against 36h across the workspace." Both figures are correct and the sentence is
 * still bad — 62.4h crosses `fmtHours`' 48h day threshold and 36h does not, so the reader has to
 * convert before they can see the gap. Straddling the threshold is what a LARGE gap looks like, so
 * the formatting broke down exactly on the rows most worth reading.
 *
 * The unit comes from the larger figure and is applied to both. The frontend has the same rule in
 * `formatFlowPair` for the row's comparison chip; the two must agree, or one row shows a sentence
 * and a chip that disagree about the same number.
 */
function fmtHoursPair(a: number, b: number): [string, string] {
  const scale = Math.max(a, b);
  // ⚠ A STRICTLY POSITIVE FIGURE MUST NEVER PRINT AS ZERO. Because the pair takes its unit from
  // the LARGER figure, the smaller one can round away: (60h, 1h) picked days and produced
  // "2.5 days to land, against 0 days across the workspace" — on a row that exists BECAUSE the
  // two differ. A floor spelling keeps the shared unit and stays true.
  // ⚠ This must stay character-identical with `formatFlowPair` in the SPA's bottlenecksModel.ts,
  // or a row's sentence and its comparison chip disagree about one number.
  const floored = (n: number, text: string, floor: string, unit: string): string => {
    const sep = unit === 'h' ? '' : ' ';
    if (Number.parseFloat(text) === 0 && n > 0) return `<${floor}${sep}${unit}`;
    return `${text}${sep}${unit}`;
  };
  const fmt = (n: number): string => {
    if (scale >= 48) return floored(n / 24, oneDp(n / 24), '0.1', 'days');
    if (scale >= 10) return floored(n, String(Math.round(n)), '1', 'h');
    if (scale >= 1) return floored(n, oneDp(n), '0.1', 'h');
    return `${Math.max(1, Math.round(n * 60))} min`;
  };
  return [fmt(a), fmt(b)];
}
function fmtCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function fmtPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ── Row types ────────────────────────────────────────────────────────────────────────────────

interface PrMeta {
  id: number;
  repoId: number;
  number: number;
  title: string;
}

interface Caps {
  /** ⚠ ROW-SCAN caps ONLY — see FlowCoverage.truncated. A PR whose FILE LIST was capped at 100
   *  belongs in `filesTruncatedPrs`, not here: the window was still scanned in full, and saying
   *  otherwise teaches the reader to ignore the caveat that matters.
   *
   *  ⚠ THIS INCLUDES CAPS INSIDE THE FOLDS THIS FILE CALLS. `loadFirstHumanReviewHours` truncates
   *  internally (PERIOD_FIRST_REVIEW_PR_CAP, and two PERIOD_COMMENT_SCAN_CAP limits) and returns a
   *  bare array, so it reports its own truncation through a sink — see the call site. Without that
   *  a ?days=90 fold on a busy workspace was cut and `coverage` still said the window was covered
   *  in full, which is the exact silent truncation this field exists to prevent. */
  truncated: boolean;
  /** ⚠ A DIFFERENT AND MUCH SMALLER FACT — the count of scanned PRs whose 100-file list was
   *  capped, so their PATH attribution is partial. Never folded into `truncated`. */
  filesTruncatedPrs: number;
}

/** A scan that came back exactly at its cap is assumed to have been cut — it is not worth a
 *  second COUNT(*) to find out, and the cost of a false positive is one honest flag. */
function noteCap(caps: Caps, rows: number, cap: number): void {
  if (rows >= cap) caps.truncated = true;
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────

/**
 * Every finding for one workspace over one window.
 *
 * It is CORE and FREE on every tier — deterministic, no model, no GitHub call. (Gating it behind
 * a Pro capability later is a one-line change in `api/routes/flow.ts`; nothing here reads a
 * capability, and nothing here should.)
 */
export async function getFlowFindings(
  accountId: number,
  scope: BotScope,
  windowDaysRaw: number,
): Promise<FlowFindingsResponse> {
  const windowDays = Math.min(
    FLOW_MAX_WINDOW_DAYS,
    Math.max(FLOW_MIN_WINDOW_DAYS, Math.round(windowDaysRaw)),
  );
  const toMs = Date.now();
  const to = new Date(toMs);
  const from = new Date(toMs - windowDays * 24 * 60 * 60 * 1000);

  const findings: FlowFinding[] = [];
  const refusals: FlowFindingRefusal[] = [];
  const caps: Caps = { truncated: false, filesTruncatedPrs: 0 };
  // `basis` DEFAULTS to 'insufficient_data' because that is what the overwhelming majority of
  // these are, and because it is the SAFE default: mislabelling "we could not measure" as a clean
  // bill of health is a false reassurance, while the reverse is only an unnecessary apology.
  const refuse = (
    kind: FlowFindingKind,
    reason: string,
    basis: FlowFindingRefusal['basis'] = 'insufficient_data',
  ): void => {
    refusals.push({ kind, reason, basis });
  };

  /**
   * EVERY KIND MUST ACCOUNT FOR ITSELF. A kind that emits neither a finding nor a refusal is
   * invisible on screen, and an absent section reads as "we checked and there is nothing here" —
   * a far stronger claim than the truth. This shipped: a real workspace (3 repos, 261 pull
   * requests scanned) returned `findings: []` AND `refusals: []`, because the emit path only
   * refused when NOTHING cleared the sample floor. Cells that cleared the floor and then failed
   * the emit predicate fell through in silence.
   *
   * The two outcomes are genuinely different and must not share a sentence:
   *   nothing cleared the floor  → "not enough data to say" (we could not measure)
   *   cleared, nothing crossed   → "measured N, none showed the pattern" (a clean bill of health,
   *                                 and the more useful of the two answers)
   */
  const settle = (
    kind: FlowFindingKind,
    candidates: FlowFinding[],
    clearedFloor: number,
    tooThin: string,
    measuredButClean: (n: number) => string,
  ): void => {
    if (candidates.length > 0) {
      findings.push(...takeTop(candidates));
      return;
    }
    if (clearedFloor === 0) refuse(kind, tooThin, 'insufficient_data');
    else refuse(kind, measuredButClean(clearedFloor), 'measured_clean');
  };

  // `[]` is a real answer ("this workspace is empty"), never a widening to the whole account.
  if (scope.repoIds.length === 0) {
    for (const k of ['single_reviewer_path', 'approval_parked', 'size_latency', 'round_trips'] as const) {
      refuse(k, 'This workspace has no repositories yet.');
    }
    return {
      workspaceId: scope.workspaceId,
      windowDays,
      findings,
      refusals,
      coverage: {
        reposInWorkspace: 0,
        reposWithData: 0,
        prsScanned: 0,
        truncated: false,
        filesTruncatedPrs: 0,
      },
      users: [],
    };
  }

  const lanes = await resolveActorLanes(accountId, scope);

  // Repo identity, for `FlowFindingPrRef.repoFullName` and the approval_parked subject.
  const repoRows = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  const repoFullName = new Map<number, string>();
  for (const r of repoRows) repoFullName.set(r.id, `${r.owner}/${r.name}`);

  const prMeta = new Map<number, PrMeta>();
  const reposWithData = new Set<number>();
  const prsScanned = new Set<number>();
  const noteScanned = (m: PrMeta): void => {
    prMeta.set(m.id, m);
    prsScanned.add(m.id);
    reposWithData.add(m.repoId);
  };

  const evidenceFor = (prIds: number[]): FlowFindingPrRef[] => {
    const out: FlowFindingPrRef[] = [];
    for (const id of prIds) {
      if (out.length >= FLOW_EVIDENCE_CAP) break;
      const m = prMeta.get(id);
      if (!m) continue;
      const full = repoFullName.get(m.repoId);
      if (!full) continue;
      out.push({
        prId: m.id,
        repoFullName: full,
        prNumber: m.number,
        prTitle: m.title,
        githubUrl: `https://github.com/${full}/pull/${m.number}`,
      });
    }
    return out;
  };

  // ══ THE SHARED LATENCY FOLD ═════════════════════════════════════════════════════════════════
  // ONE call, feeding both `single_reviewer_path` and `size_latency`. `samples` is POSITIONALLY
  // aligned with `hours` (the fold pushes to both in the same iteration), which is the only
  // reason this file can attribute the ONE first-review measurement to buckets without writing a
  // second, disagreeing one. A length mismatch means that contract changed underneath us — throw
  // rather than mislabel every PR by one, the ml-enrichment positional-zip rule.
  //
  // ⚠ THE FOLD REPORTS ITS OWN TRUNCATION, AND EVERY OTHER SCAN HERE GOES THROUGH `noteCap` FOR
  // THE SAME REASON. It caps internally — PERIOD_FIRST_REVIEW_PR_CAP (5,000 candidate PRs, a hard
  // break) and two PERIOD_COMMENT_SCAN_CAP row limits — and hands back a bare array, so a cut fold
  // and a complete one are indistinguishable from here. Reachable at ?days=90 on a busy workspace,
  // and it made `coverage.truncated` say the window was covered in full when the medians on screen
  // rested on a prefix of it. A `hours.length >= CAP` guess at this call site is NOT a substitute:
  // the caps sit on the candidate/review scans, and `hours` is that population after two more
  // narrowings, so the heuristic under-fires exactly when it matters.
  const foldCaps: ReviewFoldTruncation = { truncated: false };
  const samples: ReviewSampleRef[] = [];
  const hours = await loadFirstHumanReviewHours(
    accountId,
    scope,
    from,
    to,
    lanes,
    undefined,
    samples,
    foldCaps,
  );
  // ⚠ `truncated`, NOT `filesTruncatedPrs`: a cut scan is a claim about the WINDOW.
  if (foldCaps.truncated) caps.truncated = true;
  if (hours.length !== samples.length) {
    throw new Error(
      `flow-findings: loadFirstHumanReviewHours returned ${hours.length} hours for ${samples.length} samples — the positional sink contract changed`,
    );
  }
  const hoursByPr = new Map<number, number>();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const h = hours[i];
    if (s && h != null) hoursByPr.set(s.prId, h);
  }
  const workspaceFirstReadMedian = median(hours);
  const measuredPrIds = [...hoursByPr.keys()];

  // The measured PRs' own rows: repo/number/title for evidence, size for the bands, files for the
  // path attribution.
  interface MeasuredPr extends PrMeta {
    authorId: number | null;
    loc: number | null;
    files: StoredPrFile[] | null;
    filesTruncated: boolean;
  }
  const measured: MeasuredPr[] = [];
  for (const ids of chunk(measuredPrIds, ID_CHUNK)) {
    const rows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        number: pullRequests.number,
        title: pullRequests.title,
        authorId: pullRequests.authorId,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        changedFiles: pullRequests.changedFiles,
        files: pullRequests.files,
      })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, ids)))
      .execute();
    for (const r of rows) {
      // ⚠ UNKNOWN SIZE, NOT ZERO SIZE (the period-metrics.ts / bot-volume.ts rule). All three
      // columns default to 0, so a PR whose detail never hydrated looks exactly like an empty
      // one; feeding a fabricated 0 into a band would put every unhydrated PR in "under 50 lines"
      // and make the smallest band's median the fastest by construction.
      const observed = r.changedFiles > 0 || r.additions > 0 || r.deletions > 0;
      const m: MeasuredPr = {
        id: r.id,
        repoId: r.repoId,
        number: r.number,
        title: r.title,
        authorId: r.authorId,
        loc: observed ? r.additions + r.deletions : null,
        files: r.files ?? null,
        // GitHub gave us `changedFiles` uncapped but stored at most 100 file rows, so the two
        // disagreeing IS the truncation — no second source needed.
        filesTruncated: r.files != null && r.changedFiles > r.files.length,
      };
      measured.push(m);
      noteScanned(m);
    }
  }
  const measuredById = new Map(measured.map((m) => [m.id, m]));

  // ══ 1. single_reviewer_path ═════════════════════════════════════════════════════════════════
  // Subject: a (repo, directory) cell. A directory is CONCENTRATED when its busiest human
  // reviewer takes >= FLOW_CONCENTRATION_SHARE of its in-window human reviews, and SLOW when a
  // first human read there is materially worse than workspace-wide. Both, or nothing: a
  // concentrated directory that is read quickly is a fact about the team, not a bottleneck.
  await (async (): Promise<void> => {
    if (measured.length === 0) {
      refuse(
        'single_reviewer_path',
        `No pull request had its first human review inside the last ${windowDays} days, so there is no review latency to attribute to a directory.`,
      );
      return;
    }

    // Thread paths on the measured PRs. `review_threads` carries no accountId — it is reached
    // through `pr_id`, and every id here came out of an account-scoped scan.
    const bucketsByPr = new Map<number, Set<string>>();
    const bucketsFor = (prId: number): Set<string> => {
      let s = bucketsByPr.get(prId);
      if (!s) {
        s = new Set<string>();
        bucketsByPr.set(prId, s);
      }
      return s;
    };
    for (const ids of chunk(measuredPrIds, ID_CHUNK)) {
      const rows = await db
        .select({ prId: reviewThreads.prId, path: reviewThreads.path })
        .from(reviewThreads)
        .where(inArray(reviewThreads.prId, ids))
        .limit(FLOW_THREAD_PATH_CAP)
        .execute();
      for (const r of rows) {
        if (isRoutinePath(r.path)) continue;
        const s = bucketsFor(r.prId);
        for (const d of FLOW_BUCKET_DEPTHS) s.add(flowBucket(r.path, d));
      }
      noteCap(caps, rows.length, FLOW_THREAD_PATH_CAP);
    }

    // File paths. THE TRUNCATION LIVES HERE — see FLOW_FILES_TRUNCATED_REFUSE_SHARE.
    let fileAttributed = 0;
    let fileTruncatedPrs = 0;
    for (const m of measured) {
      if (m.files == null) continue;
      fileAttributed += 1;
      if (m.filesTruncated) fileTruncatedPrs += 1;
      const s = bucketsFor(m.id);
      for (const f of m.files) {
        if (isRoutinePath(f.path)) continue;
        for (const d of FLOW_BUCKET_DEPTHS) s.add(flowBucket(f.path, d));
      }
    }
    // ⚠ NOT `caps.truncated`. A capped FILE LIST means this PR's paths are partly unattributed;
    // it does NOT mean a scan stopped early, and conflating them made a 262-PR workspace announce
    // that its figures covered part of the window. Different fact, different field, different
    // sentence on screen.
    caps.filesTruncatedPrs = fileTruncatedPrs;
    if (
      fileAttributed > 0 &&
      fileTruncatedPrs / fileAttributed >= FLOW_FILES_TRUNCATED_REFUSE_SHARE
    ) {
      refuse(
        'single_reviewer_path',
        `Too much of the file-level evidence is missing to attribute review time to a directory: ${fileTruncatedPrs} of ${fileAttributed} scanned pull requests changed more than ${FLOW_STORED_FILES_CAP} files, and only the first ${FLOW_STORED_FILES_CAP} are stored. A shorter window, or one repository at a time, will cover more of them.`,
      );
      return;
    }

    // ── WHO REVIEWS THIS DIRECTORY, anchored to the directory ───────────────────────────────────
    //
    // ⚠ THE ROW USED TO CLAIM SOMETHING IT HAD NOT MEASURED. Concentration was counted over the
    // PR's reviews and then attributed to EVERY bucket that PR touched, so "one reviewer takes 95%
    // of the 178 human reviews in `command.go`" actually meant "95% of reviews on pull requests
    // that happened to touch command.go" — which for most repos degenerates to "…in this repo",
    // and which is why three findings on one workspace named the same person with near-identical
    // numbers.
    //
    // A review COMMENT carries a thread, and a thread carries a PATH. That is a real per-directory
    // signal, and it is not scarcer: measured, one workspace has 780 human review comments across
    // 64 buckets where the old attribution left 4 buckets above the floor.
    //
    // The LATENCY half stays a per-PR fact — "when did a person first look at this pull request"
    // has no path — so the sentence now says which half is which rather than blurring them.
    const commentsByCell = new Map<string, Map<number, number>>();
    for (const ids of chunk(measuredPrIds, ID_CHUNK)) {
      const rows = await db
        .select({
          prId: reviewThreads.prId,
          path: reviewThreads.path,
          authorId: reviewComments.authorId,
        })
        .from(reviewComments)
        .innerJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
        .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
        .where(
          and(
            eq(pullRequests.accountId, accountId),
            inArray(reviewThreads.prId, ids),
            gte(reviewComments.createdAt, from),
            lt(reviewComments.createdAt, to),
          ),
        )
        .limit(FLOW_REVIEW_SCAN_CAP)
        .execute();
      noteCap(caps, rows.length, FLOW_REVIEW_SCAN_CAP);
      for (const r of rows) {
        if (r.authorId == null) continue;
        // THE LANE RESOLVER'S UNION, never `automatedReviewerUserIds` alone — the second row of a
        // duplicated identity (`github-actions` vs `github-actions[bot]`) carries `automated: 0`
        // and would otherwise be counted as the directory's busiest HUMAN reviewer.
        if (lanes.laneOf(r.authorId) !== 'human') continue;
        if (isRoutinePath(r.path)) continue;
        const meta = measuredById.get(r.prId);
        if (meta == null) continue;
        for (const d of FLOW_BUCKET_DEPTHS) {
          const key = `${meta.repoId} ${flowBucket(r.path, d)}`;
          let byUser = commentsByCell.get(key);
          if (!byUser) {
            byUser = new Map<number, number>();
            commentsByCell.set(key, byUser);
          }
          byUser.set(r.authorId, (byUser.get(r.authorId) ?? 0) + 1);
        }
      }
    }

    interface PathCell {
      repoId: number;
      bucket: string;
      hours: number[];
      prIds: number[];
      reviewsByUser: Map<number, number>;
    }
    const cells = new Map<string, PathCell>();
    for (const m of measured) {
      const h = hoursByPr.get(m.id);
      if (h == null) continue;
      const bs = bucketsByPr.get(m.id);
      if (!bs) continue;
      for (const bucket of bs) {
        const key = `${m.repoId} ${bucket}`;
        let c = cells.get(key);
        if (!c) {
          c = {
            repoId: m.repoId,
            bucket,
            hours: [],
            prIds: [],
            // The cell's OWN comment tally, keyed the same way it was accumulated above — never
            // the PR's reviews spread across every path it touched.
            reviewsByUser: commentsByCell.get(key) ?? new Map<number, number>(),
          };
          cells.set(key, c);
        }
        c.hours.push(h);
        c.prIds.push(m.id);
      }
    }

    let clearedFloor = 0;
    const candidates: FlowFinding[] = [];
    for (const c of cells.values()) {
      let totalReviews = 0;
      let topId: number | null = null;
      let topCount = 0;
      for (const [uid, n] of c.reviewsByUser) {
        totalReviews += n;
        // Deterministic tie-break on the id so two ticks over unchanged data name the same person.
        if (n > topCount || (n === topCount && topId != null && uid < topId)) {
          topCount = n;
          topId = uid;
        }
      }
      if (c.hours.length < FLOW_MIN_BUCKET_PRS || totalReviews < FLOW_MIN_BUCKET_REVIEWS) continue;
      clearedFloor += 1;
      if (topId == null || totalReviews === 0) continue;
      const share = topCount / totalReviews;
      if (share < FLOW_CONCENTRATION_SHARE) continue;
      const value = median(c.hours);
      if (
        !materiallyWorse(
          value,
          workspaceFirstReadMedian,
          FLOW_LATENCY_RATIO,
          FLOW_LATENCY_MIN_DELTA_HOURS,
          FLOW_STRONG_RATIO,
        )
      ) {
        continue;
      }
      // Evidence = the SLOWEST PRs in the cell: the rows that actually paid the wait.
      const slowest = [...c.prIds]
        .sort((a, b) => (hoursByPr.get(b) ?? 0) - (hoursByPr.get(a) ?? 0) || a - b)
        .slice(0, FLOW_EVIDENCE_CAP);
      candidates.push({
        id: `single_reviewer_path:${c.repoId}:${c.bucket}`,
        kind: 'single_reviewer_path',
        subjectKind: 'path',
        subject: c.bucket,
        repoId: c.repoId,
        // ⚠ EACH HALF NAMES ITS OWN POPULATION. The share is over review comments ANCHORED TO
        // this directory; the wait is a per-pull-request fact about the ones that touch it. One
        // sentence, two measurements, and the reader can tell which is which — the previous
        // wording implied both were about the directory and only one was.
        headline: (() => {
          const [v, b] = fmtHoursPair(value, workspaceFirstReadMedian);
          const where = c.bucket === FLOW_BUCKET_ROOT ? 'files at the repository root' : c.bucket;
          return `One reviewer wrote ${fmtPct(share)} of the ${totalReviews} review comments on ${where}, and pull requests touching it wait ${v} for a first read against ${b} across the workspace.`;
        })(),
        detail: `Widening who reviews ${c.bucket === FLOW_BUCKET_ROOT ? 'the repository root' : c.bucket} — a second name in its CODEOWNERS, or routing its pull requests to a group — is what shortens that wait.`,
        value,
        baseline: workspaceFirstReadMedian,
        unit: 'hours',
        sampleSize: c.hours.length,
        evidence: evidenceFor(slowest),
        actorIds: [topId],
      });
    }

    settle(
      'single_reviewer_path',
      candidates,
      clearedFloor,
      `No directory reached the floor of ${FLOW_MIN_BUCKET_PRS} reviewed pull requests and ${FLOW_MIN_BUCKET_REVIEWS} human reviews in the last ${windowDays} days.`,
      (n) =>
        `Measured ${n} ${n === 1 ? 'directory' : 'directories'} in the last ${windowDays} days; none combined a single dominant reviewer with a slower first read than the workspace.`,
    );
  })();

  // ══ 2. approval_parked ══════════════════════════════════════════════════════════════════════
  // Subject: a repo. Median hours from the FIRST approving review to `mergedAt`, per repo, against
  // the workspace median.
  //
  // ⚠ THE CALIBRATION TRAP. A PR whose `mergeStateStatus` is 'blocked' is waiting on REQUIRED
  // CHECKS, not on people, and counting it makes this a CI finding wearing a review-flow costume —
  // landing on exactly the PRs an EM would most want to trust. The exclusion is drawn the way this
  // codebase already draws it (db/triage.ts READY_MERGE_STATES, lib/ui.ts mergeVerdict):
  // 'unstable' IS mergeable (only NON-required checks are red), 'behind' is NOT (GitHub 405s it),
  // 'dirty'/'conflicting' is waiting on its author.
  //
  // ⚠ AND IT ONLY REALLY WORKS ON THE OPEN HALF. The two halves read the same column, but only one
  // of them is being told anything:
  //   • the OPEN snapshot has a LIVE `mergeStateStatus`, so it takes the POSITIVE test — a PR
  //     counts as parked only if GitHub says a human could land it right now. This half is sound.
  //   • the MERGED population's `mergeStateStatus` is a stale LAST OBSERVATION, and GITHUB STOPS
  //     COMPUTING IT ONCE A PR MERGES. Measured on this install's own synced database: of 5,507
  //     merged pull requests, 5,478 read 'unknown', 27 'dirty', 2 'clean' and ZERO 'blocked' —
  //     while 553 OPEN ones do carry 'blocked'. The negative test below is therefore very nearly
  //     INERT: a PR approved at T0, held by a red required check until T0+40h and merged at T0+41h
  //     contributes its full 41h to this median.
  //
  // ⚠ SO THE ROW MAY NOT TELL THE READER THE EXCLUSION APPLIED, and the sentences below no longer
  // do. It used to say "pull requests held by required checks are excluded from this figure" on
  // every row and in two refusals, on a figure from which, in practice, none had been. An
  // UNEARNED REASSURANCE IS WORSE THAN AN ABSENT ONE — it is the reader's only defence against
  // mistaking a CI queue for a merge-approval queue, and it was spending it on nothing.
  //
  // ⚠ AND CI HISTORY IS NOT A SUBSTITUTE — this was measured before the claim was dropped rather
  // than after. `ci_status_events` survives the merge (14,360 rows over 6,221 PRs here), but it
  // records ANY check, not a REQUIRED one, and it is not evidence of blocking:
  //   • as a predictor of live 'blocked' on the only population carrying ground truth (open,
  //     approved, non-draft): fires on 29 PRs of which 12 are truly blocked — 41% precision —
  //     and misses 30 of the 42 that are (29% recall);
  //   • its coverage inside the approve→merge gap ranges from 0% to 66% BY REPO (0/45 in one,
  //     136/207 in another), and the repo is exactly the axis this finding compares — so the
  //     exclusion would become the confounder deciding which repo tops the list.
  // A substitute that wrong, biased along the comparison axis, would be a worse claim than none.
  //
  // The `!== 'blocked'` filter itself STAYS: it is the "a column may be CLEARED only on a positive
  // statement from GitHub" rule applied to a judgement — drop a row we positively observed as
  // check-blocked, keep the rest. It just no longer earns a sentence.
  await (async (): Promise<void> => {
    const mergedRows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        number: pullRequests.number,
        title: pullRequests.title,
        mergedAt: pullRequests.mergedAt,
        mergeStateStatus: pullRequests.mergeStateStatus,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          eq(pullRequests.state, 'merged'),
          gte(pullRequests.mergedAt, from),
          lt(pullRequests.mergedAt, to),
        ),
      )
      .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
      .limit(FLOW_MERGED_PR_CAP)
      .execute();
    noteCap(caps, mergedRows.length, FLOW_MERGED_PR_CAP);

    // A positive-observation drop, NOT a general exclusion — see the block above for the measured
    // reason no sentence in this section claims otherwise.
    const eligible = mergedRows.filter((r) => r.mergedAt != null && r.mergeStateStatus !== 'blocked');
    for (const r of eligible) {
      noteScanned({ id: r.id, repoId: r.repoId, number: r.number, title: r.title });
    }
    const eligibleIds = eligible.map((r) => r.id);

    // The FIRST approving review per PR (ascending, so the earliest survives the cap).
    const firstApproval = new Map<number, number>();
    for (const ids of chunk(eligibleIds, ID_CHUNK)) {
      const rows = await db
        .select({ prId: reviews.prId, submittedAt: reviews.submittedAt })
        .from(reviews)
        .where(and(inArray(reviews.prId, ids), eq(reviews.state, 'approved')))
        .orderBy(reviews.submittedAt, reviews.id)
        .limit(FLOW_APPROVAL_SCAN_CAP)
        .execute();
      noteCap(caps, rows.length, FLOW_APPROVAL_SCAN_CAP);
      for (const r of rows) {
        if (!firstApproval.has(r.prId)) firstApproval.set(r.prId, r.submittedAt.getTime());
      }
    }

    interface RepoCell {
      repoId: number;
      /** {prId, hours} together, so the evidence sort never has to look a PR back up. */
      parked: { prId: number; hours: number }[];
      openParked: number[];
    }
    const byRepo = new Map<number, RepoCell>();
    const cellFor = (repoId: number): RepoCell => {
      let c = byRepo.get(repoId);
      if (!c) {
        c = { repoId, parked: [], openParked: [] };
        byRepo.set(repoId, c);
      }
      return c;
    };
    const allHours: number[] = [];
    for (const r of eligible) {
      const approvedAt = firstApproval.get(r.id);
      if (approvedAt == null || r.mergedAt == null) continue;
      const h = (r.mergedAt.getTime() - approvedAt) / 3_600_000;
      // An approval timestamped after its own merge is clock skew, not a negative wait.
      if (h < 0) continue;
      cellFor(r.repoId).parked.push({ prId: r.id, hours: h });
      allHours.push(h);
    }

    // ── The SNAPSHOT half: approved and still open RIGHT NOW, and genuinely landable ──────────
    const openRows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        number: pullRequests.number,
        title: pullRequests.title,
        mergeable: pullRequests.mergeable,
        mergeStateStatus: pullRequests.mergeStateStatus,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.isDraft, false),
        ),
      )
      .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
      .limit(FLOW_OPEN_PR_CAP)
      .execute();
    noteCap(caps, openRows.length, FLOW_OPEN_PR_CAP);
    // ⚠ THE IMPORTED SET, never a second spelling of it. `READY_MERGE_STATES` is {clean,
    // has_hooks, unstable} — 'unstable' IS mergeable (only NON-required checks are red) and
    // 'behind' is NOT (GitHub 405s it). db/triage.ts's queue and `mergeVerdict`'s `canMerge`
    // already have to agree with each other; a third hand-maintained copy here is how a screen
    // starts disagreeing with the PR it links to. The `mergeable !== 'conflicting'` guard is the
    // separate one `mergeVerdict` applies above the status: a conflicting pull request is waiting
    // on its author, not on whoever would land it.
    const landable = openRows.filter(
      (r) =>
        r.mergeStateStatus != null &&
        READY_MERGE_STATES.has(r.mergeStateStatus) &&
        r.mergeable !== 'conflicting',
    );
    const approvalInfo = await computeApprovalInfoByPr(landable.map((r) => r.id));
    for (const r of landable) {
      const info = approvalInfo.get(r.id);
      if (!info?.approved) continue;
      noteScanned({ id: r.id, repoId: r.repoId, number: r.number, title: r.title });
      cellFor(r.repoId).openParked.push(r.id);
    }

    const withData = [...byRepo.values()].filter((c) => c.parked.length > 0);
    if (withData.length === 0) {
      // No "(N held by required checks excluded)" tail: GitHub reports 'unknown' once a PR merges,
      // so that count is ~always 0 and printing it advertised a filter that had not fired.
      refuse(
        'approval_parked',
        `No repository merged an approved pull request in the last ${windowDays} days.`,
      );
      return;
    }
    if (withData.length < 2) {
      // With one repo the workspace median IS that repo's median, so `value === baseline` and the
      // comparison the row promises would be vacuous.
      refuse(
        'approval_parked',
        `Only one repository merged an approved pull request in the last ${windowDays} days, so there is nothing to compare its approve-to-merge wait against.`,
      );
      return;
    }

    const workspaceParkedMedian = median(allHours);
    // ⚠ THE HONEST HALF OF THE OLD REASSURANCE, spelled ONCE so the two detail branches cannot
    // drift into disagreeing about what the figure contains. It replaces "pull requests held by
    // required checks are excluded from this figure", which was true of no real row.
    const checkCaveat =
      'Time a required check held a pull request is inside this figure — GitHub stops reporting that once it merges.';
    let clearedFloor = 0;
    const candidates: FlowFinding[] = [];
    for (const c of withData) {
      if (c.parked.length < FLOW_MIN_REPO_APPROVED) continue;
      clearedFloor += 1;
      const value = median(c.parked.map((p) => p.hours));
      if (
        !materiallyWorse(
          value,
          workspaceParkedMedian,
          FLOW_LATENCY_RATIO,
          FLOW_PARKED_MIN_DELTA_HOURS,
          FLOW_STRONG_RATIO,
        )
      ) {
        continue;
      }
      const full = repoFullName.get(c.repoId) ?? `repo ${c.repoId}`;
      const open = c.openParked.length;
      // Evidence: the parked-RIGHT-NOW PRs first (they are actionable today), then the longest
      // historical waits.
      const slowest = [...c.parked]
        .sort((a, b) => b.hours - a.hours || a.prId - b.prId)
        .map((p) => p.prId);
      candidates.push({
        id: `approval_parked:${c.repoId}:${full}`,
        kind: 'approval_parked',
        subjectKind: 'repo',
        subject: full,
        repoId: c.repoId,
        headline: (() => {
          const [v, b] = fmtHoursPair(value, workspaceParkedMedian);
          return `An approved pull request in ${full} waits ${v} to land, against ${b} across the workspace.`;
        })(),
        detail:
          open > 0
            ? // The OPEN count IS check-aware (READY_MERGE_STATES against a live merge state), so
              // "open and mergeable right now" is a claim this half can support — unlike the
              // merged median beside it, which the caveat is about.
              `${open} approved ${plural(open, 'pull request is', 'pull requests are')} open and mergeable there right now. The wait is after review, so the merge step is where to look. ${checkCaveat}`
            : `Nothing is parked there at this moment, so the delay is historical. ${checkCaveat}`,
        value,
        baseline: workspaceParkedMedian,
        unit: 'hours',
        sampleSize: c.parked.length,
        evidence: evidenceFor([...c.openParked, ...slowest]),
        // No actorIds. "Who merges slowly" is a person-shaped claim, and this row is about the
        // step between approval and merge, not about whoever happened to take it.
        actorIds: [],
      });
    }

    settle(
      'approval_parked',
      candidates,
      clearedFloor,
      // No "(pull requests held by required checks are excluded)" tail — see the block above.
      `No repository reached the floor of ${FLOW_MIN_REPO_APPROVED} approved-then-merged pull requests in the last ${windowDays} days.`,
      (n) =>
        `Measured ${n} ${n === 1 ? 'repository' : 'repositories'} in the last ${windowDays} days; approved work landed about as quickly in each as across the workspace.`,
    );
  })();

  // ══ 3. size_latency ═════════════════════════════════════════════════════════════════════════
  // Subject: a SIZE BAND, and the only workspace-wide (repoId: null) kind. Authors whose changes
  // run large are EVIDENCE INSIDE THE ROW and never its subject.
  await (async (): Promise<void> => {
    const sized = measured.filter((m) => m.loc != null && hoursByPr.get(m.id) != null);
    if (sized.length === 0) {
      refuse(
        'size_latency',
        `No pull request reviewed in the last ${windowDays} days carried an observed diff size, so latency cannot be compared across sizes.`,
      );
      return;
    }

    const bandHours: number[][] = SIZE_BANDS.map(() => []);
    const bandPrs: number[][] = SIZE_BANDS.map(() => []);
    for (const m of sized) {
      const i = bandIndexFor(m.loc ?? 0);
      const h = hoursByPr.get(m.id);
      if (h == null) continue;
      bandHours[i]?.push(h);
      bandPrs[i]?.push(m.id);
    }
    const qualifying = SIZE_BANDS.map((_, i) => i).filter(
      (i) => (bandHours[i]?.length ?? 0) >= FLOW_MIN_BAND_PRS,
    );
    if (qualifying.length < 2) {
      refuse(
        'size_latency',
        `Fewer than two size bands reached the floor of ${FLOW_MIN_BAND_PRS} pull requests with a measured first human review in the last ${windowDays} days, so size cannot be separated from noise.`,
      );
      return;
    }

    const bigIdx = qualifying[qualifying.length - 1] ?? 0;
    const smallIdx = qualifying[0] ?? 0;
    const bigBand = SIZE_BANDS[bigIdx];
    const smallBand = SIZE_BANDS[smallIdx];
    // ⚠ EVERY EXIT BELOW REFUSES BY NAME. These are the "we measured and it is fine" answers, and
    // they are the ones a healthy workspace hits — so a bare `return` here is the silent-section
    // bug (see `settle`), not a tidy early exit.
    if (!bigBand || !smallBand || bigIdx === smallIdx) {
      refuse(
        'size_latency',
        `Only one size band had enough reviewed pull requests in the last ${windowDays} days, so there is nothing to compare it against.`,
      );
      return;
    }
    const bigHours = bandHours[bigIdx] ?? [];
    const value = median(bigHours);
    const baseline = median(bandHours[smallIdx] ?? []);
    // ⚠ "LATENCY RISES WITH SIZE", not "one band is an outlier". The largest qualifying band must
    // also be the SLOWEST qualifying band, or a slow middle band would let the headline blame
    // large changes for a wait they did not cause.
    const slowestQualifying = qualifying.reduce(
      (best, i) => (median(bandHours[i] ?? []) > median(bandHours[best] ?? []) ? i : best),
      qualifying[0] ?? 0,
    );
    if (slowestQualifying !== bigIdx) {
      refuse(
        'size_latency',
        `Waiting time does not rise with change size here: the slowest band in the last ${windowDays} days was ${SIZE_BANDS[slowestQualifying]?.label ?? 'a middle band'}, not the largest.`,
        'measured_clean',
      );
      return;
    }
    if (
      !materiallyWorse(
        value,
        baseline,
        FLOW_SIZE_RATIO,
        FLOW_LATENCY_MIN_DELTA_HOURS,
        FLOW_STRONG_RATIO,
      )
    ) {
      refuse(
        'size_latency',
        `Large changes are picked up about as quickly as small ones here (${fmtHoursPair(value, baseline)[0]} against ${fmtHoursPair(value, baseline)[1]} over the last ${windowDays} days).`,
        'measured_clean',
      );
      return;
    }

    // ── Authors whose changes run large: EVIDENCE, never the subject ──────────────────────────
    // Human authors only, through the lane resolver's union — a dependency bot's bumps would
    // otherwise anchor the workspace median at 14 lines and make every person "far above" it.
    //
    // ⚠ THE BASELINE AND THE POPULATION IT JUDGES ARE THE SAME SET, AND THAT IS THE WHOLE FIX
    // HERE. `allSizes` used to be pushed ABOVE the human-lane filter, so the median a person's
    // ratio was measured against was the median over EVERY sized PR including the bumps — the
    // exact contamination the paragraph above says it prevents, contradicted one line later.
    // Measured on a bot-heavy workspace: 86 lines all-PR against a far higher human-only median,
    // i.e. the FLOW_BIG_AUTHOR_RATIO bar was roughly halved and the row named engineers whose
    // changes are ordinary for the humans here. Naming a person as evidence is the one thing this
    // file is least allowed to get wrong.
    const sizesByAuthor = new Map<number, number[]>();
    const allSizes: number[] = [];
    for (const m of sized) {
      if (m.loc == null) continue;
      if (m.authorId == null || lanes.laneOf(m.authorId) !== 'human') continue;
      allSizes.push(m.loc);
      const arr = sizesByAuthor.get(m.authorId) ?? [];
      arr.push(m.loc);
      sizesByAuthor.set(m.authorId, arr);
    }
    const workspaceSizeMedian = median(allSizes);
    const actorIds: number[] = [...sizesByAuthor.entries()]
      .filter(
        ([, sizes]) =>
          sizes.length >= FLOW_MIN_AUTHOR_PRS &&
          workspaceSizeMedian > 0 &&
          median(sizes) >= workspaceSizeMedian * FLOW_BIG_AUTHOR_RATIO,
      )
      .sort((a, b) => median(b[1]) - median(a[1]) || a[0] - b[0])
      .slice(0, FLOW_ACTOR_CAP)
      .map(([id]) => id);

    const slowest = [...(bandPrs[bigIdx] ?? [])]
      .sort((a, b) => (hoursByPr.get(b) ?? 0) - (hoursByPr.get(a) ?? 0) || a - b)
      .slice(0, FLOW_EVIDENCE_CAP);

    const [bigText, smallText] = fmtHoursPair(value, baseline);
    const [gapText] = fmtHoursPair(value - baseline, value);

    findings.push({
      // Workspace-wide, so the id's repo segment is the contract's `'ws'` sentinel.
      id: `size_latency:ws:${bigBand.label}`,
      kind: 'size_latency',
      subjectKind: 'size_band',
      subject: bigBand.label,
      repoId: null,
      // ⚠ ONE pair, THREE figures, ONE unit. The gap is formatted at the pair's scale too:
      // "closes the 1.1 days gap" beside "wait 2.6 days" is a sentence a reader can add up;
      // "closes the 26h gap" beside it is not.
      headline: `Pull requests of ${bigBand.label} wait ${bigText} for a first human read; pull requests of ${smallBand.label} wait ${smallText}.`,
      detail: `Splitting changes in this band is what closes the ${gapText} gap — work of ${smallBand.label} is already picked up in ${smallText}.`,
      value,
      baseline,
      unit: 'hours',
      sampleSize: bigHours.length,
      evidence: evidenceFor(slowest),
      actorIds,
    });
  })();

  // ══ 4. round_trips ══════════════════════════════════════════════════════════════════════════
  // Subject: a (repo, directory) cell. Median HUMAN comments per review thread opened in the
  // window, against the workspace median. High = a convention nobody wrote down, or a design
  // still being argued.
  await (async (): Promise<void> => {
    interface ThreadAgg {
      repoId: number;
      /** The RAW path — bucketed at BOTH grains below, so the dedup can pick the specific one. */
      path: string;
      prId: number;
      humanComments: number;
    }
    const threads = new Map<number, ThreadAgg>();
    // ONE join rather than a thread scan followed by an id-list comment scan: the thread ids
    // would be thousands of bind parameters and the two scans could disagree about the window.
    // ORDERED BY thread id so a cap cuts at a thread boundary — see the drop below.
    const rows = await db
      .select({
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        prId: reviewThreads.prId,
        path: reviewThreads.path,
        repoId: pullRequests.repoId,
      })
      .from(reviewComments)
      .innerJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          gte(reviewThreads.createdAt, from),
          lt(reviewThreads.createdAt, to),
        ),
      )
      .orderBy(reviewComments.threadId, reviewComments.id)
      .limit(FLOW_THREAD_COMMENT_CAP)
      .execute();
    const capped = rows.length >= FLOW_THREAD_COMMENT_CAP;
    if (capped) caps.truncated = true;
    // ⚠ A PARTIALLY-READ THREAD UNDER-COUNTS ITS COMMENTS, and this median is a count of
    // comments — so the last thread the cap reached is DROPPED rather than reported short. Under
    // the thread-id ordering it is the only one that can be partial.
    const lastThreadId = capped ? rows[rows.length - 1]?.threadId : undefined;
    for (const r of rows) {
      if (lastThreadId != null && r.threadId === lastThreadId) continue;
      let t = threads.get(r.threadId);
      if (!t) {
        t = { repoId: r.repoId, path: r.path, prId: r.prId, humanComments: 0 };
        threads.set(r.threadId, t);
      }
      if (r.authorId != null && lanes.laneOf(r.authorId) === 'human') t.humanComments += 1;
    }

    // A thread nobody human ever spoke in is not a round trip — it is an unanswered bot comment,
    // which the Bots rail already owns. Including it would drag every median toward zero.
    const live = [...threads.values()].filter((t) => t.humanComments > 0);
    if (live.length === 0) {
      refuse(
        'round_trips',
        `No review thread opened in the last ${windowDays} days drew a human comment, so there is no back-and-forth to measure.`,
      );
      return;
    }

    const prIdsNeeded = [...new Set(live.map((t) => t.prId))].filter((id) => !prMeta.has(id));
    for (const ids of chunk(prIdsNeeded, ID_CHUNK)) {
      const prRows = await db
        .select({
          id: pullRequests.id,
          repoId: pullRequests.repoId,
          number: pullRequests.number,
          title: pullRequests.title,
        })
        .from(pullRequests)
        .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, ids)))
        .execute();
      for (const p of prRows) noteScanned(p);
    }
    for (const t of live) {
      prsScanned.add(t.prId);
      reposWithData.add(t.repoId);
    }

    // ⚠ A RATE, NOT A CENTRAL TENDENCY — and this kind produced ZERO findings on NINE real
    // workspaces at two window sizes before the change.
    //
    // The measured distribution of human comments per thread is 1 to 3, mean 1.0–2.4. A MEDIAN
    // over that quantises to the integer 1 or 2 and throws the signal away: bevy's
    // `crates/bevy_mesh/**` (mean 2.11) and go-redis's `multidb/**` (mean 1.00) were
    // indistinguishable to it, and the old `FLOW_ROUND_TRIP_MIN_ABS = 3` floor sat above the
    // entire real distribution, so the kind could never fire at all.
    //
    // "How often does a thread here need SEVERAL passes" is the question the finding actually
    // asks, and as a share it separates cleanly on the same data: 27.8% / 25.0% / 23.5% in bevy's
    // busiest areas against 0.0% in two go-redis ones and 0.5% in erxes'.
    const deepShare = (counts: number[]): number =>
      counts.length === 0 ? 0 : counts.filter((n) => n >= FLOW_ROUND_TRIP_DEEP_COMMENTS).length / counts.length;
    const workspaceRoundTripRate = deepShare(live.map((t) => t.humanComments));
    interface RtCell {
      repoId: number;
      bucket: string;
      counts: number[];
      threads: ThreadAgg[];
    }
    const cells = new Map<string, RtCell>();
    for (const t of live) {
      // BOTH grains, same as single_reviewer_path: the dedup keeps whichever earned the finding.
      for (const d of FLOW_BUCKET_DEPTHS) {
        const bucket = flowBucket(t.path, d);
        const key = `${t.repoId} ${bucket}`;
        let c = cells.get(key);
        if (!c) {
          c = { repoId: t.repoId, bucket, counts: [], threads: [] };
          cells.set(key, c);
        }
        c.counts.push(t.humanComments);
        c.threads.push(t);
      }
    }

    let clearedFloor = 0;
    const candidates: FlowFinding[] = [];
    for (const c of cells.values()) {
      if (c.counts.length < FLOW_MIN_BUCKET_THREADS) continue;
      clearedFloor += 1;
      const value = deepShare(c.counts);
      // An area where almost nothing needs a second pass is not a finding however it compares.
      if (value < FLOW_ROUND_TRIP_MIN_RATE) continue;
      if (
        !materiallyWorse(
          value,
          workspaceRoundTripRate,
          FLOW_ROUND_TRIP_RATIO,
          FLOW_ROUND_TRIP_MIN_DELTA_RATE,
          FLOW_STRONG_RATIO,
        )
      ) {
        continue;
      }
      const noisiest = [...c.threads]
        .sort((a, b) => b.humanComments - a.humanComments || a.prId - b.prId)
        .map((t) => t.prId);
      candidates.push({
        id: `round_trips:${c.repoId}:${c.bucket}`,
        kind: 'round_trips',
        subjectKind: 'path',
        subject: c.bucket,
        repoId: c.repoId,
        headline: `${fmtPct(value)} of review threads in ${c.bucket === FLOW_BUCKET_ROOT ? 'files at the repository root' : c.bucket} take ${FLOW_ROUND_TRIP_DEEP_COMMENTS} or more human comments to settle, against ${fmtPct(workspaceRoundTripRate)} across the workspace.`,
        detail: `Repeated back-and-forth in one area is usually a convention nobody wrote down. Writing it down — a lint rule, or a short note in the directory — removes the conversation instead of speeding it up.`,
        value,
        baseline: workspaceRoundTripRate,
        unit: 'pct',
        sampleSize: c.counts.length,
        evidence: evidenceFor([...new Set(noisiest)]),
        // ⚠ DELIBERATELY EMPTY. "Who argues most in this directory" is the exact person-shaped
        // claim the header forbids, and unlike the size row there is no flow reading of it.
        actorIds: [],
      });
    }

    settle(
      'round_trips',
      candidates,
      clearedFloor,
      `No directory reached the floor of ${FLOW_MIN_BUCKET_THREADS} review threads opened in the last ${windowDays} days.`,
      (n) =>
        `Measured ${n} ${n === 1 ? 'directory' : 'directories'} in the last ${windowDays} days; threads settled in about as many passes in each as across the workspace.`,
    );
  })();

  // ── The actor resolution table ───────────────────────────────────────────────────────────────
  // `users` is one of the two GLOBAL tables, so it is read BY ID — never handed to a tenant as a
  // listing. Every id here came off a row this account's own scan produced.
  const actorIds = [...new Set(findings.flatMap((f) => f.actorIds))];
  const userRows =
    actorIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            githubLogin: users.githubLogin,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            isBot: users.isBot,
          })
          .from(users)
          .where(inArray(users.id, actorIds))
          .execute();
  const resolvedUsers: User[] = userRows.map((u) => ({
    id: u.id,
    githubLogin: u.githubLogin,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    isBot: u.isBot,
  }));

  const coverage: FlowCoverage = {
    reposInWorkspace: scope.repoIds.length,
    reposWithData: reposWithData.size,
    prsScanned: prsScanned.size,
    truncated: caps.truncated,
    filesTruncatedPrs: caps.filesTruncatedPrs,
  };

  return { workspaceId: scope.workspaceId, windowDays, findings, refusals, coverage, users: resolvedUsers };
}

/** Per-kind cap, worst first. The tie-break chain is TOTAL so two ticks over unchanged data
 *  produce byte-identical order — a panel people read top-down may not reshuffle between polls
 *  (the work plan's rank rule). */
function takeTop(candidates: FlowFinding[]): FlowFinding[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      severityOf(b.value, b.baseline) - severityOf(a.value, a.baseline) ||
      b.sampleSize - a.sampleSize ||
      (a.repoId ?? 0) - (b.repoId ?? 0) ||
      (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0),
  );
  // ⚠ DEDUPE BEFORE THE CAP, NEVER AFTER. The cap is three; restatements of one fact were filling
  // all three, so a board that looked full carried one finding. Deduping after the slice would
  // leave the board SHORTER instead of fuller — the point is to spend the three slots on three
  // different things.
  return dedupeByEvidence(ranked).slice(0, FLOW_FINDINGS_PER_KIND_CAP);
}

/** Exposed for the unit test — the floors and thresholds a fixture has to clear or miss. */
export const __flowTesting = {
  FLOW_MIN_BUCKET_PRS,
  FLOW_MIN_BUCKET_REVIEWS,
  FLOW_MIN_REPO_APPROVED,
  FLOW_MIN_BAND_PRS,
  FLOW_MIN_BUCKET_THREADS,
  FLOW_CONCENTRATION_SHARE,
  FLOW_LATENCY_RATIO,
  FLOW_LATENCY_MIN_DELTA_HOURS,
  FLOW_PARKED_MIN_DELTA_HOURS,
  FLOW_SIZE_RATIO,
  FLOW_ROUND_TRIP_DEEP_COMMENTS,
  FLOW_ROUND_TRIP_MIN_RATE,
  FLOW_BUCKET_ROOT,
  flowBucket,
  isRoutinePath,
  dedupeByEvidence,
  takeTop,
  FLOW_FINDINGS_PER_KIND_CAP,
  SIZE_BANDS,
  median,
  materiallyWorse,
};

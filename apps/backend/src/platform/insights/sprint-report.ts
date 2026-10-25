import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  DigestPrRef,
  InsightCard,
  MetricPr,
  SprintReport,
  SprintReportResponse,
  WorkspaceInsightsResponse,
  WorkspaceMetricsDetail,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { getComparisonWindow } from '../settings/store.js';
import { scopeKeyFor } from './workspace-scope.js';
import { resolveRequestWorkspaceId, workspaceScope } from './workspace-request.js';
import { resolveScopePrRefs } from './pr-refs.js';
import { prToken } from './pr-token.js';
import {
  DIGEST_MODEL,
  MIN_INTERVAL_SEC,
  tsToIso,
} from '../llm/gate.js';

// The sprint report has its OWN throttle + in-flight guard, DECOUPLED from the (now removed)
// repo-digest paths. The unified Insights "Refresh" used to fire the sprint report AND the repo
// digests concurrently; when they shared the digest's in-flight set, whichever request the server
// reached first claimed the guard and STARVED the other, which then returned its cached row
// ("Regenerate started but nothing changed"). Repeat clicks then hit the shared min-interval,
// so both returned cached ("content flashes but nothing updates"). Independent guards let a
// single Refresh regenerate both; each path still self-throttles against hammering (and the
// structural-hash / payload-hash caches keep unchanged content free either way).
//
// Throttle + in-flight state is keyed by (account, WORKSPACE) — each workspace's report is an
// independent billing path, so generating one must not throttle another.
//
// ⚠ `throttleKeyFor` is an IN-MEMORY guard key and has nothing to do with the persisted
// `scope_key` column. It was called `scopeKeyFor` until the workspace refactor, which is exactly
// the name the real cache-key builder (`./workspace-scope.js`) now has — renamed rather than
// deleted, because deleting it would have silently repurposed the throttle key.
const sprintInFlightKeys = new Set<string>();
const sprintLastRefreshAtByKey = new Map<string, number>();
const throttleKeyFor = (accountId: number, workspaceId: number): string =>
  `${accountId}:${workspaceId}`;

// The Insights "Sprint report" (Pro, Haiku): ONE cross-repo report per WORKSPACE, generated from
// the current workspace-insights state — headline metrics + prioritised, PR-linked issues, repos
// ranked by activity + code volume. Cost-safe like the digest: generation only on POST
// refresh, guarded by the per-account+workspace throttle + in-flight set, and cached until the
// Insights change (a structural hash flags staleness). The cached row's `scope_key` is
// `ws:<workspaceId>`; plugin migration 0020 DELETES the legacy rows (regenerable model output).

const SPRINT_MAX_TOKENS = 1300;

const SPRINT_SYSTEM = `You write a concise status report for an engineering team lead, from a JSON snapshot of the team's flow METRICS + review-intelligence "Insights". The window dates are \`sprint.from\`/\`sprint.to\`.

WINDOW MODE — read \`metrics.comparisonMode\` FIRST; it sets how \`.value\`/\`.previous\` are framed and MUST drive your wording:
  • 'sprint': a sprint in progress. \`.value\` = this sprint SO FAR (\`metrics.elapsedDays\` of \`metrics.sprintDays\` days elapsed; \`metrics.elapsedFraction\` = 0..1); \`.previous\` = the SAME elapsed slice of the PREVIOUS sprint (e.g. on day 3, its first 3 days). Apples-to-apples by elapsed time — read it as "how are we doing at THIS point in the sprint vs the same point last sprint"; lead with "Day <elapsedDays> of <sprintDays>". A young sprint has a small \`.value\` AND a correspondingly small \`.previous\` by definition — do NOT call an early sprint a slowdown/collapse/halt/cliff.
  • 'rolling_7' / 'rolling_14': NO sprint — \`.value\` covers the LAST \`metrics.sprintDays\` days and \`.previous\` the \`metrics.sprintDays\` days BEFORE that (both full windows). Frame as "over the last <sprintDays> days vs the prior <sprintDays> days"; do NOT say "Day N of M", "so far", or "early in the sprint".
In BOTH modes it is value vs previous over MATCHED windows — never a partial window against a complete one, never an absolute. Below, "the comparison window" means "the same point last sprint" ('sprint') or "the prior N days" ('rolling_*') — always use the phrasing that matches the mode.

CONFIDENCE — the load-bearing rule. Each metric also carries \`.lowConfidence\` (boolean) + \`.sampleSize\`/\`.previousSampleSize\`. \`.lowConfidence\` is a SAMPLE-SIZE judgement (too few items on one side to be a signal), NOT a time judgement — common early in a sprint but also whenever throughput is low — so describe it as a thin sample, and only call it "too early" when \`comparisonMode\` is 'sprint' AND \`elapsedFraction\` is genuinely small. When \`.lowConfidence\` is true: report the raw figure (e.g. "X so far", or "X over the last N days" in rolling mode) and state NO percentage, multiple, direction, or trend for it, and NEVER use words like collapsed/halted/plummeted/spiked/surged. Only assert a trend for a metric when \`.lowConfidence\` is false.

Output GitHub-flavoured markdown, in three parts:
1. A one-line **headline** in bold reading flow health, grounded in the \`metrics\`; lead with the window frame per WINDOW MODE ("Day 3 of 14 — ..." for 'sprint', "Last 14 days — ..." for 'rolling_*'). Cite trends ONLY for metrics whose \`.lowConfidence\` is false (deploy frequency = merges, lead time, review latency, CI success). If most metrics are lowConfidence, give the raw figures without a verdict and note the samples are thin. Use plain units (h/d, %, counts).
2. A short bullet list of the key **metrics**, one per line, as "<metric>: <value>" then — only when \`.lowConfidence\` is false — "(<trend> vs the comparison window)" and a 3-6 word read; for lowConfidence metrics write "(small sample — no trend yet)" instead of any trend. For CI health: when \`ciFailingNow\` > 0 say how many PRs are red, then NAME the specific red PRs from \`ciRedPrs\` by copying each one's exact \`ref\` (up to ~3, longest-red first) with its \`redDays\`; cite \`ciRecoveryHours.value\` and name the top failing stage \`ciFailureReasons[0].stage\` (with its count) when present — that's WHY CI is failing. Do NOT state a bare "N PRs red, sat for X days" without naming the actual PRs from \`ciRedPrs\`.
3. **Action items**, grouped by repo. Under each repo, one bullet per issue — do NOT worry about ordering the bullets (the app sorts them by priority deterministically). Each bullet MUST start with the issue's exact \`ref\` field (already formatted owner/name#<number>, e.g. octo/app#123) copied VERBATIM — NO backticks, NO code formatting, NO markdown link — followed by the issue. IMPORTANT: the rendered report shows the PR reference in its OWN column and strips it from the sentence, so write the issue as a SELF-CONTAINED clause that still reads correctly WITHOUT the reference as its subject. Lead with the state/action, not a verb that needs the PR as subject — e.g. write "octo/app#123 — Stalled 5 days; needs review from @alice" (renders as "Stalled 5 days; needs review from @alice"), NOT "octo/app#123 has been stalled for 5 days" (which renders as the fragment "has been stalled for 5 days"). Finish every sentence — never trail off.

Trend rule: for a metric with \`.lowConfidence\` false, express the trend as "<value> (<trend> vs the comparison window)" from its \`.previous\` (phrase the window per WINDOW MODE). When \`.previous\` is null, say "no comparable baseline" and invent no direction. When \`.previous\` is a real 0 you MAY say "up from 0", but only when 0 is an actual prior value. NEVER express a percentage or multiple for a lowConfidence metric — never a partial window against a complete one, never an absolute.

GROUNDING — the load-bearing rule for THIS report. Every specific problem you mention (a stall, a CI failure, a long wait, a "many PRs are …" pattern) MUST name the concrete PR(s) it refers to by copying their exact \`ref\` token from the JSON. Never describe a problem, a duration, or a "waiting on <person>" without the backing \`ref\`. A PR number belongs ONLY to the repo in its own \`ref\` — never pair a number with a different repo, never re-type or re-join a ref yourself. For durations, use ONLY the precomputed \`redDays\`/\`ageDays\`/\`ageHours\` fields — never compute your own day count. NEVER invent a name, login, or identifier (no placeholder like "Wlkr123"): every person you name must be a login present in the JSON, and every PR you name must be a \`ref\` present in the JSON.

Rules: ground EVERY metric claim in the JSON \`metrics\` (never invent or round wildly — one decimal max). Be terse and factual — no preamble, no restating the whole title verbatim, no invented facts. Only mention PRs present in the JSON, always by copying their \`ref\` (never in backticks). Keep it under ~230 words and always end on a complete sentence.`;

interface SprintBuild {
  payload: unknown;
  hash: string;
  prRefs: DigestPrRef[];
  sprint: { from: string; to: string };
}

// A STRUCTURAL hash of the Insights (which issues exist), deliberately excluding
// time-relative fields (ageHours) so it only changes when the SET of issues changes —
// not merely as the clock advances. Drives the "Insights changed → regenerate" flag.
function insightsHash(cards: InsightCard[]): string {
  const parts = cards
    .map((c) => {
      switch (c.kind) {
        case 'stalled_review':
          // Team names are part of the card's identity too — a team-only card has an empty
          // reviewer-id list, and swapping the requested TEAM must invalidate the cached report.
          return `stalled:${c.prId}:${[...c.requestedReviewerIds].sort((a, b) => a - b).join(',')}:${[...c.requestedTeamNames].sort().join(',')}`;
        case 'untouched_thread':
          return `thread:${c.threadId}`;
        case 'ci_failing':
          // WHICH red things exist, by their identity — the trunk head sha (a new red head IS a
          // new issue) or the PR. Deliberately excludes `observedAt` and `ciStatus`: a snapshot
          // re-observed at a later minute, or a failure that flips failure↔error, is the same
          // problem and must not re-bill a regeneration.
          return `ci:${c.arm}:${c.repoId}:${c.headSha ?? c.prId ?? ''}`;
        case 'reviewer_load':
          return `load:${c.reviewerId}:${c.pendingCount}`;
        case 'reviewer_routing':
          return `route:${c.prId}:${c.suggestedReviewers
            .map((s) => (s.kind === 'team' ? `t:${s.teamSlug ?? ''}` : `u:${s.login ?? s.userId ?? ''}`))
            .sort()
            .join(',')}`;
        default:
          return '';
      }
    })
    // ⚠ AN UNMATCHED KIND MUST CONTRIBUTE NOTHING — not an empty slot. Without this filter the
    // SEPARATOR COUNT still tracks the card count, so a kind this report ignores could move the
    // $0-on-unchanged key just by appearing or disappearing. That is now a live risk rather than
    // a theoretical one: `merge` and `update_branch` cards flip in and out on every push
    // (clean → behind → unstable), and re-billing a sprint report because somebody pushed a
    // commit is exactly what this hash exists to prevent.
    // ⚠ IT RE-KEYS EVERY STORED REPORT ONCE. `my_turn` already contributed empty slots, so this
    // moves existing hashes too — a single regeneration per workspace, not a recurring cost.
    .filter((part) => part !== '')
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

// Compact the current Insights into an LLM payload + the cross-repo PR refs. Returns
// null when there's nothing to report (no cards).
async function buildSprintPayload(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
): Promise<SprintBuild | null> {
  // One workspace, one concrete repo set (its full membership, per resolveWorkspaceRepoIds).
  // `[]` — an empty workspace — has nothing to report. The old `null`-means-the-watched-set
  // branch is gone with the watch concept itself.
  const repoIds = scope.repoIds;
  if (repoIds.length === 0) return null;
  // The scope's OWN cadence — the sprint length is a per-workspace fact.
  const window = await getComparisonWindow(ctx, accountId, scope.workspaceId);
  const [insights, detail] = await Promise.all([
    ctx.queries.getWorkspaceInsights(
      accountId,
      window,
      scope,
    ) as Promise<WorkspaceInsightsResponse>,
    // The per-PR backing lists behind the aggregate metrics. Fetched so an aggregate CI-health
    // claim ("N PRs red, sat X days") can be GROUNDED to the exact red PRs instead of an
    // unlocatable roll-up — the root cause of the "Stalled 80 days on Wlkr123" un-findable line.
    ctx.queries.getWorkspaceMetricsDetail(
      accountId,
      window,
      repoIds,
    ) as Promise<WorkspaceMetricsDetail>,
  ]);
  const cards = insights.cards;
  if (cards.length === 0) return null;

  // The SET of scope repos — a deliberate, user-initiated change (moving a repo between
  // workspaces, adding or removing one) that MUST flip staleness even when it doesn't alter the
  // card SET (a newly-added quiet repo, or the flow metrics shifting under the same issues).
  // getWorkspaceInsights is already scope-scoped, but the issue hash only fingerprints the cards;
  // the metrics that the report narrates (deploy freq, lead time, CI) span the whole scope set and
  // change wholesale when it does. We DON'T hash the metrics themselves (they churn continuously
  // with the clock — that would nag forever); the scope-repo set is the discrete signal that "the
  // report must change".
  //
  // The old else-branch — recomputing the watched set because `repoIds` could be `null` — is
  // DELETED: `resolveWorkspaceRepoIds` returns the workspace's membership, so this list is always
  // concrete and always exactly what the report covered.
  const scopeKeyRepos = [...repoIds].sort((a, b) => a - b).join(',');

  const loginOf = (id: number | null): string | null =>
    id == null ? null : (insights.users.find((u) => u.id === id)?.githubLogin ?? null);

  interface RepoAgg {
    repo: string;
    cards: number;
    loc: number;
    stalled: number;
    untouched: number;
    needsReviewer: number;
  }
  const repoAgg = new Map<string, RepoAgg>();
  const bump = (repo: string): RepoAgg => {
    const a =
      repoAgg.get(repo) ??
      { repo, cards: 0, loc: 0, stalled: 0, untouched: 0, needsReviewer: 0 };
    repoAgg.set(repo, a);
    return a;
  };

  const issues: unknown[] = [];
  const prRefs: DigestPrRef[] = [];
  const seenPr = new Set<number>();
  const addRef = (c: Extract<InsightCard, { prId: number }>): void => {
    if (seenPr.has(c.prId)) return;
    seenPr.add(c.prId);
    prRefs.push({
      prNumber: c.prNumber,
      prId: c.prId,
      repoId: c.repoId,
      repoFullName: c.repoFullName,
      title: c.prTitle,
      authorLogin: loginOf(c.authorId ?? null),
      authorId: c.authorId ?? null,
      state: 'open',
      // Enrichment for the tabular render (CI | age | author | diff). Cards carry
      // ageHours (not openedAt) — derive an approximate openedAt from it when present.
      ciStatus: c.ciStatus,
      additions: c.additions,
      deletions: c.deletions,
      changedFiles: c.changedFiles,
      // Every PR-bearing card now carries the PR's real open time (InsightPrRef.openedAt),
      // so the age column is correct for ALL kinds and it feeds the deterministic
      // LOC×age priority the renderer sorts by.
      openedAt: c.openedAt,
    });
  };

  let reviewersOverloaded = 0;
  for (const c of cards) {
    // bot_signal + bot_only_review are cross-repo AGGREGATE cards (no PR ref, no
    // repoFullName/additions/deletions) — not part of the per-PR digest the sprint report
    // compacts. Skip both here; they surface in the Insights UI directly.
    if (c.kind === 'bot_signal' || c.kind === 'bot_only_review') continue;
    // ⚠ AN EXPLICIT BRANCH, AND IT HAS TO BE. Falling through is WORSE than a silent drop here:
    // everything below `bump(c.repoFullName)` counts the card into that repo's importance ranking
    // (cards × 3) and adds a PR ref, so an unhandled kind quietly re-orders the report around
    // issues it never lists. `ci_failing` is a VIEWER-scoped red-build inbox item, not review-flow
    // work — the report's action items are reviews, and CI health is already a metrics line — so it
    // contributes nothing here rather than something misleading.
    if (c.kind === 'ci_failing') continue;
    // The same explicit branch, for the same reason. `merge` and `update_branch` are WORKLIST
    // items — "this can land now", "GitHub wants the branch updated" — not review findings, and
    // this report's action items are review-flow work. Falling through would count them into each
    // repo's `importance` (cards × 3 + LOC/50) and add PR refs to the linkable table while
    // contributing zero action items: the report would silently re-order itself around work it
    // never lists.
    if (c.kind === 'merge' || c.kind === 'update_branch') continue;
    // And the third merge-state kind, for the third time. A `conflicts` card is a git operation
    // waiting on a person with a checkout — not a review finding, so it has no action item to
    // contribute here. ⚠ IT IS THE ONE THIS LOOP WOULD HAVE SWALLOWED SILENTLY: `ConflictsCard`
    // extends `InsightPrRef`, so every field below (`repoFullName`, `additions`, `deletions`, and
    // everything `addRef` reads) EXISTS on it — no compile error, no failing test, just a report
    // whose repo `importance` (cards × 3 + LOC/50) and linkable PR table quietly grew around work
    // it never lists. The host union and this loop live in two repositories; only this line keeps
    // them honest.
    if (c.kind === 'conflicts') continue;
    // …and the two Dependencies-tab kinds, for the fourth time. A security fix or alert, and a
    // dependency bump, are not review-flow findings; falling through would count them into the
    // repo's `importance` and the linkable PR table while contributing no action item — and, like
    // `conflicts`, both extend `InsightPrRef`, so nothing below would fail to compile.
    if (c.kind === 'security' || c.kind === 'dependency_bump') continue;
    // …and EVERY my_turn card. The report is for a TEAM (the Slack digest posts it to a channel),
    // and My Turn is one person's board — the account that set the digest up. Its cards used to
    // feed `importance` and the PR table as that one reader's turn. No hash moves: `insightsHash`
    // already gives my_turn no slot.
    if (c.kind === 'my_turn') continue;
    if (c.kind === 'reviewer_load') {
      reviewersOverloaded += 1;
      issues.push({
        kind: c.kind,
        reviewer: loginOf(c.reviewerId),
        pending: c.pendingCount,
        reviewsThisSprint: c.reviewsThisSprint,
      });
      continue;
    }
    const agg = bump(c.repoFullName);
    agg.cards += 1;
    agg.loc += c.additions + c.deletions;
    addRef(c);
    if (c.kind === 'stalled_review') {
      agg.stalled += 1;
      issues.push({
        kind: c.kind,
        ref: prToken(c.repoFullName, c.prNumber),
        repo: c.repoFullName,
        pr: c.prNumber,
        title: c.prTitle,
        ci: c.ciStatus,
        loc: c.additions + c.deletions,
        ageHours: c.ageHours,
        ageDays: Math.round((c.ageHours / 24) * 10) / 10,
        waitingOn: [
          ...c.requestedReviewerIds.map(loginOf).filter(Boolean),
          ...c.requestedTeamNames.map((t) => `@${t}`),
        ],
      });
    } else if (c.kind === 'untouched_thread') {
      agg.untouched += 1;
      issues.push({
        kind: c.kind,
        ref: prToken(c.repoFullName, c.prNumber),
        repo: c.repoFullName,
        pr: c.prNumber,
        title: c.prTitle,
        path: c.path,
        ageHours: c.ageHours,
        ageDays: Math.round((c.ageHours / 24) * 10) / 10,
        waitingSince: loginOf(c.originalCommenterId),
      });
    } else if (c.kind === 'reviewer_routing') {
      agg.needsReviewer += 1;
      issues.push({
        kind: c.kind,
        ref: prToken(c.repoFullName, c.prNumber),
        repo: c.repoFullName,
        pr: c.prNumber,
        title: c.prTitle,
        touches: c.topPaths.slice(0, 3),
        suggest: c.suggestedReviewers.map((s) => ({
          who: loginOf(s.userId),
          why: s.reason,
        })),
      });
    }
  }

  // Importance = activity (insight cards touching the repo) + code volume (LOC). The
  // ranking the LLM is told to preserve.
  const repos = [...repoAgg.values()]
    .map((a) => ({
      repo: a.repo,
      importance: a.cards * 3 + Math.round(a.loc / 50),
      insightCards: a.cards,
      codeVolumeLoc: a.loc,
      stalled: a.stalled,
      untouched: a.untouched,
      needsReviewer: a.needsReviewer,
    }))
    .sort((x, y) => y.importance - x.importance);

  const headline = {
    stalledReviews: cards.filter((c) => c.kind === 'stalled_review').length,
    untouchedThreads: cards.filter((c) => c.kind === 'untouched_thread').length,
    needsReviewer: cards.filter((c) => c.kind === 'reviewer_routing').length,
    reviewersOverloaded,
    reposActive: repoAgg.size,
  };

  // The concrete PRs behind the aggregate CI-failure metric (`metrics.ciFailingNow`), so the CI-health
  // line can NAME the red PRs (with a precomputed red-age) instead of narrating an unlocatable count.
  // Bounded, longest-red first; each also becomes a linkable prRef (deduped against the card refs).
  const CI_RED_CAP = 10;
  const detailLoginOf = (id: number | null): string | null =>
    id == null ? null : (detail.users.find((u) => u.id === id)?.githubLogin ?? null);
  const ciRedPrs = detail.ciRed.slice(0, CI_RED_CAP).map((p: MetricPr) => ({
    ref: prToken(p.repoFullName, p.prNumber),
    repo: p.repoFullName,
    pr: p.prNumber,
    title: p.prTitle,
    ci: p.ciStatus,
    redDays:
      p.redAgeHours != null ? Math.round((p.redAgeHours / 24) * 10) / 10 : null,
    author: detailLoginOf(p.authorId),
  }));
  for (const p of detail.ciRed.slice(0, CI_RED_CAP)) {
    if (seenPr.has(p.prId)) continue;
    seenPr.add(p.prId);
    prRefs.push({
      prNumber: p.prNumber,
      prId: p.prId,
      repoId: p.repoId,
      repoFullName: p.repoFullName,
      title: p.prTitle,
      authorLogin: detailLoginOf(p.authorId),
      authorId: p.authorId,
      state: p.state,
      ciStatus: p.ciStatus,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      openedAt: p.openedAt,
    });
  }

  // The team flow metrics DRIVE the report — hand them to the model verbatim (stat
  // tiles carry `.value` this sprint + `.previous` last sprint for trend reads). `ciRedPrs`
  // grounds the CI-health narration to specific, clickable PRs.
  const payload = {
    sprint: insights.sprint,
    metrics: insights.metrics,
    headline,
    repos,
    issues,
    ciRedPrs,
  };
  // The $0-on-unchanged key: the issue SET (insightsHash) PLUS the day-quantized sprint window
  // PLUS the elapsed DAY within the sprint. The report is now written as a point-in-time "day N
  // of M, so far" snapshot whose lowConfidence verdicts flip as samples accrue — so it must be
  // able to advance day-by-day. For the DEFAULT (unconfigured) window `windowKey` already slides
  // daily; for a CONFIGURED sprint `windowKey` is PINNED for the whole sprint, so without the
  // elapsed-day term the prose would freeze at "Day 1 — too early" while the live tiles move to a
  // real trend, and even an explicit Regenerate would hit the hash gate and return the stale text.
  // `elapsedDayKey` (ceil of elapsedDays) makes the report go stale once per day → Regenerate is
  // offered (and actually regenerates) daily, matching the day-by-day tiles. Day granularity still
  // avoids sub-day churn, and generation stays user/schedule-triggered so this is ≤1 regen/day.
  const windowKey = `${insights.sprint.from.slice(0, 10)}..${insights.sprint.to.slice(0, 10)}`;
  const elapsedDayKey = Math.max(0, Math.ceil(insights.metrics?.elapsedDays ?? 0));
  // The composite keeps its SHAPE; only the `s<scope>` segment's vocabulary changed
  // ('all'/'<teamId>' → 'ws:<id>'), which mismatches every stored hash exactly once. Every
  // Date.now()-derived value is still quantised to a day, so an idle account never re-bills.
  const hash = createHash('sha256')
    .update(
      `${insightsHash(cards)}|${windowKey}|${scopeKeyRepos}|d${elapsedDayKey}|s${scopeKeyFor(
        scope.workspaceId,
      )}`,
    )
    .digest('hex');
  return { payload, hash, prRefs, sprint: insights.sprint };
}

// The report's linkable PR refs = the deterministic card/CI-red set UNION the refs the model
// actually wrote, VALIDATED against the DB. resolveScopePrRefs only returns `owner/name#N` tokens
// that resolve to a real PR this account owns, so a fabricated ref (or a mis-paired repo/number) is
// simply never linkified — it stays inert plain text. This is the "deterministically checked for
// validity" guarantee: the reader can trust that every LINK in the report points at a genuine PR,
// and everything the model cited that IS real becomes clickable (not just the card-derived subset).
//
// These refs are also the Slack formatter's title/author source (slack/format.ts). They are read
// on every load or refresh and never enter `buildSprintPayload`'s hash
// (`insightsHash|windowKey|scopeKeyRepos|d<day>|s<scope>`). Keep them out: a hydrated value in the
// hash re-bills forever. When a card ref and an emitted ref name the same PR, the card ref wins and
// any title/author it lacks is filled from the emitted one (a read-time merge; nothing is stored).
async function enrichedPrRefs(
  ctx: ProContext,
  accountId: number,
  summary: string,
  cardRefs: DigestPrRef[],
): Promise<DigestPrRef[]> {
  const emitted = await resolveScopePrRefs(ctx, accountId, summary);
  const byId = new Map<number, DigestPrRef>();
  for (const r of cardRefs) if (r.prId != null) byId.set(r.prId, r);
  for (const r of emitted) {
    if (r.prId == null) continue;
    const card = byId.get(r.prId);
    if (card == null) {
      byId.set(r.prId, r);
    } else if (card.title == null || card.authorLogin == null || card.authorId == null) {
      byId.set(r.prId, {
        ...card,
        title: card.title ?? r.title,
        authorLogin: card.authorLogin ?? r.authorLogin,
        authorId: card.authorId ?? r.authorId,
      });
    }
  }
  return [...byId.values()];
}

// Generate + persist the report (the ONE billing path). Returns null when there's
// nothing to summarise.
async function generateReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  scope: BotScopeWire,
): Promise<SprintReport | null> {
  const scopeKey = scopeKeyFor(scope.workspaceId);
  const built = await buildSprintPayload(ctx, accountId, scope);
  if (!built) return null;
  // $0-on-unchanged gate: if the stored report already matches this Insights state, return it
  // without re-billing (mirrors the per-repo digest's payload-hash cache). Scheduled AI-update
  // policies + Slack sends rely on this so an unchanged sprint costs nothing per tick/send.
  const pro0 = proSchemaFor();
  const existing = (await ctx.db
    .select()
    .from(pro0.sprintReports)
    .where(
      and(
        eq(pro0.sprintReports.accountId, accountId),
        eq(pro0.sprintReports.scopeKey, scopeKey),
      ),
    )
    .execute()) as Array<{
    insightsHash: string;
    model: string;
    summary: string;
    costUsd: number | null;
    createdAt: Date | number | null;
  }>;
  const prev = existing[0];
  if (prev && prev.insightsHash === built.hash) {
    return {
      summary: prev.summary,
      prRefs: await enrichedPrRefs(ctx, accountId, prev.summary, built.prRefs),
      model: prev.model,
      generatedAt: tsToIso(prev.createdAt),
      costUsd: prev.costUsd ?? null,
      stale: false,
      sprint: built.sprint,
    };
  }
  const out = await llm.complete({
    system: SPRINT_SYSTEM,
    user: JSON.stringify(built.payload),
    maxTokens: SPRINT_MAX_TOKENS,
  });
  const summary = out.text.trim();
  const now = new Date();
  // Record the spend on the shared AI-usage ledger (summary seam). Best-effort.
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'summary',
      feature: 'sprint_report',
      model: DIGEST_MODEL,
      costUsd: out.costUsd,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
    })
    .catch(() => {});
  const pro = proSchemaFor();
  await ctx.runTransaction(async (tx) => {
    await tx
      .insert(pro.sprintReports)
      .values({
        accountId,
        scopeKey,
        insightsHash: built.hash,
        model: DIGEST_MODEL,
        summary,
        costUsd: out.costUsd,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        sprintFrom: new Date(built.sprint.from),
        sprintTo: new Date(built.sprint.to),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [pro.sprintReports.accountId, pro.sprintReports.scopeKey],
        set: {
          insightsHash: built.hash,
          model: DIGEST_MODEL,
          summary,
          costUsd: out.costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          sprintFrom: new Date(built.sprint.from),
          sprintTo: new Date(built.sprint.to),
          createdAt: now,
        },
      })
      .execute();
  });
  return {
    summary,
    prRefs: await enrichedPrRefs(ctx, accountId, summary, built.prRefs),
    model: DIGEST_MODEL,
    generatedAt: now.toISOString(),
    costUsd: out.costUsd,
    stale: false,
    sprint: built.sprint,
  };
}

const disabled = (): SprintReportResponse => ({
  enabled: false,
  model: DIGEST_MODEL,
  report: null,
});

// Load the cached report + a freshly-recomputed staleness flag and cross-repo prRefs
// (so links stay valid as the board shifts). Null when nothing's been generated yet.
async function loadReport(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
): Promise<SprintReport | null> {
  const scopeKey = scopeKeyFor(scope.workspaceId);
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select()
    .from(pro.sprintReports)
    .where(
      and(
        eq(pro.sprintReports.accountId, accountId),
        eq(pro.sprintReports.scopeKey, scopeKey),
      ),
    )
    .execute()) as Array<{
    insightsHash: string;
    model: string;
    summary: string;
    costUsd: number | null;
    sprintFrom: Date | number | null;
    sprintTo: Date | number | null;
    createdAt: Date | number | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  const built = await buildSprintPayload(ctx, accountId, scope);
  // Nothing to report right now (no insight cards — e.g. the workspace holds only quiet repos,
  // or every attention item was cleared). Return null rather than the stored row: the
  // card then shows its clean "nothing to report / Generate" placeholder, consistent with the
  // Insights "Nothing needs attention" empty state beside it — instead of a stale ghost summary
  // about repos that have since left the workspace, which the built-null path used to mark stale:false
  // (leaving no Regenerate affordance to clear it).
  if (!built) return null;
  return {
    summary: row.summary,
    prRefs: await enrichedPrRefs(ctx, accountId, row.summary, built.prRefs),
    model: row.model,
    generatedAt: tsToIso(row.createdAt),
    costUsd: row.costUsd ?? null,
    stale: built.hash !== row.insightsHash,
    sprint: { from: tsToIso(row.sprintFrom), to: tsToIso(row.sprintTo) },
  };
}

// Would a refresh right now be served from cache (throttled) rather than regenerating? Reads
// the SAME guard state refreshSprintReport checks, so the route can tell the client its
// "Regenerate" no-op'd and show a "refreshed moments ago" notice. `force` (an explicit manual
// Regenerate) bypasses the min-interval cooldown, so it only reports throttled when a run is
// actually in flight.
export function isSprintRefreshThrottled(
  accountId: number,
  workspaceId: number,
  force = false,
): boolean {
  const key = throttleKeyFor(accountId, workspaceId);
  const now = Date.now();
  const last = sprintLastRefreshAtByKey.get(key) ?? 0;
  return sprintInFlightKeys.has(key) || (!force && now - last < MIN_INTERVAL_SEC * 1000);
}

// The throttled, in-flight-guarded refresh — the single sprint-report billing entry. Serves the
// cached row when throttled/in-flight; otherwise regenerates (itself $0 when the Insights state is
// unchanged, via generateReport's hash gate). TWO callers now: the manual Regenerate route and the
// Slack digest cron — the AI-update policy sweep that used to sit alongside them was deleted with
// its setting. `force` = an explicit MANUAL Regenerate: it bypasses the MIN_INTERVAL_SEC cooldown
// (a user who clicks Regenerate on a stale report shouldn't be told to wait 60s) while KEEPING the
// in-flight guard (no concurrent double-run) and the payload-hash gate (unchanged content is still
// $0), so cost stays bounded. The Slack cron omits force → stays throttled. Returns null when
// digests are disabled / nothing to say.
//
// ⚠ NONE OF THESE GUARDS ARE VESTIGIAL NOW THAT THE CRON IS GONE. The payload-hash gate in
// particular is what makes the MANUAL button $0 on an unchanged workspace, and `force` bypasses
// only the cooldown — never the hash. Deleting them would re-bill every click.
//
// ⚠ `workspaceId` IS REQUIRED — it replaced a `scope = 'all'` default, and that is a SIGNATURE
// change, not a vocabulary one. The Slack digest sweep that leaned on that default has no request
// and therefore no `?workspace=`, so it must resolve `ctx.queries.defaultWorkspaceId(accountId)`
// explicitly. Stated out loud because it is a real behaviour change: that cron now covers the
// DEFAULT WORKSPACE ONLY, where it previously covered every watched repo in the account. Iterating
// every workspace would multiply a billed LLM call by workspace count on a cron, which is not a
// change to make silently either.
/** The stored report, no model call — what the Slack digest sends when the Claude spend budget is
 *  reached (core ai/budget.ts). */
export async function storedSprintReport(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<SprintReport | null> {
  return loadReport(ctx, accountId, await workspaceScope(ctx, accountId, workspaceId));
}

export async function refreshSprintReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  workspaceId: number,
  force = false,
): Promise<SprintReport | null> {
  const scope = await workspaceScope(ctx, accountId, workspaceId);
  const key = throttleKeyFor(accountId, workspaceId);
  const now = Date.now();
  const last = sprintLastRefreshAtByKey.get(key) ?? 0;
  const throttled =
    sprintInFlightKeys.has(key) || (!force && now - last < MIN_INTERVAL_SEC * 1000);
  if (throttled) {
    return loadReport(ctx, accountId, scope);
  }
  sprintInFlightKeys.add(key);
  sprintLastRefreshAtByKey.set(key, now);
  try {
    return await generateReport(ctx, llm, accountId, scope);
  } finally {
    sprintInFlightKeys.delete(key);
  }
}

export function registerSprintReportRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  // Cached report (free). `?workspace=<id>` selects the workspace's report; absent / unknown /
  // another tenant's id ⇒ the account's Default.
  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/sprint-report',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const resp: SprintReportResponse = {
        enabled: true,
        model: DIGEST_MODEL,
        report: await loadReport(ctx, accountId, await workspaceScope(ctx, accountId, workspaceId)),
      };
      return reply.send(resp);
    },
  );

  // Regenerate (the only billing path). Shares the digest's per-account throttle +
  // in-flight guard (one AI budget per account); serves the cached row unchanged when
  // throttled or already in flight rather than erroring.
  app.post<{ Querystring: { workspace?: string } }>(
    '/api/pro/sprint-report/refresh',
    async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
    // This route is always an explicit MANUAL Regenerate → force past the min-interval cooldown
    // (the in-flight guard + payload-hash $0-gate still bound cost). `throttled` is then only true
    // when a run is genuinely in flight (a rapid double-click), which the notice explains.
    const throttled = isSprintRefreshThrottled(accountId, workspaceId, true);
    const report = await refreshSprintReport(ctx, llm, accountId, workspaceId, true);
    const resp: SprintReportResponse = {
      enabled: true,
      model: DIGEST_MODEL,
      report,
      throttled,
    };
    return reply.send(resp);
    },
  );
}

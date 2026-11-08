# Period reporting + effort-vs-automation (the CORE metrics layer)

> **Read before touching:** `apps/backend/src/db/period-metrics.ts`,
> `apps/backend/src/db/forecast.ts`, `apps/backend/src/db/actor-lanes.ts`,
> `apps/backend/src/db/person-period.ts`, and the shared contract in
> `packages/shared/src/types.ts` (`PeriodMetricKey` / `PERIOD_METRIC_KEYS` /
> `PERIOD_METRICS_SCHEMA_VERSION` / `ActorLane` / `ACTOR_LANES` / `REVIEWER_ROLE_LANE` /
> `PeriodRefusalReason`). On the frontend: `components/Activity/PeriodReportsPanel.tsx` +
> `periodReportMarkdown.ts` (`rowFigures`). Tests:
> `apps/backend/src/db/period-metrics.test.ts`, `forecast.test.ts`, `actor-lanes.test.ts`,
> `person-period.test.ts`, `apps/frontend/test/periodMetricRow.test.ts`.
>
> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md.

## What this is, and where the seam falls

The Insights → **Reports** pane is a **stored, forwardable artifact per completed period**
("5 Aug – 19 Aug"), its comparison against the prior one, and a **refusable** forecast.

**The numbers are CORE and deterministic** — no model, no GitHub quota, no new core
table:

| Layer | Lives in | Part |
|---|---|---|
| The **metric vector** (15 keys), coverage, the lane breakdown | `db/period-metrics.ts` | CORE |
| The **forecast estimator** (pure, no I/O, no db import) | `db/forecast.ts` | CORE |
| **Who did the work** — the eight-lane actor resolver | `db/actor-lanes.ts` | CORE |
| The **1:1 person vector** (no caller since 2026-10-22 — the People report is removed; kept behind the required `getPersonPeriod` seam) | `db/person-period.ts` | CORE |
| **Storage, narration, routes, hashing, backfill** | `apps/backend/src/platform/insights/period-report.ts` (+ platform migrations `0025`/`0026`) | platform |

> ⚠ **REMOVED 2026-10-22:** "Ask about this period" (the chat under a report), the People report
> and 1:1 prep, with their routes. Rules below that mention them are history; what they protected
> (one-person-per-request, the union gate on the bot routes) is described where it still applies.

The platform half — the stored rows, the Haiku narration (shown while `me.ai.enabled`; the numbers
render without it), `/api/pro/insights/period*`, the `payloadHashFor` cache key and the (removed) People-report
contract — is documented in [PLATFORM.md](PLATFORM.md)
(§ The synthesis seam, § The sprint cadence is PER-WORKSPACE, § The People report). This doc is the core side: the definitions, why they are shaped this
way, and what will bite you.

⚠ **`period-metrics.ts` writes its own SQL and reuses NONE of the existing getters, on
purpose.** Measured against the live dev DB before the file existed: `getWorkspaceMetrics`'
stat tiles honour an arbitrary window but its weekly series are a FIXED 12 weeks ending NOW;
`openPrs`/`ciFailingNow` are current-state snapshots; `ciFailureReasons` has no upper bound at
all; `getWorkspaceMetricsDetail` ignores `window.toMs` outright. None of them can answer "what
did July look like", and bending them into it would move every existing tile. It is a second,
narrower reader over the same tables — deliberately, not by oversight. It also lives in its
own file rather than `queries.ts` because that file is 13k lines and **contains literal NUL
bytes** around offset 132k, so every search tool silently under-reports matches inside it.

---

## There is no cross-workspace comparison

The Reports "By workspace" axis (a per-metric expander under each metric row, riding `byWorkspace`
on the one-report GET via the `getPeriodMetricsForWorkspaces` seam) was REMOVED 2026-10-26, after
`GET /api/workspace-metrics/compare` before it. Neither the fold, the seam, the wire field nor the UI
remains; do not reintroduce one. Every Reports figure is about the ONE viewed workspace. (Until
2026-10-22 Period reports, Chronology and the Bots ROI panel were Pro, visible-but-locked; every
gate, badge and lock pane went with the plugin.)

⚠ **`enabled: false` STAYS SILENT.** `GET /api/pro/insights/reports` can still answer
`{enabled:false}`; `PeriodReportsPanel` keeps that as a branch returning `null` rather than an
error.

---

## Window purity — no "as of now" snapshot may enter the vector

**Every metric is WINDOW-PURE: a function of events timestamped in `[fromMs, toMs)` and
nothing else.** A stored historical period has to stay *reproducible* — regenerating the
"5 Aug – 19 Aug" report in November must produce the same numbers it produced in August — and
a snapshot is not reproducible. It goes stale by simply existing.

So the vector deliberately OMITS figures the live DORA header carries:

- **`openPrs`** — "open right now" is a fact about today, not about August.
- **`ciFailingNow`** — same.
- **open-PR age**, **current thread state** — same.
- **Trunk red share** is absent for a *different* reason: `trunk_ci_status_events` has **no
  backfill** (a known gap — the writer only appends on a transition observed at the end of a
  full walk), so it is not computable for a past period AT ALL. A metric that silently reads
  "0% green" for every period before the feature shipped is worse than an omitted one.

⚠ **Every predicate is TWO-SIDED: `>= from AND < to`.** A one-sided `gte` is precisely what
makes the three existing getters unusable here, and the **half-open upper bound** is what stops
two adjacent periods double-counting the event that lands on their shared boundary.
`period-metrics.test.ts` pins both edges on four different columns.

The one deliberate exception to half-open is `getPeriodCoverage`'s bound, which is a real
`lte` — see below, and note the dialect trap recorded there.

### The vector: 15 keys, closed and ordered

`PERIOD_METRIC_KEYS` is **CLOSED and ORDERED at schema version 2, and that order IS the render
order** — part of the contract. Each human-only twin sits immediately after the blended figure
it corrects, so read adjacently they state the automation gap without any narration:

```
merged_prs
human_merged_prs
opened_prs
automation_merge_share_pct
median_lead_time_hours
median_time_to_first_human_review_hours
merge_ci_success_pct
median_pr_size_lines
median_human_pr_size_lines
review_threads_opened
threads_replied_within_36h_pct
bot_review_comments
human_review_comments
bot_comments_per_merged_pr
reviewer_concentration_pct
```

(⚠ Several comments inside `period-metrics.ts` still say "**twelve** figures" — that count is
stale, from before the v2 twins landed. The array is authoritative; count it, don't read it.)

`PeriodMetricsResult.metrics` carries **all of them, always present** — a missing key and a
null value are different facts and only one of them is legal on the wire. `null` is NOT `0`
and must never render as `0`: a count is a real observation (0 merged PRs is `0`), and only an
EMPTY SCOPE or a statistic with nothing behind it (a median of nothing, a percentage of
nothing) is null.

### Significance floors live beside the definitions

`PERIOD_METRIC_META` is a `Record<PeriodMetricKey, …>` **on purpose**: adding a key to the
union without a row here is a COMPILE error, which is the only mechanism that keeps a version
bump honest. Each row carries `direction` (`up_good` / `down_good` / `neutral`), a
`sampleFloor` and an `absoluteFloor` in the metric's OWN units.

A delta is `significant` only when **both** periods clear the sample floor, the absolute
change clears the absolute floor, AND the two periods are coverage-comparable. A percentage
change off a tiny base is noise wearing a suit — this codebase has learned that twice (the
bot-volume `BASELINE_MIN_EXPECTED` floor is the same lesson at a different grain), which is
why the floors live here rather than being re-invented by whichever consumer renders the delta.

⚠ **`automation_merge_share_pct` is `neutral` and that is a product decision, not a hedge.**
More automation is not self-evidently good (a team drowning in bumps) or bad (a team shipping
with agents). The lane split is what makes the number readable; an arrow claiming a direction
would assert a judgement the figure cannot support.

---

## Retroactive history is COVERAGE-BIASED

This is the single most important thing in the feature, and it is not optional.

**Measured on the dev DB.** Merged-PR counts by 14-day period over the last six months, oldest
period last:

```
merged PRs   570  572  557  494  491  537  464  292  354  232  230  177   39
repos        18   19   18   18   19   18   18   13   12   10    9    6    4
```

Read the top row alone and it is explosive growth: 39 → 570, a 14× improvement in team output.
The bottom row is the number of repos **contributing** to those same periods. The "trend" is
**repo onboarding**, not team output. A forecast fitted on the top row would predict growth
that is purely a data artifact.

Three mechanisms exist because of this:

### 1. `getPeriodCoverage(accountId, repoIds, atMs)`

Answers *which of these repos were already being TRACKED at `atMs`* — i.e.
`repos.createdAt <= atMs`. `repos.createdAt` is when the repo was added to **this account**,
not when it was created on GitHub: the same column My Turn's "New PRs" cutoff rides, and
load-bearing for the same reason — it is the earliest instant we could possibly know anything
about the repo.

⚠ **The bound is INCLUSIVE (`lte`), unlike the metric window's half-open upper edge** — a repo
added at the exact instant a period starts contributed to the whole of it. ⚠ **And it must be
a real `lte`, never `lt(…, atMs + 1)`**: SQLite stores `mode: 'timestamp'` as epoch SECONDS,
so a one-millisecond nudge lands in the SAME stored value and would silently flip the boundary
from inclusive to exclusive — **in one dialect only**. The returned ids are sorted ascending so
a stored `repo_ids_json` and a recomputed one compare byte-for-byte.

`PeriodCoverage` on the wire is `{trackedRepos, totalRepos, complete}`.

### 2. The comparison runs over the coverage-stable SUBSET

A comparison is drawn over the **intersection of the two periods' tracked sets**, so it is
like-for-like; the platform recomputes the prior period over that subset scope
(`comparison.subsetRepoIds` + a `subsetDisclosure` string such as *"covers 12 of 18 repos
tracked across both periods"*). An empty intersection, a changed cadence or a missing prior
period is a **named refusal**, never a fabricated number.

### 3. The forecast REFUSES rather than fitting a line through an artifact

`db/forecast.ts` is pure — no db imports, no I/O, not async, plain arrays in and out, robust
estimators only, unit-tested with literal arrays (`forecast.test.ts`) because that is the whole
point of keeping it pure: the numbers layer has to be checkable without a fixture DB. Same
discipline as `db/changepoint.ts`.

- ⚠ **THEIL–SEN, NEVER LEAST SQUARES.** A period series is 4–8 points long, so ONE chaotic
  sprint is 12–25% of the sample and OLS follows it. Measured on the test fixture:
  `[10, 12, 900, 16, 18]` — a single wild period in the MIDDLE, where its leverage on the SLOPE
  is zero — still drags the OLS intercept to 187.2 and forecasts 197.2, while the true line
  forecasts 20. Move that outlier to the END and OLS forecasts 725.6. Theil–Sen answers 20 in
  both cases, which is the same answer it gives for the clean series. The band is **MAD-derived**
  for exactly the same reason: a standard deviation would let one spike manufacture a
  plausible-looking interval around a number that is already wrong.
- ⚠ **NULLS ARE SKIPPED, NEVER IMPUTED, and the x axis is the ARRAY INDEX.** A period with no
  data is not a period with zero — imputing a 0 invents a crash that did not happen, and
  compacting the indices invents a cadence that does not exist. Keeping x = the original index
  means a gap stays a gap: `[10, null, 30, null, 50, null, 70]` forecasts 80 (slope 10 per
  period), not the 90 compaction would produce. A TRAILING null still consumes its slot.
- **Both refusals are NAMED and travel to the UI** as `PeriodRefusalReason`
  (`insufficient_history` — fewer than `MIN_FORECAST_POINTS` = 4 real points, matching
  changepoint.ts's `MIN_BASELINE_POINTS` deliberately — and `too_volatile`), because a blank
  band and a confident band around noise are the same pixel to a reader. `ForecastResult.basis`
  is a short human string naming the estimator and the band: a forecast whose method is
  invisible is a number the reader has to take on faith. `periodsUsed` counts NON-NULL periods,
  not `values.length`. The full refusal union is `no_prior_period | cadence_changed |
  partial_coverage | insufficient_history | too_volatile`.

---

## `PERIOD_METRICS_SCHEMA_VERSION` = 3

**v3 (2026-11-08)**: Limn's own writes (reviews, approvals, merges, pushes) moved off the people's
figures into the `limn` lane ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Limn's actions are bots), so every
human-only figure changed meaning — bumped in both spellings (shared `types.ts`, `db/period-metrics.ts`).

The version is **folded into the platform's `payloadHashFor`** (`v:${…}` alongside the `p3|`
formula prefix, the workspace, the period key, the cadence, the model, the sorted repo ids, the
coverage fraction, every metric value+sample size and the comparison's subset ids). That makes
a bump **self-executing**: every stored row's hash moves at once, so each row reads `stale` and
regenerates on the next read. Nothing `Date.now()`-derived is in the hash — every input is a
function of stored rows and the fixed period window — which is what keeps a dormant workspace
from re-billing on a timer.

Stored rows also carry `metricsSchemaVersion` as a column, and the reader filters
`rows.filter(r => r.metricsSchemaVersion === PERIOD_METRICS_SCHEMA_VERSION)` before treating
history as comparable.

### Three spellings, kept in lockstep

| Spelling | Why it exists |
|---|---|
| `packages/shared/src/types.ts` | the wire contract |
| `apps/backend/src/db/period-metrics.ts` | **mirrored, not imported** |
| `apps/backend/src/platform/insights/period-report.ts` | **mirrored, not imported** |

The mirror dates from when the shared package was **types-only and not shipped** (a value import
failed the release build). Shared is now vendored into the release ([PACKAGING.md](PACKAGING.md)),
but the mirrors stay — `PERIOD_METRIC_KEYS` is mirrored the same way. **`period-metrics.test.ts` imports the shared originals** (a
test is not in `release/dist`) and asserts the arrays are identical, so drift is caught in CI
rather than by a reader.

### ⚠ v1 → v2 was a CORRECTNESS fix, not a feature

v1's **`median_time_to_first_review_hours`** read `pull_requests.first_review_at`, which
records whoever reviewed **FIRST** — including automation. On a workspace where
`github-actions[bot]` auto-approves on push, it reported **0h across 115 PRs, against a real
human median of 18.3h**. The number was not slightly wrong; it was measuring a different event
and describing it with the word "review".

The fix has four parts, and the shape of it is the reusable lesson:

1. **RENAMED, never redefined in place** → `median_time_to_first_human_review_hours`, computed
   from the `reviews` table with a lane filter. Redefining a key in place would leave a v1 row
   and a v2 row subtractable under one key, silently comparing two different measurements. A
   rename makes the incompatibility structural.
2. **Human-only twins added beside the blended figures they correct** —
   **`human_merged_prs`** and **`median_human_pr_size_lines`**. Blended PR size on the measured
   workspace read **68**: Dependabot's 14-line bumps mixed with the humans' 142-line changes.
   68 is not a compromise between two numbers, it is **a number no pull request in that
   workspace resembled**, and it understated real human PR size by 2.1×.
3. **`automation_merge_share_pct` added** so the gap the twins expose has a figure of its own
   (117 merged PRs of which 46 were Dependabot).
4. Every stored row goes stale via the hash and regenerates — no migration, no backfill script.

**When to bump.** Only when a definition was actually *wrong*. The lane breakdown is
deliberately NOT part of the vector for this exact reason: adding keys invalidates every stored
period against the new ones, and "how much of this was a person" is a NEW question, so it gets
its own additive block and costs the existing periods nothing.

### ⚠ A `_pct` metric MUST join `PCT_METRIC_KEYS`

`PCT_METRIC_KEYS` lives in the **platform** (`platform/insights/period-report.ts`) and declares the
metrics measured on a 0–100 scale. Their forecast declares `{max: 100}`; without it a rising
series projects **"CI success ≈ 104% (98–110%)"** — not a bold call but an impossible number.

Current members: `merge_ci_success_pct`, `threads_replied_within_36h_pct`,
`reviewer_concentration_pct`, `automation_merge_share_pct`.

⚠ **Adding a `_pct` metric without adding it here is a SILENT DEFECT, not a compile error.**
The series fits fine and simply projects an impossible number ("112% of merges authored by
automation"). It is kept beside the forecast rather than in core because the SCALE is a
property of the metric definition, and core's estimator is deliberately told nothing about
which metric it is fitting.

---

## The eight `ActorLane`s (`db/actor-lanes.ts`)

The vector answers *what happened*; the lane resolver answers *how much of it was a person*.
Both are needed, because on a real workspace the blend is severe enough to make the headline
figures describe nobody (the 68-line median above).

```
human · code_agent · dependency · limn · ai_review · quality_gate · release · housekeeping
```

`limn` is Limn itself: every `limn:<login>` bot, whatever its stored role (rule 0 below), band
`responds`, label "Limn".

`ACTOR_LANES` render order is people first, then the automation that **AUTHORS** code (the
lanes that distort throughput), then the automation that **RESPONDS** to it (the lanes that
distort review counts) — that grouping is `ActorLaneBand` (`people` | `authors` | `responds`),
and it is not cosmetic: the band is the answer to *"which figures above should I distrust
because of this"*. `release` sits in `authors` because release trains and backporters open real
pull requests; a merge queue that only merges contributes to neither count.

### Why lanes and not "bot vs human"

Because automation contaminates DIFFERENT metrics depending on what it does, and one bucket
cannot tell those apart:

| Lane | What it does | What it distorts |
|---|---|---|
| `dependency` | authors bumps | throughput, lead time, PR size |
| `code_agent` | authors real changes | the same metrics, meaning the OPPOSITE |
| `quality_gate` | responds / approves | review counts, approvals |
| `ai_review` | writes findings | the only automation whose review volume means anything |
| `release` | merges / tags | its merges are governance events, not work |
| `housekeeping` | greets, labels, triages | pure noise in every one of the above |

"Your throughput is inflated by bumps" and "your approvals are automated" are different
problems with different fixes, and a single `isBot` flag can state neither. The same workspace
showed **SonarQube posting 786 comments — every one of them a "Quality Gate Passed/Failed"
badge**; folding that volume in with an AI reviewer's findings would report 786 pieces of
feedback where there were none. It also submitted **384 automated approvals** via
`github-actions`, which is why approvals are counted separately from comments.

### ⚠ The dependency / `code_agent` split resists collapsing — do not merge them

It is the split most likely to be "simplified" back. Both lanes AUTHOR pull requests, so any
"bot vs human" view puts them together — and yet **a merged Dependabot bump is overhead a team
absorbed, while a merged agent PR is work it shipped**. A single "automation authored 40% of
merges" figure that mixes them tells the reader nothing they can act on.

### The resolver's rule order IS the contract

The categories genuinely overlap (`github-advanced-security` is a scanner with a vendor brand;
SonarQube is a quality check some accounts classify by hand; Copilot both reviews and,
elsewhere, authors). Earlier rules win:

0. a `limn:` login → `limn` (before everything: it is never a person)
1. manual "this is a person" → `human` (nothing overrules it)
2. no automation signal at all → `human`
3. **MANUAL** role → that role's lane
4. known login vocabulary (`roleForBotLogin`) → that role's lane
5. stored role **other than** `'review'` → that role's lane (a seed we derived)
6. vendor kind in `AI_REVIEW_KINDS` → `ai_review`
7. anything else automated → `quality_gate`

⚠ **Rules 3 and 5 are the same column read twice, and splitting them is the point.** `role`
defaults to `'review'`, so a stored `'review'` is ambiguous: on a manual row it means "a person
chose Review bot", on every other row it means "we have never heard of this login". Collapsing
the two either ignores the user's choice (mark Copilot a code agent, watch the report keep
calling it AI review) or lets a stale default beat a login we positively recognise.
`manualRoleUserIds` carries the disambiguation, and it is automated-rows-only so a manual HUMAN
cannot be handed a bot lane by whatever role their row happens to carry.

⚠ **Rule 7 is deliberately NOT `ai_review`, and also NOT `housekeeping`.** An unrecognised
automation is far more likely to be a CI script than a reviewer, and the cost of the mistakes
is asymmetric: miscounting a script as a quality gate understates nothing anyone acts on;
miscounting it as an AI reviewer **inflates the one number a team would use to judge whether
their review tooling is earning its licence**; filing it under housekeeping would quietly drop
it out of every count instead of merely declining to credit it.

⚠ **`in_house` is NOT in `AI_REVIEW_KINDS`,** and the shared type's description ("the account's
OWN AI") is not what the column actually holds. Measured live: of 37 rows carrying
`kind: 'in_house'`, **25 were assigned by `source: 'github_type'`** — the fallback for "this is
a GitHub App and we don't recognise the brand". That bucket contained sonarqubecloud,
dependabot[bot], github-actions[bot], gitguardian, socket-security, google-cla and jit-ci; not
one of them is an AI reviewer. Treating it as one produced exactly the failure this module
exists to prevent: `github-actions` landed in `quality_gate` while `github-actions[bot]` — the
SAME actor, second user row, the one carrying the `in_house` classification — landed in
`ai_review`. One CI bot, two lanes, both under-counted, and the "is our AI review tooling
earning its licence" number quietly inflated by 384 automated approvals.

`ROLE_LANE` is **mirrored** from shared's `REVIEWER_ROLE_LANE` (same runtime-import reason as
the schema version) and `actor-lanes.test.ts` asserts the two are identical. It is deliberately
**1:1**: a user who picks "Release automation" and finds the actor filed under "Quality gate"
has been told their choice did not take.

### ⚠ The automation set is the lane resolver's UNION, not `automatedReviewerUserIds` alone

```
automated  ⇐  workspace verdict ∪ users.isBot ∪ the login vocabularies
human      ⇐  only when NO signal fires, or a human explicitly said so
```

**Why the union.** Real accounts carry the SAME actor as two user rows with CONFLICTING flags:
`dependabot` and `dependabot[bot]`, `github-actions` and `github-actions[bot]`. On the measured
account **one of each pair sat at `workspace_reviewers.automated = 0`, i.e. counted as a
human** — which is what put bot text into `human_review_comments`. Merging the rows is not an
option: they have different GitHub node ids and may be genuinely different accounts (an App vs
a user of the same name). So the resolver never trusts a single signal.

⚠ **A genuine manual "this is a person" still wins and is checked FIRST.** Widening detection
to `users.isBot` + the vocabularies re-admits an actor a person has explicitly marked human —
because such an actor usually *has* a bot-ish login or a stale global flag, which is exactly
WHY someone corrected it by hand. What does not win is the mere ABSENCE of an automated verdict.

`users` is a **GLOBAL** table, so the `isBot` sweep is read **by id** and never handed out whole; `ActorLanes.laneOf(null)` is `human` (a deleted GitHub account is unattributable, and
calling it automation would be a claim we cannot support).

### The lane breakdown counts ALL THREE comment channels

⚠ The vector's comment metrics count **inline review comments only**, so on the measured
workspace they reported zero bot activity while SonarQube had posted **786 PR comments** — the
single loudest automated actor, invisible, because quality gates post *issue* comments rather
than inline ones. A lane breakdown inheriting that blind spot would be worse than useless: a
confident 0% next to a workspace saturated with automation. `getPeriodLanes` therefore counts:

- **review comments** — inline, on a diff line
- **PR comments** — the issue-comment timeline, where every quality gate posts
- **review bodies** — the text attached to an approve / request-changes / comment review

with **approvals counted separately** (a different act: governance, not review volume).

---

## "Time until a person reviewed it" has ONE fold

**`loadFirstHumanReviewHours(accountId, scope, from, to, lanes, authorUserId?, samplesOut?,
truncatedOut?)`** is the single definition, read by BOTH the vector's
`median_time_to_first_human_review_hours` and the lane panel's
`medianTimeToFirstHumanReviewHours` — which render **one directly above the other on the same
screen**.

**They had two folds, and disagreed on the live database the first time this shipped: 18.16h
in the table against 18.27h in the panel below it, under a caption asserting they were the
same measurement.** The cause was not rounding. The lane fold read only reviews INSIDE the
window and took each PR's earliest of those, so **a PR a person had reviewed in a previous
period counted as freshly reviewed**. The vector fold looked at all of time and required the
first human review to fall in the window — which is the correct question.

The fold is two queries:

1. **CANDIDATES** — every PR with a non-pending review submitted in `[from, to)`. A superset
   (a PR whose first HUMAN review is in-window necessarily has a review in-window), ordered
   newest-first so the dedupe keeps the most recent on hitting the cap. Deduped in TS rather
   than with a `groupBy`, deliberately: `min(submitted_at)` comes back as a raw **epoch integer**
   (drizzle's `mode: 'timestamp'` mapping applies to selected COLUMNS, not to `sql` fragments) —
   a conversion this file has no reason to acquire for a trivial fold.
2. **EVERY non-pending review on a candidate PR, across ALL TIME.**

⚠ **The unbounded time range in query 2 is the whole point and must not be "optimised" back to
`[from, to)`.** That optimisation *is* the bug above: a PR a person reviewed in January and
revisited today would answer "first reviewed today", reporting a months-old review as fresh
latency. Seeing the earlier review is the only way to rule it out. Query 2 is ordered
**ASCENDING** so each PR's earliest review survives the cap — a newest-first cap would drop
exactly the rows the fold is looking for.

### `PERIOD_FIRST_REVIEW_PR_CAP` = 5,000

⚠ **A different KIND of cap from the other scan caps in this file, and much smaller for a
reason that is not memory.** Because query 2 must look outside the window, the candidate ids
travel as **BIND PARAMETERS** in an `IN (…)`. **SQLite caps those at 32,766**, so reusing `PERIOD_PR_SCAN_CAP` (20,000) would sit one busy quarter away from a hard
driver error rather than a truncated result. A period is a sprint: 5,000 human-reviewed PRs in
one is far beyond anything real. (`PERIOD_COMMENT_SCAN_CAP` is 200,000 and bounds the row
scans, not the bind list.)

⚠ **AND THE FOLD REPORTS ITS OWN TRUNCATION — a caller cannot infer it.** All three caps above
(the candidate break, and both `PERIOD_COMMENT_SCAN_CAP` row limits) cut the population silently:
the return is a bare `number[]` plus a positional sink, so a cut fold and a complete one are
indistinguishable. **A call-site heuristic (`hours.length >= CAP`) UNDER-FIRES** — the caps sit on
the candidate and review-row scans while `hours` is that population after two further narrowings,
so it is routinely far below any cap on a fold that really was truncated. `db/flow-findings.ts`
consequently reported `coverage.truncated: false` on a cut `?days=90` fold, which is the exact
silent truncation that field exists to prevent. Hence `truncatedOut` below.

### The three optional parameters exist so nobody writes a second fold

- **`authorUserId`** narrows the candidate PR population to one author — the People report's
  "median hours THEIR PRs waited for a first human review". Query 2 runs over those candidates,
  so one predicate covers both. Nothing else changes.
- **`samplesOut`** is the People report's evidence sink: it receives `{prId, atMs}` for
  EXACTLY the PRs whose hours entered the median, off this one fold, so no caller writes a
  sibling predicate to name the sample population. Optional and append-only — both period-vector
  call sites pass nothing and are byte-identical to before.
- **`truncatedOut`** (`ReviewFoldTruncation`) is the truncation sink: set to `true` — and only
  ever to `true`, so one sink can be OR'd across several folds — when any of the three caps cut.
  Bottlenecks ORs it into `coverage.truncated`. ⚠ **The fold is EXTENDED, never forked**: it has
  three other callers, and a second fold of this number is the shipped bug this section opens with.

`median()` and `round2()` are exported from `period-metrics.ts` for `db/person-period.ts`, so
the person vector rounds and medians identically. `round2` is not cosmetic: an unrounded
`16.888888888888889` in a report cell is worse than useless, and an unrounded float also churns
the fingerprint on re-computation.

---

## The sprint cadence is PER-WORKSPACE

**The cadence IS the period grid.** Everything on this surface — which fortnights exist, which key
names which window, which periods the Reports chart shows — is derived from one pair:
the sprint LENGTH and its PHASE ANCHOR. That pair used to live on `pro_settings`, one row per
ACCOUNT, so two teams sharing an account read each other's fortnights under their own headings.

### Storage: a new table, never a wider `pro_settings` key

`pro_workspace_settings` (platform migration **0029**), one row per
`(account_id, workspace_id)`, holding `sprint_cadence_days` + `sprint_start_at` and nothing else.

⚠ **Do NOT widen `pro_settings`' unique index to `(account_id, workspace_id)`.** It is an
ACCOUNT-grained table and what is left live on it is genuinely account-wide — by platform 0033 that
is the narration model, the vestigial auto-resolve pair and the legacy `bot_cost_json` blob;
everything else has MOVED to a per-workspace table rather than forking this one (the tracker and
the cadence in 0031, the comparison mode in 0032, the bot Slack-digest toggle in 0033, the Slack
delivery itself in 0030). Widening the index would ALSO break `writeProSettings`'
`onConflictDoUpdate`, whose target is `pro_settings.accountId`. A stale conflict target
**type-checks perfectly** and raises only at RUNTIME, on an actual write.

**Tenancy is STRUCTURAL.** `workspace_id` arrives on a request (`PUT /api/pro/settings/workspace`),
so 0029 carries the NAMED composite FK `pro_workspace_settings_workspace_account_fk` against core's
`workspaces (id, account_id)` — the same arrangement as `advisor_bot_profiles` (0021), leaning on
core's `workspaces_id_account` unique index. `ON DELETE CASCADE` is correct HERE and wrong for
`workspace_period_reports`: this row is CONFIG (a deleted workspace's cadence describes nothing),
that one is a stored artifact somebody forwarded.

### Reading: ONE resolver, and NO fallback beneath it

```ts
resolveSprintCadence(ctx, accountId, workspaceId) -> { cadenceDays, startAtMs }
```

in `platform/settings/store.ts`. Every consumer goes through it: `getComparisonWindow`,
`getInsightsRangeWindow`, `periodGrid` (via `currentSprintWindow`), the People report's grid, the
sprint report and the Slack digest.

⚠ **THE ACCOUNT-LEVEL FALLBACK IS GONE (platform migration 0031).** The resolver reads the workspace
row or answers "no cadence" — TWO STATES, NO CHAIN. `pro_settings.sprint_cadence_days` /
`sprint_start_at` are **dormant**: still in the database, undeclared in both drizzle schema
modules, therefore never selected and never written. `SprintCadence` lost its `source` field with
them, because there is no longer another source to name.

⚠ **"NO CADENCE" IS THE PRODUCT DEFAULT AND IT IS NOT A NUMBER.** A workspace with no stored
cadence has no sprint grid: `resolveComparisonWindow` degrades a `'sprint'` mode to the rolling-14
window and the Reports sprint grain refuses (`cadenceConfigured: false`). That is exactly what an
unconfigured account always did — the removed fallback pointed at an account pair which was itself
null for most accounts. **Do not introduce a default sprint length**; there has never been one.

⚠ **0031 backfilled NOTHING for the cadence, deliberately.** An account that had set an
account-level cadence and never a workspace one loses its sprint grid on upgrade and falls back to
the rolling window. Copying one team's fortnight onto every workspace is the exact defect 0029
existed to end; re-doing it under a migration's authority to spare one re-entry would ship it back.
The old values stay readable in `pro_settings` — the second reason nothing is dropped.

⚠ **`currentSprintWindow` / `periodGrid` / `resolveComparisonWindow` / `resolveInsightsRange` take a
resolved `SprintCadence`, NEVER a `SettingsRow`.** That signature is the enforcement — a caller
cannot reach the account columns from a row it already had in hand, which is exactly how a surface
quietly goes back to being account-grained.

### Writing: ONE writer, and it NEVER deletes the row

```ts
writeWorkspaceSettings(ctx, accountId, workspaceId, patch) -> WorkspaceProSettings
```

⚠ **`pro_workspace_settings` CARRIES THREE SETTINGS SINCE 0032** — the sprint cadence, the
Jira/Linear tracker (provider, base URL, project keys, match scope) and the comparison-window mode.
That is why the writer is one function with a sectioned partial patch
(`{sprint?, issue?, comparisonMode?}`) and why `mergeWorkspace` **seeds every column from the stored
row**: a column declared in `WorkspaceMutableCols` but not seeded is NULLED
by the upsert on any unrelated patch, which on this row means editing the cadence silently wipes
the tracker.

⚠ **CLEARING A CADENCE NULLS THE PAIR; IT DOES NOT DELETE THE ROW.** Its predecessor
`writeWorkspaceCadence` deleted the row to express "follow the account default" — there is no
account default any more, and a delete would now destroy an unrelated setting. A row whose cadence
pair is null reads **identically** to no row at all, and a test pins that equivalence: if the two
ever answered differently, clearing a cadence would behave differently depending on whether the
workspace happened to have a tracker configured.

### ⚠ `comparisonMode` IS PER-WORKSPACE TOO (platform migration 0032), and the old claim was FALSE

This doc used to say: *"`comparisonMode` stays account-wide. Rolling-7 / rolling-14 /
sprint-position is a reading preference with no per-team meaning."* It is not, and
`resolveComparisonWindow` is the falsifier in five lines: under `'sprint'` a workspace **with** a
cadence gets a sprint-POSITION window (this sprint so far vs the same slice of the last one), while
a workspace **without** one silently gets a rolling FORTNIGHT. So one account setting produced two
different window **shapes** across a single reader's workspaces, with nothing on screen naming which
one they were looking at. The mode does not merely sit beside the cadence — it **composes** with it,
and a fact that composes with a per-workspace fact is a per-workspace fact.

It is now the third column on `pro_workspace_settings`, with the same two-state rule as the other
two: **a stored mode, or the PRODUCT DEFAULT `'rolling_14'`.** No account fallback, no inheritance
chain; `pro_settings.comparison_mode` is **dormant** (undeclared in both schema modules, never
selected, never written) and `ProSettings.sprint.comparisonMode` is a husk that always reads `null`
— deliberately not `'rolling_14'`, because emitting the product default from a route that no longer
stores the setting would assert an account-wide mode no workspace need resolve to.

- **The resolvers take VALUES, never a row.** `resolveComparisonWindow(mode, cadence, nowMs)` and
  `resolveInsightsRange(mode, cadence, nowMs, range)` — same enforcement as `currentSprintWindow`'s
  `SprintCadence`: a caller cannot reach an account row from inside them, so the window cannot
  quietly go back to being account-grained. `comparisonModeOf(row)` / `cadenceOf(row)` split one
  read, and `getComparisonWindow` / `getInsightsRangeWindow` now issue **ONE** query where they used
  to issue two — which is what makes it structurally impossible for the two halves of a window to
  come from different grains.
- **The write is TOP-LEVEL on the patch** (`WorkspaceProSettingsUpdate.comparisonMode`), not inside
  `sprint`: that section declares `cadenceDays` REQUIRED so that clearing a cadence is always an
  explicit ask, which would make a mode-only patch impossible to express. There is no "clear" — the
  mode always has a value.
- ⚠ **The migration BACKFILLS, unlike 0031's cadence.** The mode applied to every workspace's
  window, so not copying it would silently re-frame every non-default team's comparison on upgrade
  — 0031's *tracker* case, not its *cadence* case (where copying one team's fortnight would have
  invented a per-team fact nobody stated). Only a mode that **differs from the product default** is
  copied: writing an explicit `'rolling_14'` into a row would create configuration that says
  nothing and turn "the default" into a stored value somebody later has to reason about.
- **The SPA edits it in the Sprint section, on ONE Save.** The mode was the last account-grained
  control in the Settings modal — fenced off in its own box captioned "Applies to every workspace",
  with its own Save button, because one Save spanning two GRAINS is how a per-team edit travels to
  every team. 0032 collapsed the grains, so the fence came down and the two Saves became one.
  ⚠ **The rule is SPENT here, not repealed**: the modal now renders every global section first and
  every workspace-scoped section under ONE "Workspace · <name>" heading, and a control added at the
  ACCOUNT grain still belongs above that heading with its own Save. ⚠ **`buildSprintPatch` sends
  only the half that CHANGED** (`apps/frontend/test/sprintSectionPatch.test.ts`) — the invalidation
  sweeps key on which SECTIONS are present, so an unchanged `sprint` riding along on a mode-only
  edit would push every stored period report through the "the cadence changed" refetch path. The
  mode sweeps `['workspace-insights']` / `['workspace-metrics-detail']` and **not** the period keys:
  it re-frames a comparison window, it moves no boundary.
- **Nothing stored keys on the mode**, so there is no `cadence_changed`-style refusal to add. A
  `workspace_period_reports` row's identity is `(account, workspace, period_key, cadence_days,
  model)` and the period pipeline never reads the mode. The payload hashes already carry
  `s<workspaceId>`, so a per-workspace change invalidates that workspace's cache and no other's.

## The CALENDAR-MONTH grain

Reports offers **two period grids, and they coexist — sprint is still the default**. The second
is the **calendar**: real months aligned to the 1st in **UTC**, 28–31 days long, needing no
configuration at all. (The live month-to-date view went with the stored reports, 2026-11-08.)

`PeriodGrain = 'sprint' | 'month'` (shared). It is a **READING CHOICE CARRIED ON THE REQUEST,
never a stored setting** — folding it into `pro_workspace_settings` would silently move the
flow-metrics comparison window on another tab, which nobody asked for by picking a grain on
Reports. The SPA holds it in `filters.insightsReportGrain`, mirrored to `?reportGrain=month`.

### The grid, the key, the title

| | sprint | month |
|---|---|---|
| grid | arithmetic: `startMs + i·cadenceMs`, phase-anchored, indices go negative | calendar: whole months since 1970-01 UTC, so the index is an absolute address |
| configured? | yes — no cadence ⇒ the surface refuses (§6.1) | **never** — `periodGrid(_, now, 'month')` cannot return null |
| key | `sprint-<YYYY-MM-DD>` | `month-<YYYY-MM>` |
| title | the date range, `18 Aug – 1 Sep` | the month's NAME, `August 2026` |

`PeriodGrid` is a **UNION on the grain**, deliberately: a month grid has no phase anchor, no
configured length and no fixed duration, so `startMs`/`cadenceDays`/`cadenceMs` are not merely
unused there — any value they could hold would be a lie. Absent, every read of them is a compile
error that must be answered per grain. `windowAt` is the ONE place the arithmetic forks.

⚠ **A month needs its OWN title formatter.** `periodEnd` is the EXCLUSIVE bound, so the sprint
formatter renders August as **"1 Aug – 1 Sep"** — a 32-day span that does not exist, on a document
somebody forwards. `formatPeriodRange(from, to, grain)` (platform) and `periodTitle(start, end, grain)`
(SPA) both take a trailing optional grain.

⚠ **`periodDayKey`'s `YYYY-MM-DD` cannot express a month.** A month named by its first day is
indistinguishable from a sprint that starts on the 1st, and both grains share one key space, one
`?report=` parameter and one `period_key` column. Hence `periodMonthKey` and the shorter form.
**`grainOfKey(key)`** then answers "what does this document measure" from the key alone — which is
why only the LIST route takes `?grain=`; every other route is handed a key and derives it, so no
parameter can disagree with the key beside it (`period-routes.ts`, `person-routes.ts`).

⚠ **Months align to UTC midnight, NOT to the Slack digest's send-time zone**
(`workspace_slack_targets.timezone` since platform 0030; it was `pro_settings.slack_timezone`). Hanging the report grid off it would move a stored artifact's window when
somebody edited an unrelated notification setting, and would make `month-2026-08` disagree with its
own start instant for every reader east of Greenwich. Every other boundary in this feature is UTC.

### ⚠ THE FORECAST IS REFUSED AT MONTH GRAIN — `uneven_periods`

`db/forecast.ts` fits Theil–Sen on **x = the ARRAY INDEX**: the series is assumed EQUALLY SPACED,
which is exactly true of an arithmetic sprint grid and false of the calendar. 28 → 31 days is a
**±5.4% swing in every COUNT metric** that the estimator has no way to read as anything but
signal — February would look like a genuine dip **every year**, with a MAD band sitting
confidently around it.

The alternative, normalising counts to a per-day rate before fitting, was **rejected**:

- Core's estimator is deliberately told NOTHING about which metric it is fitting (the same reason
  `PCT_METRIC_KEYS` lives in the platform). The platform would have to classify all fifteen keys as
  count / median / percentage and get every one right, silently.
- A per-day projection is a **different metric** from the one in the table above it ("2.4 merged
  PRs per day" vs "merged PRs"). Redefining a key's units per grain is precisely what
  `PERIOD_METRICS_SCHEMA_VERSION` exists to forbid — a metric is RENAMED, never redefined.

So every key refuses with the new `PeriodRefusalReason` member **`uneven_periods`** (a trailing
union member), and `REFUSAL_TEXT` in `periodReportMarkdown.ts` being a
`Record<PeriodRefusalReason, string>` made the copy a compile error rather than a blank cell.
**The sprint grain still forecasts**, which is what makes the refusal a statement about the grain
rather than a switch-off.

### ⚠ COVERAGE BIAS IS ~2.2× WORSE AT MONTH GRAIN — and the rule is NOT relaxed

`getPeriodCoverage` samples tracked repos at the window **START ONLY**, so a repo onboarded on day
3 of a 31-day month counts as untracked for all 31 days. Expect `complete: false` and
`partial_coverage` to fire far more often than at a 14-day cadence. **That is correct and must not
be softened to make months look better** — the stable-SUBSET comparison is the mechanism that stops
this feature reporting repo onboarding as team output (39 → 570 merged PRs over six months, on 4 →
18 contributing repos).

## The series — THE Reports chart, code only (2026-11-08)

Owner decision 2026-11-08: Reports is CODE ONLY. The AI write-up, its Generate route
(`POST /api/pro/insights/reports/:periodKey/generate`, removed with its rate-limit arm) and the
period picker are gone; the pane is ONE chart over every period (docs/FRONTEND.md § Reports pane).
The stored-report pipeline was then DELETED (2026-11-08): generation, narration, backfill, the
payload hash, the archive, month-to-date, the list / one-report GETs, `period-questions.ts`,
`grounded-figures.ts`, the report-model pricing (`llm/seam.ts`) and the `reportModel` setting.
`workspace_period_reports` and `pro_settings.report_model` stay DORMANT (never dropped, still erased).
What survives in `platform/insights/period-report.ts` is the grid, the significance meta,
`buildDeltas`, `buildForecasts` and `buildPeriodSeries`, pinned by `platform/test/period-grid.test.ts`
and `period-series.test.ts`.

`GET /api/pro/insights/period-series?workspace=&grain=` → `PeriodSeriesResponse`
(`platform/insights/period-report.ts buildPeriodSeries`, pinned by `platform/test/period-series.test.ts`):

- **How many**: the completed periods of the last **12 weeks** at sprint grain
  (`floor(84 / cadenceDays)`, at least 2, at most 12) or the last **6 months** (`seriesLength`),
  oldest first. The period in progress is the `next` slot, never a point.
- ⚠ **ONE REPO SET for every point**: the repos tracked since the OLDEST period shown
  (`getPeriodCoverage` at its start). A repo onboarded inside the window is left out of EVERY point,
  never added to the later ones — the coverage rule above, applied to a whole line rather than a
  pair. A period before ANY repo was tracked is DROPPED, never drawn as zero. `repos: {measured,
  total}` states the set; the SPA prints it.
- **Deltas** are consecutive (`buildDeltas` on neighbours, same set), so they carry the server's
  own `significant`; the SPA never re-derives it.
- **The forecast** is `buildForecasts` over this series (complete by construction, ≥ 4 points);
  refused `uneven_periods` at month grain and `insufficient_history` below 4 points.
- **Lanes** per period over the FULL membership — their own population, labelled apart.
- DB only, never stored, never a model: ≤ 12 metric scans + ≤ 12 lane scans per read → rate tier
  `[search, read]` (`tierFor`, pinned in `rate-limit.test.ts`).

## ⚠ `getBotAnalytics`'s `toMs` rule

Not strictly period-reporting, but it is the same "one row must not mix two window
populations" defect at the **bot** grain, and it arrived with this work (the People report's
bot sections need `getBotAnalytics` to cover a COMPLETED period, which has no `BotWindowKind`
spelling — hence the `{kind, fromMs, toMs}` window form).

**The defect.** `getBotAnalytics` honoured an explicit `toMs` in only TWO of its folds. The
automated thread scan, `mergedPastRows`, `getMlWindowAggregates` and `countUnlabelledBotText`
were `>= from` with **no upper bound at all** — so ONE ROW of the ROI table mixed two window
populations.

**⚠ The first fix was itself wrong.** Applying `lt(col, to)` UNCONDITIONALLY excluded rows
written in the CURRENT SECOND under the enum window form (where `to ≡ Date.now()`, and these
columns are second-granular on SQLite), which flaked `verify:isolation`.

**The rule:**

```ts
const toBound = typeof window === 'string' ? null : to;
```

An upper predicate for **EXPLICIT bounds only**. That also keeps every enum-form scan
byte-identical to the drill-downs over the same rows — preserving the "an Inflation count IS
the flagging drill-down's `filteredTotal`" identity.

**Explicit bounds are half-open `lt`, never `lte`** — the routes advertise `[fromMs, toMs)` and
`db/person-period.ts` already spells it that way, so a boundary-millisecond row lands in
exactly one period. Pinned by `db/bot-analytics-window-bounds.test.ts`.

---

## See also

- [PLATFORM.md](PLATFORM.md) — the platform half: stored rows,
  `payloadHashFor`, the Haiku narration + the D4 digit gate, and the removed **People report**
  (history).
- [API.md](API.md) — `/api/pro/insights/period*`, `/api/bot-analytics` (`fromMs`/`toMs`).
- [DATA-MODEL.md](DATA-MODEL.md) — `repos.createdAt`, `workspaceReviewers` (the bot object),
  `ReviewerRole`.
- [FRONTEND.md](FRONTEND.md) — `PeriodReportsPanel`.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### Period reporting

- **Period reporting** ([docs/PERIOD-REPORTING.md](PERIOD-REPORTING.md)): metrics are core
  (`db/period-metrics.ts`, `db/forecast.ts`, `db/actor-lanes.ts`); the Reports chart is the
  platform's DB-only series (storage and narration were removed 2026-11-08). Every metric is **WINDOW-PURE** (two-sided `[fromMs, toMs)` on every column).
  History is **COVERAGE-BIASED** (check contributing repos). A series line is ONE repo set. a metric is RENAMED, never redefined. A `_pct` metric joins
  `PCT_METRIC_KEYS`. Grain (sprint vs calendar month) is a READING choice, never stored; the forecast refuses at month grain. Every reading setting is PER WORKSPACE (`pro_workspace_settings`), no inheritance.
  An explicit `toMs` reaches every fold of a windowed getter (half-open `lt`).

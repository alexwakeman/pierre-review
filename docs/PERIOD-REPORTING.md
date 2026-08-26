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

**The numbers are CORE, free and deterministic** — no model, no GitHub quota, no new core
table:

| Layer | Lives in | Tier |
|---|---|---|
| The **metric vector** (15 keys), coverage, the lane breakdown | `db/period-metrics.ts` | CORE |
| The **forecast estimator** (pure, no I/O, no db import) | `db/forecast.ts` | CORE |
| **Who did the work** — the seven-lane actor resolver | `db/actor-lanes.ts` | CORE |
| The **1:1 person vector** (People report sections) | `db/person-period.ts` | CORE |
| **Storage, narration, routes, hashing, backfill** | `packages/pro/src/insights/period-report.ts` (+ pro migrations `0025`/`0026`) | Pro `periodReports` |

The plugin half — the stored rows, the Sonnet narration, `/api/pro/insights/period*`, the
`payloadHashFor` cache key, the "By workspace" axis and the People-report contract — is
documented in [PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) (§ apiVersion 21,
§ The People report). This doc is the core side: the definitions, why they are shaped this
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
like-for-like; the plugin recomputes the prior period over that subset scope
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

## ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS

**The defect this feature shipped three times in one build.** Rendering

```
117  |  146  |  −33
```

where 117 − 146 = −29 is not a rounding artifact — it is two different populations printed as
if they were one subtraction. The headline (117) is the **full current membership**; the delta
(−33) is computed over the **coverage-stable subset**, whose "this period" figure is 113, not
117.

**`rowFigures()` (`components/Activity/periodReportMarkdown.ts`, re-exported from
`PeriodReportsPanel.tsx`) is the ONE place that decides**, and it is a pure exported function
precisely so the invariant can be pinned arithmetically — there is no jsdom in that workspace,
so the row cannot be rendered, and what matters here is arithmetic rather than visuals
(`apps/frontend/test/periodMetricRow.test.ts`).

```ts
rowFigures(mv, delta, populationsDiffer) -> { value, prior, headline, lowSample }
```

- `value` is **`delta ? delta.value : (mv?.value ?? null)`** — deliberately **NOT**
  `delta?.value ?? mv?.value`, which silently substitutes the headline whenever the subset
  legitimately has no figure, reintroducing the two-population mix in the one case that is
  hardest to spot.
- `headline` is the full-membership figure and is non-null **only when it is a genuinely
  different number** from the one being subtracted. It is **disclosure, never an input to the
  arithmetic**.
- `lowSample` is taken from the **same object** as `value`. The two populations have different
  sample sizes, and marking the row's figure with the *other* one's thinness is the same mixing
  bug in miniature.

**The wire-level statement of the same rule** (`PeriodReport` docs in `shared/types.ts`):
`metrics[].value` and every `history[].metrics[].value` are HEADLINE figures over the full
membership; `comparison.deltas[]` and `movements[]` are over the coverage-stable SUBSET. For
the same metric key their `thisPeriod` legitimately differs from the headline, **and that gap
is repo onboarding, not team output**. A comparison pair is ALWAYS `thisPeriod` against
`priorPeriod` **from the same object**. Never pair a `metrics[].value` with a `priorPeriod`,
and never present a headline figure as one side of a change.

`figuresOnly(report)` names a fourth state that used to render identically to the other three:
a backfilled, metrics-only period where no comparison was ATTEMPTED (hence no refusal) and no
forecast was computed — distinct from a refused comparison and from a genuine first period.

---

## `PERIOD_METRICS_SCHEMA_VERSION` = 2

The version is **folded into the plugin's `payloadHashFor`** (`v:${…}` alongside the `p3|`
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
| `packages/pro/src/insights/period-report.ts` | **mirrored, not imported** |

The backend cannot import the shared package at RUNTIME: it is **types-only and not shipped**,
so `build-release.mjs` greps `release/dist` and FAILS the build on a real value import — the
same reason `AI_CREDITS_PER_USD` is inlined in `db/credits.ts`. `PERIOD_METRIC_KEYS` is
mirrored for the identical reason. **`period-metrics.test.ts` imports the shared originals** (a
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

`PCT_METRIC_KEYS` lives in the **plugin** (`insights/period-report.ts`) and declares the
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

## The seven `ActorLane`s (`db/actor-lanes.ts`)

The vector answers *what happened*; the lane resolver answers *how much of it was a person*.
Both are needed, because on a real workspace the blend is severe enough to make the headline
figures describe nobody (the 68-line median above).

```
human · code_agent · dependency · ai_review · quality_gate · release · housekeeping
```

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

`users` is a **GLOBAL** table, so the `isBot` sweep is read **by id** and never handed to a
tenant; `ActorLanes.laneOf(null)` is `human` (a deleted GitHub account is unattributable, and
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

**`loadFirstHumanReviewHours(accountId, scope, from, to, lanes, authorUserId?, samplesOut?)`**
is the single definition, read by BOTH the vector's
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
   than with a `groupBy`, deliberately: `min(submitted_at)` comes back as an **epoch integer on
   SQLite and a `Date` on Postgres** (drizzle's `mode: 'timestamp'` mapping applies to selected
   COLUMNS, not to `sql` fragments) — a dialect divergence this file has no reason to acquire
   for a trivial fold.
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
travel as **BIND PARAMETERS** in an `IN (…)`. **SQLite caps those at 32,766 and Postgres at
65,535**, so reusing `PERIOD_PR_SCAN_CAP` (20,000) would sit one busy quarter away from a hard
driver error rather than a truncated result. A period is a sprint: 5,000 human-reviewed PRs in
one is far beyond anything real. (`PERIOD_COMMENT_SCAN_CAP` is 200,000 and bounds the row
scans, not the bind list.)

### The two optional parameters exist so nobody writes a second fold

- **`authorUserId`** narrows the candidate PR population to one author — the People report's
  "median hours THEIR PRs waited for a first human review". Query 2 runs over those candidates,
  so one predicate covers both. Nothing else changes.
- **`samplesOut`** is the People report's evidence sink: it receives `{prId, atMs}` for
  EXACTLY the PRs whose hours entered the median, off this one fold, so no caller writes a
  sibling predicate to name the sample population. Optional and append-only — both period-vector
  call sites pass nothing and are byte-identical to before.

`median()` and `round2()` are exported from `period-metrics.ts` for `db/person-period.ts`, so
the person vector rounds and medians identically. `round2` is not cosmetic: an unrounded
`16.888888888888889` in a report cell is worse than useless, and an unrounded float also churns
the fingerprint on re-computation.

---

## ⚠ `getBotAnalytics`'s `toMs` rule

Not strictly period-reporting, but it is the same "one row must not mix two window
populations" defect at the **bot** grain, and it arrived with this work (the People report's
bot sections need `getBotAnalytics` to cover a COMPLETED period, which has no `BotWindowKind`
spelling — hence the apiVersion-18 `{kind, fromMs, toMs}` window form).

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

- [PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) — the plugin half: stored rows,
  `payloadHashFor`, the Sonnet narration + the D4 digit gate, the "By workspace" axis
  (`getPeriodMetricsForWorkspaces`), and the **People report** (`?evidence=1`,
  `PERSON_REPORT_VERSION`, the bot section's two vectors).
- [API.md](API.md) — `/api/pro/insights/period*`, `/api/bot-analytics` (`fromMs`/`toMs`),
  `/api/bot-authoring`.
- [DATA-MODEL.md](DATA-MODEL.md) — `repos.createdAt`, `workspaceReviewers` (the bot object),
  `ReviewerRole`.
- [FRONTEND.md](FRONTEND.md) — `PeriodReportsPanel`, the Reports People picker's scoping rule.

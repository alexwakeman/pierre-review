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

The plugin half — the stored rows, the Haiku narration, `/api/pro/insights/period*`, the
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

## What an UNENTITLED reader sees: visible-but-locked, not absent

The app's older posture on a capability the account does not have is **absence** — the control
is simply not rendered, and there is no nudge (`WorkspaceBotCharts` returns null, the "Depth →"
pill is omitted). That posture is deliberate and still correct for most controls.

**Period reports, the People report and the by-workspace axis are exceptions**, along with
Chronology and the Bots ROI panel: they are **VISIBLE-BUT-LOCKED**. The pane exists, it carries a
`Pro` badge, and an unentitled reader lands on a calm statement of what the view answers plus one
link. Everything renders through the one shared component — **`components/ProGate.tsx`**
(`ProBadge`, `ProLockPanel`, `useProGateState`) — and nothing hand-rolls either half.

| Surface | Locked pane lives in | `data-testid` |
|---|---|---|
| Period reports | `PeriodReportsPanel` (replaces the whole panel) | `period-reports-locked` |
| The People report — 1:1 prep | `PersonPeriodSection`, on the contributor-activity tab | `person-period-locked` |
| The People report — the report | `PeopleReportDetail`, before the seed check | `people-report-locked` |
| By workspace | *(none — transitively gated, see below)* | — |

Four rules, each of which has a matching comment in the code:

- ⚠ **THE LOCKED PANE'S TESTID IS NOT THE ENTITLED BODY'S.** `PeriodReportsPanel`'s real body is
  `period-reports`; the lock is `period-reports-locked`. Sharing one id is how a screenshot
  pipeline photographs a lock screen and ships it as marketing (`scripts/capture-shots.mjs` waits
  on testids).
- ⚠ **`enabled: false` IS NOT "UNENTITLED" AND MUST STAY SILENT.** `GET /api/pro/insights/reports`
  answers `{enabled:false}` when the plugin has self-disabled its reports surface (a stale
  `/api/me`, `PRO_DIGEST_ENABLED` flipping). That is a **paying** account. Both
  `PeriodReportsPanel` and `PersonPeriodSection` keep this as a separate branch returning `null` —
  collapsing the two asks a customer to buy what they have already bought.
- ⚠ **NEVER READ THE CAPABILITY NAKED — GO THROUGH `useProGateState`.** `useProCapabilities()`
  returns an all-false literal until `/api/me` resolves, so `!periodReports ? <lock/> : <real/>`
  paints "See what Pro includes" for one frame on every cold load **of an account that pays**.
  The helper holds at `'pending'` for that flight and resolves an `/api/me` error to `'locked'`.
- **ONE LOCK PER PANE.** `PeriodPeopleSection` gained an *intrinsic* `periodReports` guard (it was
  previously safe only because of where it is mounted, and it fires eight roster queries on
  mount), but that guard returns `null` — the reader is already looking at the panel's lock a few
  rows above, and a second dashed box under it reads as two broken sections.

**The by-workspace axis has no independent surface.** It rides `byWorkspace` on the one-report
GET, it has no route of its own (`GET /api/workspace-metrics/compare` is deleted and must not
return), and its only control is the per-metric "By workspace" expander inside the already-gated
panel. So it is gated **transitively** and carries only the badge on that expander — there is
nothing to lock, because an unentitled reader never reaches the table the expander sits in.

**Local/OSS is gated too, and that is a real change to the dev loop.** `entitledProCapabilities`
short-circuits on `account.isLocal`, so local entitlement collapses to whatever the plugin
published — and the plugin publishes `periodReports: PRO_DIGEST_ENABLED === 'true'`. A flag-less
`pnpm dev` with the submodule checked out therefore reports `periodReports: false` and now shows
the **locked** panes where it used to show nothing. `pnpm demo` and the shots Pro pass set the
flag; the ordinary dev loop does not. Set `PRO_DIGEST_ENABLED=true` to work on these panes.

**Server enforcement is unchanged and already exists — three layers, none of them client-side:**
the routes are `/api/pro/*`, so a free cloud account is 402'd by the blanket gate in
`api/plugins/auth.ts`; in OSS the routes are never registered; and the plugin self-gates on
`DIGEST_ENABLED`. Every hook already takes the capability as its `enabled`
(`usePeriodReportsList`, `usePeriodReport`, `usePersonPeriod`), so nothing polls a paywall.

⚠ **The People report's BOT sections read three routes it does not own** — `/api/bot-analytics`,
`/api/bot-analytics/vendor/:key/comments` and `/api/bot-authoring`, all core and all shared with
the Bots ROI panel, which gates on **`botDepth`**. **All three now carry an entitlement check, and
all three take the UNION `botDepth || periodReports`** (`botAnalyticsEntitled`, one predicate in
`api/routes/bot-triage.ts`) — because `botDepth` alone would open a report a Reports customer paid
for with every bot section blank and no explanation on screen. Their client hooks mirror the same
predicate, and so must any future one. Two of the three refuse outright (402); `/api/bot-analytics`
NARROWS instead, because the same response also feeds two free surfaces in `BotsView` — details in
[API.md](API.md).

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

## The sprint cadence is PER-WORKSPACE, and a cadence change is REFUSE-AND-PRESERVE

**The cadence IS the period grid.** Everything on this surface — which fortnights exist, which key
names which window, what `listPeriods` offers, what a stored row means — is derived from one pair:
the sprint LENGTH and its PHASE ANCHOR. That pair used to live on `pro_settings`, one row per
ACCOUNT, so two teams sharing an account read each other's fortnights under their own headings.

### Storage: a new table, never a wider `pro_settings` key

`pro_workspace_settings` (plugin migration **0029**, both dialects), one row per
`(account_id, workspace_id)`, holding `sprint_cadence_days` + `sprint_start_at` and nothing else.

⚠ **Do NOT widen `pro_settings`' unique index to `(account_id, workspace_id)`.** It is an
ACCOUNT-grained table and what is left live on it is genuinely account-wide — by plugin 0033 that
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

in `packages/pro/src/settings/store.ts`. Every consumer goes through it: `getComparisonWindow`,
`getInsightsRangeWindow`, `periodGrid` (via `currentSprintWindow`), the People report's grid, the
sprint report, the preset prompts and the Slack digest.

⚠ **THE ACCOUNT-LEVEL FALLBACK IS GONE (plugin migration 0031).** The resolver reads the workspace
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

### ⚠ `comparisonMode` IS PER-WORKSPACE TOO (plugin migration 0032), and the old claim was FALSE

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

### ⚠ A cadence change is REFUSE-AND-PRESERVE — the three defects it used to cause

A period key names a **START DAY** (`sprint-YYYY-MM-DD`), and the same day begins a period at more
than one cadence: from one anchor, index 4 of a 14-day grid and index 8 of a 7-day grid both start
on day 56. Two rows, two different windows, one key. Three defects fell out of that collision, and
all three were silent:

| | What happened | Fix site |
|---|---|---|
| **(a) SILENT OVERWRITE** | `loadStoredReport` matched on `periodKey` ALONE and `persistReport` upserted on `(account, workspace, period_key, model)` with `set: values` carrying `period_end` and `cadence_days`. A 14→7 change **rewrote a stored artifact in place**: same name, a different window's numbers, in a document already in somebody's inbox. | migration **0029** adds `cadence_days` to the unique index, and `persistReport`'s `onConflictDoUpdate` target moves with it |
| **(b) LISTED-BUT-BLANK** | `listPeriods` emitted every stored row regardless of grid alignment while the detail GET refuses a non-aligned key, so after a 14→21 change most of the history stayed CLICKABLE and opened as the ordinary "not generated yet" empty state — indistinguishable from a period nobody had run. | `listPeriods` gates every stored row on `windowForKey(grid, key) != null` and returns a second list |
| **(c) PERMANENT STALENESS** | The staleness probe recomputes the fingerprint over the NEW window and compares it to the stored one, so a colliding row read `stale: true` **forever** — inviting exactly the regenerate that performed (a). | the hard `row.cadenceDays === window.cadenceDays` guard in `loadStoredReport` |

**`cadenceCurrentPool(rows, cadenceDays)`** is the read half, sitting beside `schemaCurrentPool` and
applied by every consumer of a period's rows: `loadStoredReport`, `listPeriods`, `historyFromRows`,
`generatePeriodReport` (the backfill's "already have it" check, the history and the $0 cache) and
`answerPeriodChat`.

⚠ **It has NO FALLBACK, and that is the difference from `schemaCurrentPool`.** That helper degrades
to the whole set when no current-schema row exists, because an old-schema row is still a report about
the same window — stale, regenerable, honest. A row at a different cadence measures a different
number of DAYS; serving it under the new grid's heading is the two-populations lie one dimension
over.

⚠ **`historyFromRows` filters too, and the filter lives in the fold rather than at its call sites.**
That array feeds the period chat's grounding, whose prompt tells the model to read it as ONE SERIES
— a mixed 14-day/7-day history hands it counts that are half the size for no reason it can see,
under a `historyBasis` promising comparability. `comparableToCurrentPeriod` cannot catch it either:
that flag compares REPO SETS, and a cadence change leaves the repos identical. (The forecast fit is
safe by a different route — `chooseForecastSeries` re-measures every window live off the current
grid — but it is safe by accident there, so this fold does not lean on it.)

### The archive: preserved, named, readable — never deleted

⚠ **Nothing is deleted and nothing is auto-archived on the settings write.** The codebase's own rule
holds: *a report only stops being listed when it is ERASED, never because a setting changed or time
passed.* `listPeriods` therefore returns `{ periods, archived }`:

- **`periods`** — rows at the current cadence that `windowForKey` resolves, UNION the calendar
  periods. Every listed period is one the detail GET will actually serve.
- **`archived`** (`PeriodArchivedReport[]`) — everything else, at the explicit key
  `` `${periodKey}@cad${cadenceDays}` `` (`archivedKeyFor` / `parseArchivedKey`), each carrying the
  cadence it was MEASURED under and a `reason` of `'cadence_changed'` or `'outside_history'` — two
  different facts, and a reader needs to know which (one is a setting somebody made and can undo).

`GET /api/pro/insights/reports/:periodKey` answers an archived key BEFORE consulting the grid, via
`loadArchivedReport`, and serves it **frozen**: `archived: true`, **no by-workspace axis**, and
`stale: false` with no metrics scan. ⚠ **An archived report must never report staleness.** `stale`
exists to offer a REGENERATION, and an archived period cannot be regenerated at all — its window is
not on the grid, so `windowForKey` refuses it. A stale badge there would name an action that does not
exist, and the action it used to invite is what destroyed the artifact. The SPA hides Generate
entirely on an archived selection (absent, not disabled) and lists the archive under **"Earlier
cadences"** at the bottom of the Reports pane.

### The by-workspace axis REFUSES under mixed cadences

`byWorkspaceAxis` hands ONE window (the viewed workspace's period) to every workspace on the account.
That was right while the cadence was account-wide. It is not once a workspace can run its own: a team
on a 7-day sprint measured over a 14-day window contributes roughly **double** its per-sprint
throughput to a column headed "this period" — every count wrong, the medians and percentages wrong
less visibly and therefore worse.

So the axis returns `{ current: [], prior: null, refusal: 'cadence_changed', refusalWorkspaces }`.
`cadence_changed` is REUSED rather than given a new `PeriodRefusalReason` member: it already means
"measured over different-length windows, do not subtract", which is the same claim at a different
grain. `refusalWorkspaces` names which workspaces diverge (names and cadences only — there are no
figures to give).

⚠ **It refuses WHOLESALE rather than dropping the mismatched rows.** Silently restricting the table's
membership would make one team's Reports change shape because ANOTHER team edited their sprint
length — a surface that mutates for a reason its reader cannot see.

### The routes and the control

`GET`/`PUT /api/pro/settings/workspace?workspace=<id>` (`WorkspaceProSettings` /
`WorkspaceProSettingsUpdate`) carries all THREE per-workspace settings — the sprint pair, the issue
tracker and, since plugin 0032, the comparison mode. `?workspace=` degrades through
`resolveRequestWorkspaceId` like every scoped route; `cadenceDays: null` CLEARS the cadence by
NULLING the pair (the row survives — it holds two other settings); an **omitted** `startDate` keeps
the stored anchor, so a cadence-only edit does not silently re-phase the grid; `comparisonMode` is
TOP-LEVEL on the patch and has no "clear" (there is always a value, and `'rolling_14'` IS the
default).
⚠ Both are on the **`read`** tier — the `/api/pro/` catch-all's `generates` heuristic exempts settings
writes by a LIST now (`path === '/api/pro/settings' || path.startsWith('/api/pro/settings/')`), not
by an `endsWith('/settings')` suffix that this path does not match.

The SPA control is `components/settings/SprintSection.tsx`, which names the workspace in its
heading — there is no workspace picker in Settings, so the heading is the only thing telling a
reader which team they are retuning — and **discloses before the Save** that reports generated under
the old cadence are kept exactly as they are but stop appearing in the period picker.

⚠ **THE "TWO GRAINS, TWO SAVE BUTTONS" RULE IS SPENT HERE, AND IT WAS RIGHT WHILE IT LASTED.** The
section held one workspace-grained control (the cadence) beside one account-grained one (the mode),
and a single Save spanning both is how an edit meant for one team silently reaches every team. Since
0032 both halves are the same grain and the same row, so one Save is now correct — and the argument
that separated them still applies verbatim to any future control at a DIFFERENT grain landing in
this section. Keep the reasoning, not the button count.

---

## The CALENDAR-MONTH grain, and the one live period

Reports offers **two period grids, and they coexist — sprint is still the default**. The second
is the **calendar**: real months aligned to the 1st in **UTC**, 28–31 days long, needing no
configuration at all. Plus one live view, **month to date**.

`PeriodGrain = 'sprint' | 'month'` (shared). It is a **READING CHOICE CARRIED ON THE REQUEST,
never a stored setting** — folding it into `pro_workspace_settings` would silently move the FREE
flow-metrics comparison window on another tab, which nobody asked for by picking a grain on
Reports. The SPA holds it in `filters.insightsReportGrain`, mirrored to `?reportGrain=month`.

### ⚠ THE REFUSAL KEYS ON GRAIN FIRST, AND ON `cadenceDays` ONLY WITHIN THE SPRINT GRAIN

**This is the whole feature, and getting it wrong returns a named refusal for every single
comparison.** `buildPeriod` refused when the stored prior row's `cadenceDays` differed from the
window's. January is 31 days and February is 28 — so at month grain **every** month-over-month
comparison would have answered `cadence_changed`, silently, with no deltas and no error, and
month-over-month is precisely what the grain exists to provide.

A sprint row's day count IS the configured setting, so a difference there means the setting moved
and the two rows measure different-length windows (refuse-and-preserve). A month row's day count
is the length of that calendar month. Same rule, one function: **`grainPool`**, with
`grainCurrentPool` (a whole grid) and `windowCurrentPool` (one window) over it. `cadenceCurrentPool`
survives for `loadArchivedReport` only, where the archived key pins both.

⚠ **A month row keeps its REAL day count — never a sentinel 30 or 0.** It is a disclosure on a
forwarded artifact and an input to `payloadHashFor`; a false day count there is a false claim in a
document.

### ⚠ THE `grain` COLUMN EXISTED FROM DAY ONE AND WAS NEVER READ

`workspace_period_reports.grain` was added with the table (`DEFAULT 'sprint'`, *"so a second grain
does not need a migration to tell the two apart"*) — and **four sites hard-coded `grain: 'sprint'`
on the way out**: `rowToReport`, `buildPeriod`'s report, `backfillHistory`'s report, and
`persistReport`'s values. A month row would therefore have been **PERSISTED as `'month'` and
SERVED as `'sprint'`**: the SPA would have titled it with the sprint formatter and the narration
prompt would have been handed the sprint grain's month-word ban for a document that IS a month.
All four now read or carry the real value; `rowGrain(row)` is the tolerant read (anything not
exactly `'month'` is `'sprint'`, which is what every pre-existing row holds).

**No migration was needed.** `month-2026-08` and `sprint-2026-08-01` are disjoint key shapes, so
`period_key` already discriminates the grain inside the unique index.

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
somebody forwards. `formatPeriodRange(from, to, grain)` (plugin) and `periodTitle(start, end, grain)`
(SPA) both take a trailing optional grain.

⚠ **`periodDayKey`'s `YYYY-MM-DD` cannot express a month.** A month named by its first day is
indistinguishable from a sprint that starts on the 1st, and both grains share one key space, one
`?report=` parameter and one `period_key` column. Hence `periodMonthKey` and the shorter form.
**`grainOfKey(key)`** then answers "what does this document measure" from the key alone — which is
why only the LIST route takes `?grain=`; every other route is handed a key and derives it, so no
parameter can disagree with the key beside it (`period-routes.ts`, `person-routes.ts`).

⚠ **Months align to UTC midnight, NOT to the Slack digest's send-time zone**
(`workspace_slack_targets.timezone` since plugin 0030; it was `pro_settings.slack_timezone`). Hanging the report grid off it would move a stored artifact's window when
somebody edited an unrelated notification setting, and would make `month-2026-08` disagree with its
own start instant for every reader east of Greenwich. Every other boundary in this feature is UTC.

### The lists are GRAIN-SCOPED, and the archive is not a dumping ground

`listPeriods` filters `allRows` to the grid's grain BEFORE anything else. A month row seen from the
sprint grid is **not an archived artifact** — it is a live period one toggle away, so it belongs in
neither list. Folding it into `archived` would put the whole calendar history under "Earlier
cadences" and list every document twice. `PeriodReportListItem.grain` and
`PeriodArchivedReport.grain` are trailing-optional on the wire (absent ⇒ `'sprint'`), and the SPA
**reads** them rather than inferring: two grains write one `insightsReportKey`, and a picker whose
only distinguishing mark is a date range lets a reader forward a document without knowing what it
measures.

⚠ **Only the sprint grain can produce a `cadence_changed` archive reason.** At month grain a row
the grid cannot name has aged out — `outside_history` — because a 28-day February beside a 31-day
January is not a retired setting. `parseArchivedKey` accepts BOTH key shapes; without the month
form, `archivedKeyFor` would emit keys nothing could read back (defect (b) in a new costume).

### MONTH TO DATE — live, un-stored, un-narrated, un-billed

`buildMonthToDate(ctx, accountId, scope, nowMs)` → a `PeriodReport` carrying `inProgress: true`
and `elapsedDays`. Served by **`GET /api/pro/insights/month-to-date?workspace=`**, and also by the
one-report GET when `:periodKey` names the OPEN month (so a forwarded `?report=month-2026-09` link
renders instead of showing "not generated yet" for a period that CANNOT be generated).

⚠ **DO NOT "IMPROVE" IT INTO A STORED ROW.** Two independent mechanisms make an open period
unstorable, and both are load-bearing elsewhere:

1. The free cached-read GET recomputes every stored row's **data fingerprint**, which folds every
   metric VALUE. An open month's fingerprint moves on every merge — the row would read
   `stale: true` on essentially every load, **forever**, beside a Generate button. That is the
   permanent-staleness defect the cadence work closed, at a new grain.
2. **`payloadHashFor` folds nothing `Date.now()`-derived**, or a dormant workspace re-bills on a
   timer. An open period's upper bound IS `Date.now()`, so it could not enter that hash honestly.

So: no row, no `payload_hash`, no narration, no model, no credits, `stale: false` always, and
**no Generate button — absent, not disabled**, exactly like an archived report. `buildMonthToDate`
takes no `LlmClient` and no `aiCredits`, so the absence of billing is structural rather than
policed.

**The comparison is an ELAPSED-SLICE comparison, not month-against-month.** Seventeen days of
August against the whole of July is a 45% "drop" that is entirely the calendar. Both sides are
measured over the same number of milliseconds from their own month's start, over the
coverage-stable subset, and ⚠ **the slice is CLAMPED to the SHORTER month and the clamped length
used on BOTH sides** (on 31 March, 30 days have elapsed and February has 28). Clamping one side
only would subtract windows of different lengths — the exact thing `cadence_changed` refuses.
The headline still covers `[monthStart, now)` over the full membership: that is the standing
headline-vs-subset split `rowFigures()` already resolves, and the slice length is stated in
`subsetDisclosure` because it is a second axis on which the populations differ.

⚠ **It carries its own rate-limit tier.** `/api/pro/insights/month-to-date` does not match the
`…/insights/reports` family block, so without an explicit entry it falls through to the `/api/pro/`
catch-all's GET→`read` branch and sits on the 600/min blanket bucket — while costing SIX indexed
scans. Pinned on `[search, read]` in `api/plugins/rate-limit.ts` and `rate-limit.test.ts`.

### ⚠ THE FORECAST IS REFUSED AT MONTH GRAIN — `uneven_periods`

`db/forecast.ts` fits Theil–Sen on **x = the ARRAY INDEX**: the series is assumed EQUALLY SPACED,
which is exactly true of an arithmetic sprint grid and false of the calendar. 28 → 31 days is a
**±5.4% swing in every COUNT metric** that the estimator has no way to read as anything but
signal — February would look like a genuine dip **every year**, with a MAD band sitting
confidently around it.

The alternative, normalising counts to a per-day rate before fitting, was **rejected**:

- Core's estimator is deliberately told NOTHING about which metric it is fitting (the same reason
  `PCT_METRIC_KEYS` lives in the plugin). The plugin would have to classify all fifteen keys as
  count / median / percentage and get every one right, silently.
- A per-day projection is a **different metric** from the one in the table above it ("2.4 merged
  PRs per day" vs "merged PRs"). Redefining a key's units per grain is precisely what
  `PERIOD_METRICS_SCHEMA_VERSION` exists to forbid — a metric is RENAMED, never redefined.

So every key refuses with the new `PeriodRefusalReason` member **`uneven_periods`** (a trailing
union member — `apiVersion` stays **21**), and `REFUSAL_TEXT` in `periodReportMarkdown.ts` being a
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

### `no_prior_period` now floors on the LOOK-BACK HORIZON, not index 0 (a fixed pre-existing bug)

`buildPeriod` refused with `no_prior_period` on `window.index === 0`, treating the configured
sprint start as the beginning of recorded history. It is not — it is a **phase anchor**, and
`completedWindows` and `backfillHistory` both already extend to NEGATIVE indices. So the period at
index 0 refused a comparison against index −1, a period this surface lists, stores and can measure
with the same scan every other prior period gets. The floor is now
`priorIndex < grid.currentIndex - MAX_HISTORY_PERIODS` — below the horizon we decline to scan, so
below the horizon there genuinely is nothing before. At month grain index 0 is January 1970, so the
old guard was unreachable there; leaving a wrong condition in place for a grain that cannot hit it
is how it comes back.

### The month-word ban is GRAIN-CONDITIONAL, in FIVE places

⚠ **It lives in the model's SYSTEM PROMPT, not only in UI copy** (`reportSystemFor(grain)` in
`period-report.ts`), and the model will reach for "month on month" unprompted because it is the
register these documents are written in. At sprint grain the ban stands verbatim — a 14-day cadence
is ~2.17 periods per calendar month, so the label is false on a forwarded document. At month grain
it is REPLACED (never deleted) by the rule that bites there: months are 28–31 days, so a change
between two of them is not a like-for-like rate change and must not be annualised.

The five sites: `period-report.ts`'s `REPORT_SYSTEM_HEAD` / `reportSystemFor`,
`period-questions.ts`'s `formatPeriodRange`, `periodReportMarkdown.ts`'s `periodTitle` and its
markdown title line, and `PeriodReportsPanel.tsx`'s header comment + title block.

### The SPA

A **Grain toggle** on the Reports pane (`Sprint | Month`), above every loading branch so it never
disappears while a list reloads — which is exactly when it does. `setInsightsReportGrain` ⚠ **CLEARS
`insightsReportKey`**: the two grains share one key space but not one grid, so carrying the key
across would leave the panel requesting a period that cannot exist, rendering the ordinary "not
generated yet" box. The picker marks the open month `· to date`, the title row carries an
`in progress · N days so far` chip instead of `generated …`, and Generate is **absent**.

⚠ **`PeriodPeopleSection` reads the SAME grain.** It holds its own `usePeriodReportsList` call; the
list key is grain-scoped, so reading the default there while the panel is on months would land on a
different cache entry, fail to resolve the `month-…` key, silently seat the newest FORTNIGHT, and
read the roster over fourteen days under a month heading. It also excludes `inProgress` periods from
the "Begin report" seed (the person route resolves against the grid, which refuses the open period)
and clamps an open period's roster window to `now`. `AskAboutPeriod` does the same clamp — an open
period's `periodEnd` is in the FUTURE, and grounding the chat to it would hand the model a window
running past today under a caption saying "to date".

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
  `payloadHashFor`, the Haiku narration + the D4 digit gate, the "By workspace" axis
  (`getPeriodMetricsForWorkspaces`), and the **People report** (`?evidence=1`,
  `PERSON_REPORT_VERSION`, the bot section's two vectors).
- [API.md](API.md) — `/api/pro/insights/period*`, `/api/bot-analytics` (`fromMs`/`toMs`),
  `/api/bot-authoring`.
- [DATA-MODEL.md](DATA-MODEL.md) — `repos.createdAt`, `workspaceReviewers` (the bot object),
  `ReviewerRole`.
- [FRONTEND.md](FRONTEND.md) — `PeriodReportsPanel`, the Reports People picker's scoping rule.

# Chronology — the court ledger

Every hour a pull request is open, somebody is holding the ball. Charge each interval to its holder
and the hours account for themselves.

Three courts, and they partition the open life of a pull request:

| Court | Meaning | The action it implies |
|---|---|---|
| **reviewer** | waiting for a person to look | routing — request a named reviewer, chase the overdue |
| **author** | waiting for the author to answer review | fewer, clearer review passes |
| **landing** | approved, waiting to merge | arm "merge when ready" |

| Piece | Where |
|---|---|
| The engine | `apps/backend/src/db/pr-intervals.ts` (courts) + `db/flow-detail.ts` (working hours, budgets, per-PR) + `db/working-hours.ts` (the calendar) |
| Settings | `packages/shared/src/flow-settings.ts` · `workspaces.flow_settings` · `PUT /api/workspaces/:id/flow-settings` · `components/settings/FlowSettingsSection.tsx` |
| Request history | `review_request_events` · `sync/upsert.ts` `persistReviewRequestHistory` · `sync/backfill-review-requests.ts` |
| Pointers (Pro, model) | core `db/flow-pointers.ts` (evidence) · `packages/pro/src/flow-pointers/` · `GET`/`POST /api/pro/flow-pointers` · `Activity/FlowPointersPanel.tsx` |
| The route | `apps/backend/src/api/routes/flow.ts` — `GET /api/flow-findings?workspace&days` |
| The contract | `FlowResponse` and friends in `packages/shared/src/types.ts` |
| The panel | `apps/frontend/src/components/Activity/BottlenecksPanel.tsx` + `bottlenecksModel.ts` + `ChronologyCharts.tsx` / `ChronologyTables.tsx` / `chronologyModel.ts` + `chronologyInfo.tsx` (the modal copy) · `components/InfoModal.tsx` · `components/charts/ChartPopover.tsx` |
| Tests | `db/pr-intervals.test.ts` · `db/flow-detail.test.ts` · `db/working-hours.test.ts` · `sync/review-request-history.test.ts` · `api/routes/workspace-flow-settings.test.ts` · the `getFlowCourts` block in `verify-isolation.ts` · `packages/pro/test/flow-pointers.test.ts` · `apps/frontend/test/chronologyModel.test.ts` + `flowSettingsForm.test.ts` |

Deterministic, **no model touches any part of it except the Pointers block**, which is a separate,
opt-in, credit-metered generation (below) — and **PRO**, on the existing `periodReports` capability.

## Tier

**Pro, on `periodReports`** — deliberately not a capability of its own. Chronology and the period
report answer the same question at two grains ("where did a completed stretch of work actually
go"), and a fifteenth `ProCapabilities` member would mean bumping `apiVersion` across four literals
in two repositories to gate one route. `apiVersion` stays **21** and `packages/pro` is untouched.

Three places carry it, and they are ONE decision written three times:

| Where | What |
|---|---|
| `api/routes/flow.ts` | `if (!req.account \|\| !entitledProCapabilities(req.account).periodReports)` → `402 {error:'pro required'}`. **THE monetisation gate**; same shape as `PUT /api/bot-reviewers/:userId/cost`. |
| `hooks/useFlowFindings.ts` | `enabled: periodReports`. Stops the SPA learning it by error — this query **polls**, so an ungated hook is a 402 every five minutes, per mounted pane, forever. |
| `Activity/InsightsView.tsx` | The tab keeps its place in the strip, wears a `ProBadge`, and opens onto `ProLockPanel` (`chronology-locked`) instead of the panel. |

- ⚠ **THE ENGINE STAYS CAPABILITY-BLIND.** `getFlowCourts` takes no flag and reads no account
  state; `verify:isolation` calls that fold directly. The free/paid line is a ROUTING decision, and
  the day it moves into `pr-intervals.ts` those assertions need an account to run. Same reason the
  `[7, 90]` window clamp lives in the engine and the entitlement check does not.
- ⚠ **THE REPORTS RAIL ENTRY IS UNGATED ON EVERY TIER AND THIS DID NOT CHANGE THAT.** The free flow
  metrics share the pane and are the reason the entry is free. Only the named sub-tab is gated.
- ⚠ **VISIBLE-BUT-LOCKED, WHICH REVERSES THE APP'S USUAL POSTURE** (elsewhere a missing capability
  is silent absence — `WorkspaceBotCharts` returns null, the "Depth →" pill is omitted). The
  reversal is scoped to six named surfaces; `apps/frontend/src/components/ProGate.tsx` enumerates
  them and owns the badge and the locked pane. Nothing hand-rolls either.
- ⚠ **AN UNENTITLED `?insightsTab=bottlenecks` RENDERS THE LOCK UNDER THE TAB IT NAMED.**
  `effectiveInsightsTab` normalises values outside the union only — never a gated member. That
  literal ships in bookmarks and in history entries Back replays, and a redirect to Overview would
  explain nothing.
- ⚠ **LOCAL IS GATED TOO, and needed no entitlement change to be.**
  `entitledProCapabilities` hands a local account whatever the bound plugin advertises, and the
  plugin advertises `periodReports: PRO_DIGEST_ENABLED === 'true'`. So OSS (no plugin) is locked —
  and so is a **flag-less `pnpm dev` with the submodule checked out**, which is the ordinary dev
  loop. `pnpm demo` and the screenshot pipeline's Pro pass both set the flag.
- The 402 is pinned in both directions by `api/routes/bot-triage-entitlement.test.ts` (402 with no
  capabilities or `botDepth` alone, 200 with `periodReports`), and the tier by `rate-limit.test.ts`.

## What this replaced, and why

The first version of this tab emitted findings at a PATH-BUCKET grain and produced rows like
**"`src/**` is a bottleneck"**. That was the wrong unit, not the wrong threshold.

A unit is only useful at PR stage if it carries three things: an **owner**, a **duration** and an
**exit condition** — those are what turn a row into an action. A waiting interval carries all three.
A directory carries none: the chain from finding to action is `directory → file → pull request →
thread → commenter → the wait`, four proxies, and on a conventional single-package repo `src/**` IS
the repository, so the row stated a fact about the repo with a directory's authority.

The evidence agrees. Every code-review intervention with a published effect size acts on a WAIT
owned by an identified party — a reminder on an overdue pull request (**−60.6%** lifetime,
randomised, 8,500 PRs), assigning an individual rather than a group (**−11.6%** time-in-review,
Meta), automatic merge (**29–63%** of review lifetime is post-acceptance, 569,914 reviews). The two
interventions aimed at code properties and at people measured **nothing**: reviewer workload
balancing (no significant change) and pull-request size (r_s = 0.26 over 845,316 PRs).

Of the four old kinds: `single_reviewer_path` and `round_trips` are **deleted**; `size_latency` is
**deleted as a finding** on the size evidence above; `approval_parked` survives, absorbed as the
LANDING court where it finally has a denominator.

## The rules

- ⚠ **A BOT ACTION NEVER MOVES THE BALL, AND AUTOMATION'S OWN PULL REQUESTS ARE NOT MEASURED.**
  This is the whole moat and it is two predicates. A tool keying on `user.type === 'Bot'` cannot
  separate "this pull request was reviewed" from "a person looked at this". Human-ness comes from
  `resolveActorLanes`' UNION, never `users.isBot` alone.
  Measured: bot-authored work was **43% of merges** on a real workspace and **slower** than human
  work (32h against 24h mean), so blending them moved every share — 72/10/18 became 60/16/24 — and
  put `Bump actions/checkout from 4 to 7` on screen as something a person was waiting on.
- ⚠ **A REPO MUST BE LOPSIDED *AND* SLOW BEFORE A COURT IS NAMED** (`FLOW_SLOW_P75_HOURS`). A real
  repository is 73% author-court with a p75 lead time of **eighteen minutes**; naming a dominant
  court on the share alone invents a crisis in a healthy repo, which is exactly what made the path
  findings worthless. Repos that clear the floor but are not both are listed under "Nothing stands
  out" — showing them is what stops the panel reading as "everything is on fire".
- ⚠ **THE ADVICE IS A PROPERTY OF THE COURT, NOT THE REPOSITORY** (`CourtDirective`). Stated once
  per section. The first cut put it on every repo row and a real workspace rendered **six identical
  paragraphs**, which is the same restatement problem one level up.
- ⚠ **A PULL REQUEST NO HUMAN EVER ACTED ON IS EXCLUDED, NOT SCORED.** Its ledger is 100% reviewer
  by construction and on real data that is **46% of merges** — including them would drive every
  reviewer share towards 100%. They are reported separately as the unreviewed-merge finding, which
  is a governance claim (a branch-protection setting) rather than a productivity one.
- ⚠ **THIS SCREEN NAMES NO PERSON.** Not a login, not an avatar, not a per-head count. The server
  does not send actor ids at all, which makes it structural rather than a convention. "Guide the
  work, never rank the people" is the licence this feature operates under.
- ⚠ **EVERY SENTENCE IS TEMPLATED** in `pr-intervals.ts`. The SPA formats figures and renders the
  server's prose; it never composes a claim of its own out of the numbers. The page renders server
  prose only where it is not a restatement: refusals, a budget row's reason (in its popover, when
  there is no verdict), the landing tail's empty sentence, each court's one-line `summary` on the
  page and its full `directive` behind the "i". `workHeadline`, `headline`, `narrative`,
  `contrast.sentence`, `requests.sentence` and a judged row's `sentence` ride the wire unrendered,
  and so does the "None stands out" refusal whenever the "Nothing stands out" list is on screen
  (`buildBottlenecksModel`). Disclosure lines the client builds from wire COUNTS (coverage,
  exclusions, request coverage, capped lists) state a count, never a finding.
- ⚠ **A REFUSAL IS ONE PLAIN FACT.** The rule behind it (the lopsided-and-slow call-out, the
  unreviewed-merge floor) is explained in that section's modal, so the three refusals that used to
  carry it were shortened on the server; `pr-intervals.test.ts` pins the new wording.
- ⚠ **`FLOW_RULES` (packages/shared/src/flow-settings.ts) is the ONE spelling of every floor the
  page quotes**; the engine's local constants are assigned from it and keep their names (a
  structural test reads them), and `Activity/chronologyInfo.tsx` reads it for the modal copy.
- Both exclusions are **rendered** (`exclusionLineFor`), as is coverage. Retroactive history is
  coverage-biased, and a reader who does not know what was set aside will mis-read every share.

## The state machine, and its three judgement calls

Start at REVIEWER from `openedAt`. Per human action, charge the elapsed interval to the current
court, then move the ball: a reviewer action → AUTHOR; an author action → LANDING if already
approved else REVIEWER; an approving review → LANDING.

1. **A reviewer comment after approval moves the ball to the AUTHOR**, not back to the reviewer.
   Somebody said something and the author owes a reply.
2. **An author push after approval stays in LANDING.** Whether it invalidates the approval is a
   branch-protection setting we do not sync, so the conservative reading is "approved, with new
   code, waiting to land" — and it does not silently inflate the author court.
3. **A never-human-touched pull request is excluded**, as above.

All three are mutation-proven in `pr-intervals.test.ts`; changing one by accident fails exactly the
test that pins it.

## Window

`?days` clamps to `[7, 90]` and the CLAMPED value is echoed as `windowDays`, because every sentence
on screen names it. The window is on `mergedAt`, two-sided and half-open `[from, to)` — a cycle-time
figure belongs to the period the work COMPLETED in, matching `db/period-metrics.ts`.

## Working hours and budgets

**Measured on a real workspace, 73% of the hours the court ledger charged fell outside the team's
working day** — a PR opened on Friday afternoon was charged a weekend, and "Friday" read as the
slowest day (70 clock hours median, 7 working hours). So everything the panel now LEADS with counts
working hours only, in the workspace's own zone, days and hours (`workspaces.flow_settings`,
Settings → Workspace → "Working hours and budgets"; CORE and free to set).

- **Stored as overrides only.** NULL until someone changes something, then only what they changed;
  every reader goes through `resolveFlowSettings`, so a later change to a product default reaches
  every workspace that never overrode it. `PUT` replaces the whole override set; `{}` resets. The
  Settings form sends only what differs from a default (`flowSettingsForm.ts`) — a form that sent
  every field would freeze today's defaults into any workspace whose owner merely pressed Save.
  The Settings form is sliders on a stepped scale (see docs/FRONTEND.md); it still sends overrides
  only.
- **The default zone** is the machine's own locally, UTC in the cloud, `WORK_TIMEZONE` over both
  (`config.defaultWorkTimezone`, echoed on `/api/me` as `workTimeZone`).
- **The calendar** (`db/working-hours.ts`) precomputes each working day's window through Intl, so a
  clock change is simply a day one hour shorter in UTC terms; `between(a, b)` is two binary searches
  over a prefix sum. No holidays — a bank holiday is a working day, stated as a weekly pattern.
- **Budgets, not balance.** An even three-way split is not health: a PR approved on its first review
  never visits its author, which is the best case and reads as lopsided. Each wait instead has a
  budget in working hours ("good" / "acceptable"), and the chart under the working-hour split shows
  where three in four landed against it. Defaults: first look 4/8 (Google's one-business-day guidance as the ceiling),
  reply 8/16, approved-to-merged 1/4, whole PR 8/16. The triangle of court shares is kept, labelled
  as context.
- ⚠ **THE REPO CALL-OUT STAYS ON CLOCK HOURS.** `FLOW_SLOW_P75_HOURS` was calibrated over 66,088 PRs
  on clock hours; moving it would silently invalidate the calibration. The panel labels that half
  "By repository, in clock hours".
- ⚠ **ONE STATE MACHINE.** `walkCourtIntervals` returns spells; `walkCourts` is their sum, so the
  clock and working-hour splits cannot disagree about who held the ball (a 200-case agreement test
  pins it). It also yields rounds (times the ball went to the author), the first look and the first
  approval.
- ⚠ **Budget sentences speak in hours, never working days** — a "2.2 working days" beside a
  "16-hour limit" is one figure in two spellings.

## The per-PR view

`FlowResponse.prs` carries one row per measured PR (capped at 1,000: every slow PR, then an even
stride — `prsCapped` says so) with no actor on it. The panel draws it as a log-scale scatter (hover
for the breakdown, click opens the PR; the "20 slowest" table is its keyboard and screen-reader
view), then: the fastest-vs-slowest-quarter contrast (a row "separates" at 2× with an absolute
floor, so ten times six minutes is not a finding), lead time by size and by weekday (clock beside
working), the landing tail, and first-review concentration.

`prFigures` carries the scatter's and triangle's headline figures over EVERY measured PR — the
per-PR rows are capped at 1,000, and a figure counted over a sample was wrong exactly when
`prsCapped`.

- **Landing tail.** PRs approved for more than a working day. A ticket key (title, else branch)
  offers SIBLINGS — PRs in another repository under the same ticket that merged between this one's
  approval and a day after its merge. A sibling that landed before the approval cannot have held
  it, so it is not offered. The key extractor is the Pro one's no-allow-list fallback.
  `siblingsOver` counts the PRs approved for over a working day that had at least one sibling.
- **Concentration names no one.** Per repository: how many people gave first reviews, the busiest
  one's share, and their first-look median against everyone else's ("slower" at 1.25× and 30
  minutes). Read to count; `firstReviewerId` never leaves `flow-detail.ts`.
- On real data the working-hour view overturned a wall-clock finding: the busiest first reviewer
  in one repo looked about twice as slow on the clock and is faster in working hours.

## Asking for a review — the request history

`review_requests` holds only OUTSTANDING requests, so "was a person or a team asked, and how soon
did anyone look" was unanswerable for a merged PR. `review_request_events` now keeps every
ReviewRequestedEvent / ReviewRequestRemovedEvent (first 25 per PR), fed by the fat walk's
`reviewRequestHistory` selection — **measured free** (`rateLimit(dryRun: true)`: 15 points/page with
and without it; a leaf connection adds nothing).

- ⚠ **NOT RECEIVED IS NOT "NOBODY".** `pull_requests.review_requests_synced_at` is stamped only from
  a response that carried the selection (an empty list is a positive statement and IS stamped). A
  PR without the stamp is "not known" and counted apart; the panel states the coverage.
- **The backfill** (`sync/backfill-review-requests.ts`) re-reads merged PRs in the trailing 90 days
  with no stamp, 100 per repo per walk in `nodes(ids:)` batches of 50, after EVERY walk — user and
  scheduled (the scheduled path has no other post-walk tail). Budget-aware (`isLimited` /
  `noteLimited` / `noteBudget`), strictly non-fatal. Measured: 769 PRs in 26 seconds.
- **Who counts.** The first MOMENT decides; a person and a team asked together is "a named person".
  Requests to automation and to the author are skipped; a request dated before the PR opened is
  clamped to the opening; a first look before anyone was asked is left out of the request medians
  and counted.
- ⚠ **THE REVIEWER ADVICE DEFERS TO THIS.** "Request a named reviewer instead of a team" is the
  published intervention — and on the first real workspace a team request was answered FASTER
  (1.8 working hours against 3.1). When the stored history says so, `directiveFor` drops that
  clause. With no history, the default stands.
- A PR child with no `account_id` (the `review_requests` precedent): in BOTH delete paths, erased
  through the repo loop; `verify:isolation` seeds history for one tenant and proves the other's
  fold sees none.

## Pointers (Pro, the one model-written block)

Three to five short pointers — a **pattern**, an **example worth copying**, a thing to **try** —
each citing the PRs behind it. **The code picks the evidence, the model writes the sentences.**
Core `db/flow-pointers.ts` folds the evidence from the same `getFlowCourts` pass the panel renders
(bounded rows — the slowest 25, the fastest 15, 20 from the middle — plus, per size band, its
slowest and quickest PR with the first thing a person other than the author said, @handles
masked), handed to the plugin through the optional `ProHostQueries.getFlowPointerEvidence`
(apiVersion stays 21). The plugin is the work plan's shape gate for gate: a free GET (cache +
staleness, never generates) and a POST (the only billing path) with a synchronously claimed
in-flight slot, a min-interval on billed runs, the credit check inside the slot, the payload-hash
$0 cache and `recordAiUsage` on spend. Rate tiers: POST `ai`+`ai_hourly`, GET `search`.

- ⚠ **THE PARSE IS THE MECHANISM.** Cited ids ⊆ the evidence (strays counted), the D4 Unicode digit
  gate, an @-handle gate, a length cap, and a pointer with no surviving citation dropped WHOLE.
  Drop reasons are logged per kind so the prompt can be tuned against real refusals.
- ⚠ **Links are never stored** — every read rebuilds them from the live fold, so a PR that left the
  window renders no link.
- ⚠ **The parse checks that a citation exists, not what the sentence says about it.** A pointer can
  describe one PR while citing its neighbour; that is why the block is styled apart (AI tokens,
  sparkle) and why every cited PR is one click away.
- Prompt history (`FLOW_POINTERS_PROMPT_VERSION`, folded into the hash so a bump flips every row
  stale): v1 restated the charts and lost three of five pointers to ticket keys (digits); v2 points
  at content and shape, bans numbers and keys by name and asks for one of each kind; v3 adds who was
  asked first. Measured on real data at v2: five of five survived, under forty words each.

# Bottlenecks — where human review time goes

The Bots rail answers "is this bot worth its seat". This answers the twin question nothing else in
the product asked: **where does HUMAN review time go, and what keeps costing it.**

It is deliberately the **Bot Tuning Advisor's architecture pointed at the human lane** — evidence
CELLS computed over stored rows, sample FLOORS a cell must clear before it may make a claim, and a
NAMED refusal for a cell that cannot. CORE, deterministic, **free on every tier**, and **no model
touches any part of it**.

| Piece | Where |
|---|---|
| The folds | `apps/backend/src/db/flow-findings.ts` |
| The route | `apps/backend/src/api/routes/flow.ts` — `GET /api/flow-findings?workspace&days` |
| The contract | `FlowFinding*` in `packages/shared/src/types.ts` (its comments are normative) |
| The panel | `apps/frontend/src/components/Activity/BottlenecksPanel.tsx` + `bottlenecksModel.ts` |
| Tests | `apps/backend/src/db/flow-findings.test.ts` · `apps/frontend/test/bottlenecks.test.ts` |

## The four findings

| Kind | Subject | Asks |
|---|---|---|
| `single_reviewer_path` | a path bucket | one person owns this directory AND review here is slower |
| `approval_parked` | a repo | work that PASSED review then sat |
| `size_latency` | a size band | big changes wait disproportionately for a first read |
| `round_trips` | a path bucket | threads here take N passes to settle |

## Tiering

Free on every tier today, and CORE — it is deterministic, so there is no capability to gate and it
works in OSS mode. **Gating it later is a one-line change** in the route; it was deliberately left
open so the findings could be evaluated against real workspaces first.

## The rules

The Bots rail asks "is this bot worth its seat". **Bottlenecks asks the twin question about
people: where does human review time go, and what keeps costing it.** It is
`getAdvisorFindings`' architecture pointed at the human lane — evidence CELLS over stored rows,
sample FLOORS, a NAMED refusal for a cell that cannot clear one. CORE, **free on every tier**,
`db/flow-findings.ts` + `api/routes/flow.ts` + `Activity/BottlenecksPanel.tsx`. Four kinds:
`single_reviewer_path` · `approval_parked` · `size_latency` · `round_trips`.

- ⚠ **THE SUBJECT OF A ROW IS THE FLOW, NEVER A PERSON** - a directory, a repo, a size band.
  People appear ONLY as `actorIds` inside a row, as evidence for a claim about the flow. No
  cross-person sort, no comparison table, no leaderboard. "Guide the work, never rank the people"
  is the entire licence this feature operates under; the moment a row's subject is an engineer it
  is a performance dashboard, which is a different product. Same rule that stops the work plan
  calling a red trunk a pull request.
- ⚠ **NO MODEL TOUCHES IT.** Every headline and detail is templated in `flow-findings.ts`. An
  EM makes staffing decisions off this screen, so a generated sentence would launder an unverified
  figure into it. Same discipline `llm-isolation.test.ts` pins for the bot advisor.
- ⚠ **EVERY KIND ACCOUNTS FOR ITSELF: a finding OR a refusal, never silence.** An absent
  section reads as "we checked and there is nothing here" - the strongest of the three claims and
  always the wrong one. This shipped: a real workspace (3 repos, 261 PRs) returned `findings: []`
  with `refusals: []`, because the emit path only refused when NOTHING cleared a floor. `settle()`
  is the one place that decides; `flow-findings.test.ts` asserts it across EVERY fixture scope,
  because the bug lived in the gap between the populations each individual test was built around.
- ⚠ **`FlowFindingRefusal.basis` separates the two silences**, and they are opposite claims:
  `'insufficient_data'` ("could not measure" - an apology) vs `'measured_clean'` ("measured,
  nothing crossed the bar" - a clean bill of health, and the more useful answer). Rendering the
  second under "Not enough data to say" sends the reader hunting a sync problem that does not
  exist.
- ⚠ **THE CALIBRATION TRAP in `approval_parked`**: a PR whose `mergeStateStatus` is `blocked`
  is waiting on REQUIRED CHECKS, not on people. Counting it makes the flagship finding a CI
  finding wearing a review-flow costume - on exactly the PRs an EM would most want to trust.
- ⚠ **AND THE EXCLUSION ONLY WORKS ON THE OPEN HALF, WHICH IS WHY NO SENTENCE CLAIMS IT.** GitHub
  stops computing `mergeStateStatus` once a PR merges: measured on the dev database, of 5,507
  merged PRs **5,478 read `unknown`, 27 `dirty`, 2 `clean` and ZERO `blocked`**, while 553 OPEN
  ones do carry it. So the merged half's `!== 'blocked'` filter is very nearly inert, and the row
  detail plus both refusals used to tell the reader it had applied - **an unearned reassurance on
  the one figure an EM staffs from**. The clause is gone; the detail now carries the TRUE caveat
  ("time a required check held a pull request is inside this figure"). The filter itself stays as
  a positive-observation drop. The OPEN snapshot keeps its exclusion in full - it reads a LIVE
  `mergeStateStatus` through `READY_MERGE_STATES`, and that half is sound.
  - ⚠ **CI history is NOT a usable substitute**, measured before the claim was dropped rather than
    after: `ci_status_events` survives the merge but records ANY check, not a REQUIRED one. As a
    predictor of live `blocked` on the only population with ground truth (open + approved +
    non-draft) it is **41% precise and 29% recall**, and its coverage inside the approve→merge gap
    ranges **0%-66% BY REPO** - the very axis this finding compares, so the exclusion would become
    the confounder deciding which repo tops the list.
- ⚠ **`size_latency`'s author bar and the population it judges are ONE SET.** The workspace size
  median is taken over HUMAN-authored sized PRs only, the same filter `sizesByAuthor` uses. Pushing
  to `allSizes` above that filter let a bot-heavy workspace's bumps anchor the median (86 lines
  all-PR against a far higher human-only figure), halving the `FLOW_BIG_AUTHOR_RATIO` bar and
  NAMING PEOPLE whose changes are ordinary for the humans there.
- ⚠ **A value/baseline PAIR SHARES ONE UNIT** (`fmtHoursPair` server-side, `formatFlowPair`
  client-side - and the two must agree, or a row's sentence and its chip disagree about one
  number). Formatting them independently shipped "2.6 days vs 36h", because 62.4h crosses the 48h
  day threshold and 36h does not - so it broke exactly on the rows with the widest gap.
- Reuses **`loadFirstHumanReviewHours`** (the ONE first-review fold - its header records the
  shipped 18.16h-vs-18.27h bug) and **`pathBucket`**, so this panel and the Bots panel name the
  same directories. `coverage` is ALWAYS rendered; WARN `pullRequests.files` is capped at 100 by
  the sync query and that truncation lands hardest on the big PRs `size_latency` is about.
- ⚠ **`coverage.truncated` vs `coverage.filesTruncatedPrs` are DIFFERENT CLAIMS and must not be
  re-merged.** `truncated` = A ROW SCAN HIT ITS CAP, so every median covers only a PREFIX of the
  window; `filesTruncatedPrs` = some PRs' 100-file lists were capped, so only their PATH
  ATTRIBUTION is partial. One 120-file PR made a 262-PR workspace announce a window problem it did
  not have.
- ⚠ **A CAP INSIDE A SHARED FOLD IS STILL THIS PANEL'S TRUNCATION.** `loadFirstHumanReviewHours`
  truncates internally (`PERIOD_FIRST_REVIEW_PR_CAP` 5,000, two `PERIOD_COMMENT_SCAN_CAP` 200,000
  limits) and returns a bare `number[]`, so it REPORTS ITS OWN truncation through the optional
  trailing `ReviewFoldTruncation` sink, OR'd into `caps.truncated` at the call site. Reachable at
  `?days=90` on a busy workspace. A call-site heuristic (`hours.length >= CAP`) UNDER-FIRES - the
  caps sit on the candidate/review scans, and `hours` is that population after two more narrowings.
  The fold is EXTENDED, never forked: it has three other callers and its header records the
  two-folds-one-screen bug.


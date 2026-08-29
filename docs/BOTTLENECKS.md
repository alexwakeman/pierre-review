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
| The engine | `apps/backend/src/db/pr-intervals.ts` |
| The route | `apps/backend/src/api/routes/flow.ts` — `GET /api/flow-findings?workspace&days` |
| The contract | `FlowResponse` and friends in `packages/shared/src/types.ts` |
| The panel | `apps/frontend/src/components/Activity/BottlenecksPanel.tsx` + `bottlenecksModel.ts` |
| Tests | `apps/backend/src/db/pr-intervals.test.ts` · the `getFlowCourts` block in `verify-isolation.ts` |

CORE, deterministic, **free on every tier**, and **no model touches any part of it**.

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
  server's prose; it never composes a claim of its own out of the numbers.
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

# Review triggers — what starts each AI review run, and when

One place that lists **every automatic start** of the review features: what triggers it, how long it
waits, what must be true, what limits it, and what it may write to GitHub. The design detail stays in
the topic docs ([CLAUDE-REVIEW](CLAUDE-REVIEW.md), [TEAM-REVIEW](TEAM-REVIEW.md),
[SONARCLOUD](SONARCLOUD.md), [MERGE-CI-TRUNK](MERGE-CI-TRUNK.md), [PLATFORM](PLATFORM.md)); this doc
is the index across them. Values were checked against the code on 2026-11-24 (main `40c35f90`), then
updated for the daily AI quota (branch `feat/daily-ai-quota`).

> ⚠ When you change a trigger, a wait, a cap or a gate, update this table in the same commit.

## 1. The gates every automatic run passes

An automatic run starts only when ALL of these hold. A reader's click skips the ones marked *(auto only)*.

| Gate | Rule | Where |
|---|---|---|
| AI is on | `config.aiEnabled` (`ENSEMBLE_AI_DISABLED !== 'true'`). Off ⇒ no sweeper, no route. | `registerAgenticRoutes` |
| Auto review is on for the workspace *(auto only)* | `workspaces.auto_review_enabled`, OFF until switched on. Most sweepers below read it. | Settings → Auto review |
| The onboarding floor *(auto only)* | Only PRs opened (or failures observed) at or after the switch went on. | `auto_review_enabled_at` |
| A person's PR *(auto only)* | Not a draft, author not a bot under the workspace's judgement. | `hiddenBotUserIds` |
| The AI quotas *(auto only)* | The ONE gate: the DAILY quota (spend since local midnight, % of the week; default 10%) and the WEEKLY quota (default 50%), plus the hidden 5-hour share (follows the weekly one). Over any ⇒ SKIPPED, never queued; the day resumes at the next local midnight. | `review/budget-gate.ts` `automaticRunAllowed` → `ai/budget.ts` |
| The AI is ready *(auto only)* | A signed-in provider that can run the kind. Not ready ⇒ waits, never fails. | `agenticRunReady` |
| Not an external repo *(auto only)* | No automatic run on a repo another workspace owns. | `automationAllowedForPr` |
| The team claim | A teammate's live `ensemble/` claim on the head holds the full review (25-minute lease). | § Team claims in CLAUDE-REVIEW |
| One run per PR | Claimed synchronously. Nothing in flight is ever cancelled by a push. | each manager |

**Catch-up on return.** After a boot, or a gap of 5 min or more between ticks (sleep, stall), the
review sweeper holds every workspace until its repos have synced since the break, at most 30 min
(`AUTO_CATCH_UP_GAP_MS`, `AUTO_CATCH_UP_SYNC_WAIT_MAX_MS`). Then the normal rules apply. A press
does not wait.

**All clocks are in memory and all queues are rows.** A restart restarts a wait, never skips one,
and loses no work.

**No daily counts (since 2026-11-24).** The per-workspace and per-account daily counts of automatic
runs (auto reviews 20, Check threads 30, CI reviews 20, story checks 60, diagrams 30, docs checks 30)
are gone. The quotas are the only daily limit. The per-SUBJECT loop guards stay: retries per head,
replies passes per PR, auto fixes per PR, diagram redraws per subject. The quota is asked when an item
is queued AND again when it starts (manager.ts), so the overshoot past a quota is at most the runs
already in flight (`PRO_REVIEW_CONCURRENCY`, 4).

**The near-quota notification.** At 80% of the daily or weekly quota, the header's toast cluster shows
a card with a bouncing "!" and "Change quota" (Settings → AI spend); at 100% the same card says runs
are paused and when they resume (`aiQuotaWarning`, `components/AiBudget.tsx` `AiBudgetToast`).

## 2. The sweepers

Backend paths are under `apps/backend/src/`.

| Sweeper | Cadence | File |
|---|---|---|
| PR review (first, re-review, Check threads, replies pass, verdict pick-up, retries) | every minute | `review/claude-review/auto.ts` |
| CI review | every minute | `review/ci-review/sweep.ts` |
| Ticket review (story check) | every minute | `review/ticket-review/sweep.ts` |
| Auto fix decision | every minute + on events | `coding/ai-fix/auto-fix-queue.ts` |
| Late SonarCloud post | every minute | `sonar/late-post.ts` |
| Dependency automation + merge runner | every 2 minutes | `merge/auto-merge-runner.ts` |
| Run watchdog (sleep / stall) | every 30 s while a run is in flight | `review/claude-review/run-watchdog.ts` |

## 3. Model runs — what starts each one

| Run | Starts when | Waits | Other conditions | Limits | Writes to GitHub |
|---|---|---|---|---|---|
| **First auto review** | A new PR in the population has no review row of any kind | None: the next tick | Gates § 1 | The AI quotas. Lane: 20 waiting. | Through auto-posting (§ 4) |
| **Re-review: new commits** | The synced head matches no run, and the PR has a succeeded run (or its only run is a failed AUTO run at an older head) | None when no run started or finished in the 5 min before the first push. Otherwise 5 quiet minutes after the last push; never more than 20 min after the first push. | One run per head; a run in flight is not cancelled — the push starts its clock | The AI quotas and the lane, as first reviews | Through auto-posting (§ 4) |
| **Check threads** (light pass) | A comment by a PERSON or a REVIEW bot in an unresolved thread NOT rooted on an Ensemble finding, newer than what the runs and checks at this head covered | 2 quiet minutes after the newest comment; 20 min ceiling | Same head (a moved head gets a full review instead). Refused with no model when no thread changed. | The AI quotas; $1 and 20 turns per run | Nothing |
| **Replies pass** | A person's reply on one of Ensemble's posted findings (a thread, or a PR comment after a PR-level finding), newer than what the full reviews and the passes at this head covered. **Also when the author then resolved the thread** (since 2026-11-24). | 2 quiet minutes; 20 min ceiling | Same head; never while a full review of the PR is queued or running. Refused with no row when nothing is left to judge. | 5 auto passes per PR per rolling 24 h (a loop guard) | The pass's outcome post, auto resolve, pushback (§ 4) |
| **Replies pass at a held head** | A push that a teammate's claim holds (so the full review is skipped) and a reply waits | Once per head per settle wait | Same as the replies pass | Same | Same |
| **Cover pass** | One half of a Claude + Codex pair failed | When the half fails (the pair waits for it, at most 30 min) | The other provider checks the failed half's findings | — | Through the pair's post |
| **A teammate's verdict** | The PR's author (a teammate) posted their own Ensemble review at the head, or the head moved past teammates' Ensemble reviews only. Never the reader's own PR. | The moved-head rule above | Started BEFORE first reviews and re-reviews; one teammate takes it through the team claim | At most 5 a tick; the AI quotas | Through auto-posting (§ 4), the verdict included |
| **Retry of a failed auto run** | The latest AUTO run at the current head failed with a TRANSIENT error (usage or rate limit, overload, 5xx, network, sign-in, "interrupted") and nothing at that head succeeded | At once if the default provider changed; else at the reset time the error or usage reading names; else 1 h after the first failure, 4 h after later ones. Never while the failed provider is locked out. | A budget / turn cap, a 406 diff, a schema failure or an unknown error is FINAL | 3 auto attempts per (PR, head); the AI quotas | Through auto-posting (§ 4) |
| **Interrupted run** | The machine slept (tick > 90 s late) and the run made no progress 2 min after waking, or a run made no progress for 30 min | — | Marked FAILED (transient), so the retry rule above re-runs an AUTO one; a manual one is not retried | — | — |
| **Run auto reviews now / Retry** (a press) | The reader presses it on Open PRs or the AI Review tab | Waives the settle waits, the retry backoff, the attempt cap and the transient test | A run in flight still waits; Retry also waives the onboarding floor for that PR | The lane is NEVER waived; over a quota the button asks twice, and the runs it queues still ask the quota when they start | Through auto-posting (§ 4) |
| **Check threads beside a manual review** | A MANUAL review routed `skip` (no textual change) | At once | Every manual run gets its threads judged | Clicks never count | Nothing |
| **CI review** (why checks failed) | An open, non-draft, RED PR a person opened; a failing set at the synced head not explained yet (key: PR, head, sorted failing check names) | None: a failing check is final. A set that grows later is a new key. | Failure observed at or after auto review was switched on. Refused with no model when nothing fails, no Actions log, logs unreadable. | The AI quotas; $2 and 25 turns per run | One PR comment per (PR, head, failing set) through CI auto-posting (§ 4) |
| **CI review beside a manual review** | A reader starts a manual PR review and the PR is red with a failing set not yet explained | At once | Every workspace, auto review on or off | Counts as a click | Nothing automatic |
| **Ticket review** (story check) | A member PR opened, pushed, joined, left or merged; the story text changed. One hop, never transitive. A first auto PR review also kicks it. | 2 quiet minutes after the newest change; 20 min ceiling | A first run needs a member opened after the switch. A queued or running check waits. A reader's Stop holds until the next change. **All criteria met stops it** until the story is edited. | The AI quotas; $4 and 40 turns per run | Story gaps on the member PR the run names (§ 4) |
| **Design diagram** | Any SUCCEEDED PR review (manual or auto); any succeeded ticket review (the story design) | At once (fire-and-forget) | Workspace switch "Draw a design diagram after each review" (ON by default). Skipped with no model: no code changed, already drawn at this fingerprint (PR + head), one in flight. | The AI quotas; a subject already drawn at most 2 a day (a loop guard); $1.50 and 30 turns per run; a Redraw click never counts | Nothing |
| **Auto fix** (AI Fix) | Re-decided on: a succeeded AUTO review, a succeeded CI review, a fix session closing, and the minute sweep | CI still running: up to 45 min. CI review of the head running or due: up to 15 min. A review of the head running, settling or due: up to 15 min after CI was ready. A push from the last fix: until the sync sees the new head. A Claude + Codex pair: until both halves end. | The reader's OWN open non-draft PR; workspace "auto AI Fix" ON (OFF by default). Seeds from the AUTO review at the head (plus CI causes), else CI causes alone. A head the fix's own review loop already reviewed starts nothing. | The fix start queue | Pushes only with "Push automatically" (OFF by default) or "Push when done" — own PR, clean report |

## 4. GitHub writes — what posts, and when

Every automatic write is CLAIMED (compare-and-set) before it reaches GitHub, recorded, and NEVER
retried. Nothing a MANUAL run does is posted without a click, except "Review and post" and the
own-PR resolve below.

| Write | Starts when | Conditions | Default |
|---|---|---|---|
| **Auto-post the review** (one GitHub review with its comments) | An AUTO PR review succeeds; or a manual run started with "Review and post" | Auto-posting ON; PR open, not a draft, not a bot's; scope "mine" = the reader's own PR, a PR they are or were asked to review, or one they reviewed or commented on ("all" = every PR). Kinds: blockers, warnings, questions, story gaps on; nits and "not asked for" off. | ON (where auto review is on) |
| **Auto verdict** | Same post | APPROVE only when Claude approved and nothing blocks (no blocker, no warning, no open earlier point, the impact level allows it); any blocker ⇒ REQUEST_CHANGES; else COMMENT with ONE reason why not | ON |
| **Replies outcome** (one short review) | An AUTO replies pass ends, resting on an AUTO full review | The auto-post gates. A disputed blocker ⇒ REQUEST_CHANGES; every point settled ⇒ APPROVE; a held approval posts its reason once per (PR, head) | Follows auto-posting |
| **Auto resolve** (reply "Addressed in abc1234", then resolve) | After every AUTO run's post; after a replies pass that accepted a reply | Ensemble's OWN inline threads judged addressed / no longer applies / reply accepted. On a thread the person already resolved: the reply only. | Always on with auto-posting |
| **Resolve my Ensemble threads when addressed** | ANY succeeded run of the reader's own on their OWN PR (auto, manual, a replies pass) | Own PR only (drafts too); never a teammate's or a person's thread | ON |
| **Resolve on a teammate's word** | A teammate's imported review at the current head judged the reader's own thread addressed | Own PR; no later run of the reader's own at that head | ON (same setting) |
| **Pushback** (one reply) | An AUTO replies pass or review DISPUTES a reply | At most ONE per thread, ever; never resolves | Follows auto-posting |
| **CI review comment** | An AUTOMATIC CI review ends | Auto-posting ON and its CI kind ON; items diagnosed with confidence > 50; one comment per (PR, head, failing set) | ON |
| **SonarCloud comment** | An AUTO review of the head ends; retried every minute for 2 h while SonarCloud has not analysed the head yet | Auto-posting ON with its Sonar kind; SonarCloud saved; one per head | ON |
| **Story gaps** | An AUTOMATIC ticket review ends | Posted only on the member PR the run names; that PR's own workspace must have auto review ON | ON |
| **Slack "review ran"** | An AUTO review succeeds (a pair: once, at its end) | The workspace's Slack review signal ON; a `skip`-routed run is silent | OFF |
| **Dependency approve / AI fix** | The automation tick, every 2 min | Settings → Dependencies ON; a TRUSTED dependency bot (Dependabot, Renovate); the policy (size, security-only, ecosystems) | OFF |

## 5. What never triggers anything

- Ensemble's own comments, replies, pushbacks and acknowledgements (any Ensemble's marker).
- CI, coverage, deploy, dependency and housekeeping bots. Only a person or a REVIEW bot counts.
- A comment in a RESOLVED thread not rooted on an Ensemble finding.
- Review bodies and PR-level comments, except a person's PR comment after an Ensemble PR-level
  finding (a replies pass).
- A draft PR, a bot's PR, a closed PR, a PR opened before auto review was switched on.
- Local branch review (`ensemble review` / `ensemble mcp`): a reader's click only; no post, push,
  claim, My Turn or auto fix.
- The review loops of AI Fix and Implement story: they run inside a session the reader started.

## 6. The numbers in one place

Backend paths are under `apps/backend/src/`.

| Constant | Value | File |
|---|---|---|
| `AI_BUDGET_DEFAULTS.daySharePct` | 10% of the week a day (local midnight to midnight) | `packages/shared/src/ai-budget.ts` |
| `AI_BUDGET_DEFAULTS.weekSharePct` | 50% of the week | `packages/shared/src/ai-budget.ts` |
| `AI_QUOTA_WARN_FRACTION` | 0.8 (the near-quota notification) | `packages/shared/src/ai-budget.ts` |
| `AUTO_REVIEW_CANDIDATE_PAGE` | 50 PRs read per workspace per tick (a page, not a quota) | `review/claude-review/auto.ts` |
| `AUTO_REREVIEW_SETTLE_MS` | 5 min (pushes) | `review/claude-review/auto.ts` |
| `AUTO_COMMENT_SETTLE_MS` | 2 min (same-head comments) | `review/claude-review/auto.ts` |
| `AUTO_REREVIEW_MAX_WAIT_MS` | 20 min | `review/claude-review/auto.ts` |
| `PRO_REVIEW_AUTO_MAX_QUEUED` | 20 waiting | `review/claude-review/manager.ts` |
| `AUTO_RETRY_MAX_ATTEMPTS` | 3 per (PR, head) | `review/claude-review/auto-retry.ts` |
| `AUTO_RETRY_BACKOFF_FIRST_MS` / `_LATER_MS` | 1 h / 4 h | `review/claude-review/auto-retry.ts` |
| `AUTO_CATCH_UP_GAP_MS` / `AUTO_CATCH_UP_SYNC_WAIT_MAX_MS` | 5 min / 30 min | `review/claude-review/auto.ts` |
| `VERDICT_PICKUP_PER_TICK` | 5 | `review/claude-review/auto.ts` |
| `TEAM_CLAIM_LEASE_MS` | 25 min | `review/claude-review/team-claim.ts` |
| `REPLIES_PASS_AUTO_DAILY_CAP` | 5 per PR per rolling 24 h | `review/claude-review/replies-pass.ts` |
| `TICKET_AUTO_GRACE_MS` / `TICKET_AUTO_MAX_WAIT_MS` | 2 min / 20 min | `packages/shared/src/types.ts` |
| `SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS` | 2 per subject per UTC day | `packages/shared/src/sequence-diagrams.ts` |
| `AUTO_FIX_CI_WAIT_MAX_MS` | 45 min | `packages/shared/src/auto-fix-queue.ts` |
| `AUTO_FIX_CI_REVIEW_WAIT_MS` / `AUTO_FIX_REVIEW_WAIT_MS` | 15 min / 15 min | `packages/shared/src/auto-fix-queue.ts` |
| `COVER_WAIT_MAX_MS` | 30 min | `review/claude-review/replies-check.ts` |
| `SONAR_LATE_WINDOW_MS` | 2 h | `sonar/late-post.ts` |
| `AUTO_MERGE_CRON` | every 2 min | `merge/auto-merge-runner.ts` |

# Merge, CI logs & trunk status

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Merge, CI logs & trunk status (CORE, no AI)

### The ONE merge verdict (`lib/ui.ts` `mergeVerdict`)

Every surface that answers "can this land?" resolves it through the pure `mergeVerdict()` →
`MergeVerdictInfo{verdict,label,tone,canMerge,detail}`. It replaced `mergeWarning()` plus each
surface's own ad-hoc reading, which is how the same PR could read "mergeable" in the Overview
and "blocked" in the merge control.

**Why GitHub's `mergeable` is not the answer:** it reports ONLY merge-CONFLICT state
(MERGEABLE / CONFLICTING / UNKNOWN). A PR whose REQUIRED checks are failing is still
`mergeable: 'mergeable'` — which is exactly what the Overview row used to render as a green
"mergeable" (~444 open PRs in one real DB). **`mergeStateStatus` is the protection-aware field**
and the one to lead with (`clean` / `blocked` / `unstable` / `behind` / `dirty` / `has_hooks` /
`unknown`); `mergeable` survives only as the conflict corroborator. `mergeStateStatus` is
**ACTOR-AGNOSTIC** — it does not model an admin's bypass power, which is precisely why it needs
no branch-protection API call to be trustworthy, and why "blocked" may not be blocking *you*.
`reviewDecision` (new PR column) names the review half of a `blocked` status so the verdict can
say *why*; absent (the lean timeline PR doesn't carry it) the reason stays generic, never invented.

- **`unstable` IS treated as mergeable** (`canMerge: true`, warn tone): it means only
  NON-required checks are red, and GitHub's own merge button merges it. Do not read "respects
  CI" as stricter than that. `behind` is `canMerge: false` because GitHub itself 405s the merge
  when the repo requires up-to-date branches. `queued`/`armed` are checked FIRST (the truest
  answer to "what happens next"), then conflicts, then draft.
- `db/triage.ts` had the identical blindness: `approved_ready` tested `mergeable === 'mergeable'`
  alone and tagged PRs "approved & ready" with red required checks. It now also requires
  `mergeStateStatus ∈ READY_MERGE_STATES {clean, has_hooks, unstable}` — **that set and
  `mergeVerdict`'s `canMerge` must agree**, or the triage queue and the PR disagree about the
  same PR.
- Consumers: `ChecksTab` (Overview verdict row, open PRs only), `MergeControl`,
  `Activity/RepoOpenPrList` + `Timeline/prBar` via **`mergeVerdictWarning()`**.
  **Landmine:** `mergeVerdict` returns `draft` before it looks at behind/blocked, and `draft`
  is not a compact warning — so a draft that was ALSO behind lost its ⚠ on the dense surfaces.
  `mergeVerdictWarning` re-derives with `isDraft` dropped and shows only
  `conflicts`/`behind` underneath (never `blocked`/`unstable` — "required reviews missing" IS
  what draft means, and unstable's "GitHub will still merge it" is a lie about a draft).
  `MergeControl` deliberately does NOT pass `autoMergeArmed`: the `armed` verdict reports
  `canMerge: true`, which on that surface would enable a Merge button for a blocked PR.
- `PrMergeOptions.mergeStateStatus` is GitHub's LIVE REST string (it can return values the enum
  doesn't model, `draft` among them), so the live path narrows through **`toMergeStateStatus()`**
  rather than casting — anything unrecognised becomes `unknown`.

### Merge queue (GitHub's native)

`fetchMergeQueueState` / `enqueuePullRequestOnQueue` / `dequeuePullRequestFromQueue` are the
one place `github/mutations.ts` **forks from its REST house style**, and it has to:
`enqueuePullRequest`/`dequeuePullRequest` are GraphQL-only with no REST equivalent, and queue
presence is not inferable from REST at all — `MergeStateStatus` has no QUEUED value, so a queued
PR looks like any other blocked one. Nothing is synced (a position changes minute to minute and
only the merge control renders it): state rides the lazy `merge-options` fetch. When a queue
exists the control REPLACES "Merge" with "Add to merge queue" — GitHub refuses a direct merge on
a queued branch, so offering one only produces a confusing 405. `estimatedTimeToMerge` is SECONDS
in GitHub's schema; the ×1000 lives in the single `SECONDS_TO_MS` constant, applied at the two
call sites that read the field (`fetchMergeQueueState` + `enqueuePullRequestOnQueue`).
`fetchMergeQueueState` also carries the PR's LIVE `state` (OPEN/CLOSED/MERGED — a fast queue can
merge inside one watcher tick, before the sync observes it) and `reviewDecision` (the review half
of branch protection is the part that BLOCKS an enqueue; checks don't — AWAITING_CHECKS is a
normal entry state), both read by the auto-merge watcher's queue phase below.

### "Merge when ready" (`merge/auto-merge-runner.ts`)

A Pierre-side standing intent in `auto_merge_requests`, re-evaluated on its own cron
(`AUTO_MERGE_CRON` `*/2`, registered in `scheduler.ts` under the same `disableScheduler` gate as
sync — hence the UI saying it only lands while the app is running). Bounded per tick
(`MAX_INTENTS_PER_TICK` 25, least-recently-checked first so a backlog rotates), one tick at a
time, grouped per account so each tenant's token is fetched once and one bad token fails only
that tenant.

**It deliberately does NOT use GitHub's `enablePullRequestAutoMerge`**, which has 422'd since
2026-03-25 on any PR that does not ALREADY meet its merge requirements — i.e. exactly the PRs
the feature exists for. Using it would invert the feature.

Pre-flight, before any GitHub read: past `expiresAt` ⇒ `expired`; PR no longer open ⇒
`disarmed_blocked`; **write permission re-checked at LAND time**, not just at arm time, because
access can be revoked in between and the watcher must never act on a stale grant. Then, per
intent, ONE `GET /pulls/{n}` (`fetchPrMergeSnapshot`) serves both the head and the mergeability —
they are non-overlapping fields of the same payload, and reading them separately cost 750 wasted
calls/hour at 25 intents. The gates it feeds:

1. **Pinned `expectedHeadOid`** — arming is consent to merge THE CODE THE USER SAW. A different
   head ⇒ `disarmed_head_moved`, never a merge.
2. **`isOurUpdateMerge`, the one sanctioned re-pin** — a head move is adopted only on all three
   proofs: we issued an update for THIS intent recently against exactly the pinned head; the new
   head is a **TWO-parent** commit whose FIRST parent is that pinned head (a human commit on top
   also has the old head as a parent — the ARITY is what separates "merged into" from "pushed
   onto"); and the second parent is contained in the base ref. Anything unproven, including a
   compare that couldn't run, is a NO.
3. **Async update-branch is never re-pinned optimistically** — GitHub's update returns **202
   ACCEPTED** and merges asynchronously with no handle to poll, so re-reading the head there
   would adopt a concurrent human push as consented-to code. The runner records what it ASKED
   for (`pendingUpdates`, TTL 15 min) and lets a later tick prove the move via (2).
4. **Retarget guard** — a `PATCH pulls/{n}` base change leaves `head.sha` alone, so the head pin
   is blind to it; the runner compares the live base against the last SYNCED base ref and
   disarms on a mismatch (waiting, not merging, when it can't tell). The exact fix is an
   `expected_base_ref` column that does not exist yet.
5. **COMPARE-AND-SET immediately before the merge** — everything above acts on a scan snapshot
   that can be minutes old; a user who hit Cancel mid-tick DELETED the row, and merging anyway
   would leave the UI saying "cancelled" for a PR that landed.
6. **Green light = `mergeableState ∈ {clean, has_hooks, unstable}`** — so, as everywhere else,
   **`unstable` merges** (CI red but not REQUIRED by branch protection), matching GitHub's own
   button. `blocked`/`conflicts` KEEP WAITING with a `lastReason` (unblocking on its own is the
   whole value of arming); only a head move disarms. `unknown` waits.

**Landmine: `behindBy > 0` is true of MOST healthy PRs** (any trunk commit since the branch
point) — only `mergeStateStatus === 'behind'` means GitHub is blocking. Treating `behindBy` as a
blocker parked every clean armed PR forever, and freshening on it every tick pushed a merge
commit (and a CI run) every two minutes for the intent's 72h life; hence `freshenedIntents`,
which honours "update before merging" exactly ONCE. A local rebase (`coding/merge.ts`, local-only
— cloud has no clone) IS synchronous and returns the sha it pushed, so re-pinning to that adopts
nothing we didn't produce. On success the runner stamps the PR merged locally (like the
interactive route) and sets `merged`; a merge/close that happened outside Pierre becomes
`disarmed_blocked`, NOT `merged` — the latter means "the watcher did it" and would raise a false
toast. `MAX_CONSECUTIVE_FAILURES` 3, counted in memory so a restart errs towards retrying.

**Merge-queue repos** ("queue when ready"): the arm route probes the queue (best-effort, like
merge-options') and stamps `viaMergeQueue` on the intent — the terminal action is then a
head-pinned `enqueuePullRequest` instead of the direct merge GitHub would refuse; a PR already
IN the queue 409s `AlreadyQueued` at arm time (it is already landing). The watcher's queue
phase, per tick (ONE extra GraphQL point, paid only by queue intents; re-verified live, so a
queue disabled after arming falls back to the direct merge):

- **Ordering is load-bearing**: the queue phase settles BEFORE the freshen gates — a branch
  update moves the head, which kicks the entry out of the queue — but the freshen still runs
  before the FIRST enqueue (rules 1–5 unchanged: behind + a strategy ⇒ bring it current, once,
  then enqueue the freshened head on a later tick).
- **The enqueue green light is `reviewDecision`**, not `mergeableState` — a queue repo's resting
  status is 'blocked' (a direct merge is never allowed), and checks don't gate entry
  (AWAITING_CHECKS is a normal entry state; the queue runs them itself). REVIEW_REQUIRED /
  CHANGES_REQUESTED wait with a named reason; APPROVED / null (no review requirement) enqueues,
  CAS-guarded and pinned to `expectedHeadOid` exactly like the direct merge. A rejected enqueue
  throws to the strike counter (transient errors retry; a persistent refusal fails the intent
  with GitHub's message).
- **`enqueuedAt` is the attribution record** (a real column — it must survive restarts): the
  watcher's own enqueue stamps it; a merge observed while it is set resolves `merged` (the toast
  is truthful — checked against the LIVE PR state, since a fast queue can land inside a tick,
  AND against the synced state in the pre-flight, whichever sees it first); a queue entry a
  human created supersedes the intent (`disarmed_blocked`), and OUR entry thrown out of the
  queue (human dequeue, or UNMERGEABLE) stands down with "re-arm to queue it again" rather than
  re-enqueueing against that decision. A re-arm resets it — new consent, new record.
- **Disarm dequeues what the watcher enqueued**: DELETE `…/auto-merge` with `enqueuedAt` set
  also removes the queue entry (best-effort) — "cancel" must not leave the queue to land the PR
  anyway. The row is deleted FIRST so the cancel beats the watcher's CAS even if the dequeue
  fails; a human's own entry (`enqueuedAt` null) is never touched.

**Client side — the ONE way to arm is `MergeWhenReadyControl`**, a dedicated button beside
Merge/Close in the Overview Actions row (`MergeControl` keeps its richer armed panel + cancel,
but no arm button — two arm entries meant two strategy defaults). It fetches merge-options
EAGERLY on mount (SAME query key as MergeControl, 30s staleTime — one fetch serves both; the
3-GitHub-call cost per viewed eligible PR is accepted because the user is looking at this PR),
since eligibility needs the live `behindBy`: **`mergeWhenReadyEligible`** (`lib/ui.ts`, pinned by
`test/mergeWhenReadyEligibility.test.ts`) offers the button while a SELF-CLEARING blocker is up
(verdict `blocked` / `behind` / `unknown`) OR the PR is clean-but-behind (`canMerge &&
behindBy > 0` — arming updates from trunk, then lands it). Absent on a fully clean up-to-date PR
(that's just Merge) and on conflicts/drafts (the exit there is a push, which DISARMS). A
merge-QUEUE repo uses the SAME rules — the button reads "Queue when ready" and the confirm copy
says the queue is the landing verb; only a PR already IN the queue is excluded, via its own
'queued' verdict (not a wait verdict, `canMerge:false` — there is no `queueEnabled` disqualifier
anymore). `behindBy`
only ever WIDENS this button — it still never gates Merge (the landmine above), and the verdict
fed to the predicate must never carry `autoMergeArmed`. Arming always stores a REAL
`updateStrategy` (`canRebaseUpdate ? 'rebase' : 'merge'`, never `'none'`) so a PR that falls
behind AFTER arming still freshens — the old arm path stored `'none'` unless already behind,
which parked exactly those PRs forever on up-to-date-required repos. While armed: the control
becomes "Armed — merging when ready" (queue intents: "Armed — queueing when ready", then "In the
merge queue" once `enqueuedAt` is set, when Cancel also dequeues) + cancel, the PR header shows
an armed chip, and the Close
button HIDES (opposite promises) — all via **`usePrArmedIntent`**, a selector over the polled
armed list (zero new requests; predicate is `state === 'armed'`, NEVER row existence — the list
carries 24h-resolved rows; cross-tab it can lag the 45s poll, own-tab arm/disarm is instant via
the `ARMED_MERGES_KEY` invalidation). `useArmedMerges` polls `GET /api/auto-merge` (45s,
foreground only) and `AutoMergeBanner` toasts only on an `armed → terminal` TRANSITION it
observed itself — the first poll seeds a silent baseline, so a page load never replays
yesterday's outcomes.

### CI logs (`github/actions-logs.ts`)

`GET /repos/…/actions/jobs/{id}/logs` 302s to a short-lived signed blob URL that **does honour
HTTP `Range`** (206 + `Content-Range`), so the fetcher resolves the redirect itself
(`redirect:'manual'`) and issues ONE ranged GET for the window it wants — real byte chunking, not
a download-then-slice. The signed URL is server-side only and NEVER returned to a client (it is
unauthenticated and would bypass the route's ownership check). `parseContentRange` also parses
the start-less `bytes */<total>` form — the shape RFC 7233 mandates on a 416, and the only way to
learn the log's true size when the window fell past the end; a start-anchored-only regex made the
416 recovery dead code.

**Logs are offered for PASSING checks too** — the failure-only gate was OURS, not GitHub's, which
serves logs for every Actions job, and "what did this green check actually run?" is a real
question. `CheckRow` now expands for any check with a job id parsed out of its `detailsUrl`;
third-party checks (external URL, no job) keep the plain link row. The viewer opens at the TAIL
and pulls EARLIER chunks as you scroll up (`useCheckLogs`, a `useInfiniteQuery` where "next page"
means earlier, `LOG_PAGE_BYTES` 128 KiB); the prepend is anchored by **distance from the bottom**,
which is what stays constant when content is added above, and the "Load earlier" control lives
OUTSIDE the `<pre>` so it can't change the scroller's `scrollHeight` mid-anchor.

### Default-branch ("trunk") status

`GET /api/branch-status` over `repos`' four head columns + `branch_commits` (written by the sync
step described under **Sync pipeline**). It exists because everything else in this app is
PR-shaped, while a broken default branch invalidates every open PR's CI at once — and because it
**cannot come from the existing `commits` table, which is PR-scoped: a squash-merged PR never
appears there under the SHA that landed on trunk**. Deliberately informational: it feeds no
attention count, no badge, no My Turn.

> **ONE EXPLICIT EXCEPTION, added with `trunk_ci_status_events` (migration `0052` / pg `0039`):
> a trunk CI FAILURE can appear as a row in the Activity Feed** — but only behind the Feed's
> opt-in "CI failures" pill, which is **OFF by default**. The sentence above still holds in the
> sense that matters: a trunk failure produces **no attention count, no badge, and no My Turn
> row**. It is emitted with `prId: null` (so `enrichMyTurn` structurally declines it) AND is
> withheld from the my-turn enrichment outright (`db/queries.ts` `isCiFeedKind`), because a CI
> item is actor-less and would otherwise satisfy "the actor isn't you" trivially and become an
> UNCAPPED yellow card. CI rows also stay in the CAPPED set, so a chronically red trunk cannot
> starve the 250-row plain-activity budget. See **Trunk CI failures in the Activity Feed** below.

- **Both detail columns follow the partial-response write policy** (Conventions): `undefined` ⇒
  omit the key from the upsert, `null`/`[]` ⇒ clear. `failingChecksToWrite` /`prNumberToWrite`
  are the implementations, and what counts as GitHub's POSITIVE statement is specific — for
  failing checks, a green/`expected` phase-1 ROLLUP or a phase-2 response that actually carried a
  `contexts` list (an `unknown` rollup, which is also what a nulled-by-partial rollup maps to,
  clears nothing); for the PR ref, an `associatedPullRequests.nodes` ARRAY, whose emptiness means
  "this commit came from no PR" — a direct push, a legitimate steady state, not a gap.
  Phase 2's own failure is caught separately (`syncBranchStatus` is already non-fatal upstream, so
  an unguarded throw here would discard the phase-1 snapshot too): detail failure degrades to "no
  carets", never to "no strip".
- Failing checks reuse `sync/upsert.ts`'s `checkContextState` + `parseActionsIds` **verbatim** (now
  exported) so a trunk failure is the SAME object as a PR failure — one vocabulary, one icon set.
  They are deduped by display name keeping the highest Actions `runId`, because `contexts` returns
  every check suite on the commit and does not collapse to latest-per-name the way GitHub's PR UI
  does. `workflowName` is null for a legacy StatusContext and for a non-Actions suite; nothing may
  require it. The repo-level `failingChecks` is DERIVED from the commit whose sha is `headSha`
  (one writer, one reader), matched by SHA and not by position — a backdated committer date can
  sort the head outside the read cap.
- **Commit → PR link.** `pickAssociatedPrNumber` stores exactly ONE number from
  `associatedPullRequests` under a 0/1/many contract, ranked (merged into THIS default branch) >
  (merged anywhere) > (open) with the lowest number as tiebreak — determinism is the point, since
  `first:1` on an unordered connection could FLIP between syncs. Candidates from another
  repository are DROPPED (the connection spans the repo network, so a fork's PR can appear).
  **Landmine: the read layer's map key is `(repoId, number)`, NEVER a bare number** — PR numbers
  are unique only WITHIN a repo, so a number-keyed map cross-links repo A's #12 onto repo B's
  commit and opens the wrong PR. The `inArray × inArray` predicate intentionally over-matches;
  keying by the pair is what makes that harmless, and there is a seeded test rather than only a
  comment. `prId != null` → open the PR's own detail tab in-app; `prNumber` set but `prId` null
  (squash-merged before the backfill window, or a repo added later) → link out to github.com;
  both null → no chip. Headlines go through `lib/prRef.ts` `trimTrailingPrRef` first: GitHub
  truncates `messageHeadline` itself (~70 chars, a literal U+2026) and the trailing `(#1234)` is
  the FIRST thing eaten, so the chip would otherwise sit next to a dangling `(#2…`.
- UI: `Activity/BranchStatusChip` (rail row: dot + branch + age; a HOLLOW dot for "no CI
  observed", unlike the PR surfaces which render nothing for `unknown`) and
  `Activity/BranchStatusPanel` (cross-repo strip on the Feed entry, `compact` per-repo variant in
  `RepoFeedHeader`). **The expanded row lists MERGED PRs, not commits** (`mergedPrs`, ≤10 in
  merge order): each row consolidates its retained trunk commits, whose sha + headline list is
  the row's `title` TOOLTIP (capped at 20 lines; the visible "N commits" count is the hint it's
  there); the row's dot is its NEWEST commit's rollup, the #chip opens the PR in-app when
  `prId` resolved else links to github.com, and a branch fed only by direct pushes shows an
  explicit "direct pushes only" line (those commits stay visible in the chart cells). The old
  per-commit failing-check carets went with the commit list — the HEAD's failing checks remain
  on the row summary.
- **Branch trend charts** (expanded row, above the commit list). `branch_commits` retains
  **the newest 100 commits unconditionally** (`BRANCH_COMMIT_WINDOW` in
  `sync/branch-status.ts` — the widening is 1 → 4 GraphQL points per repo per sync, an
  accepted cost) **plus anything deeper that still sits inside the 90-day trend window** —
  those deeper rows come from the ONE-TIME history backfill (`backfillBranchHistory`,
  paginated `history(since: now − 90d)`, ≤10 pages ≈ 1000 commits, run after a repo's first
  full sync / deep re-sync — see [SYNC.md](SYNC.md) § CI-history backfill; backfilled commits
  carry `ciStatus` only, no failing-check detail). The trim is the HYBRID
  `staleBranchCommitIds`: a row dies only when it is BOTH below the newest-100 floor AND
  outside 90d. ⚠ The unconditional floor is a landmine guard, not a nicety: a pure age bound
  was tried and deleted a repo's ENTIRE set whenever every commit was older than the cutoff
  (dormant repo, or backdated committer dates) — "never synced" strip row, permanently
  disabled expander, 4 points burned per sync writing rows the same transaction destroyed.
  The 90-day horizon is `getBranchTrends`' READ filter. `READ_PR_CAP` is **10** — the
  expanded row lists the 10 most recent merged PRs (deeper history is the trend strip's job),
  which keeps the workspace-wide strip WIRE payload lean (the DB read is bounded by
  `BRANCH_COMMIT_WINDOW × repos` — accepted; see the comment in `db/branch-queries.ts`).
  The series ride the LAZY `GET /api/branch-trends?repoId` (`db/branch-queries.ts`
  `getBranchTrends`, `useBranchTrends(repoId, open)` — fetched only when a row expands, never
  inlined into the hot `/api/branch-status` path): ONE per-UTC-day array on a SHARED axis —
  `failed` (trunk commits with a red rollup) + `merged` (PRs merged into the default branch:
  `baseRefName = defaultBranchName`, NULL base excluded — blind to direct pushes by decision).
  Dense from the OLDEST RETAINED commit day (padding to 90d would fabricate quiet days on a
  busy repo whose 100 commits span less); the merged line truncates to the SAME span on
  purpose — cell-for-cell alignment is the point of the single chart. Rendered as the Bot
  Behaviour **"Daily coverage" layout verbatim** (`DayStrip`: red failure cells + the thin
  merged-PRs line band above) in BOTH panel variants — the per-repo console (`compact` panel
  prop — note the deliberate inversion, `fullTrends={compact}`) wraps it in the same
  `ChartCard` composition as `BotBehaviourPanel`; the cross-repo Feed strip (a `max-h-64`
  scroll box) gets the bare captioned strip. Two honest caveats stored nowhere else:
  per-commit `ciStatus` is upserted in place on re-sync, so a re-run that goes green
  retroactively erases a past failure from the chart (backfilled rows below the live window
  are never re-observed, so THEIR statuses are frozen at backfill time); and depth is bounded
  by the 90d backfill/read window (and, on a repo landing >1000 trunk commits in 90 days, by
  the history backfill's page cap — disclosed in its log line, never silently).

### Trunk CI failures in the Activity Feed (`trunk_ci_status_events`)

The Feed's opt-in **"CI failures"** pill (OFF by default; `feedShowCiFailures` →
`includeCiFailures=true` on `GET /api/activity/feed`) emits **one item per failed check RUN**,
keyed `(PR-or-branch, head sha, check name)`, from two transition logs:

> ⚠ The toggle is a **standing preference**: it is the one feed toggle in `FilterDefaults`, so it
> persists with the filter bar **and is URL-serialized as `ci=1`** (`hooks/useUrlState`). BOTH are
> required, and the URL half is the one that actually restores it: the persisted blob is read only
> on a BARE url, while `writeToUrl` puts `?workspace=<id>` on the address bar as soon as the scope
> resolves. A `FilterDefaults` key that is not serialized is therefore written to localStorage on
> every change and read back never — it survives nothing.

| kind | source | shape |
|---|---|---|
| `ci_failed` | `ci_status_events` (written by `sync/upsert.ts` on every walk) | has a `prId` |
| `trunk_ci_failed` | `trunk_ci_status_events` (written by `sync/branch-status.ts`) | `prId: null` |

**Why the trunk half needed a new table rather than reading `branch_commits`.** That table's
`ci_status` is **updated IN PLACE** by the idempotent snapshot upsert, so a commit that turns red
hours after it landed carries no record of *when*: its only timestamps are `committedAt` (git
commit time) and `createdAt` (first insertion). Presenting either as a failure time would be a
quiet lie, so the observation gets its own append-only row — the exact trunk twin of what
`ci_status_events` already does for a PR head.

Write rules, all load-bearing:
- **Only on a TRANSITION** — status / head sha / failing-check name set differs from this repo's
  last row (`trunkCiTransitionChanged`, pure + tested) — **with one narrow exception: a head move
  while trunk is GREEN is not a transition.** Trunk's head changes on every landed PR and the
  snapshot runs at the end of every walk (as often as every 120s on a hot repo), so recording
  "still green, newer commit" filled an active repo's log with rows that state nothing the Feed
  can read. The exception is deliberately minimal — it needs a POSITIVE green (`success` /
  `expected`) on BOTH sides with no named failing checks on either — so nothing red, and nothing
  amber-with-a-real-failure, can be swallowed: a new head that is still red is a NEW failure (its
  own commit, its own card) and is always recorded, and the first green after a red is a status
  change, so recovery timing survives.
- **Only on a POSITIVE statement from GitHub.** `headSha == null` or a rollup mapping to
  `'unknown'` writes NOTHING. `'unknown'` is both "a state we don't model" and what
  `graphqlTolerant` yields when a partial response NULLs the selection — recording it would
  manufacture a "trunk changed" event out of a permissions error. Same gate the PR-side writer
  uses (`ciStatus !== 'unknown'`).
- **Failing-check names follow the same three-state rule as the columns**: `undefined` (phase 2
  never told us) DROPS the name dimension from the transition comparison rather than comparing it
  against `[]`, or a repo whose detail fetch is failing would log a spurious transition every
  sync. The stored value is `null` — names are never inherited forward from the previous row.
- **Strictly non-fatal and OUTSIDE the snapshot's transaction.** A feed nicety must not be able
  to roll back (or fail) the strip that just succeeded; its own `try/catch` warns and moves on.

Retention: the table has **no PR**, so `pruneOldData` — which anchors everything to a parent PR's
`updatedAt` — can never reach it. It is bounded by a per-repo trim in the writer
(`staleTrunkCiEventIds`), and cleared outright by `deleteRepo` + `eraseAccountData` (it is on
`accountScopedTables()`, unlike `ci_status_events` which sits in that test's KNOWN_UNCHECKED
exemption).

⚠ **That trim is HYBRID — newest `TRUNK_CI_EVENT_WINDOW` (200) rows unconditionally ∪ everything
inside `FEED_WINDOW_DAYS` (14)** — the same shape as `branch_commits`, and it has to be, for
reasons pointing in opposite directions. A pure COUNT bound was wrong: this log is written on
every observed transition and an active repo transitions far faster than 14 days' worth of 200
rows, so the newest-200 rule evicted the failure rows `getTrunkCiFailureFeedItems` reads — exactly
on the repos that have the most of them, and with no symptom other than a Feed that quietly stops
showing trunk failures. A pure AGE bound is wrong too: a dormant repo's whole log is older than
the cutoff, so it would be emptied and the next observation would read as a first observation
forever. `FEED_WINDOW_DAYS` is imported from `db/queries.ts`, not restated, so the retention can
never drift below what the read window asks for.

Reading side (`db/queries.ts`): both builders collapse the log to one card per key, taking the
**EARLIEST** observation so a re-confirmed failure doesn't keep jumping to the top; a head with
more than `MAX_CI_ITEMS_PER_HEAD` (5) failing checks emits 5 cards and **discloses** the overflow
in each summary rather than dropping it silently.

⚠ **The cap and the disclosure are per (target, head), NOT per row** — `collapseCiRows` is
two-pass for exactly that reason. Both sources are TRANSITION logs, so a sharded matrix build
going red shard by shard writes ten rows for ONE head, each carrying the cumulative set. Computing
the cap from a single row's list (while the dedupe set spanned rows) let EVERY row contribute one
more card — a newly-named shard sorts into that row's top-5 window and is an unseen key — so one
head emitted far more than 5 cards, and the early ones disclosed "0 more" while 7+ checks were
failing. Pass 1 accumulates, per head, the UNION of every name ever observed plus the capped picks
in first-observation order; pass 2 emits, so every card on a head carries the same final overflow
count. Cards are actor-less, so they are skipped
whenever a member filter is active and on the `botsOnly` path, and the trunk half is also skipped
under single-PR isolation. ⚠ `observedAt` is **OUR** observation time — neither GraphQL query
selects `completedAt`, and trunk has no fast path at all (`syncBranchStatus` runs only at the end
of a full walk, never from `syncOnePr`), so a trunk failure can be up to the adaptive bucket + the
30-minute floor old. Copy therefore says **"detected"**, never "failed at". A trunk card has no PR
to open, so it stops looking clickable and carries one explicit affordance: the commit on GitHub,
through `safeExternalUrl`.



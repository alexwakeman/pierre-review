# Blast radius — how far a pull request can reach

**Read this before touching `db/blast-radius.ts`, `db/file-coupling.ts`, `lib/ui.ts`'s
`blastRadius()`, or the `impact` annotation kind.**

A maintainer looking at the Pending board cannot tell, without opening each pull request, which
ones deserve a real review and which can be pushed through on a glance. The board already carries
diff size (`+/−`, files changed) and the **large-PR flag** (`codeLoc`), but **size is a weak proxy
for risk**: a 2,000-line lockfile bump is trivial, and a four-line change to a database migration
is not.

Blast radius is the second, **orthogonal** reading — *how far can this change reach* — rendered as
`Low` / `Medium` / `High` beside the size numbers, with the reasons visible so a reader can audit
and disagree with the verdict.

**The product promise is the LOW chip.** High and medium are useful; the reason the feature exists
is to let someone merge a third of their queue after a glance instead of a review.

Tiering: the **level is CORE and free** in both deployment modes, with no AI and no GitHub calls.
Only the **impact note** — two sentences explaining what could break — is Pro, on the existing
`prSummary` capability.

---

## The three parts

| Part | Where | Tier |
|---|---|---|
| The signal vector, folded from stored `files[]` | `db/blast-radius.ts` | CORE, free |
| The co-change ("hub file") index | `db/file-coupling.ts` + `repo_file_coupling` | CORE, free |
| The level + the reasons | `lib/ui.ts` → `blastRadius()` | CORE, free |
| The impact note | `packages/pro/src/annotations/` — kind `impact` | **Pro** (`prSummary`) |

**The wire carries SIGNALS, never a level.** Exactly the rule `codeLoc` follows, for the same three
payoffs: the sensitivity dial becomes a pure render-time comparison (change it in Settings and
every surface repaints with **no query-cache invalidation anywhere**), the chip can name its
reasons rather than assert a bare verdict, and there is **exactly one place** a level is decided.

---

## The definitions

**HIGH — "read it properly."** Any one of:

- **A contract surface is touched** — DB migration or schema, `.sql`, `.d.ts`,
  `.proto`/`.graphql`/`.thrift`, OpenAPI, IaC, auth/security paths. The shapes whose *consumers
  live outside the diff*.
- **Hub** — a touched file whose historical co-change degree clears its repo's bar.
- **Spread** — ≥3 subsystems, or ≥6 directories, or ≥15 non-test code files.
- **Volume** — ≥1,000 code lines.

**LOW — "a quick eyeball is enough."** All of: no contract surface, and either **zero non-test code
files** (docs/config/tests/deps only) or **≤3 non-test code files, ≤100 code lines, one
subsystem** — and the file list was **not truncated**.

**CAPPED AT MEDIUM** — a change whose every line is a **comment**, or which only moved
**whitespace**, however it earned high. See *The trivial-change cap* below.

**MEDIUM** — everything else measurable. ⚠ **The medium row names the condition that actually kept
it out of low** (too many files / too wide / too long / size unknown). An earlier cut folded them
into one boolean and printed *"1 code file across 1 directory"* beside the word **Medium** — a
sentence arguing for the opposite verdict, on a real pull request whose discriminator was its 300
lines.

**UNKNOWN → render nothing.** No stored breakdown, a never-observed size, or truncated-and-not-high.

---

## The rules that have already cost something

### ⚠ Truncation reads asymmetrically — the safety rule of the whole feature

GitHub's `files(first: 100)` truncates, and it truncates **exactly the biggest pull requests** —
precisely the ones that must never be labelled "just eyeball it". So **HIGH may be asserted on a
truncated list** (a missing file can only add reach) and **LOW may not**. A truncated pull request
firing no high arm degrades to **unknown**, not to low.

Enforced **once**, in the resolver, below the high arms and above the low branch — not by
convention at four call sites. `BlastSignals.truncated` is the same page-cap fact as
`codeLocIsLowerBound`, one level up.

### ⚠ `hubDegree: null` is "no reading", never 0

Two cases are deliberately fused: the repo has no index (**measured: only 6–7 of 22 real
repositories clear the coverage floor**), or no touched file is a hub. Nothing in the product ever
says "this is *not* a hub", so no screen can show the difference. A `hubDegree ?? 0` in the
resolver would convert every silence into a clean bill of health.

### ⚠ `hub_bar` is `max(repo p90, HUB_MIN_DEGREE)` — relative **and** absolute

This took the longest to get right. **A p90 alone is exceeded by a tenth of paths by
construction**, so a repository with no coupling whatsoever still publishes "hubs". Measured: a
config repo produced **77 of them**, which were eight per-environment copies of one service's
`.env` file. An absolute floor alone fails the other way — degree scales are not comparable
between a 2,800-path monorepo and a 130-path library.

Together they took that config repo to **zero** while leaving `redis.go` (73),
`src/renderers/WebGLRenderer.js` (65) and `crates/bevy_render/src/lib.rs` (70) standing.

### ⚠ The index excludes tests, and skips huge pull requests

A test co-changes with its subject *by construction* — that is what a test is, not evidence of
reach. Measured: one repo's top "hubs" were four `*.test.js` files sitting above their own
controllers. And a pull request touching more than `HUB_PR_FILE_CAP` (25) files creates a clique in
one stroke; without the cap **one** such PR can lift a hundred unrelated paths over the bar.

### ⚠ The trivial-change cap — comments and formatting

The case: **`golang/go#80721`**, *"crypto/hpke: document sequence counter size"* — one file,
+4 −2, **every changed line a `//` doc comment**, flagged HIGH because `crypto/` is a contract
surface. The path was right about the **file** and wrong about the **change**.

`ChangeShape` is read from the diff and caps that at **MEDIUM**.

⚠ **MEDIUM, NEVER LOW, AND THAT IS THE POINT.** A comment in a migration is still a change to a
file that matters: the reader should look, they just should not have to review it like a schema
change. Demoting to low would make the file's consequence disappear, which is the opposite error.

⚠ **`contentKind: null` MEANS "WE DID NOT LOOK", AND IT IS THE COMMON CASE.** Knowing this needs
the **diff** — a REST call per pull request — so it is fetched only where it could change the
answer: currently HIGH on a **contract surface alone**, and small
(`MAX_CANDIDATE_LOC` / `MAX_CANDIDATE_FILES`). Measured: **26 of 1,566 open pull requests, 1.7%**.
Everything else carries null forever, and null must never demote.

⚠ **`content_kind_sha` IS NOT BOOKKEEPING.** A diff read is only true of the commit it read.
Without it a "comments only" verdict survives a force-push that added a schema change. The
staleness test lives **once**, inside `blastSignalsFor`, so no surface has to remember it.

⚠ **THE CLASSIFIER'S ASYMMETRY IS ITS WHOLE DESIGN.** An unknown extension, a patch GitHub did not
give us, a block comment it cannot bound — all resolve to `code`/`null`, never to `comments`. A
wrong `code` leaves a pull request HIGH and read carefully; a wrong `comments` waves a crypto
change through. A failed fetch stores `'code'` against that sha, both as the safe answer and as
the sentinel that stops it being retried on every walk.

⚠ **IMPORTS WERE CONSIDERED AND LEFT OUT.** Reordering imports is trivial; *adding* one means the
file now uses something it did not, which is a real change with real reach. They are one line
apart in a diff. If it is ever added it belongs beside `deps` — carried for narration, never as a
reason to lower a level.

The Pro impact note is fed the same fact and told it **outranks the file paths** — otherwise a
model shown "crypto/ touched" reaches for a security consequence a documentation change does not
have. `promptLevelFor` mirrors the cap so the note never explains a verdict the reader is not
looking at, and `contentKind` is folded into the payload hash so a note written *before* the diff
was read is marked stale rather than frozen wrong.

### ⚠ The anti-double-count rule

A 2,000-line PR would otherwise carry an amber *"2,000 code lines"* from `largePrFlag` **and** a
High chip whose only reason is those same 2,000 lines. `BlastVerdict.volumeOnly` marks that case:
the flag keeps the number, the chip keeps the level, and the chip leads on the non-obvious reasons
— surfaces, spread, hubs — which nothing else on the row reports.

⚠ The resolver reads **the same `codeLoc` the flag reads**. It is deliberately *not* duplicated
into `BlastSignals`: one fact, one grain, or the two chips quote different line counts.

### ⚠ `deps` and `ci` are carried but are not high arms

`deps` is the most common surface on real data (**222 of 1,405 open PRs**) and a dependency bump is
the archetypal *low*-blast change; it is carried so the chip can say "dependencies" rather than
stay silent. `ci` does not ship to users, so it is not high — but it can break everyone's build, so
it is not free either. It lands medium.

### ⚠ The known false positive, shipped visible rather than hidden

`db_schema` matches `schema/` and `models/` trees. In a repo whose **product** is an ORM, its own
`src/**/schema/**` source tree trips a rule that means "this changes the database" — measured, 55
hits, almost all one such repo. This is why the chip always **names** the surface, and why
`surfacesOff` exists in Settings. It is deliberately *not* special-cased in the matcher, which
would make the behaviour invisible to the reader.

---

## The fourth path classifier

`db/code-loc.ts`'s header documents three. This is the fourth, and none may be folded into another:

1. `NOISE_GLOBS` (`review/prepare.ts`) — "strip this from the diff the paid **agent** reads?"
2. `isLockFile` (frontend `lib/diff`) — "start this file's diff **collapsed**?"
3. `isNonCodeFile` (`db/code-loc.ts`) — "does this churn count as **code** a human must read?"
4. `BLAST_SURFACES` + `isTestFile` (`db/blast-radius.ts`) — "do this file's **consumers live
   outside the diff**?"

⚠ **It must not import `NOISE_GLOBS` or `API_PATH_PATTERNS`.** Both are tuned for a paid agent's
diff budget, where over-matching is *safe*. Over-matching here is a false claim on screen, and
editing either to suit this feature would silently change what Claude Review reviews with no test
to catch it.

### Why this is not `decideReviewMode`

The Claude Review depth router asks a genuinely similar question and its *shape* is this feature's
ancestor (file/line/directory/subsystem ceilings, a contract-touch signal, `allFilesNew`). It
cannot be **called** here:

1. It runs on the **diff body**, fetched through the `gh` CLI — a GitHub call per PR, and
   **nothing on the Pending board may fetch on mount**.
2. Claude Review is **local-only** and force-disabled in cloud; blast radius works in both.
3. Its gate is deliberately over-conservative (*any ambiguity → worktree*) because over-routing
   there only costs money. Over-routing here marks everything high and the feature stops meaning
   anything.

---

## Where the chip appears

| Surface | Form |
|---|---|
| Pending board (`PrMetaRow`) | labelled, not expandable — the card is itself a link |
| Feed, **PR-opened** cards | labelled, on the card's own metadata row |
| Feed, every other card kind | icon-only on the PR-ref line (no card body to put it on) |
| PR detail | labelled and **expandable** |
| vis-timeline | a tooltip row, via the same resolver |

⚠ **A PR-opened Feed card suppresses the ref-line icon**, because it carries the labelled chip
below — the same fact twice on one card is the double-count the large-PR flag rule already names.

⚠ **None of this costs a GitHub call.** The signals ride `ConsolidatedFeedItem`/`InsightPrRef`/
`TimelinePr`, folded server-side once per PR on the page.

## The per-repository card (Reports → Flow metrics)

**"Reach by repository"** — one row per repository, its currently-open pull requests split
Low/Medium/High. It sits beside "Activity by repository" in the "Where the work is happening"
section (`WorkspaceReachCard`, folded by `useWorkspaceReach` in `hooks/useBlastRadius.ts`), and it
is the only AGGREGATE view of the level in the product.

**It is a client-side fold, and that is the design.** `useWorkspaceOpenPrs()` already returns every
open pull request in the workspace carrying `blast`, `codeLoc` and `codeLocIsLowerBound` — i.e.
`BlastPrFields` plus `repoId` — and the card calls `blastRadius()` on each row with the account's
resolved config. Three consequences, each of which is why it is not a server field:

- **The level stays decided in exactly one place.** A per-repo `{low, medium, high}` on the wire
  would be the product's first server-decided level, and the card could then disagree with the chip
  on the same pull request, silently, per row.
- **The dial stays a render-time comparison.** `useSetBlastConfig` invalidates `['me']` and nothing
  else; moving the sensitivity dial re-runs a fold over rows already in memory. A server count
  would have to invalidate `['workspace-metrics']` too, and a stale cached response would draw one
  distribution while every chip on screen drew another.
- **It costs no extra request once the Feed has been opened** — the Feed's open-PR panel holds that
  exact cache entry. Opening Reports first pays one `/api/open-prs`.

⚠ **IT READS `useWorkspaceOpenPrs`, NEVER `useSearchOpenPrs`.** The latter narrows by
`filters.repoIds`, the TIMELINE board's picker, which is not mounted on Reports.

⚠ **UNKNOWN IS NOT A FOURTH SEGMENT AND NOT A ZERO.** A `null` verdict — never measured, or
truncated-and-not-high — is not drawn. A fourth band would make "we don't know" look like a level
and would inflate the bar so it no longer means "pull requests with a reading". The consequence is
that **the bars do not total the open-PR count the list is ranked by**, so the count is stated in
words under the card and beside the name of any repository it applies to. (Measured 10.0% of open
PRs before the file backfill; 1 of 1,562 after it — the disclosure exists for both.)

⚠ **THE POPULATION IS OPEN RIGHT NOW** — a snapshot, not a window, and the fourth framing on that
panel, so the card says so. It also includes DRAFTS, which the "Open PRs" flow tile above it
excludes (`state === 'open' && !isDraft`); on a real workspace that is 210 against 204, so the
draft count is disclosed rather than reconciled by dropping the drafts.

⚠ **THE THREE FILL COLOURS ARE MEASURED, AND TWO OBVIOUS CHOICES FAILED.** A fill must clear 3:1
against BOTH page grounds, which admits only luminance 0.107–0.300 — so a light-to-dark ramp of one
hue is arithmetically impossible. The card uses three Okabe–Ito CVD-safe hues as a cool→warm ramp:
`#0072B2` low (5.19:1 light · 3.88:1 dark), `#CC79A7` medium (3.06 · 6.58), `#D55E00` high (3.87 ·
5.21), stacked in a FIXED low→high order so position encodes the level too, with all three named in
a key. The chip's own palette cannot be reused as fills: its greens/greys/ambers are theme-forked
text pairs, `PALETTE.green` is the success green the chip rejects by name (and 2.28:1 here),
`PALETTE.gray` is 2.54:1 and the chip's amber 2.15:1.

**Free on every tier**, like the level itself — no `ProGate`, no capability read, no 402.

## The expansion is free, because it is deterministic

Every reason and every figure in the disclosure comes from `blastRadius()` and `blastSignalsFor()`.
**No model is in that call path** — so it is open to every user on every tier. (The Pro half of
blast radius is the impact *note*, a different component.)

⚠ **EVERY pull request expands, not only multi-reason ones — and that is only defensible because
the panel shows the EVIDENCE, not just the reasons.** An earlier cut opened onto `reasons[]` alone,
which on a single-reason pull request meant reading its own summary back verbatim. The signal
vector underneath (files, tests, directories, areas, code lines, and the change shape *when it was
read*) is what makes the click worth making.

⚠ **The panel carries `self-start`.** It sits in PR detail's `items-center` metadata row, so
without it an expanded panel makes the row tall and vertically centres the author line against it —
the line visibly drifts as the reader opens the disclosure.

## Showing and hiding the impact note

`BlastRadiusConfig.showImpactNote` — account-grained, beside the sensitivity dial. **Absent means
SHOWN**, so an account that has never expressed an opinion gets the feature; only `false` is ever
stored, for the same two-state reason nothing else in that blob stores a default.

**There are TWO controls and they answer different questions.**

| Control | Where | Means | Stored |
|---|---|---|---|
| **Collapse** (`⌄ Impact note`) | on the note | "folded right now" — one click unfolds it | `localStorage`, per viewer |
| **Offer the impact note** | Settings | "never offer this at all" — removes the button, stops the query | `showImpactNote`, server |

⚠ **Collapsing used to write the SERVER field, which made one click a one-way trip.** The reader
could only get the note back through Settings — reported as "when I 'Hide' the summary, it is gone
for good". The caret is now the reversible control and the server field is only the permanent
switch.

⚠ **The collapse is `localStorage`, per this codebase's stated rule** for a lightweight per-viewer
convenience: whether this browser currently shows a panel folded is a fact about this browser.
Wrapped in try/catch, correct when it comes back empty (empty = expanded). It is deliberately not
the Zustand filter store, which persists and resets from one shared list — "Clear filters" would
silently unfold every note.

⚠ **The collapsed stub still shows a `· flagged` marker** when the model escalated. Hiding the
fact that something was flagged is the one thing a fold may not do.

⚠ **Collapsing never hides the "What could this break?" button** — only a generated note. A reader
who folded one must still be able to ask for another.

Hiding via Settings removes the **whole affordance**, button included — and it is ANDed into the annotation
query's own `enabled`, because a "hidden" note that still costs a request on every PR open is not
hidden. Two entry points write the one field: the Settings checkbox, and a **"Hide these"** link
on the note itself. ⚠ The inline link sends the **whole config**, because the route REPLACES the
blob rather than merging — sending `{showImpactNote:false}` alone would silently reset the
reader's dial and surface opt-outs.

The checkbox renders even for an account with no plugin: this is a **reading preference, not an
entitlement**, so a reader who turns it off stays off if they later gain the capability.

## The impact note (Pro)

**The code decides the level, free. The model explains the consequence, paid.** The same split the
work plan and Chronology live by.

- Rides **`prSummary`** — the cheap Haiku tier `review-assess`, `resolution-check` and
  `annotations` already reuse. **No new capability; `apiVersion` stays 21.**
- Lands as `kind: 'impact'`, `targetKind: 'pull_request'`, `targetId = prId` on the **existing**
  `pr_comment_annotations` table — whose unique index is already
  `(accountId, kind, targetKind, targetId)`, so **no plugin migration**.
- Inherits the whole cost machinery: the payload-hash cache ($0 on unchanged), the pure cached GET
  (opening a PR costs nothing), the one billing path, the per-account in-flight slot, the
  min-interval, `shouldStop` on socket close.
- **One target per PR**, so it never chunks.

⚠ **It may never LOWER the level.** Its only verdicts are `concern` (raise a separately-labelled
flag *beside* the chip) and `none`. A model that can say "actually this is fine" is a model that
can talk a maintainer out of reviewing a migration. Escalation is safe because its only effect is
making someone look harder. `FALLBACK_VERDICT.impact` is `none` for the same reason — an
unparseable response must not raise an alarm the model never raised.

⚠ **PR detail only, click-gated.** Never on a Pending card or the timeline: the board may not fetch
on mount, and a board that *billed* on mount would be worse.

⚠ **`DEFAULT_ANCHOR_KINDS` deliberately excludes `pull_request`.** That is a billing guarantee: the
combined `'review'` run is what the per-thread "Check review" button sends, and if impact were
reachable from there, every click on a comment would also bill a whole-PR call.

⚠ **The payload hash folds only stored facts** — head sha, the file list, title, body, and the
signal vector including the hub fields. Nothing hydrated, nothing `Date.now()`-derived. The free
cached GET recomputes it on every PR open on a path that hydrates nothing; a hydrated or
clock-derived input would make GET and run disagree forever — every note permanently `stale`,
re-billed on every click. That defect has already cost this codebase two bugs.

---

## Calibration (measured, not invented)

Against the dev DB: **1,559 open pull requests across 22 repositories**, 1,405 with a usable
measurement.

| | |
|---|---|
| Measurable | **90.1%** — the other 9.9% render nothing |
| Distribution (shipped code, defaults) | low **36.8%** · medium **26.7%** · high **26.6%** · silent **10.0%** |
| `codeLoc` | p50 106 · p75 385 · p90 1,122 · p95 2,046 · max 19,481 |
| Non-test code files | p50 3 · p75 7 · p90 17 |
| Directories · subsystems | p50 2 / p75 4 · p50 1 / p75 2 |
| Surfaces seen | deps 222 · schema 55 · ci 43 · dts 2 · migration 2 · sql 2 |
| Chip coverage on open PRs, after the file backfill | **100%** (was 90.2%) |
| Repos clearing the hub coverage floor | **6 of 23** |
| PRs whose level the hub arm changes | **3.5%** |
| PRs eligible for a change-shape diff read | **26 of 1,566 (1.7%)** — 363 are HIGH, 53 on a surface alone |
| Cost of one repo's pass (golang/go, 4,000+ PRs) | **8 calls, 3.9s**, then 0 until a head moves |

**Re-run it after any change to an arm.** The script is not committed (it reads the dev DB
directly); rebuild it from `blastSignalsFor` + `codeLocFor` + `blastRadius` and check the
distribution has not drifted. A large drift means an arm changed meaning.

---

## Why the classification stays narrow — measured, not assumed

The obvious "just classify everything on sync" was tested and rejected on the numbers:

| | |
|---|---|
| Cost of `contentKind` for every open PR | **1,410 calls** up front, ~213/day steady state |
| …for every PR ever synced | **7,567 calls** |
| Of those, PRs a cap **could not possibly change** | **1,048** — a cap only ever lowers a HIGH |
| Sampled from the highs today's gate SKIPS | **0 of 40** were trivial |
| Hit rate inside the gate | **3 of 25 (12%)** |

So widening spends hundreds of calls for a measured zero. **The narrow gate stays.**

⚠ **THE LEVEL ITSELF WAS NEVER THE EXPENSIVE PART, AND IS ALREADY UNIVERSAL AND LIVE.** It is
folded from synced columns on every read, so a commit that adds files or directories moves the band
on the next sync with no extra work at all. What needed fixing for "every PR has a chip" was not a
diff read but a missing FILE LIST — see below.

## The two backfills, and why they are not the same thing

| | `backfillMissingPrFiles` | `runChangeShapeClassification` |
|---|---|---|
| Fetches | the file list (`/pulls/:n/files`) | the same call, read for its **patches** |
| Buys | a level **existing at all** | a level being **refined** (the cap) |
| Population | open PRs with `files IS NULL` | high-on-a-surface, small |
| Measured | 142 PRs → coverage 90.2% → **100%** | 25 PRs → 3 capped |

⚠ **The first cannot be replaced by the second.** With no `files` there is nothing for a diff to
refine — `codeLocFor` returns null and every surface correctly renders nothing.

⚠ **The file backfill alone was not enough, and the reason is worth knowing.** After it ran, all
1,564 open PRs had a real file list and coverage had *not moved*. The blocker was `codeLocFor`'s
**trap 2**: `additions`/`deletions`/`changedFiles` all 0 reads as "never observed", and 154 PRs had
exactly that alongside a perfectly good file list. The trap was narrowed to fire only when the file
list **agrees** (sums to zero too) — a stored `files[]` with real per-file numbers is a positive
observation of size, from the same GitHub payload the columns should have carried. A genuinely
empty PR still refuses.

## Verifying

```bash
pnpm typecheck && pnpm test                                    # includes the fixture suite
./apps/backend/node_modules/.bin/vitest run --root apps/frontend   # the LEVEL rules — hand-run
./apps/backend/node_modules/.bin/vitest run --root packages/pro    # hand-run
pnpm --filter @pierre-review/backend verify:isolation           # both new id-addressed getters
```

⚠ **`apps/frontend/test/` is neither run in CI nor typechecked** (its tsconfig includes only
`src`). That bit during this feature's own build: renaming `hubP90` → `hubBar` left a stale key in
a test factory, which no compiler saw, and the hub arm silently stopped firing in every test using
it. Run the frontend suite by hand after any wire-field rename.

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
`reviewDecision` (a PR column, and the only field GitHub gives that names an unmet rule) is the
review half of a `blocked` status — see **Why a blocked PR is blocked** below for the whole
answer; absent (the lean timeline PR doesn't carry it) the reason stays generic, never invented.

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
- Consumers: `ChecksTab` at **TWO sites** — the Overview Status chip (open PRs only) and the
  **Conflicts** row's gate, `conflictsRowVisible(state, verdict)`, which consumes the RESOLVED
  verdict rather than re-reading `mergeStateStatus`/`mergeable` so the merge queue keeps outranking
  the conflict test — then `MergeControl`,
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

### Why a blocked PR is blocked (`deriveMergeBlockers`, PR detail only)

`mergeStateStatus: 'blocked'` is the ONE verdict GitHub refuses to explain, and the PR pane used
to pass the shrug straight through. GitHub collapses **at least six** protection failures into
that one word — required approvals not met, a standing CHANGES_REQUESTED, a required check that
is red / pending / never reported (`EXPECTED`), unresolved review threads on a repo with *Require
conversation resolution before merging*, required signed commits / linear history / deployments,
and repository rulesets — and puts **nothing on the same payload that separates them**.

**Branch protection is NOT the answer, and this is a decision, not an omission.**
`Ref.branchProtectionRule` (and REST `/branches/{b}/protection`, `/rulesets`) is **admin-only**:
it returns `null`/403 for the WRITE/MAINTAIN tokens most viewers hold, and `graphqlTolerant`
NULLs forbidden fields on a partial 200 — so *"this repo has no such rule"* and *"you may not see
this repo's rules"* arrive identical, which is exactly the state
[the partial-response rule](../CLAUDE.md) forbids acting on. Syncing it would make the feature
authoritative on a handful of repos and silently blank on the rest. Nothing in
`apps/backend/src` selects it; do not add it.

So `deriveMergeBlockers(facts)` (pure, `lib/ui.ts`, unit-pinned by
`apps/frontend/test/mergeBlockers.test.ts`) reasons from what the app already syncs and ranks the
candidate causes by `certainty`:

| certainty | means | which kinds |
|---|---|---|
| `proven` | GitHub itself names this requirement as unmet | `changes_requested`, `review_required` — both from `reviewDecision`, the ONLY field that names a rule |
| `inferred` | the fact is real and locally verified, but GitHub never says it is what BLOCKED means | `checks_red`, `checks_pending`, `unresolved_threads`, and the terminal `unexplained` |

⚠ **`certainty` ORDERS THE LIST AND IS NOT RENDERED, AND `MergeBlocker` CARRIES NO `note`.** The
row shipped with a preamble about what GitHub does and does not tell us, a PROVEN/INFERRED chip on
every entry, and a note under each explaining the hedge — three layers of scaffolding around one
short true sentence. The pane now prints the facts, proven ones first, and nothing else: which of
them GitHub is actually enforcing is the reader's call and they are better placed to make it. See
**Product voice** in [CLAUDE.md](../CLAUDE.md). The rigour below is unchanged — it moved into what
the sentences are ALLOWED TO SAY, which is where it belongs, rather than into commentary beside
them.

Rules, each of which the measured data forced:

- ⚠ **NEVER ASSERT UNRESOLVED THREADS ARE THE BLOCKER.** Only **89 of 572** blocked PRs in a real
  database have ANY unresolved thread — the claim is false for 84% of them — and the setting that
  would prove it is the admin-only one above. The copy hedges causally and the row is `inferred`.
- ⚠ **THE THREAD COUNT IS `!isResolved`, WHICH INCLUDES `likely_addressed`.** That heuristic says
  the code probably changed; GitHub only cares about the resolve click, so those threads still
  block. `likelyAddressedThreads` rides the same fact object so ONE sentence names both
  populations — because there are now **three** unresolved-thread counts on or near this screen
  and none may wear another's word:

  | where | population | on-screen word |
  |---|---|---|
  | this blocker row | `!isResolved` (incl. `likely_addressed`) | "not resolved on GitHub", + "(N of them look addressed)" |
  | `ChecksTab`'s Bots chips | `untouched \| replied_unresolved` | "N need a look" (was "N unresolved" — renamed for exactly this reason) |
  | `db/triage.ts` `untouched_threads`, `db/work-plan.ts`, `mergeCardDetail` | `untouched` only | "N unanswered threads" |

- ⚠ **`reviewDecision === 'approved'` REMOVES a row; it never adds one.** Its predecessor
  `blockedDetail` returned a flat *"required checks aren’t passing"* for every approved+blocked
  PR — **false on 10 measured PRs whose CI rollup was green**, asserted from a field that says
  nothing about checks. Approval now only sharpens `unexplained`.
- ⚠ **An outstanding review request is NEVER a blocker of its own.** GitHub answers
  `reviewDecision: null` when the base branch requires no review — the shape 1,430 of 1,552 open
  PRs are in, and it is genuine, not a sync gap (`PR_NODE_FIELDS` selects `reviewDecision` and
  `persistPr` writes it in both arms of the upsert). `requestedReviewers` only ever NAMES a
  proven `review_required` row.
- **`unexplained` is the terminal entry and the list is never empty** — 17 real PRs are approved
  + blocked with no unresolved thread, and a bare "blocked" with nothing under it is the
  complaint this feature answers.
- **The order is fixed and by evidence strength:** GitHub's own naming, then a red rollup (a red
  NON-required check alone reads as `unstable`, not `blocked` — the same inference
  `merge/auto-merge-runner.ts` already makes when it labels an armed intent's wait), then checks
  that haven't reported, then threads.
- **Populated for `blocked` ONLY.** Every other verdict is already a complete sentence about
  itself; a one-row list under "resolve the conflicts with the base branch" is noise. ⚠ **The rule
  stands, and the Conflicts row does not bend it.** `conflicts` now has its own Overview Row — but
  what that row carries is an **ACTION** (the **Resolve conflicts** button, and a link out to the PR
  on GitHub for readers the button is hidden from), not a
  ranked list of candidate causes. `blocked` needs `blockers[]` because GitHub refuses to say what
  it is enforcing; a conflict names itself, so there is nothing to rank. That is also why the row
  earns its place only in exchange for the Status chip's `· detail` echo being SUPPRESSED for this
  one verdict — otherwise the same five words print twice an inch apart. **Do not give the conflicts
  verdict a `blockers` array** to make the two rows look alike: `mergeBlockers.test.ts` asserts
  `blockers` is `undefined` for `dirty` among five other statuses.

**`MergeBlockFacts` is one OPTIONAL OBJECT on `MergeVerdictInput`, and its presence is the
signal.** The compact surfaces (`Timeline/prBar`, `RepoOpenPrList`, the Pending cards) are fed a
`TimelinePr` carrying neither threads nor a review decision; handing them a list derived from
silence would print "nothing we can see explains it" on every blocked row in the app — a claim
about the PR rather than about what we bothered to fetch. Omit it there and `detail` keeps its
old generic sentence. **`ChecksTab` builds it once and threads it into `MergeControl` and
`MergeWhenReadyControl`**, which previously built their verdict from the live merge state alone
and so rendered a *worse* reason than the line directly above them.

**`GET /api/prs/:id/merge-options` now returns `reviewDecision` at zero extra GitHub cost.**
`fetchMergeQueueState` has always selected it (the auto-merge watcher waits on it by name) and
the route always issues that probe — it just dropped the field, and threw the whole probe away on
any repo without a merge queue. ⚠ It is SPREAD, never assigned: `queue` is null when the probe
FAILED, and "we never asked" must not reach the client wearing the same `null` GitHub uses for
"this base branch requires no review". Absent → the control falls back to the synced row.

### Resolving conflicts in the app (`src/conflict/`, CORE/free, BOTH MODES)

**This retracts an old claim.** Until this shipped, several places in this repo said some version
of *"resolving conflicts is a git operation this app does not perform, and GitHub offers no button
for it either"*. It does now. What has NOT changed: `mergeVerdict` still returns `canMerge: false`
for a conflicting PR, GitHub still 405s a merge on one, "Update branch" still cannot clear a
conflict, and the `conflicts` Pending card still carries **no merge affordance**. The one thing it
gained is the resolver entry.

**Where it exists: everywhere.** `app.ts` registers `conflictRoutes` unconditionally and
`MeResponse.conflictResolver` is `true` in both modes. ⚠ **This RETRACTS "LOCAL ONLY"**, which rested
on two claims that are no longer true — that the cloud image has no git, and that it has no clone
directory. It ships git, and `config.cloneDir` resolves to the container's ephemeral filesystem in
cloud (`/tmp/pierre-review/clones`), swept by the same janitor that runs locally. ⚠ **There is still no
`CONFLICT_RESOLVER_ENABLED` and there must not be** — a per-handler env check looks like a gate and
is one Railway variable away from not being one. The field stays on the wire as a constant because
the SPA's entry gate reads it and a field that disappears is a field every caller has to re-learn.
It is CORE and free in both modes: no `ProGate`, no upsell, no seventh visible-but-locked surface.

**Nothing about the routes changed for multi-tenancy, because nothing about them was ever
single-tenant.** Ownership is `getPrWriteContext(id, accountId)` on all seven (→ 404, so the family
is not an existence oracle), write permission is re-checked on all seven (→ 403), and ⚠ **every git fetch
goes out under the CALLER'S OWN token**, into a ref namespaced by session id
(`fetchRefIntoClone`, review/clone-manager.ts). That last property was incidental under one account
and is now LOAD-BEARING: the clone cache is keyed `owner__name` and shared across tenants, so it
holds OBJECTS, never permission — a tenant who cannot read a private repository cannot fetch from
it, whoever else has already cloned it. `conflicts-cloud.test.ts` pins all of it; it used to assert
the resolver's paths 404 in cloud and was INVERTED rather than deleted, because this is the moment
that proof has to get stronger.

**Two caps, two sentences, and neither names another tenant.** A resolver job is a clone, two
fetches and a merge-tree. ONE running job per ACCOUNT ("you're already resolving another pull
request"), and a small global ceiling on top ("the service is busy") — computed inside the same
SYNCHRONOUS claim window as the per-PR slot, with ⚠ **no `await` between the check and the write**,
or two POSTs a tick apart both claim. ⚠ **The two refusals are not one sentence with a variable in
it.** The predecessor was a single process-global cap of 2 whose own comment reasoned from "the
LOCAL mode's single account", so in cloud one tenant opening two resolvers told every other tenant
that *"Two pull requests are already being prepared"* — false about their work, and a disclosure
about somebody else's.

**The entry is click-gated and fetches nothing.** `ResolveConflictsButton` is the ONE entry, mounted
on three surfaces (the PR pane's Conflicts row, `MergeControl`'s expanded conflict box, the Pending
`conflicts` card) and re-implemented by none of them. Its gate is `conflictResolverEntryVisible` over
four already-synced facts — the PR is open, the resolved `mergeVerdict` says `conflicts`, the viewer
can push, and `/api/me` says the resolver exists here — plus the App-root `['me']` cache, so fifty
cards on a board issue zero requests. ⚠ **HIDE, never disable**: a reader without push access sees
the surrounding sentence and its GitHub link, which is what the row was before the button existed.
Everything expensive happens on the click.

**Three panes, and the merge base is not one of them.** LEFT is the PR branch ("Your version"),
RIGHT is the base branch ("Changes from `<base>`"), CENTRE is the result — seeded from the merge base
and changed only by per-region decisions. The ancestor is a popover (`BasePopover`), because it is
the thing the other two are both changes TO rather than a fourth option.

**Nothing is applied until the reader presses something.** The SPA opens every session with
`autoApply: false` — on BOTH open arms in `hooks/useConflictSession.ts`, because `claimSession`
re-attaches a LIVE session and ignores the flag on that path — and there is no client-side seeding
pass either: `autoApplyMoves` is DELETED and must not come back. The centre pane therefore opens
with no wash at all and every decidable region reads "Needs a decision". ⚠ **The server knob stays**
— `ConflictOpenBody.autoApply` and `defaultDecisionFor` are untouched; what changed is the value the
SPA sends, which is now the contract. ⚠ **Do NOT bump `CONFLICT_MODEL_VERSION` for it**: `autoApply`
changes which decision a region STARTS on, not what the region IS, which is exactly why `hash.ts`
leaves it out of the model hash — a defensive bump would throw away every live session's decisions.

**The commit is HARD BLOCKED until every decidable region in every supported file is decided.**
`CommitPlan.canCommit` (`lib/conflictCommit.ts`) is the ONE gate, folded ONCE in the shell and handed
down to the panes, the landing step, the footer, the close confirm and the result panel, so no two of
them can disagree. `outstanding` is every supported file with an unanswered region, counted off the
MANIFEST's `decidableCount` so a file nobody opened still blocks, and the landing step lists each as
a `<button>` that jumps to that file's first unanswered region. ⚠ **A half-decided file is no longer
dropped from the commit and labelled "Still conflicted"** — nothing is excluded from a commit without
the reader choosing it. ⚠ **"Still conflicted" is `CommitPlan.notCarried`, which is NOT "the
unsupported ones"**: a SUPPORTED file whose regions all came out `unchanged` (a mode-only conflict,
say) is dropped from the commit too, and narrowing that list to `state === 'unsupported'` put it
nowhere on screen at all — the same silent exclusion one class over. ⚠ The one counter is
`decidedTotal` / `decidableTotal`, every DECIDABLE region across the pull request; the file menu's
trigger, its rows and the toolbar countdown all fold through it, and the wand's own sentence is per
FILE over CONTESTED regions and says "in this file" for exactly that reason. ⚠ The route's
`IncompleteDecisions` stays as the second line of defence — a client gate is never the gate.

**BOTH BUTTONS ARE SHUT, AND ONE FOLD SAYS WHY.** The toolbar's button says **"Commit and push"** —
the same words as the landing step's, deliberately: one is the entry to the press and the other is
the press, and they are told apart by their ACCESSIBLE NAMES (`COMMIT_ENTRY_NAME` /
`commitPressName`), never by diverging labels. Both are disabled by
`commitBlockedReason(plan, headMoved)` (`lib/conflictCommit.ts`), which returns null exactly when
`plan.canCommit && !headMoved` and otherwise returns the ONE sentence both of them print. ⚠
**`headMoved` is NOT in `canCommit` and must not be folded into it** — the plan is a pure fold over
the session and the reader's decisions, while the head moving is a fact about GitHub the shell
observed. ⚠ **`Enter` on the panes container is the same door and carries the same lock**: it
announces the reason instead of landing, because a gated button with an ungated keystroke beside it
is a bypass, not a shortcut. ⚠ The landing step keeps two clauses of its own — the branch-name
refusal (which prints beside the field it is about) and a push already in flight — and the toolbar,
which has neither, must not be shut by them.

⚠ **THIS REVERSES "Continue is deliberately NOT disabled"**, which held because pressing it was the
only route to the list explaining the block. The list moved: the toolbar's "N of M changes decided"
counter is now a popover (`OutstandingPopover`) carrying the blocked sentence and the SAME per-file
rows, each a `<button>` that jumps to that file's first unanswered region. ⚠ `notCarried` — what the
commit will not carry — is still rendered only on the landing step, and every unsupported file is
listed with the server's own noun phrase in the FILE MENU, so nothing went out of reach behind the
shut button. ⚠ **"Next" jumps to the next file that still needs decisions** (`nextOutstandingFile`:
it walks `outstanding`, not the manifest, and WRAPS) and is ABSENT rather than disabled once there
is nowhere to jump — including when the only outstanding file is the one the reader is already in,
where the jump would land them where they are. The chevrons still page the manifest and were
re-worded to "Previous/Next file in the list", because two controls announcing as "Next …" is the
duplicate-verb problem the gutter arrows already cost us; `n`/`p` still walk REGIONS within a file.

**The ribbons: one filled bezier per side that actually put content into the result**
(`components/conflicts/RegionRibbons.tsx`), drawn across the 1.75rem gutter track from the accepted
hunk's near edge to the centre hunk's, in the applied GREEN — **one class, `.mr-fill-applied`**,
because a ribbon joins an accepted side (green) to the result (green) and a type-hued band between
them read as a third, different thing. `ribbonSides()` (beside `panePaint`, so the two cannot
drift) is the rule: `ours` → left, `theirs` → right, both-orders and wand/suggestion → both, and ⚠
**`base`/ignored, UNDECIDED and `edited` draw nothing at all** — that is where it still differs from the
wash, which paints every OFFERED side of an undecided region (`sideOffered`) in the conflict type;
a ribbon claims content reached the result, which nothing has yet. ⚠ It reads `sideOffered` too, so
a ribbon can never leave a pane the wash left bare. ⚠ **THE OVERLAY ONLY EVER READS GEOMETRY**: it holds no React
state, never writes `scrollTop`, never calls `focus()` and gives no pane a scroller of its own — it
is a read-only exception to the one-scroller invariant below, built the way
`Timeline/index.tsx`'s `drawCrossConnectors` is (imperative SVG into a `DocumentFragment`,
`replaceChildren`, rAF-coalesced, `pointer-events: none`, `aria-hidden`). Cell rects are cached in
CONTENT coordinates on a structural change only, so a scroll frame is arithmetic and no
`getBoundingClientRect()` at all; a region fully off the page is culled on the UNION of its two
boxes, and one whose far end has scrolled past the fold is drawn in full and CLIPPED, never
clamped. ⚠ **`.mr-ribbons` carries no z-index on purpose** — positioned at z-index `auto` it paints
under the panes' sticky `z-10` headers. ⚠ **`CONFLICT_MODEL_VERSION` IS NOT BUMPED FOR ANY OF
THIS**: it pins what bytes a decision produces, and a shape over the gutter produces none.

**Hunk-level accept/ignore, plus ONE text box — and the invariant it retracts is narrower than it
looks.** `ConflictDecision` is a closed enum — `base` · `ours` · `theirs` · `both_ours_first` ·
`both_theirs_first` · `disjoint_merge` · `suggestion` · `edited`. This page used to say "there is no
typing anywhere" and "there is no `custom` member and there must never be one". Read what each half
of that was protecting:

- **WHAT MOVED.** `POST …/conflicts/edit` takes the lines a reader typed for ONE region. It is
  scoped to DECIDABLE regions (`unchanged` context refuses with `not_editable`), pinned by the
  region's `fingerprint` as well as its id, and VALIDATED BEFORE AN ID EXISTS — no NUL, no lone
  surrogate, no surviving conflict marker, and at most `CONFLICT_SUGGEST_MAX_CHARS` (one budget for
  both text ingresses). A refusal mints nothing AND DESTROYS NOTHING: the budget is summed without
  mutating, or a save that overran the cap took the region's previous accepted edit with it.
- ⚠ **THE REGION'S TWO INVISIBLE BYTES ARE INHERITED, NOT READ BACK OFF THE WIRE** (`editShapeFor`).
  A textarea's API value normalises every CRLF to a bare LF before React sees a keystroke, so one
  character typed into a Windows-authored file rewrote the WHOLE hunk's line endings — every line of
  the diff changed, and a genuinely wrong file in any repo carrying `* text eol=crlf`. And the BOM
  that `model.ts` deliberately KEEPS as a character (`ignoreBOM: true`) made the first region of
  every BOM file refuse `not_text` for ever, over a zero-width character the sentence told the
  reader to retype. So: the region's own line ending is re-imposed when its evidence is unanimous,
  and one LEADING U+FEFF is allowed and re-attached when this region is where the file's BOM lives.
  U+FEFF anywhere else is still `not_text`, and `validateConflictSuggestion` — whose input is MODEL
  output — is untouched.
- ⚠ **A SUPERSEDED HANDLE IS NEVER EVICTED**, `storeSuggestion`'s rule. Re-saving a region used to
  delete its previous edit on the argument that "a region has one current text" — true of the
  region, false of the handles pointing at it. The undo stack files `previousEditId`, so a second
  save plus one Ctrl+Z restored an id the server had just destroyed: the pane went on rendering the
  region decided (its line map is append-only) and the WHOLE commit came back `UnknownEdit`, naming
  no file and no region. Two tabs on one PR did it across the process.
  `MAX_EDIT_CHARS_PER_SESSION` is the bound.
- **WHAT DID NOT.** The COMMIT body still carries nothing but indexes, ids and enum members.
  `'edited'` travels as an opaque `editId` exactly as an accepted Pro suggestion travels as a
  `suggestionId`; the server re-folds its OWN regions through `foldFile` and hashes the result. So
  the property that mattered — **the server commits only bytes it folded, from a request that names
  no content** — is unchanged. A `custom` member carrying its lines inline is still forbidden, and
  for that reason.
- ⚠ **`CONFLICT_MODEL_VERSION` IS NOT BUMPED FOR IT, AND THAT IS THE REASON EDITING IS SCOPED THE
  WAY IT IS.** The test is "does this function's output change for a given input"; no input that was
  previously possible can contain a member that did not previously exist, and `hash.ts` covers
  neither `region.allowed` nor `defaultDecision` — the only two things a new member touches. A
  defensive bump would throw away every live session's decisions. Same argument as `autoApply` and
  the ribbons.
- ⚠ **VALIDATION DELIBERATELY OMITS THE SUGGESTION VALIDATOR'S CHECKS 6, 7 AND 8** (context not
  repeated, common lines kept, side lines kept). Those exist because a MODEL silently drops lines it
  was not asked to drop. A person deleting a line is the feature — an empty box is ZERO lines, which
  is how a whole hunk gets deleted.
- ⚠ **AN EDITED REGION'S CENTRE IS GREEN AND NO RIBBON LEAVES IT.** Both sides paint nothing and
  `ribbonSides` returns none, because the text came from neither pane and a ribbon would claim a
  correspondence nothing can state. The strip's word, `Your text`, is what says whose it is.
  Undo clears it like any other decision.
- ⚠ **THE UI IS A PANEL UNDER THE CENTRE CELL, NOT A `contenteditable` AND NOT A TEXTAREA REPLACING
  THE CELL** — the slot `HunkSuggestionPanel` already uses. That keeps `data-mr-cell` on a
  content-sized box (so ribbon geometry never learns about it), keeps `CodeCell` a pure memo with no
  local state, and keeps hljs output out from under a caret. The draft is RENDERED in the panel and
  REMEMBERED in `useRegionEdit`'s ref, keyed `${fileIndex}:${regionId}`; the store holds the handle;
  `useRegionEdit`'s module map holds the saved lines, keyed by SERVER session, because
  `ResolverPanes` unmounts the moment the toolbar's "Commit and push" is pressed.
  ⚠ **EVERY ROW IS KEYED BY FILE AND REGION.** Region ids restart at 1 in every file and the grid is
  the same element across a file switch, so a bare `key={region.id}` reconciled file A's row with
  file B's — and the panel at its fixed child slot came back holding file B's text under file A's
  fingerprint. ⚠ **AND THE BOX IS `readOnly` WHILE SAVING, NEVER `disabled`**: a browser blurs a
  disabled element, so the caret vanished exactly when a refusal asked the reader to fix their text.
  Focus goes back to the control the box was opened from, because `document.body` is outside `#root`
  and every single-key verb in the panes dies there.
- ⚠ **`Escape` BELONGS TO THE INNERMOST THING OPEN, AND REGISTRATION ORDER IS NOT A MECHANISM**
  (`popoverLayer.ts`). The shell's handler is added on MOUNT, so it won the race against every
  popover and its `stopImmediatePropagation` meant no later `window` listener ever ran — Escape on
  the file menu, the compare-base popup or the counter's list closed the WHOLE RESOLVER, and killed
  floating-ui's own `document`-level dismiss with it. The three popovers now take the key through
  one counted hook and the shell stands aside while any of them is open.
- ⚠ **`ResolverPanes.onKeyDown` RETURNS FOR A FIELD BEFORE THE SINGLE-KEY VERBS**, and that guard is
  now load-bearing rather than defensive: the textarea is inside the scroller, so `b` would
  otherwise take both sides of the region being edited and Enter would leave for the commit step.
  `resolverControls.test.ts` pins both its existence and its position.

**The wand NEVER picks a side.** `ConflictWandReason` has exactly four members — `only_ours`,
`only_theirs`, `both_same`, `disjoint_words` — and ⚠ **there is deliberately no member meaning "we
picked the better one"**, because it never does. It settles a region only when one side changed it,
or both made the identical edit, or the two edits are provably disjoint at word level; a genuine
contest is left alone. The reason rides every region it touches so it can say exactly what it did,
and ⚠ a decision the reader already took is never overwritten — it is an accelerator, not a reset.
⚠ The disjoint merge's LINES ride the wire (`ConflictRegion.mergedLines`), because a client that
recomputed them computed something else: cross-checked over 4,000 generated three-way regions, the
SPA's second implementation dropped every pure insertion and rendered the ancestor for a region the
commit landed merged. `packages/shared/src/conflict-fold.ts` is the ONE fold, called by the centre
pane and by the land route, which is what makes "what you saw is what lands" structural.

**The per-file workflow.** The session is a MANIFEST — files, counts, pins, landing options — and
carries no regions: a thirty-file conflict with regions inline is a multi-megabyte payload on every
progress frame. One file's regions arrive on selection. A file the model cannot represent (binary,
submodule, symlink, file/directory, rename/rename, rename/delete, modify/delete, mode-change,
non-UTF-8, too big, too many conflicts, no shared history, engine disagreement, budget exhausted) is
⚠ **listed and DISABLED, never hidden** — an unlisted file is why the PR stays conflicted after a
commit with nothing on screen to explain it. Each carries a NOUN PHRASE naming the reason, and the
panel states the instruction once above the list. A commit may be partial — but only because of these files,
since every SUPPORTED file must be fully decided before the button goes (see the gate above);
`stillConflicting` says so and the PR stays conflicted.

**Landing: merge or rebase, and rebase is single-commit only.** `merge` builds a two-parent commit
when every conflicted file was resolved and a one-parent commit when it was partial — ⚠ **a partial
resolution is NOT a merge commit**, because saying "the base branch landed here" in the commit graph
is a lie the next merge acts on. `rebase` is offered only when `commitsAboveBase === 1` and every
conflicted file is resolvable here, and it is built with `commit-tree -p <base>`: ⚠ **no `git rebase`
process ever runs**, there is no multi-stop path and no `RebaseStalled`. Above one commit the server
withholds it and says why in one sentence the SPA renders verbatim. The target is the PR's own branch
or a new one; ⚠ **a fork PR whose author did not allow maintainer edits has no PR-branch option at
all** — `ConflictSession.prBranchPushable` (one live `fetchPrHeadInfo` at session build, non-fatal,
defaulting TRUE) hides it and pre-selects the new branch. It is an affordance, never the
authorisation: the land route re-reads the same two fields milliseconds before the push and answers
`PushDenied`.

**The pins are what make a stale commit refuse.** Three of them ride the session and are echoed on
the commit body: `headSha`, `baseSha`, and `modelHash` — a sha256 over the canonical model
serialisation with ⚠ **`CONFLICT_MODEL_VERSION` folded in**, so any change to the fold or the chunker
that alters output for a given input MUST bump it in the same commit (the same self-executing
discipline as `PERIOD_METRICS_SCHEMA_VERSION`; the failure is silent — a stale session lands bytes
the reader did not choose). A moved head is `HeadMoved`, a moved base `BaseMoved`, a differing hash
`ModelStale`, and nothing is written in any of the three. The land path re-derives the model behind
the lock and re-checks ownership, `WRITE_PERMISSIONS`, PR state and head sha immediately before the
push, so the window between the checks and the irreversible half is milliseconds — the
`auto-merge-runner.ts` land-time pattern. ⚠ **An armed "merge when ready" intent is DISARMED first,
and not for tidiness**: a merge-strategy resolution commit has exactly the two-parent shape
`isOurUpdateMerge` proves against, so a live intent would ADOPT it, re-pin to it, and land code the
reader never consented to merge.

**Nothing is stored.** No table, no migration, no journal entry, no `accountScopedTables()` entry,
nothing in `localStorage`. The reader's typed edits are held in the same module-level session and
die with it, bounded by a per-session character budget (64 × `CONFLICT_SUGGEST_MAX_CHARS`) with one
live edit per region — re-saving REPLACES, so the store is bounded by region count rather than by
keystrokes. The server session is a module-level `Map`, bounded four ways —
a 30-minute idle TTL, a **4-hour absolute lifetime `touch()` cannot extend**, and retained-record
caps of **3 per account / 24 per process** (LRU eviction of a SETTLED record, this account's share
first). ⚠ **The TTL alone bounds nothing**: every manifest read touches, the SPA polls the manifest
for as long as the overlay is mounted, and each retained record holds a whole `ConflictModel` — up
to `CONFLICT_MAX_TOTAL_BYTES` (8 MiB) of file text — in a process every tenant shares. The
client keeps decisions in `store/conflictResolver.ts` under a key pinned to
`(prId, headSha, baseSha, modelHash)`, so a moved head simply does not find them. ⚠ The reflex in
this repo is to add a table; here it is wrong — the model is source code, it is pinned to two SHAs,
and it is worthless the instant either moves. ⚠ **Shipping in cloud does NOT change this.** A
redeploy loses every session and that is correct, not a gap to close: a row that survived a restart
would survive into a world where the push it describes may be wrong, and the reader's decisions are
in the SPA's own store under the pinned key already.

**A cut stream is not a lost session, and that took a fix.** ⚠ **Railway ends every HTTP request at
15 minutes; a session lives 30.** So a reader who took their time got the SSE stream cut at minute
15, pressed Commit at minute 16, the route answered 202 and PUSHED, and not one phase frame came
back — the overlay sat on "Starting…" forever while **the push may well have landed**. The recovery
channel already existed: the manifest GET returns the whole commit state, is a Map lookup on the
`read` tier, and `touch()`es the session. So when the stream ends and the overlay is still open the
SPA POLLS it (2s while a job runs, 8s otherwise) — no new route, no wire change, and ⚠ **not a
reconnect**: re-running the open would spend another clone and a new stream would be cut at the same
15 minutes. Only a 409 is terminal; a 502 from the same proxy is a blip. ⚠ **When the session IS
gone mid-commit the copy follows the `visible` contract to the letter**: it says the resolution was
sent and names where the answer is, it NEVER says it failed, and it offers **no retry, because a
retry is a second push**. Closing from that state closes as *committed*, so the reopen toast cannot
say "nothing pushed".

**A redeploy must not kill a push in flight.** The process's one `SIGTERM` handler (`index.ts`)
refuses new claims, waits for running jobs to reach zero or 120s (the timeout on a single git
subprocess), then closes. ⚠ **It exists for the in-flight push and nothing else** — it does not
preserve sessions and must not grow into something that does. It cannot hang: the drain is bounded,
and `app.close()` gets its own short deadline because the resolver's SSE sockets are HIJACKED and
Fastify's close does not force those shut. A second SIGTERM is logged and ignored rather than
escalating, because escalating would kill the push the handler exists to protect.

**The clones are swept on a clock now.** Every opened resolver fetches two refs into the shared
clone and ⚠ **only the COMMIT path deletes them** — so a reader who opens the resolver, looks, and
closes the tab leaves two refs pinning objects, and until now the only thing that collected them was
the next restart. `conflict/janitor.ts` runs quarter-hourly (`CONFLICT_JANITOR_CRON`, in
`sync/scheduler.ts` beside `retentionCron`): per clone, SEQUENTIALLY and under the SAME
`withRepoLock` a resolver takes, it deletes every `refs/pierre/conflict/<id>/…` whose session is not
in the live map, runs `git gc --prune=now` past a loose-object threshold, then the existing LRU. ⚠
**It must exclude live sessions** — at boot every conflict ref is an orphan by definition, but a
running process has sessions sitting at `ready` whose commit re-reads those refs. ⚠ **Do not
parallelise the loop**: MEASURED, 16 concurrent `git config` calls took 1,779ms against 131ms for
one. The cloud operational picture — the ephemeral disk, why there is no Railway volume, and the
drain window — is in [docs/DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md).

**No worktree, at any phase.** `merge-tree --write-tree` performs a full three-way merge with no
index and no working tree; the oracle cross-check runs `merge-file` over three loose files in
`os.tmpdir()`. That makes the resolver immune to the worktree defect classes rather than dependent
on their fix, and it is why a session costs nothing to hold open. ⚠ **No git 2.40+ flags** either —
no `merge-tree --merge-base=`, no `-X ours|theirs`, no `merge-file --object-id`; the cloud image is
on 2.39.5 where all three exit 129 — which is now a live constraint rather than a hedge against a
later port. ⚠ **"No worktree" is about WORKTREES, not clones.** It does clone: `buildConflictModel`
and the land path both go through the shared `ensureClone`, blobless and checkout-less. Measured
worst case for one clone is 111 MB; a cold clone is 3.6s (bevy) to 13.7s (golang/go).
The one floor is 2.38 for `--write-tree`, probed once and refused as `git_too_old` at the open route.

Routes and tiers: [docs/API.md](API.md). The SPA's landmines, the `--mr-*` palette and the two
defects found by running it: [docs/FRONTEND.md](FRONTEND.md) § The merge-conflict resolver. The
clone-cache hardening it rests on: [docs/SECURITY.md](SECURITY.md).

### Merge queue (GitHub's native)

`fetchMergeQueueState` / `enqueuePullRequestOnQueue` / `dequeuePullRequestFromQueue` are the
one place `github/mutations.ts` **forks from its REST house style**, and it has to:
`enqueuePullRequest`/`dequeuePullRequest` are GraphQL-only with no REST equivalent, and queue
presence is not inferable from REST at all — `MergeStateStatus` has no QUEUED value, so a queued
PR looks like any other blocked one.

**MEMBERSHIP AND ENTRY STATE ARE NOW SYNCED COLUMNS; POSITION AND ETA STAY LIVE-ONLY.**
`pull_requests.in_merge_queue` + `merge_queue_entry_state` ride the normal walk (and the
`/api/attention/liveness` sweep) onto `InsightPrRef` and `PrDetail`, because two surfaces that may
NOT fetch — the Pending board and the PR pane's Overview row — otherwise offer a Merge button
GitHub will refuse on a PR it is already landing. ⚠ **THREE STATES**: `true` / `false` (both
positive statements from GitHub) and `null` = NOT OBSERVED, which may never render as "not
queued". ⚠ `unmergeable` is the member that earns the state column — GitHub is EJECTING the entry,
which is what a reader could previously only discover by pressing Merge and reading the failure;
`pendingQueueBadge` (exported from `Activity/AttentionCards.tsx`) is the ONE place those five
sentences are written, and the PR pane imports it rather than re-wording them. Position and
`estimatedTimeToMerge` genuinely do change minute to minute and stay on the lazy `merge-options`
fetch, which is why the queue chip states neither. When a queue
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
   for and lets a later tick prove the move via (2).
   ⚠ **The record is the `update_issued_against_oid` COLUMN, not the `pendingUpdates` Map.** The
   Map was the only record until sqlite `0061`/pg `0048`, and losing it on a restart did not read
   as "I forgot" — it read as an unexplained head move, whose safe answer is to disarm. Under
   `pnpm dev` that is every file save and in cloud every deploy, so an unrelated code push could
   kill an intent with a message blaming the user's branch. The Map survives only as a **freshness
   hint** (TTL 15 min); when it is empty the column still proves the SHA and the three GitHub-side
   proofs in (2) are what actually establish the commit is ours.
4. **Retarget guard** — a `PATCH pulls/{n}` base change leaves `head.sha` alone, so the head pin
   is blind to it, so the runner compares the live base against the branch the user consented to
   and disarms on a mismatch (waiting, not merging, when it can't tell).
   ⚠ **That branch is `expected_base_ref`, PINNED AT ARM TIME** (same migration). It used to be
   the SYNCED `pull_requests.base_ref_name`, re-read every tick — a column the sync owns and may
   rewrite at any moment, so a walk that corrected it reported a retarget nobody performed. Rows
   armed before the column existed fall back to the synced value, exactly as before. The arm route
   already fetches the live base (it refuses to arm when the two disagree), so the pinned value is
   GitHub's own answer at the moment of the click, not a lookup that can change underneath it.
5. **COMPARE-AND-SET immediately before the merge** — everything above acts on a scan snapshot
   that can be minutes old; a user who hit Cancel mid-tick DELETED the row, and merging anyway
   would leave the UI saying "cancelled" for a PR that landed.
5b. **A merge-queue refusal that names an unfinished check is a WAIT, not a failure**
   (`isWaitableEnqueueRefusal`). `enqueueWhenReady` used to gate on `reviewDecision` alone, on the
   belief that checks never gate entry ("AWAITING_CHECKS is a normal entry state; the queue runs
   them itself"). That is true of a queue configured to run its own checks and **false of a branch
   whose protection requires them first** — and on the reporting account it was false: **3 of 21
   armed intents died**, two of them refused purely because CI was still running
   ("Pull request 2 of 3 required status checks are in progress"). The throw reached the tick's
   strike counter and three strikes at a two-minute tick killed the intent **~6 minutes after the
   user armed it**. Now a refusal naming an unfinished or failing required status check parks the
   intent at `awaiting_checks` and costs no strike.
   ⚠ **The first attempt is ALWAYS made.** Refusing to ask when GitHub says `blocked` would
   deadlock a repo whose queue runs the checks — `blocked` is exactly the state entering the queue
   clears. Only after a refusal does the runner stop re-asking, and only while `mergeableState`
   still says `blocked`.
   ⚠ **`MAX_CONSECUTIVE_FAILURES` was not consecutive.** `failureCounts` was cleared only by
   `forgetIntent`, i.e. only on a terminal state, so three unrelated transient errors over three
   days killed an intent that succeeded on every tick between them. A clean pass now clears it,
   and the budget is 8 (~16 min) rather than 3 (~6 min) — shorter than a CI run, a rate-limit
   pause or a deploy blip.
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

#### The per-repo landing queue — rule 8 (`db/merge-queue.ts`)

**Arming five bumps on one repo used to be BROKEN, not merely slow.** `freshenedIntents` was
once per intent **LIFETIME** (cleared only by `forgetIntent`, i.e. only on a TERMINAL outcome),
so: all five freshened from trunk at once, #1 merged, **the trunk moved**, and #2–#5 were behind
again with their one freshen already spent. Two failure modes, depending on how GitHub words the
block — and both fixed here:

- `mergeStateStatus === 'behind'` still re-freshens (`blockedByBehind` bypasses the mark), so the
  batch churned: **N(N+1)/2 branch updates and CI runs for N PRs**, each racing the next merge.
- anything else that is really "out of date" (a repo that reports `blocked` while `behindBy > 0`)
  went through `couldFreshen`, which the mark gates — so those intents were **stranded at their
  blocker until the 72-hour expiry**, having updated exactly once, against a trunk long gone.

The fix, per `(accountId, repoId)` — ⚠ **the composite key, never `repoId` alone**: two accounts
can track the same repo, and a repoId-keyed group would serialise one tenant's landings behind
another's:

1. **Armed DIRECT-merge intents form a FIFO ordered `armedAt ASC, id ASC`** — click order. ⚠ The
   id tiebreak is load-bearing: sqlite stores these timestamps as **unix SECONDS**, so one
   click-through gives every intent the same `armedAt` and the autoincrement id is the only
   surviving record of the order the feature promises to land them in.
2. **Exactly ONE intent per repo holds the SLOT.** Only the slot-holder may freshen, enqueue or
   merge; the rest record phase **`queued_local`** and their place ("waiting its turn — 2nd of 5
   armed on acme/api"). ⚠ **`queued_local` ≠ `queued`**: the latter means GitHub has the PR in a
   merge queue and is testing it. Two queues, two sides of the network, and the copy must never
   merge them.
3. ⚠ **RULES 1–4 STILL RUN FOR EVERY INTENT — this split is the crux.** Expiry, a closed/merged
   PR, a head move and a retarget resolve on the tick that observes them, slot or no slot. Parking
   a gone-bad intent behind a slot-holder for hours is the same starvation the queue exists to
   prevent, reintroduced one level up. Only the freshen/enqueue/merge half is gated.
4. ⚠ **`viaMergeQueue` intents are excluded from all of it — BY THE LIVE QUEUE VERDICT, NEVER THE
   STORED FLAG.** GitHub already serialises them; a second queue in front would halve throughput
   for nothing. A genuinely queued intent gets `holdsSlot: true` with a null position, so the wire
   fields stay absent and "freshen once BEFORE the first enqueue, never while queued" is
   untouched. ⚠ But the runner re-verifies the queue live each tick, and an intent whose queue was
   **DISABLED since arming falls back to the DIRECT merge** — which is exactly the action rule 8
   serialises. Exempting it off the stored flag merged a second PR on the repo **in the same
   tick** as its actual slot-holder. So the first tick that observes the queue gone only
   re-classifies the intent (mark `queueDisabled`, park at `queued_local` with a reason that says
   so); the next fold puts it in the direct FIFO and it lands from its place there.
5. **HEAD-OF-LINE: a slot-holder the watcher CANNOT ITSELF UNBLOCK yields**, exactly as a merge
   queue ejects a failing entry — it needs its author, not a turn. It stays **ARMED** and **keeps
   its FIFO place**; the mark clears on any tick that observes the blocker gone, and it is the
   slot-holder again on the next one. **TWO blockers qualify, and they are separate sets so the
   copy can tell them apart:**
   - **failed required checks** — ⚠ decided on a **LIVE** read (`fetchPrHeadCheckRollup`, one
     GraphQL point), never `syncedCiStatus`: that column is fine for LABELLING a wait, but
     yielding re-orders the user's clicks and is not a call to make on sync-stale data. A null
     rollup is UNPROVEN and never yields. This is the one that sets the wire's
     `yieldedForFailedChecks`.
   - **conflicts** — ⚠ they DO yield, and the reasoning that said otherwise ("the fix is a push,
     a push moves the head, rule 1 frees the slot next tick") assumed an author action that may
     never come. A conflicting slot-holder can never be landed by the watcher, so holding the slot
     for it parked every other armed PR on that repo **until the 72-hour expiry** — a REGRESSION
     against no queue at all, where the clean PR behind it merged immediately. Free to detect:
     `mergeable === false` is already in the snapshot every intent pays for.
   ⚠ **A yield is only ENTERED when there is somebody to yield TO** (`slot.canYield` — another
   direct intent that has not itself stepped aside), which is also what stops the paid rollup read
   from repeating every tick on a repo where everything is red. ⚠ And when **EVERY** direct intent
   has yielded, **the first one keeps the slot**: handing it over merges nothing (the runner
   re-reads a live snapshot and parks on the same blocker), while having NO holder left a lone
   yielded intent claiming it was "letting the next armed PR through" with no next armed PR, and
   unable to reach the branches that report its real state.
6. ⚠ **A WAITER'S OWN BLOCKER OUTRANKS ITS POSITION.** The rule-8 park writes the place in line,
   but never over the truth: a waiter GitHub reports as conflicting keeps phase
   `waiting_conflicts` (one of the banner's STALLED phases) with the position in its prose
   ("waiting: conflicts with main — 2nd of 2 armed on acme/api"). Overwriting it with
   `{queued_local, "waiting its turn — 2nd of 2"}` was true, useless, and *calmer* than the truth:
   a PR that cannot land in any position read as ordinary progress.
7. **THE FRESHEN FIX: a LANDING clears every other armed intent's freshen mark on that repo**
   (`clearSiblingFreshenMarks`, called from all three landing observations — our merge, our queue
   entry merging, and a merge we merely observed). The trunk they were freshened against just
   moved; who moved it is an attribution question, not a freshness one. That makes the mark mean
   "freshened against the CURRENT trunk" instead of "freshened, ever" — **N branch updates and N
   CI runs for N PRs, in click order**.

**Where it is computed, and why not on the row.** `listArmedMergeRequestsForRunner` is LIMITed to
one tick's GitHub budget (25, LRU), and **a queue position cannot come from a partial scan** —
"2nd of 5" is a fact about all five rows. So the order rides its own tiny UNLIMITED read
(`listArmedIntentOrder`: five scalar columns, one join, no GitHub), folded by the pure
`buildArmedRepoQueues`. The runner derives it once per tick and **sorts slot-holders first** in
the page it works (stable sort, so the LRU fairness rotation survives inside each half and a
slot-holder outside the page is picked up by that same rotation next tick). The routes derive it
per request and decorate the wire with `withArmedQueueFields`; nothing is stored, because the
order changes whenever anyone arms or cancels and a stored position would be wrong for every row
but the one the watcher last touched.

**`queuePosition` / `queueDepth` / `yieldedForFailedChecks` are TRAILING OPTIONALS** on
`ArmedMergeRequest`, populated by all three builders (`GET /api/auto-merge`, the arm POST's
response, `GET …/merge-options`). Absent on every terminal row, on every `viaMergeQueue` intent,
and when the yield flag is false — a client that has never heard of them renders exactly what it
did before. `AutoMergeBanner` reads them for the `queued_local` headline ("Waiting its turn — 2 of
5 on this repo"; a yielded row says "checks failed, letting the next PR through" and takes the
STALLED tone, since same phase / two very different states). ⚠ **`yieldedForFailedChecks` is set
by that reason ALONE** — a CONFLICT yield carries its own truthful phase instead, and flagging it
here would put "checks failed" over a PR whose checks are fine. ⚠ **A WAIT NEEDS SOMEBODY AHEAD:**
the headline phrases a position only when `queuePosition > 1`. `phase` is whatever the watcher last
STORED (up to a tick ago) while the position is recomputed LIVE per request, so the slot-holder
merging inside the same tick that parked a row left the card reading "Waiting its turn — 1 of 1 on
this repo" for two minutes; position 1 falls through to a neutral "Next up on this repo". **No migration was needed**: `phase`
is a plain `text` column in both dialects (sqlite `0055` / pg `0042` add it with no CHECK), and
drizzle's `text(..., { enum })` is TypeScript-only metadata.

**The three marks live in the runner's process memory** — `yieldedForFailedChecks`,
`yieldedForConflicts` and `queueDisabledIntents` — alongside `failureCounts` / `pendingUpdates` /
`freshenedIntents` and dropped by the same `forgetIntent`. A restart forgets a yield, the intent
takes its slot back, re-observes the failure and re-yields — one wasted tick, never a merge nobody
asked for. The fold and the routes read all three through the runner's `armedQueueMarks()`
accessor (one `ArmedQueueMarks` object, so a fourth mark is a field rather than another positional
parameter), which is why `api/routes/prs.ts` imports the runner: every one of them is a LIVE
observation of GitHub made inside the tick, so the runner is the only thing that can own them.

**`phase` — the machine-readable half of `lastReason`** (shared `ArmedMergePhase`, a nullable
column on `auto_merge_requests`, sqlite `0055` / pg `0042`). `lastReason` is PROSE for a human
and is **NULL at success**, so a cross-PR surface reading it alone would be string-matching a log
line that goes blank exactly when it matters. Every watcher write therefore sets phase and prose
in the SAME `updateAutoMergeState` call — they cannot disagree — and the rules are:

- **It describes a LIVE intent only.** Every terminal outcome is already an `ArmedMergeState`
  member, so `resolve()` (and both merged landings) CLEAR it; a finished card renders off
  `state`. Duplicating terminals here would give one row two contradicting lines.
- **Null is a legitimate value**, meaning "this wait can't be honestly characterised" — an
  unknown `mergeableState`, an unconfirmable base. The client falls back to `lastReason`. Never
  invent the nearest member for a row the user has to act on.
- **`'blocked'` is disambiguated from the ALREADY-SYNCED CI status**, never a new fetch: GitHub
  collapses "required checks running" and "required reviews missing" into one `mergeableState`
  with nothing else on the payload to separate them, so `pullRequests.ciStatus` ∈
  {`pending`,`expected`} ⇒ `awaiting_checks`, anything else ⇒ the generic `blocked_protection`.
  Advisory only — it never gates a merge. Derive behind/blocked from `mergeableState`, never
  `behindBy` (the landmine above).
- **`'merging'` / `'enqueuing'` are stamped BEFORE the irreversible call**, so the row is honest
  for however long GitHub takes and never blank at the moment of success.
- **An IN-FLIGHT phase must not outlive the operation it names.** `'updating_rebase'` follows the
  same before-the-call rule (the clone-based rebase runs for tens of seconds; the SPA re-reads the
  row every 8s), but the write that lands AFTER it returns stamps `'awaiting_checks'` — the same
  phase as the native update's re-pin, whose prose is its twin. Leaving `'updating_rebase'` on the
  finished row span a "Rebasing onto the base branch…" spinner over a row whose own `lastReason`
  said it was waiting for checks: phase and prose contradicting each other is the ONE thing this
  column exists to prevent. (`'updating_merge'` is the exception that proves it — GitHub's
  update-branch really IS still running when that row is written.)
- `armAutoMerge` writes `'pending_first_check'` at arm AND re-arm (beside the `lastCheckedAt` /
  `lastReason` reset), so a freshly armed row has a true first line instead of a blank one for
  the up-to-two-minutes until the first tick.

`ArmedMergeRequest` also carries **`repoOwner` / `repoName` / `prNumber` / `prTitle`**:
`GET /api/auto-merge` is a cross-PR payload with no PR context to look a label up from, and the
alternative (a per-armed-PR merge-options fetch, ~3 GitHub calls each) is exactly what that route
must not do. `listAutoMergeRequests` gets them from the same `pullRequests`+`repos` joins the
runner scan already had — the join is NOT the tenancy guard, the explicit `accountId` predicate
on `auto_merge_requests` still is, and the route stays a pure DB read on the `read` rate tier.

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
Merge/Close/Reopen in the Overview Actions row (Reopen renders only on a CLOSED PR, so it and the
arm button are never on screen together — no fourth control competes for that row) (`MergeControl` keeps its richer armed panel + cancel,
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
the `ARMED_MERGES_KEY` invalidation).

⚠ **AND WHEN THE WATCHER GIVES UP, SOMETHING MUST SAY SO — `usePrStoppedIntent`.** Because every
armed surface gates on `state === 'armed'`, a disarmed, expired or failed intent used to make the
panel simply VANISH: the PR did not merge and nothing anywhere said why. That is the reported
"the arming is disarmed for unknown reasons", and the reason was never unknown — the watcher
writes it to `last_reason` on the way out. The selector returns the most recent non-`armed`,
non-`merged` row for a PR (a re-arm supersedes its own history; `merged` is excluded because a
success is announced, not posted), and it drives an **"Auto-merge" Row on the PR pane** (open PRs
only — on a merged one the question has answered itself) and a line on the **Pending card**. Both
read `TERMINAL_LABEL` from `AutoMergeBanner`, exported for exactly that reason: one outcome, one
wording. Both self-clear when the server drops the row at 24h.

⚠ **The banner's outcome card needed a DURABLE baseline for the same reason.** `foldArmedPoll`
only reports a transition for a PR it previously observed `armed`, and `useArmedMerges` sets
`refetchIntervalInBackground: false` — so an intent that resolved while the tab was backgrounded
or between page loads had no prior observation to compare against and was silently discarded. The
last-seen map is now seeded from `localStorage` (armed states only; a terminal state read back
would let the fold believe it had already reported an outcome it never showed). An empty read
degrades to the original silent-first-poll behaviour, which is what a genuinely first visit wants.

⚠ **`useEnqueueMergeQueue`/`useDequeueMergeQueue` AWAIT their `merge-options` invalidation**, and
they are the only mutations in `usePrWrites.ts` that await anything. The button renders from that
query's `inQueue` — the very fact the mutation just changed — so a fire-and-forget invalidation
dropped `isPending` while the cache still held the pre-click payload: the button snapped back to
"Add to merge queue" and stayed there for the whole refetch, which is a live GitHub call. Seconds,
not a flicker, and clickable throughout. React Query v5 keeps a mutation pending until an
`onSuccess` promise settles, so awaiting exactly that one query carries the spinner across the gap;
the other invalidations stay `void` because nothing on the control reads them. `useArmedMerges` polls `GET /api/auto-merge` foreground-only
on an ADAPTIVE cadence — 8s while any row is `armed`, 45s otherwise, because an account with
nothing armed must not pay a per-8s request for a card that renders nothing.

**The armed-merge progress stack (`AutoMergeBanner`)** is the global lifecycle surface, a plain
card in App.tsx's ONE bottom-right toast column (never a second fixed element — see
docs/FRONTEND.md). ONE CARD PER MERGE: a row appears on the CLICK that arms, tracks `phase` while
the watcher works, and is REPLACED IN PLACE by its outcome — there is no separate terminal toast
for a PR the stack was already showing. Four rules hold it together:

- **The arm mutation SEEDS `ARMED_MERGES_KEY` from its own response** (`setQueryData` beside the
  existing invalidate). The POST returns the full row, so the card is immediate; without the seed
  the surface whose job is to say "I heard you" would be a poll interval late.
- **Live rows are derived straight from the polled list; outcomes are local state captured on the
  `armed → terminal` transition.** The list keeps resolved rows for 24h, so a page load must not
  open with a merged card from two hours ago — the first poll still seeds a SILENT baseline. The
  derived-not-copied half is what makes a disarm (which DELETES the row) clear the card at once.
  ⚠ **Each capture carries its OWN id (a per-page-load counter), never `${prId}:${state}`** — a PR
  reaches the same terminal twice routinely (arm → the branch moves → re-arm → it moves again),
  all inside the 24h window, and the pair-key gave those two captures one React key and one
  dismissal key, so dismissing the first run permanently silenced the second. A newer capture, or
  a re-arm, SUPERSEDES that PR's older outcome row: one PR never occupies two rows of the stack.
- **Terminals render off `state`, phases off `phase`, and `lastReason` is only ever the secondary
  line** — it is null at success, so a card bodied on it goes blank exactly when it should read
  "Merged".
- **Indicator + Cancel, nothing else.** Cancel is `useDisarmAutoMerge` (the DELETE that dequeues);
  the stack must never grow a re-arm / "update now" / freshen control, and must never call
  `useMergeOptions` per armed PR (~3 GitHub calls each — the reason the row carries its own
  identity and phase).

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
> "CI failures" pill, which is OFF by default — one click turns it on. The sentence above still holds in the
> sense that matters: a trunk failure produces **no attention count, no badge, and no My Turn
> row**. ⚠ It USED to be emitted with `prId: null`, which made `enrichMyTurn` structurally decline
> it; now that it names the PR that landed the broken commit, the only thing keeping it out of the
> My-Turn lane is being withheld from that enrichment by KIND (`db/queries.ts` `isCiFeedKind`) —
> a CI item is actor-less and would otherwise satisfy "the actor isn't you" trivially and become an
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

The Feed's **"CI failures"** pill emits **one item per failed check RUN**, keyed
`(PR-or-branch, head sha, check name)`, from two transition logs. It is a THREE-state lens
(`feedCiLens`), not a toggle:

The pill cycles **`off` → `feed` → `only` → `off`**, so one click from the default turns it on:

| state | stream | wire |
|---|---|---|
| `'off'` (**default**) | no CI rows fetched at all | param omitted |
| `'feed'` | CI rows interleaved chronologically with human activity | `includeCiFailures=true` |
| `'only'` | narrowed to CI rows (client-side, like the category pills) | `includeCiFailures=true` |

> ⚠ **Why three states.** It shipped as an include-only boolean, OFF by default, and that
> combination hid the feature twice over. Rows are placed by TIME, so in a high-traffic workspace
> (bevy/three.js: ~23 non-CI events in the 11.5h since the newest CI failure) the first red card
> lands ~23 rows down while the pill's count reads 34 — a control that looks dead. The identical
> code puts it at index 0 in a quiet workspace and looks perfect, which is why it was reported as
> "works under one workspace, broken under another". `'only'` is the state that makes the effect
> legible at any traffic level.
>
> ⚠ **The DEFAULT has flipped twice — off → feed → off — and the two flips are not symmetric.**
> The first was a fix for the invisibility above. The second is a product call: one card per
> failed check per head means a red matrix build can be most of what a new user's first feed
> contains, which is a poor first impression of a situational-awareness tool. What makes an
> off-by-default acceptable NOW and not then is that the pill renders **unconditionally**, so the
> feature is one visible click away rather than ambient. The include-only-boolean lesson is
> unchanged and permanent: never ship a toggle whose only feedback is a count.
>
> ⚠ **A default flip on this key needs a `FILTER_STORAGE_VERSION` bump** (v3 → v4, dropping
> exactly `feedCiLens`) because `pickFilterBarState` persists it UNCONDITIONALLY — every blob
> written under the old default holds a literal `'feed'` that no user chose, so without the bump
> the new default would reach new installs only and every existing user would keep the noisy
> feed forever. A deliberate `'only'` is lost with it; that is the accepted cost of flipping a
> default on a key whose stored value cannot be told apart from the default that produced it.
> `migratePersistedFilters`'s steps CHAIN — a v2 blob must land at v4, and a per-step early
> return would strand it where the caller's version check then discards the blob WHOLE.
>
> ⚠ `'only'` **skips the Comments / PR-events category pills.** CI rows belong to neither category
> (deliberately — see `catMatch`), so composing them could only ever produce an empty feed.
>
> ⚠ The lens is a **standing preference**: it is the one feed control in `FilterDefaults`, so it
> persists with the filter bar **and is URL-serialized** (`ci=only` / `ci=1`; the `'off'` default
> is omitted, an explicit `ci=0` is still honoured, and `ci=1` has meant "on" since this was a
> boolean — so links from every older shape read correctly). ⚠ **The OMITTED value must track the
> CURRENT default**: when the default flipped, leaving `ci=0` as the emitted one would have
> written the default onto every URL while the newly non-default `'feed'` vanished — i.e. the one
> state that now needs serializing would be the one state that never survived a reload. An old
> link that MEANT `'feed'` carried no `ci` param and now reads as `'off'`; an absent param cannot
> be told apart from a bare URL, and it is the same direction as the storage migration.
> BOTH are required, and the URL half
> is the one that actually restores it: the persisted blob is read only on a BARE url, while
> `writeToUrl` puts `?workspace=<id>` on the address bar as soon as the scope resolves. A
> `FilterDefaults` key that is not serialized is written to localStorage on every change and read
> back never — it survives nothing.
>
> ⚠ The legacy boolean `feedShowCiFailures` in a stored blob is **dropped, not migrated**. Its
> default was `false` — what nearly every stored blob holds — so mapping it onto `'off'` would
> preserve the very invisibility this change fixes, for exactly the users who never found the pill.

| kind | source | shape |
|---|---|---|
| `ci_failed` | `ci_status_events` (written by `sync/upsert.ts` on every walk) | has a `prId` |
| `trunk_ci_failed` | `trunk_ci_status_events` (written by `sync/branch-status.ts`) | the LANDING PR when the head sha resolves to one, else `prId: null` |

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
30-minute floor old. Copy therefore says **"detected"**, never "failed at".

**A trunk card names the PR that LANDED the broken commit** (`resolveTrunkCommitPrs` in
`db/queries.ts`), so it opens like any other card. The mapping is already stored —
`branch_commits.pr_number`, written by the snapshot's `pickAssociatedPrNumber` — and this only
walks the two hops that turn it into a local PR id. What to know before touching it:

- **Both hops key on `(repoId, X)`, never a bare sha or number.** The lookups are
  `inArray(repoIds) × inArray(shas|numbers)`, which deliberately over-matches; the composite key
  is the only thing discarding the cross-repo rows it returns. ⚠ The repo/number lists are built
  **from the trunk rows being resolved**, so a cross-repo test is VACUOUS unless a second repo
  also has a red trunk — the first version of that test passed against a deliberately-broken
  bare-number map for exactly this reason. `ci-feed-items.test.ts` now gives acme/decoy its own
  failure and its own `#34`, and the mutation fails two tests.
- **A miss is ordinary, not an error** — a direct push has no PR, `pr_number` is null until the
  association is observed, the two logs trim on different schedules (`branch_commits` =
  newest-100 ∪ 90d vs `trunk_ci_status_events` = newest-200 ∪ the 14-day feed window), and the
  landing PR may not be synced. All of them fall back to a PR-less card, which stops looking
  clickable and keeps the commit link as its only affordance.
- **`githubUrl` stays the COMMIT even when a PR resolved**: a trunk run's checks live on the
  commit page, and the failure is a fact about trunk. The PR is reached from the card's own PR
  reference, which is LABELLED (`landed by` when `prState === 'merged'`, else `from`) — the
  picker falls back to an OPEN associated PR when that is the only candidate, and claiming that
  one landed anything would be false.
- ⚠ **`prId: null` used to be what kept these rows out of the My-Turn lane.** It no longer is —
  the kind-based `isCiFeedKind` filter on `enrichMyTurn` is now the ONLY guard, and it must stay:
  a CI row is actor-less, so `actorId !== localUserId` is trivially true and every red trunk build
  on a PR you touched would become an uncapped yellow card. Pinned by a test.



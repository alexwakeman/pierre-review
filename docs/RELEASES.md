# Releases (This Sprint → Releases) and hotfix builds

The spec agreed with the owner on 2026-11-14, reworked with the owner on 2026-11-15 after a try on real
data (releasable repos, each repo judged on its own, the fixed hyphen), and again the same day: the
candidate is AUTOMATIC — no start tag, the whole reachable history, a progress line while it reads. On
2026-11-16 the owner approved a SIMPLER RULE, then (same day, after trying it on BNG) made it CUMULATIVE:
releasing a tag ships everything below it, so the candidate is the tag just below the OLDEST tag that holds a
ticket not Complete or with a pull request still open, over the WHOLE history (no floor). Ticket titles sit
beside every ticket key. The reader checks what is listed. It is the acceptance
contract: § Acceptance checks is
what a build of this feature must pass. Implementation notes are added below § Implementation as the
work lands; keep the spec sections true.

## Purpose

Say, per RELEASABLE repository (ticked "Released from this workspace"), which version tag on `main` is
safe to release, by itself (deterministic, no AI, nothing for the reader to pick): the newest version tag
such that it AND every version tag below it (after the last release, or since the start of the history)
have all their tickets Complete with no pull request still open. The reader validates what is shown
(tickets the tracker could not find, pull requests with no ticket). Each repository is judged on its
own. One reader
press tags each safe version with the workspace's release suffix (the tag is the trigger for the
team's image build; Ensemble deploys nothing), publishes release notes and comments on each shipped
ticket. A hotfix is an Implement option that builds one fix twice: on the latest release and on
`main`, as two PRs per repository. Ensemble automates nothing after those PRs open.

Owner decisions: tags are cut from `main` only (by CI or by hand; Ensemble never cuts a version tag);
nothing is in production yet; the aim is always the newest safe tag; "Done" = complete.

## Terms and settings

**Settings → Releases** (per workspace, no inheritance):

- **Release suffix** (e.g. `-rc`) and **Hotfix suffix** (e.g. `-hotfix`). Both REQUIRED before the
  Releases tab or the hotfix option does anything; there is NO default (the owner has not settled the
  suffix). Until both are set the tab shows ONE line linking to the setting.
- **The hyphen is fixed.** The reader types `rc`; the stored suffix is `-rc`. The form shows a fixed "-"
  to the left of the box (not editable). Older stored values without a leading `-` got one (migration).
- Validation, on the TYPED part: no leading hyphen; a valid git ref fragment (no spaces, `~^:?*[\`, `..`,
  `@{`, no trailing `.lock`/`/`/`.`), 1–32 characters; the two must differ, and neither may END WITH the
  other (a tag must classify one way).
- **Released from this workspace** — a tick per workspace repository (home and External). Default: none.
  EVERYTHING in Releases uses only ticked repos: the rows, the check, the tickets, the dialog, the writes,
  the tag sync's ranges, and the hotfix bases (an unticked repo is read only in a hotfix build). Unticked
  repos are ignored entirely — never a warning, never a block. With none ticked the tab shows ONE line
  linking to the setting.
- Changing a suffix after releases exist warns before saving: older tags stop counting as releases.
- User-facing words never say "rc" or name a suffix except the configured one.

**Tags:**

- **Version tag** — a tag pointing at a commit on `main` (reachable from the default branch head),
  ending in neither suffix.
- **Release tag** — `<version tag><release suffix>`, annotated, on the version tag's commit. Ensemble
  creates these on the reader's press.
- **Hotfix tag** — a tag ending in the hotfix suffix. The team creates these by hand on a hotfix branch.
- **Latest release** (per repo) — the newest release OR hotfix tag (by the tagged commit's date, ties
  by tag creation). The hotfix base.
- **Baseline** (per repo) — the newest RELEASE tag whose commit is an ancestor of `main`. None ⇒ NO
  baseline: the walk starts at the OLDEST version tag on `main` (the whole history the app can reach —
  every tag the tag read returns, beyond the 90-day PR sync). There is no start tag (removed 2026-11-15:
  the app works out the starting point itself).
- **Increment of a version tag** — the PRs merged INTO THE DEFAULT BRANCH after the previous version tag (or the
  baseline) up to and including that tag's commit.
- **Scope of a version tag** — the tickets the check reads for it: every PR it would ship — with a baseline,
  every PR in (baseline, tag] (the whole content since the last release); with no baseline, every PR from the
  start of the history up to the tag (owner, 2026-11-16: no floor).
- **Range** — older word for the increment, still used in code. Read in ONE pass over the default branch's FIRST-PARENT
  history, newest first (GraphQL `history` with each commit's `associatedPullRequests`): each commit belongs
  to the nearest tag at or above it; a commit with no PR is a direct push. The OLDEST tag with no base: every
  first-parent commit down to the root. Each range PR is kept as a LIGHT record (title, head branch, author,
  merge) — no full PR sync; tickets are read in BATCHES (§ Implementation → One history pass).
- **Done / Complete** — the ticket is in the workspace's Complete stage and nothing else (`stage === 'done'`,
  `SPRINT_STAGES`; with automatic buckets: the tracker's `done` category minus the names that read as
  cancelled). ⚠ **A Cancelled ticket ("Won't do", "Duplicate", "Closed as not planned") is NOT Complete, but
  it NEVER STOPS A TAG** (owner, 2026-11-16, after BNG's frontend fell back to April over BMD-290 "Won't do"):
  it is listed with a tick — "Won't Do (Cancelled) — doesn't stop a release" — even with an open PR, and is
  never commented on (not READY). Only the workspace's Cancelled stage counts: a not-Complete ticket in any
  other bucket still blocks (docs/TRACKERS.md § The status order and buckets).
- **Open PR** — a stored `pull_requests` row still OPEN, into the repo's DEFAULT BRANCH (a base not synced
  yet counts), in ANY releasable repo of the workspace, whose detected tickets include the ticket. A merged
  PR anywhere is fine; a closed-unmerged one is ignored; an open PR into `hotfix/…` is not one.
- **Human vs bot PR** — by author through `globalAutomationUserIds`, never `hiddenBotUserIds`.

## The release check (one pure fold, deterministic)

**THE CUMULATIVE RULE (owner, 2026-11-16). Per releasable repo, on its own:**

1. Baseline = the newest release tag on `main` (`<tag><release suffix>`), or none.
2. Walk the version tags after the baseline NEWEST → OLDEST.
3. A tag's SCOPE = the tickets named by every PR merged into the default branch up to it — what releasing
   it ships:
   - with a baseline: every PR in (baseline, tag] — the whole content since the last release;
   - with no baseline: every PR from the start of the history up to the tag.
4. The tag QUALIFIES when every ticket in its scope that the tracker returned is Complete (`stage ===
   'done'`) or Cancelled (`stage === 'cancelled'`, which never stops a tag) — every other stage does not
   qualify — AND has no open PR in any of the
   workspace's releasable repos.
5. **The first tag that qualifies is the candidate. The walk stops there.** Because the scope is cumulative,
   that is the tag just below the OLDEST tag that holds a blocking ticket, and every tag below it qualifies
   too. Proving it needs the whole scope, so the history pass reads down to the baseline or the root first
   (BNG backend, 2026-11-16: 0.324.0 holds BMD-1061 In Code Review, so the candidate is 0.323.0 although
   0.415.0–0.418.0 are clear on their own).
6. **PICKED TOGETHER (owner, 2026-11-16): no Complete ticket ships half.** After every repository's walk, a
   ticket with merged work at or below one repository's candidate AND merged work above ANOTHER releasable
   repository's candidate — "not in a tag yet" (merged after the newest tag) and a repository with no
   candidate count as above — blocks the tags holding it in each repository where part of
   it would ship: "BMD-1048 “Edit an AREA” would ship without bng-metric-backend #539 (in 0.326.0), which waits
   on bng-metric-backend 0.324.0: BMD-1061 “…” is In Code Review." The reason always ends at the ROOT CAUSE —
   the tag holding a ticket not Complete or with an open PR, followed through earlier splits (`root`), never
   back to the other half — and its link goes there. A ticket line says "would ship without" only in the tag
   it holds back; in the tag that holds its other half it reads Complete (`ticketBlockerIn`). The walks
   run again until nothing changes (candidates only move down). A repository still checking, or with no
   version tags, takes no part yet. Cancelled and not-found tickets never block, so they are never split.
   (BNG, 2026-11-16: backend 0.316.0, frontend 0.328.0 — BMD-1048, BMD-1083 and BMD-1086 had work on both
   sides.) **NEVER WITHIN ONE REPOSITORY (owner, 2026-11-23):** later work on a Complete ticket in the SAME
   repository (in a later tag or not in a tag yet) is the next increment, never a split — releasing a tag
   ships everything below it, and the earlier part already stood alone on `main`. (BNG, 2026-11-23: BMD-887
   had bng-library #28 (3 Aug) and #129 (3 Nov); counting that as a split dropped bng-library below #28 and,
   through the cross-repository tickets below it, every repository back to late June. Cross-repository only:
   bng-library #118, backend 0.316.0, frontend 0.328.0.)

- **Tickets the tracker could not give do NOT block** (not found, no access, failed past the retry limit,
  a tracker that cannot read at all). A "not found" or "no access" that comes AFTER an older successful
  read wins over it — the ticket was deleted or moved (BMD-1026, 2026-11-16); a transient failure never
  replaces a successful read. They are listed under the tag — "BMD-123 not found", "BMD-9 could
  not be read: the tracker did not answer" — for the reader to check. A ticket NOT READ YET (the tracker
  has not answered, a transient state) makes the tag CHECKING until it is read; after three failed reads
  in a row it becomes "could not be read" and stops blocking.
- **PRs with no ticket** (human or bot) never block and are never a warning: listed under the tag ("Also
  includes 3 pull requests with no ticket") with links. The notes still list them ("Untracked changes",
  "Dependency and bot changes").
- **Authorship never changes anything**: a bot PR naming a not-Complete ticket rules its tag out.
- **Tags newer than the candidate** each say why they do not qualify, the ticket's TITLE beside its key:
  "BMD-1048 “Edit an AREA” is In PO Review.", "BMD-1050 “Habitat export” has an open pull request in
  bng-metric-frontend (#812)." A reason may come from an earlier tag in the scope, and says which:
  "BMD-1040 “Hedgerow validation” (from 0.391.0) is In Progress." A title longer than 60 characters is cut
  on a word with "…" (`releaseTitleShort`).
- **Work not done yet is CHECKING, never a reason**: a scope the history pass has not read, a ticket not read
  yet, a newer version tag (or a release tag that may be a newer baseline) whose place on `main` is not
  known yet. The walk stops at that tag (it may yet qualify). A reason that rules a tag out is certain even
  while other parts of its scope are still read (more reading only adds tickets), so a tag can be ruled out
  early.
- **No early candidate**: the history pass reads `main` newest first, so the newest tags can be RULED OUT
  first, but a candidate is named only once the pass has reached the baseline (or the root) and the scope's
  tickets are answered. Until then the row is "Checking…" with the progress bar and line.
- No version tag after the baseline: "Nothing new" — not in the release. A PR into a hotfix branch is in no
  increment (merged or open).
- Commits with no PR (direct pushes): a note on their tag only.

The fold is pure and DB-only on a view (tags, the walked history, light PR records, the open PRs and ticket
statuses are synced/stored, the scan's live progress is in memory); it never fetches on mount. THE SCAN (the
tags step, the background) reads `main`'s history once, newest first, and the tickets in batches, within the
rate budget, and keeps what it read: the next scan reads only the commits newer than the walked head.

## Releases tab (This Sprint → Releases, the 4th inner tab, key `4`)

1. Header: "Latest release: none" / "Latest release: 12 Nov", Refresh, an ⓘ with the rules in a few lines.
2. ONE ROW PER RELEASABLE REPO, in plain words:
   - candidate: "Release 0.392.0 → 0.392.0-rc", with "Latest 0.394.0" beside it when different, and counts
     "6 tickets · 1 to check" (tickets the tracker could not give);
   - none: "No tag can be released — 0.394.0: BMD-1048 “Edit an AREA” is In PO Review", or with a baseline
     "No tag since 0.380.0-rc can be released — 0.394.0: BMD-1040 “Hedgerow validation” (from 0.391.0) is In
     Progress" (the newest tag's reason);
   - checking: "Checking…", with a PROGRESS BAR and ONE short line of what the check waits for — "Reading
     main's history: 1,200 of 5,400 commits", "Reading tickets from Jira: 300 of 420" (the workspace's
     tracker). Every wait likely to pass 5 seconds shows the bar and its line (Refresh too: "Reading
     tickets from Jira again");
   - "Nothing new since 0.390.0-rc" / "No version tags on main yet".
   The tab polls `GET /api/releases` every ~3 s ONLY while a repo is checking, and stops when none is. There
   is no separate tickets panel and nothing to pick.
2b. Above the list, ONLY the repositories with NO candidate get a line (no version tags, nothing new, none can be
   released, "Checking…"). The repositories WITH one are named on the candidate ticket (★): each candidate, its
   COMMIT — the HEAD that would be released — as a short sha linked to GitHub, and its day, with ONE "Release…"
   for all of them (shown only with a candidate the reader can push to — HIDE, never disable).
3. THE TICKET LIST (owner, 2026-11-16) replaces the per-repository tag rows. ONE list for the whole workspace, a
   CARD PER TICKET (a ticket in both repositories is one card), newest at the top:
   ```
   bng-library   No version tags on main yet
   ┌───────────────────────────────────────────────────────────────────────────────────────────┐
   │ ☐ Show PRs with no ticket                                                                 │
   │ ⌃ Show next 3 of 7
   ⊘ BMD-1060 VALIDATION: Save invalid habitat data combinations as null · Done · merged 4 Nov ›
       bng-metric-backend 0.326.0   Waits on BMD-1061: In Code Review   Show BMD-1061
     › 14 PRs with no ticket · 13 by bots
   ★ BMD-1082 NEW TEMPLATE: Support the new data structure … · Done · merged 23 Oct            ›
       bng-metric-backend 0.316.0   9 PRs, the last by robin-dunn
       bng-metric-backend  0.316.0 → 0.316.0-rc · e18c3b2 · 23 Oct · Latest 0.418.0
       bng-metric-frontend 0.328.0 → 0.328.0-rc · 1e3249f · 27 Oct · Latest 0.420.0   [Release…]
     › 14 PRs with no ticket · 12 by bots
   ✓ BMD-1028 Trading Summary Page - Hedgerows · Done · merged 21 Oct                           ›
   │ ⌄ Show previous 3 of 12                                                                   │
   └───────────────────────────────────────────────────────────────────────────────────────────┘

   ┌─ (apart, at the bottom) ──────────────────────────────────────────────────────────────────┐
   │ Not in a tag yet                                                                          │
   │ ✗ BMD-1045 PI HABITAT DETAILS: Edit an AREA enhancement · In Code Review                 ›│
   │     bng-metric-frontend: open PR   Open PR: bng-metric-frontend #518                      │
   │ Holding the release                                                                       │
   │ ✗ BMD-1061 HABITAT EDITING: Edit Baseline references · In Code Review                    ›│
   │     bng-metric-backend 0.324.0  bng-metric-frontend 0.341.0   Holds back bng-metric-…     │
   └───────────────────────────────────────────────────────────────────────────────────────────┘
   ```
   - **Order** (`ticketList`): a ticket sits where its LATEST TAG sits — the newest tag, in any releasable
     repository, holding its merged work (tags of different repositories by commit date, `tagAt`).
   - **The window** (`ticketWindow`): it opens on THE CANDIDATE TICKET (★) — the newest ticket all of whose work
     is in the release candidates — with ONE ticket either side; "Show next 3 of 7" (above) / "Show previous 3
     of 12" (below) add 3 (component state), the second figure being the tickets still hidden that way
     ("Show next 2 of 2" when fewer are left). While a repository has older tags the server has not read
     (`older.moreAvailable`), the total below is NOT KNOWN and is not given: "Show previous 3". Past the
     tickets sent, "Read earlier tags" asks the server for more.
   - **Holding the release** (`releaseHolders`, always shown, in the box BELOW the list): the ticket that stops the tag
     just above each repository's candidate — a split followed to its ROOT — once, naming the repositories it
     holds ("Holds back bng-metric-backend and bng-metric-frontend").
   - **Not in a tag yet**, in that same box below the list: tickets whose only work is an open pull request. A ticket with
     tagged work AND an open PR stays in the list; its line names the open PR.
   - **The card** is simple: the mark (✓ in the candidates · ✗ RED not Complete or an open PR · ⊘ AMBER Complete
     but held back · ? the tracker could not give it — a DASHED card, "Not found in Jira — check it by hand",
     never a block · a part-circle not read yet), key, title, the tracker's status, the date its LAST PR
     was merged ("merged 23 Oct", the newest `mergedAt` over its merged PRs in the releasable repos — the same
     `ticketLatest` fold that orders the list; nothing when none is merged), the latest tag per repository,
     and ONE line: what it WAITS ON ("Waits on BMD-1061: In Code Review", with "Show BMD-1061"
     scrolling to the holder; never another held ticket), or for a ✓ card what was DONE ("9 PRs, the last by
     robin-dunn"; its date is on the card). Every PR and tag is behind the arrow: "Type · Assignee · Jira status read 5 hours
     ago", "Open in Jira", "Story", and each PR (open first, then merged newest first: "merged 23 Oct ·
     robin-dunn · in 0.316.0", "not in a tag yet", OPEN), each opening its PR tab or GitHub. Nothing is fetched
     to open it.
   - **Pull requests with no ticket** are NARROW rows between the cards, consecutive ones grouped ("14 PRs with no
     ticket · 13 by bots"), opening to their list. BOT PRs are left out of those lists unless "Show bot PRs" (top
     of the box, OFF by default, component state) is ticked; the row's words always count them. The rows show
     only while "Show PRs with no ticket" (OFF by default) is ticked; a ticket the tracker could not give is a
     card and stays.
   - **The rail** (the PR Activity tab's design): one vertical line down the left of the list, each row's icon in
     a disc on it — ★ the candidate ticket, ✓, ✗, ⊘, ?, a part-circle — and a merge mark for each group of PRs
     with no ticket. In the list the card carries no mark of its own.
   - "Released" is never said unless a release tag contains it.
4. No warnings panel: nothing about a pull request with no ticket is a warning (removed 2026-11-16).
5. **"Release…"** on the candidate ticket — ONE for every repository with a candidate; shown only with a
   candidate in a writable repo (HIDE, never disable). Dialog: the releasable repos with a candidate (ticked unless
   the release tag exists; each judged on its own, so unticking one only
   leaves it out; none ticked hides Confirm); release notes preview (editable); tracker comment preview;
   Confirm.
   Confirm FIRST re-checks the chosen candidate under THE RULE: every ticket in its scope re-read from the
   tracker in one batch, the open PRs read again from the DB, and each version tag's commit read on
   GitHub; any change (it no longer qualifies, or another tag is now the candidate) stops it and shows
   what — nothing is written.
6. Writes, in order, each claimed (compare-and-set) BEFORE the GitHub/tracker write, NEVER retried:
   1. annotated release tags (an existing name is REFUSED, never moved);
   2. a GitHub pre-release on each release tag carrying that repo's notes;
   3. a tracker comment on each ticket whose repos ALL tagged successfully (Jira first; other trackers
      say "not supported yet");
   4. a per-step result list. One failure never undoes the steps that worked.
7. Afterwards the new release tags are the baseline: rows read "Nothing new" until new version tags.

**No Ensemble wording** in tag messages, release notes, pre-release bodies or tracker comments. Comment:

> Approved for release by <reader's display name> on 14 Nov 2026.
> api v2.4.0-rc · web v1.8.2-rc
> Release notes: <link to the GitHub pre-release>

## The path to newer releases — the release graph (owner, 2026-11-24)

Shared `release-graph.ts` `releaseGraph(check)`: ONE pure fold over the release check's result (no fetch,
no clock, no AI). The SPA folds it on read; the backend folds the same for "Explain what's blocking".

- **The shape.** At or below a repository's candidate everything can be released: a straight line. Above
  it each repository is a LADDER — releasing a tag ships everything below it, so a newer tag needs what an
  older one needs plus its own. The graph is the edges between ladders and work: tag → ticket (`not_done`,
  `open_pr`), ticket → open PR, tag → tag in ANOTHER repository (a `split`: that point's needs join),
  tag → "a new version tag" (a split whose other half is in no tag yet), and ticket → ticket from the
  TRACKER's "is blocked by" links (`blockedBy`, read from `blocked_by_json` on the freshest successful
  read). Tracker links are not the release rule, so a stop keeps them APART (`via`), but the plan counts
  them: a ticket cannot really be finished before what it waits on.
- **A stop** = a run of newer tags with the same needs, named by its highest tag (where the candidate moves
  once they are done). `adds` = what it needs beyond the stop below it.
- **The plan (`moves`).** Within one ladder the needs are nested, so the cheapest next stop is exact.
  Across ladders (splits, shared tickets) the fewest tickets for the most releases is set cover, so the
  plan is GREEDY: each move takes the next stop, in any ladder, with the fewest unfinished items, ties
  broken by how many release points it unlocks. ≤ `RELEASE_PLAN_MOVES_MAX` (8).
- **Per work item**: `holds` (the first point it holds back in each repository) and `unlocksAlone` (finish
  only this, and what it waits on, and these become releasable — the highest per repository).
- **Loops** of tracker links (A waits on B waits on A) are found (Tarjan) and marked `inCycle`; the plan
  takes the loop as one move.
- ⚠ **UNKNOWN IS NEVER ZERO.** A tag already ruled out lists NO reason for a ticket not read yet (the check
  stops at the first certain reason), so a tag whose own tickets are still unread is `partial`: it never
  folds into the stop below, nothing is promised from it upward, and the plan stops there. A tag still
  `checking` ends the ladder (`checkingFrom`).

## Explain what's blocking (owner, 2026-11-23)

An AGENTIC report on the Releases tab, for action: which in-flight work (tickets and pull requests, named)
unlocks which newer release, why each repository's newer tags are blocked, and the order to do things in.

- **The panel** ("What's blocking", `Sprint/ReleaseBlockersPanel.tsx`) sits above the ticket list. It is VISIBLE
  only while `me.ai.enabled` and GET /api/releases carries `blockers` with a report or `explainable` (the check is
  decided — no repository checking — and some repository with a candidate or none has a newer tag that does not
  qualify). The button "Explain what's blocking" ("Explain again" once a report exists) shows only while
  `explainable` (HIDE, never disable), inside `AiRunGate kind="complete"`; its explanation is behind the ⓘ.
- **Nothing runs on its own and nothing fetches on mount**: the stored report rides GET /api/releases (ONE fetch
  on mount stays true); "Out of date" when the input hash differs from the one the report was written from.
- **ONE completion per press** (`POST /api/releases/blockers`, docs/CLAUDE-REVIEW.md § Release blockers) over
  the check the server already folded — no GitHub or tracker read. The input (`releases/blockers-input.ts`,
  pure): per repository the last release, what can be released now, the newest tag, and the blocked newer tags
  OLDEST FIRST with their OWN reasons and the CUMULATIVE "Needs before it can be released" (a newer tag's
  reasons are whole, so this is every ticket to finish first; a split is followed to its ROOT; a split whose
  other half is in no tag yet needs a new version tag); tags with no reason of their own are folded into a
  count (≤ 15 listed per repository, plus the newest); the tickets holding a release back (status, assignee,
  open and merged PRs, "holds back: <repo> from <tag>") and the tickets with only an open PR (≤ 40). ⚠ Titles,
  statuses, names and tag names are UNTRUSTED: one line each, capped, inside ONE nonce fence.
- **Refuse rather than guess**: the answer may cite only the input's tickets (by key) and PRs ("repo #n"). A
  step or repository line naming anything else is dropped and counted ("1 point left out: it named work not in
  the check"); a headline doing so refuses the answer (one retry, then nothing is stored and the old report
  stays). Ticket links go to the tracker, PR links to the PR tab (or GitHub), every URL through `safeExternalUrl`.
- **Stored per workspace** (`release_blocker_reports`, migration 0217) with the input's hash: sha256 of
  `RELEASE_BLOCKERS_VERSION` + the input text — no clock-derived field.

## Release notes

One document per release, a section per repo (each section is also that repo's pre-release body). Each
section lists the candidate's SCOPE under "Stories": with a baseline, everything since the last release;
with none, everything up to the candidate tag, with one line, "First release: everything up to this tag." A
ticket the tracker could not give is listed by its key (it gets no comment). Per story: key, title, link, the PRs per repo, and — when `me.ai.enabled` — a one-paragraph summary
from the ticket text and PR titles/descriptions through `ai/provider.ts` (`cheapComplete`, writing
rules). Without AI the same document minus summaries; never blocked. Version numbers and counts are
code-derived, never model-written. Then "Untracked changes" and "Dependency and bot changes". Stored
against the release and viewable again from the tab.

## Hotfix (an Implement option)

In the story view, Implement's Start offers **"Treat as a hotfix"** — only when both suffixes are set
and ≥ 1 RELEASABLE workspace repo has a latest release. Start shows each repo's base (a repo not released
from this workspace is read only, whatever its tags):

```
api     from v2.4.0-rc (12 Nov)   → PRs into hotfix/v2.4.0-rc and main
web     from v1.8.2-rc (12 Nov)   → PRs into hotfix/v1.8.2-rc and main
worker  no release yet — read only
```

- The release checkout starts at the latest release's commit; stacking (owner decision 1) is OFF.
- The agent fixes the release checkout, runs the tests, then PORTS the fix to a `main` checkout in the
  same sandbox, resolves differences and runs the tests again. Each repo shows two diffs: "Release fix"
  and "Main fix". A repo without a release is read-only for the build.
- **The port report.** The release and `main` may have diverged: the fix may not be needed on `main` (the
  code was removed) or may need to be different there. Before porting, the agent reads the `main` checkout;
  at the end it reports per repo one of **Applied to both** (the same fix), **Applied to both, adapted for
  main** (what differs) or **Not applied to main** (why). Test passes are not the measure. Ensemble checks the
  claim against the two diffs (not against tests) and flags a contradiction: "Says main does not need it,
  but changed main." / "Says it was ported, but main is unchanged." No report reads "No report from the
  agent" — never inferred. The tab shows one line per repo before Push:
  ```
  api     Applied to both
  web     Applied to both, adapted for main — main builds totals in src/money.ts
  worker  Not applied to main — the export code was removed in src/export/
  ```
- Plan first works as usual. The review loop and "Build end to end" are OFF for hotfix builds (v1).
- **Push** (reader's press, per repo): create `hotfix/<latest release tag>` at the release commit if
  missing; open PR 1 from `<KEY>` into it and PR 2 from `<KEY>-main` into `main`. Both titled
  `<KEY>: <title>`; each body links the other; draft by default (the existing toggle); the usual Push
  rules (reader's PR, `BRANCH_EXISTS` refused, permission re-checked). If the hotfix branch exists and
  has moved past the release commit, PR 1 still targets it and the tab names the PRs already on it.
  **Not applied to main** with an unchanged `main` checkout opens PR 1 only (no `<KEY>-main` branch), its
  body saying "Not applied to main: <reason>". Otherwise both bodies carry the one-line outcome (+ the reason
  when adapted). A repo with a contradiction flag can still be pushed; the reader decides.
- After the PRs open, Ensemble writes NOTHING more for that build.

## Releasing without version tags (owner, 2026-11-19)

A repository with NO version tags is released from its MERGED PULL REQUESTS. It works the same way from the
reader's side; only what a "tag" is changes.

- **"Release from"** (Settings → Releases, per ticked repository; `workspace_release_repos.release_basis`):
  **Auto** (NULL, the default) · **Version tags** · **Merged pull requests**. Auto = merged pull requests while
  the repository has no VERSION tag by name (any branch; shared `releaseBasisOf`), else version tags. The release
  tags Ensemble creates end in the release suffix, so they never turn Auto back to tags.
- **Release points.** Each merged PR's NEWEST first-parent commit on the default branch stands in for a version
  tag, named `#<number>` (squash or merge commit: the PR's one commit; a rebase merge's earlier commits fall to
  the point above them; a commit that brings two PRs is one point named by the first; direct pushes belong to the
  point above them). They come from the history pass already stored (`release_history_commits.pr_numbers` from
  `associatedPullRequests`) — no new GitHub read. Real version tags are ignored in this mode; release and hotfix
  tags still count.
- **THE CUMULATIVE RULE is unchanged**, over points: the candidate is the newest merged PR such that every PR
  merged since the last release (or since the start), up to it, has its tickets Complete (or Cancelled) with no
  open PR. Picked together, not-found tickets, PRs with no ticket, the older band — all as for tags.
- **The baseline** is the newest RELEASE tag on the default branch, as before: the tag a release here creates.
- **The release tag**: there is no version to name it after, so it is the local DATE + the release suffix,
  `2026.11.19-rc`, then `2026.11.19.2-rc`, `.3`… when the name is taken (a stored tag, or a release item's name
  not synced back yet; shared `releaseDateTagName`). Annotated, on the point's commit; the pre-release and the
  tracker comment as before. Ensemble still never cuts a VERSION tag.
- **Confirm** checks a point's commit is still ON THE DEFAULT BRANCH (REST compare `sha...branch`: `ahead` or
  `identical`) instead of reading a version tag again; "#539 in api is no longer on main." stops it.
- **Words**: the strip reads "Up to #539 “Edit an AREA” → 2026.11.19-rc", "Nothing merged since 2026.11.10-rc",
  "Nothing merged since … can be released", "Nothing merged yet"; reasons say "(from #531)"; a split names the PR
  alone when it is its own point ("web #21"); the notes say "Built from #539 (e18c3b2)." and "First release:
  everything up to this pull request."
- **Hotfix**: unchanged — the base is the latest release tag, which a release here creates.

**Risks, as decided.** A REVERTED PR stays in the scope and still holds its tag if its ticket is not Complete
(as with tags). A ticket spread over several repositories is released whole or not at all (picked together);
later PRs on it in the SAME repository are the next increment and never hold an earlier point. A PR with no
ticket never blocks.

## Invariants this feature adds

- Tag sync is part of the default-branch snapshot step: STRICTLY NON-FATAL, found by the settle sweep
  (tag pushes are updatedAt-silent). The RELEASE SCAN runs for RELEASABLE repos only: ONE pass over the
  default branch's first-parent history, NEWEST FIRST, back to each releasing workspace's baseline or the
  root (time-boxed runs, budget-aware, paused on the rate budget, resumable from a stored cursor), then the
  tickets in batches. The walked commits are stored; which tag a commit belongs to (and whether a tag is on
  `main`) is DERIVED on read, so a new or MOVED tag needs no GitHub call. A head that moved is walked only
  down to the walked head; rewritten history is walked again from scratch.
- A range PR is a LIGHT record from the history read (`release_range_prs`) — never a full PR sync; its
  tickets are found by THE detection rule and read in batches by the scan (Jira: one search per 100 keys) —
  read when RECEIVED, never when viewed.
- `pullRequests.mergeCommitOid` is cleared only on a positive statement from GitHub.
- New tracker write: the release comment (the reader's press). Added to the tracker-writes list.
- New GitHub writes: release tags, pre-releases, the hotfix base branch — each a reader's press,
  rate-limit tier in `tierFor`, settle-and-verify.
- New account-scoped tables join `accountScopedTables()`; composite FKs; hand-registered migration.

## Acceptance checks

Settings
1. Without both suffixes, or with no repository ticked "Released from this workspace", the Releases tab
   shows only the setup line, and "Treat as a hotfix" is absent.
2. Equal suffixes, or one ending with the other, are refused with a sentence. The reader types `rc` and
   `-rc` is stored; a typed leading hyphen is refused; a stored `rc` reads as `-rc` after the migration.
3. Changing the release suffix after a release exists warns; after saving, old release tags no longer
   form the baseline.

Candidate (automatic, deterministic — THE CUMULATIVE RULE, 2026-11-16)
4. Tags v1.0.0, v1.1.0, v1.2.0, no release, all tickets Complete → candidate v1.2.0, its scope everything up to
   it (T1–T3); the candidate band is v1.2.0 alone; v1.1.0 and v1.0.0 are the older band.
4a. THE BNG CASE: v1.2.0 names a ticket In Code Review and v1.3.0, v1.4.0 are clear on their own → candidate
   v1.1.0; v1.4.0 says "T3 “…” (from v1.2.0) is In Code Review."
5. NEWEST-FIRST STOP: v1.2.0's increment names a ticket In review → candidate v1.1.0; v1.2.0 says "T3 is In
   review."; v1.0.0 is not read.
6. That ticket moves to Complete (the scan's read or Refresh) → candidate v1.2.0.
7. UNTRACKED PRS LISTED, NOT WARNED: a PR with no ticket (human or bot) never blocks and is no warning; it is
   listed under its tag ("Also includes 2 pull requests with no ticket"); the notes list it under "Untracked
   changes" / "Dependency and bot changes".
8. A bot PR with no ticket → listed like any PR with no ticket; under "Dependency and bot changes" in the notes.
9. A bot PR naming a not-Complete ticket → its tag does not qualify.
10. NOT FOUND LISTED, NOT BLOCKING: a ticket the tracker could not give (not found, no access, failed three
    times, a tracker that cannot read) → the tag still qualifies; the ticket is listed under it ("T3 not
    found", "T3 could not be read: there is no access to it"), counted "1 to check", in the notes by its key,
    and gets no comment.
11. CANCELLED NEVER STOPS A TAG: "Won't do" in the Cancelled stage, even with an open PR → the tag qualifies;
    the ticket is listed ("Won't Do (Cancelled) — doesn't stop a release") and not commented on.
12. No version tag after the baseline → "Nothing new", not in the release; no version tag at all → "No
    version tags on main yet".
13. A merged PR into `hotfix/…` is in no `main` tag's scope; an open PR into `hotfix/…` is not an open PR.
14. NO BASELINE, OWN INCREMENT: no release; v1.1.0 adds a not-Complete ticket, v1.2.0 only Complete ones →
    candidate v1.2.0 (v1.1.0's ticket is not in v1.2.0's scope, and is not read).
15. BASELINE, WHOLE SCOPE: after a release on v1.0.0, v1.1.0 adds T2 (In review), v1.2.0 adds T3 (Complete) →
    v1.2.0 does not qualify ("T2 (from v1.1.0) is In review."), nor does v1.1.0 → "No tag since v1.0.0-rc can
    be released"; T2 moves to Complete → v1.2.0, whose notes list T2 and T3.
16. NONE: every tag ruled out → "No tag can be released — v1.2.0: T3 is In PO Review" (the newest tag's reason);
    with a baseline "No tag since 0.380.0-rc can be released — …".
17. CHECKING: a ticket not read yet, or a scope not read yet, makes its tag checking — the walk stops there and
    the row reads "Checking…" with a progress bar and one line ("Reading main's history: 1,200 of 5,400
    commits", "Reading tickets from Jira: 0 of 1"); a reason that rules a tag out is still shown at once.
18. OPEN PR IN ANOTHER RELEASABLE REPO: a Complete ticket with an open PR into the default branch of any
    releasable repo → the tag does not qualify ("T3 has an open pull request in web (#812)."); a merged PR
    elsewhere is fine, unless it leaves part of a ticket above a candidate (57). Otherwise another
    repository's tag ruled out holds nothing, and an unticked repository is ignored entirely (no row, no
    block, its PRs count for nothing).

Writes
19. Confirm creates `<version><release suffix>`, annotated, on the version tag's commit; no Ensemble wording.
20. An existing release tag name → refused for that repo; the others go ahead.
21. A ticket leaves Complete, or a pull request for it opens, between opening the dialog and Confirm → Confirm
    stops, shows it ("T2 is In review.", "T1 has an open pull request in web (#88)."), writes nothing.
22. A repo fails to tag → its tickets get no comment; tickets only in other repos do; the result says so.
23. The comment is posted once per shipped ticket; pressing again writes nothing new.
24. After success every released repo reads "Nothing new" until the next version tag.

Hotfix
25. After a release, "Treat as a hotfix" shows each releasable repo's base as its latest release; repos
    without one, or not released from this workspace, are read only.
26. The release checkout starts at the release commit; the main checkout at `main`'s head.
27. A conflicting port is resolved by the agent; both diffs shown with test results.
28. Push creates `hotfix/<tag>` at the release commit and opens two PRs per changed repo, right bases,
    each linking the other.
29. A second hotfix off the same release targets the existing branch and names the PRs on it.
30. A hand-pushed hotfix tag becomes the latest release; the next hotfix bases on it.
31. After the PRs open, Ensemble writes nothing else for that build.

Notes
32. AI off: complete minus summaries. AI on: a summary per story, no model-written numbers.
33. No output contains the product name ("Ensemble", or the old "Limn").

Port report
34. The agent reports **Applied to both**: the tab reads "Applied to both"; Push opens two PRs, both bodies
    saying "Applied to both."
35. **Adapted for main**: the tab reads "Applied to both, adapted for main — <reason>"; both PR bodies carry the
    reason.
36. **Not applied to main** with an unchanged `main` checkout: the tab reads "Not applied to main — <reason>"; Push
    opens PR 1 only, its body says "Not applied to main: <reason>"; the ticket neither blocks nor warns in the
    release check for that repo.
37. A claim the diffs contradict (not needed but `main` changed, or ported but `main` unchanged) shows the flag
    beside Push; Push still works and sends no outcome line. No report reads "No report from the agent".

History, fetching, polling
38. HISTORY BEYOND THE 90-DAY SYNC IS READ: every tag the tag read reaches (paged, up to 1000); the history
    pass reads `main` back to the baseline, or to the root with no release — unless the candidate is proven
    first (48). A release tag on main is the baseline: only later version tags are read.
39. RANGE PRS FROM THE HISTORY READ: a range PR with no `pull_requests` row is read from its LIGHT record
    (title + head branch through THE detection rule, the same tickets a stored PR with that title and branch
    names); its ticket is read in the scan's next batch; until then its tag is checking.
40. A ticket the tracker did not answer is checking and retried; after three failed reads in a row it is
    listed ("BMD-12 could not be read: the tracker did not answer") and stops blocking.
41. The tab polls `GET /api/releases` every ~3 s while any repo is checking, and stops when none is.
42. Every tag newer than the candidate is listed with why it does not qualify; with a baseline a reason from
    an earlier tag names it ("BMD-1040 (from 0.391.0) is In Progress.").

Fast scan (the one history pass, 2026-11-15; early answer 2026-11-16)
43. NO EARLY CANDIDATE (cumulative rule): part way through the pass, a tag read and Complete is still
    "Checking…" with the history line until the pass reaches the baseline or the root; a tag ruled out by its
    own tickets is ruled out at once (a release tag whose place is not known yet is a baseline not known yet).
44. INCREMENTAL RESCAN: after a complete pass, a new commit on `main` costs one REST compare and one history
    page (only the new commits are read); a force-pushed `main` (the walked head is not an ancestor) is walked
    again from scratch.
45. BATCHED TICKET READS: 600 Jira tickets are read in 6 searches (`key in (…)`, ≤ 100 keys); a key that does
    not exist splits its batch, never fails the rest; Refresh and Confirm read their tickets in one batch too.
46. NO FULL PR SYNCS: the scan creates no `pull_requests` row; PRs already stored still lend their links,
    author and PR tab.

Simple rule (2026-11-16)
47. NOTES SCOPE: with a release the notes list everything since it ("Stories"); with none, everything up to the
    candidate tag ("Stories") and "First release: everything up to this tag."
48. HISTORY READ TO THE END: a candidate needs its whole scope, so the pass reads to the baseline or the root
    before the check names one (`releaseCandidateProven` is then true and the pass rests).

The ticket list (owner, 2026-11-16)
49. ONE CARD PER TICKET: a ticket with PRs in two repositories is one card, placed by its latest tag in either
    (tags of both repositories by commit date), with the latest tag per repository on it.
50. THE WINDOW: the list opens on the candidate ticket (★, the newest ticket all in the candidates) with one ticket
    either side; "Show next 3 of n" / "Show previous 3 of n" add 3, n = the tickets still hidden that way
    (fewer left: "Show next 2 of 2"); while older tags are unread the total below is not known and not given
    ("Show previous 3").
51. HOLDING THE RELEASE: the ticket stopping the tag above each candidate (a split: its root) is always shown
    above the list, once, naming the repositories it holds; every ⊘ card says "Waits on <that ticket>".
52. NOT IN A TAG YET: a ticket whose only work is an open PR is listed apart at the top.
53. NO-TICKET ROWS: PRs with no ticket are narrow rows between the cards, consecutive ones grouped.
54. MISSING TICKETS: a ticket the tracker could not give is a dashed card, "Not found in Jira — check it by hand";
    it never stops a release and is never the candidate ticket.
55. TICKET TITLES: every reason and every older-tag summary names the ticket's title beside its key, cut at 60
    characters on a word ("BMD-1172 “NEW TEMPLATE: Support individual trees from the new…” is In Code
    Review").
56. PROGRESS OVER 5 SECONDS: the history read, the ticket reads and Refresh each show a bar with a line saying
    what is being read.
57. PICKED TOGETHER: T2's api PR is in v1.1.0 and its web PR in w1.1.0, above web's candidate → api v1.1.0 does
    not qualify ("T2 would ship without web #21 (in w1.1.0).") and api's candidate drops below it; a web PR
    merged after web's newest tag ("not in a tag yet") counts the same; a second PR in the SAME repository
    (in a later tag or not in a tag yet) NEVER does; Cancelled / not-found tickets and a repository still
    checking take no part.
58. CARD DETAIL: a card opens in place to its type, assignee and "Jira status read 4 min ago", "Open in Jira",
    "Story", and every PR for it in the releasable repos — OPEN, merged "in v1.2.0", or "not in a tag yet".
    Nothing is fetched to open it. A ✓ card's line says what was done ("2 PRs, the last by alex").
    Every card with a merged PR shows its newest merge date on its row ("merged 2 Nov"); one with none shows
    nothing.
59. THE CANDIDATE'S COMMIT: the candidate ticket names each repository's candidate and its commit (short sha, a
    GitHub link), with ONE Release…; only repositories with no candidate get a line above the list.
60. BOT PRS: a no-ticket row lists only human PRs until "Show bot PRs" is ticked; its words count the bots.
61. NO-TICKET ROWS OFF BY DEFAULT: until "Show PRs with no ticket" is ticked the list holds only ticket cards (missing
    tickets included).
62. THE RAIL: every row of the list has its mark in a disc on one vertical line; a no-ticket group has a merge mark.

Releasing without version tags (owner, 2026-11-19)
63. AUTO: a ticked repository with no version tag (release / hotfix tags do not count) is released from merged
    pull requests; one version tag ⇒ version tags; "Release from" overrides either way.
64. POINTS: each merged PR's newest first-parent commit is a point `#n`; a rebase merge is one point at its top
    commit; a direct push belongs to the point above it.
65. THE RULE OVER POINTS: PR #2's ticket not Complete ⇒ the candidate is #1 and #4, #3, #2 say why.
66. THE RELEASE TAG is `<YYYY.MM.DD><suffix>`, `.2` when taken; it lands on the point's commit and is the next
    baseline (only later PRs are new; nothing merged since ⇒ "Nothing merged since …").
67. CONFIRM: the point's commit no longer on the default branch ⇒ stopped, nothing written.
68. SPEED: 1,500 merged PRs with the oldest held fold in well under a second (each point's reasons are whole;
    only the candidate, the tag the walk stopped at and the oldest read list their whole scope).

## Implementation

(Filled in as it lands: modules, tables, routes, tests.)

### Slice 1 — data and sync foundation

- **Settings.** `workspaces.release_suffix` / `hotfix_suffix` (migration `0195`, NULL = not set, no
  default). Shared `packages/shared/src/releases.ts`: `validateReleaseSuffix`, `validateReleaseSettings`
  (the ONE validator, route and form), `normaliseReleaseSuffix`, `releaseSettingsConfigured`, `tagKind`
  (`'release' | 'hotfix' | 'version'` by NAME; a version tag also needs `on_default_branch`),
  `releaseTagName`, types `ReleaseSettings` / `ReleaseSettingsResponse` / `SetReleaseSettingsBody`.
  `db/release-settings.ts` (`getReleaseSettings`, `setReleaseSettings`, `workspaceHasReleases`,
  `getReleaseSettingsResponse`). Routes `GET`/`PUT /api/workspaces/:id/release-settings`
  (`api/routes/releases.ts`, tier `read`); client `releaseSettings` / `setReleaseSettings`.
- **`pull_requests.merge_commit_oid`** from `mergeCommit { oid }` in `PR_NODE_FIELDS` (walk and single-PR
  read); `sync/upsert.ts` `mergeCommitOidToWrite` (null only for a PR GitHub says is not merged).
- **Tag sync.** `repo_tags` + `repos.tags_signature` / `tags_synced_at`; `github/tag-queries.ts`;
  `sync/repo-tags.ts` (`syncRepoTags`, `syncRepoTagsSafe`, pure `foldTagRefs`, `tagSignature`,
  `planTagWrites`, `ancestryTargets`, `ancestryFromCompareStatus`). Newest 100 by `TAG_COMMIT_DATE`, the
  rest logged as not read. Ancestry: REST compare `tag...head` (`per_page=1`), ≤ 20 per sync.
- **Ranges.** `repo_tag_ranges` holds each tag's INCREMENT (previous default-branch tag, tag] — suffix-free,
  so a new baseline or a suffix change needs no recompute; the release check sums increments from the
  baseline. Same-commit tags (a release tag on its version tag) are empty. `sync/tag-ranges.ts`
  (`computeTagRanges`, pure `planTagRanges`, `compareTagOrder`, `rangePrNumbersFromAssociated`).
  Commit → PR: `merge_commit_oid`, then stored PR `commits`, then GraphQL `associatedPullRequests`;
  PRs merged into the default branch only. The OLDEST tag has no base: method `'history'` = stored PRs
  merged into the default branch no later than its commit.
- **Wiring.** `sync/tags-step.ts` `runTagsStep` (after `syncBranchStatus` in `sync-repo.ts`, own
  non-fatal guard, not for external repos, tag read at most every 15 min from a walk) and
  `scheduleTagSync` (the settle sweep: `refs(first: 1)` in `github/settle-query.ts`; `observedTagSig`,
  `tagSyncDue` in `sync/settle-sweep.ts`).
- **Release tables** (schema only, no writer yet): `releases`, `release_items` (unique
  `(account, repo, release_tag_name)` across releases), `release_ticket_comments`. All five new tables:
  composite FKs, `accountScopedTables()`, erased explicitly; `deleteRepo` drops tags/ranges/items;
  `deleteWorkspace` re-homes releases to Default.
- **Reads for the next slice:** `db/repo-tags.ts` `getRepoTags(accountId, repoIds)` and
  `getTagRanges(accountId, repoIds)` (PR numbers resolved to ids; unstored numbers kept).
- **Tests:** `api/routes/release-settings.test.ts` (acceptance 1–3 at the settings level),
  `sync/repo-tags.test.ts`, `sync/tag-ranges.test.ts` (acceptance 4 ranges, 13 hotfix PRs excluded).
- **Deferred:** the release check fold, the Releases tab, the release writes, notes, hotfix; the
  Settings → Releases form (only the route + client exist); a `merge_commit_oid` backfill for already
  synced merged PRs (unmatched commits fall back to `associatedPullRequests`); the data export does not
  include the new tables yet.

### Slice 2 — the release check fold and its read route

- **The fold** is shared `packages/shared/src/release-check.ts` `foldReleaseCheck(input)` (pure, no
  clock, no fetch). Inputs per repo: stored tags + range increments; PRs (`isBot` by
  `globalAutomationUserIds`, `intoDefaultBranch`, state, ticket idents); tickets (`done`, read state);
  accepted repos (`sprint_ticket_repos`). It sums each version tag's increments after the baseline (in
  `compareTagOrder`, now shared and re-exported by `sync/tag-ranges.ts`), blocks on not Done /
  unreadable / open PR into the default branch, then runs SHIPS WHOLE to a fixpoint (`rounds`). An
  increment missing or stale (moved tag, changed base) is `range_pending`: that tag cannot be a
  candidate yet. Also `releaseSelectionProblems(result, includedRepoIds)` (the dialog's untick
  re-check, acceptance 18) and `releaseBlockerText(blocker, ctx)` (the sentences, e.g. "PLAT-290 holds
  api at v2.4.0: its web PR #21 is merged but not in a version tag yet. Cut a tag in web.").
- **Reading of "ships whole".** A ticket is held when the candidates would ship SOME of its merged PRs
  into the default branch while another is outside its repo's candidate; once held it stays held (so
  the rounds are monotone and end). A ticket wholly past every candidate ships nothing, is `ready`,
  and holds nothing (`inRelease: false`). A merged PR in no stored range is "not in a version tag yet",
  unless it merged no later than the oldest stored range's floor (older than the read history: treated
  as shipped).
- **The DB half** `apps/backend/src/db/release-check.ts`: `loadReleaseCheckInput`, `getReleases`, pure
  `ticketIsDone` (THE This Sprint resolver: `sprintStageOf` over `sprintLayoutFor`, category fallback
  when the sprint was never read; "Won't do" → Cancelled, so NOT Done) and `bestTicketRow`. Ticket links are
  `tracker_tickets` rows on the workspace's CURRENT tracker site only (`workspaceSite`); rows of another
  site are not links. A fresher `sprint_tickets` status wins over the PR rows'.
- **Route** `GET /api/releases?workspace=` (`api/routes/releases.ts`, tier `read` in `tierFor`), client
  `api.releases`, wire type `ReleasesResponse`. docs/API.md § Releases.
- **Tests:** `db/release-check.test.ts` (acceptance 4–18 by number on the pure fold, plus pending /
  moved increments, an existing release tag name, latest release vs baseline, one-repo ships whole;
  `ticketIsDone`; `getReleases` on a throwaway DB), `api/routes/release-settings.test.ts` (the route:
  Default fallback, acceptance 3 at the check level), `rate-limit.test.ts`, `verify:isolation` (the
  release check never reads another account's workspace, repo or PRs).
- **Deferred:** the Releases tab, the dialog, the writes, notes, hotfix. "Refresh" (acceptance 6) is
  the tracker worker's next read of the ticket; a forced re-read belongs to the tab's slice. Direct
  commits (`unmatchedCommits`) and truncated compares are reported per tag but never block; PR numbers
  in a range that are not stored yet are ONE `unsynced_prs` warning per repo.


### Slice 3 — creating a release: the writes, the notes, the tracker comment

- **Shared, pure** `packages/shared/src/release-write.ts`: the dialog SNAPSHOT (`releaseSnapshotOf`,
  `releaseShippedTickets`) and `releaseSnapshotChanges(before, after, {liveShaChanged, unread})` (the
  sentences that stop Confirm); the NOTES (`releaseNotesInputOf(result, repoIds, summaries)` →
  `releaseNotesSection` per repo = that repo's pre-release body, `releaseNotesDocument`, `notesText` —
  markdown escaped, an `@name` put in code so it notifies nobody, `candidatePrIds`); the summary gate
  `cleanStorySummary` (any `\p{Nd}\p{No}\p{Nl}` numeral or the product's name ⇒ null); the COMMENT
  (`releaseCommentLines` — exactly the spec's three lines — `releaseCommentWiki`, `jiraWikiPlain`,
  `releaseDateWords`); `releaseTagMessage`; `releaseStepLines` (the per-step result list) and
  `releaseFinalState`. Wire types `ReleasePreviewBody/Response`, `CreateReleaseBody/Response`,
  `ReleaseDetail`, `ReleaseSnapshot`, `RELEASE_NOTES_SECTION_MAX`.
- **Backend** `apps/backend/src/releases/`: `github.ts` (`releaseGithubFor(token)`: `readTagSha` over
  `git/ref/tags/<name>` peeled, `createReleaseTag` = `git/tags` + `git/refs` with a 422 on the ref read
  as "exists", `createPrerelease`; the two writes are `github/mutations.ts` `createAnnotatedReleaseTag` /
  `createGithubPrerelease` through `limnWrite` with the `'reader'` origin — new `LimnActionKind`s
  `release_tag` / `prerelease`, never ledgered today), `notes.ts` (`storySummaryInputs`, `storySummaries` — ≤ 30 stories, 4 at
  once, an in-memory 30-min memo; `modelStorySummary` through `cheapComplete`, usage recorded, never
  gated: a reader's click), `create.ts` (`previewRelease`, `createRelease`, `getReleaseDetail`,
  `releaseTagStored`, `ReleaseRequestError`, the `ReleaseWriteDeps` seam with `defaultReleaseWriteDeps`).
- **Confirm** (`createRelease`): tickets re-read through `syncOnePrNow` (`force: true`; documented in
  TRACKERS.md § The release comment), the check re-run, each snapshot version tag read live; any change
  ⇒ `{outcome: 'stopped', changes}` and NO row. Then one `runTransaction` inserts the `releases` row and
  its items (`onConflictDoNothing` on the cross-release tag-name unique: an earlier press owns that
  name, said as a step); a release tag name GitHub already has is inserted `refused`. Tags, then
  pre-releases (only on tags that landed), then comments (only for tickets whose repos ALL tagged in this
  release; Jira only, others `skipped` "not supported yet"), each claimed `pending → claimed` by
  compare-and-set before the call and never retried. Then the tags step per tagged repo (settle) and a
  check the release tag is stored at its commit (verify; else "It will show up here shortly").
- **Routes** (`api/routes/releases.ts`): `POST /api/releases/preview` (tier `ai` + `ai_hourly`),
  `POST /api/releases` (tier `search` + `github_write`), `GET /api/releases/:id` (tier `read`); client
  `api.releasePreview`, `api.createRelease`, `api.release`. docs/API.md § Releases.
- **Tests:** `releases/release-write.test.ts` (acceptance 18/21 change lists, 22 step lines, 32 notes AI
  off / on, 33 no "Ensemble", the digit gate, the comment's exact lines), `releases/create.test.ts` on a
  throwaway DB with fake GitHub / tracker (acceptance 18 at Confirm, 19, 20, 21, 22, 23; an unread
  ticket and a moved version tag stop Confirm; a claimed-and-failed tag is never written again; another
  tracker's "not supported yet"; edited notes reach the pre-release; preview AI off / on),
  `rate-limit.test.ts`, `verify:isolation` (another account's release id reads nothing; Confirm naming
  another account's repo is refused).
- **Deferred:** the Releases tab and the dialog UI (the routes and client methods exist), so no user
  docs or CHANGELOG entry yet; `release_ticket_comments.comment_id` (`postTicketComment` returns no id);
  a `stopped` release row (nothing is recorded for a stopped Confirm); hotfix. Confirm runs its writes
  inside the request (a few GitHub calls per repo); a very large release could be slow to answer.

### Slice 4 — the Releases tab and Settings → Releases (frontend)

- **This Sprint → Releases** is the 4th inner tab (`SprintInnerTab` `'releases'`, `SPRINT_RAIL_TABS`,
  key `4`, `?sprintTab=releases`, ⌘K "This Sprint: Releases"). `SprintTabView` mounts
  `components/Sprint/ReleasesView.tsx` in place of the lane board. One fetch on mount, `GET /api/releases`
  (`hooks/useReleases.ts` `useReleases`, key `['releases', ws:<id>]`); nothing renders while `workspaceId`
  is null; not configured ⇒ one setup line with "Set up in Settings" (`openSettings('releases')`).
- **The view**: header ("Latest release: none / 12 Nov", ⓘ with the rules, "View notes" for the newest
  release made here, Refresh, "Create release…"); the no-baseline line; repo rows that expand to their
  version tags newest first (candidate starred, held tags with `releaseBlockerText`, PRs → PR tabs, ticket
  chips → `useOpenStory()`); the tickets panel (per repo ✓/✗/⚠ marks through Icons.tsx); warnings.
- **The dialog** `components/Sprint/ReleaseDialog.tsx` (`ReleaseDialog`, `ReleaseDetailModal`, on
  `InfoModal`): the preview is read only while it is open (`useReleasePreview`, once, for every
  releasable repo); unticking re-checks through the shared `releaseSelectionProblems` and HIDES Confirm,
  naming the ticket; editable notes per ticked repo (only edited sections are sent); the comment preview
  (its tag line follows the ticks); Confirm sends `releaseSnapshotOf(check, ticked)`; a stopped Confirm lists
  `changes` ("Nothing was written."); a written one shows `steps` and the pre-release links
  (`safeExternalUrl`). `useCreateRelease` (shared mutation key, `useCreatingRelease`) re-reads the check,
  the settings and drops the preview when it settles.
- **Pure helpers** `components/Sprint/releasesModel.ts`: `releaseDayWords`, `latestReleaseLine`,
  `releaseWordsContext`, `shortBlocker`, `repoFirstBlocker`, `repoRowText`, `ticketRepoMark`,
  `ticketsPanelRows`, `releaseWarningText`, `releasableRepos`, `showCreateRelease`, `defaultTickedRepoIds`,
  `confirmStops`, `editedSections`, `releaseTagsLine`.
- **Settings → Releases**: a new Settings tab `releases` (`settingsTabs.ts`, focus `'releases'`) holding
  `settings/ReleasesSection.tsx` — two fields, the shared `validateReleaseSettings` inline, and
  `settings/releasesSectionModel.ts` `releaseSuffixChangeWarning` shown before the Save once a release
  exists (acceptance 3).
- **E2E fixtures**: `GET /api/releases` (not configured) and `GET /api/workspaces/:id/release-settings`
  in `apps/frontend/e2e/mock-api.ts`, typed.
- **User docs**: `/docs/this-sprint/releases`, `/docs/settings/releases`, a line on This Sprint's overview,
  CHANGELOG Unreleased.
- **Tests**: `apps/frontend/test/releasesModel.test.ts` (acceptance 3, 4, 5, 7, 12/24, 14, 15, 17, 18 over the
  real shared fold; the header line; hidden Create release; edited sections), `settingsTabs.test.ts`,
  `sprintModel.test.ts` (the 4th tab).
- **Deferred / deviations:** Refresh is the This Sprint tracker read plus a re-read of the check — tickets
  outside the current sprint update on the tracker worker's next read (no forced per-ticket re-read route).
  The ticket chip opens the story TAB (`useOpenStory()`), not This Sprint's tray (the tray is the lane
  boards'). Only the newest release made here can be viewed again (no release list route). The landing's
  `SprintLanesMock` still shows the three lane boards only (it mirrors the boards, not this tab). Hotfix is
  still to come.

### Slice 5 — hotfix builds (Implement's "Treat as a hotfix")

The flow and its rules: [STORY-BUILD.md](STORY-BUILD.md) § Hotfix builds.

- **Migration `0196_story_build_hotfix`** (registered in the journal): `story_builds.hotfix`; on
  `story_build_repos` `hotfix_tag`, `read_only`, the MAIN FIX columns `main_base_ref` / `main_base_sha` /
  `main_sandbox_path` / `main_patch` (+ sha, stat, files, commit message) / `main_status` / `main_error`, PR 2's
  push record `main_pushed_*` + `main_push_error(_code)`, and `hotfix_branch_json`. No new table (the rows are
  already erased and exported).
- **Shared** `packages/shared/src/hotfix.ts`: `hotfixBasesOf` (the bases fold, through the new
  `release-check.ts` `latestReleaseTag` — the release check's `latestRelease` now calls it too, ONE rule),
  `hotfixPatchVerdict` (the read-only refusal), `hotfixPushTargets`, `hotfixBranchName`,
  `hotfixMainBranchName`, `hotfixBranchState`, `hotfixPairLine`, the lines `HOTFIX_NO_LOOP_LINE` /
  `HOTFIX_NOT_OFFERED_LINE` / `hotfixReadOnlyLine`, the wire `StoryBuildHotfixBasesResponse`,
  `StoryBuildRepoHotfix` (`StoryBuildRepo.hotfix`), `StoryBuildHotfixBranch`; `StoryBuild.hotfix`,
  `SandboxSessionStartBody.hotfix`, `StoryBuildDiffResponse.target`, the error codes `HotfixNotOffered` /
  `HotfixNoLoop`, `STORY_BUILD_API.hotfixBases`, the `LimnActionKind` `'hotfix_branch'`.
- **Backend**: `db/hotfix-bases.ts getHotfixBases`; the story subject (`sandbox/session/manager.ts`):
  `hotfixBasesFor` (release checkout at the tag via `remoteRef: refs/tags/<tag>`, main checkout pinned by
  `base-refs.ts storyBuildMainRef`, stacking off, read-only repositories), `extractHotfix`, the main patches put
  back on Resume, no review loop; `sandbox/workspace/hotfix.ts mainCheckoutPaths` + `prepareSessionWorkspace`'s
  `hotfix` option (the second mirror) + `hotfixSeedOf`; `seed.ts hotfixSection` (+ one system-prompt line);
  `plan.ts planBuildInstruction({hotfix})`; `approvePlanRevision({writePrs: false})`;
  `coding/story-build/push-hotfix.ts pushHotfixRepo` (seam `setHotfixPushDepsForTests`), dispatched from
  `push.ts pushRepo`; `github/mutations.ts createHotfixBranch` (origin `reader`) + `fetchOpenPrsOnBase`.
- **Routes**: `GET /api/story-builds/hotfix-bases?workspace=` (DB only, tier `read`, pinned in
  `rate-limit.test.ts`); `POST /api/story-builds` takes `hotfix` (`400 HotfixNoLoop` / `HotfixNotOffered`);
  `…/loop/settings {on: true}` and `…/auto-push {on: true}` answer `409 HotfixNoLoop` on a hotfix build;
  `GET …/repos/:repoId/diff?target=main`. The push is the existing `github_write` route.
- **Frontend**: the Start panel's "Treat as a hotfix" box and base list (`useHotfixBases`), the build tab's
  two diffs ("Release fix" / "Main fix"), both PR links, the moved-branch line and "Push both as drafts"
  (`lib/hotfix.ts`; `canPushRepo` counts a main-only fix). E2E fixture for `GET …/hotfix-bases`.
- **User docs**: `/docs/implement-story/hotfix`, a line on Implement's overview, CHANGELOG Unreleased.
- **Tests**: `coding/story-build/hotfix.test.ts` (acceptance 1, 25, 26, 28, 29, 30: the bases, the read-only
  verdict, the targets and branch names, the moved state, the pair line, the main paths and pin key, the seed
  byte-identical without a hotfix, the build turn); `coding/story-build/push-hotfix-db.test.ts` (25, 28, 29, 31:
  the bases from the DB, the two PRs and the body edit, a moved branch, a second press writing nothing, read
  only, permission, the review-loop refusals, `?target=main`); `sandbox/session/session-flow-db.test.ts` § a
  hotfix build (1, 25–27 over the real routes and manager: the start refusals, both checkouts, the seed, both
  patches stored apart and a read-only change refused, no loop); `apps/frontend/test/hotfixBuild.test.ts`.
- **Deferred / deviations:** acceptance 27's "conflicting port resolved by the agent" is the agent's work in
  the sandbox (told by the seed and the build turn); Ensemble checks nothing about the port beyond storing both
  patches, and the build report is unchanged (one entry per planned PR). A hotfix repository's PRs are not
  stacked and cannot be renamed after `BRANCH_EXISTS` (the push says so; discard and start again). The main
  checkout is a second mirror of the repository (`<path>.main`), not a git worktree: the agent ports by fetch +
  cherry-pick between the two, or by hand. The Codex and Claude seeds differ only in the existing file names; no
  Claude prompt golden changed. The landing's build-tab mock does not show a hotfix build.

### Slice 6 — docs, landing mock, changelog, final consistency

- **Landing mock**: `SprintLanesMock` (`apps/landing/src/components/mock/reports.tsx`) now has the app's FOUR
  This Sprint tabs; the 4th, Releases, is `ReleasesPanel` (latest release, a row per repository with the
  candidate starred, the tickets with their per-repo marks, the warnings, and a clickable "Create release…"
  that shows what the dialog would write). Data: `SPRINT_RELEASES` in `src/mock/acme.ts`, worded with
  `Sprint/releasesModel.ts`'s sentences. A new `initialView` prop opens it on Releases, used on
  `/docs/this-sprint/releases`. The mock → component table in `apps/landing/README.md` names
  `Sprint/ReleasesView.tsx` and `releasesModel.ts`. Styles: `.rp-releases` in `mock.css`.
- **User docs and CHANGELOG**: the pages `this-sprint/releases`, `settings/releases` and
  `implement-story/hotfix`, and the three Unreleased "Added" entries, landed with slices 4 and 5; checked
  here, unchanged.
- **Topic docs**: FRONTEND (§ This Sprint, the Releases tab), DATA-MODEL (§ Releases, the hotfix columns),
  API (§ Releases and the story-build hotfix routes), SYNC (§ Tags), TRACKERS and STORY-BUILD were checked
  against the code: every new route and table is documented.
- **CLAUDE.md**: a RELEASES row in the doc map and one invariant line under This Sprint (the check is ONE
  pure shared fold, DB only on a view; `repo_tag_ranges` holds per-tag increments). To stay under 48,000
  bytes (now 47,998), three links that repeat the doc map became plain text, and the Security section's
  "Read docs/SECURITY.md before …" sentence moved into the doc map row ("AI routes").
- **Deferred**: the release tables are still not in `GET /api/me/export` (they are erased); no Playwright
  spec for the Releases tab or a hotfix build; no landing mock of a hotfix build.

### Fix stage — review findings

- **The range window reaches back to every baseline.** `planTagRanges(tags, stored, {settings})` keeps (and
  computes) every range after the OLDEST baseline any configured workspace gives, not just the newest
  `TAG_RANGE_WINDOW` (now shared, 40); shared `tagRangeKeepFrom`; `db/release-settings.ts`
  `configuredReleaseSettings`. With NO baseline, the fold treats a tag older than the window like a PR older
  than the synced history (not checked; the no-baseline line says so) instead of `range_pending` forever.
- **A stored range is final, so it must be complete.** The GraphQL fallback now asks about EVERY unmatched
  commit (`COMMIT_PR_FALLBACK_MAX` = `TAG_RANGE_MAX_COMMITS`); one that pauses for the budget is NOT stored
  (counted `pending`, retried next sync). A TRUNCATED compare now HOLDS its tag: `range_pending` with
  `reason: 'too_large'` ("v1.1.0 has more commits than can be read, so its changes cannot be checked.").
  Commits the fallback confirmed have no PR (direct pushes) still only show as a note.
- **The 'history' range is read fresh** (`db/release-check.ts` `historyPrIds`): PRs the deep backfill stores
  after the row was computed enter it.
- **A range PR whose ticket the worker has not read** (no `tracker_tickets` row) is found with THE detection
  rule (`detectKeysWithAccess` over title + head branch + stored links, DB only) and BLOCKS as `not_read`
  (a sprint read of it counts as a read). Confirm re-reads it like any other ticket.
- **Refresh** is `POST /api/releases/refresh?workspace=` (`releases/refresh.ts` `refreshReleases`, pure
  `ticketsToRefresh`; tier `search`): the tickets the check holds by their OWN state (not Done, unreadable),
  at most 30, read again from the tracker through `syncOnePrNow(force)` — the worker never re-reads a MERGED
  PR's ticket on a TTL. A reader's press (docs/TRACKERS.md exception), never a view. Client
  `api.refreshReleases`, hook `useRefreshReleases`; the tab names tickets the tracker did not answer for.
- **Preview and Confirm fold the check over the WHOLE workspace** and apply the selection after
  (`releasable`, `releaseShippedTickets`, `releaseSelectionProblems`), so a ticket's other repos are always
  seen. The test fake now honours the repo ids it is given.
- **A failed or refused release tag no longer holds its name.** Migration `0197_release_items_live_tag`
  replaces the full unique with a PARTIAL unique on live rows (`tag_state IN ('pending','claimed','done')`,
  in the .sql only). A later press is a new claim on a new row; a live earlier row is named by its state
  ("was already made…", "is being made by an earlier release, or that release stopped part way…"). A press
  where no repo gets a row records NO release (answered `stopped`, nothing written).
- **Ancestry**: never-asked tags are asked before re-asks of off-branch tags, one request per commit, and a
  tag on the commit of a tag known on the branch inherits it (`inheritedAncestry`) — a fresh release tag is
  never starved by older hotfix tags.
- **Hotfix push** names the PRs open on `hotfix/<tag>` whenever the branch already existed, moved or not
  (acceptance 29); the tab says "hotfix/v2.4.0-rc already exists. Already on it: #50 …".
- **Not changed:** `summariesAvailable` already answers for the ACTIVE provider (`detectClaudeAuth` is the
  per-provider pre-flight despite its name) and `cheapUsage` prices a Codex answer as Codex.
- **Tests:** `db/release-check.test.ts` (the 50-tag window, a truncated compare, Refresh's picks, the
  not-read detected ticket, the fresh history range, acceptance 6 through `refreshReleases`),
  `sync/tag-ranges.test.ts` (the window reaches the baseline, the budget-paused range not stored),
  `sync/repo-tags.test.ts` (never-asked first, inherited ancestry), `releases/create.test.ts` (whole-workspace
  check, failed-tag re-press, a claimed earlier row, no empty release), `coding/story-build/push-hotfix-db.test.ts`
  and `apps/frontend/test/hotfixBuild.test.ts` (acceptance 29 at the release commit), `rate-limit.test.ts`.

### Port report

The agent's per-repository verdict on the port to the default branch, checked against the two diffs. The flow
and its rules: [STORY-BUILD.md](STORY-BUILD.md) § Hotfix builds → The port report.

- **Migration `0198_story_build_port_report`** (registered in the journal): `story_build_repos.port_report_json`
  (shared `HotfixPortClaim`; NULL = no report). The flag and the files comparison are derived on read.
- **Shared** `packages/shared/src/hotfix.ts`: `HotfixPortOutcome` (`same` / `adapted` / `not_needed`),
  `HotfixPortClaim`, `hotfixPortClaimOf` + `hotfixPortText` (the host's clip: one line, reason ≤ 600 characters,
  ≤ 10 evidence entries of ≤ 200), THE FOLD `hotfixPortOf` (the claim vs the patches: `not_needed_but_changed`,
  `ported_but_unchanged`; `hotfixPortFilesOf`: `same` / `some_differ` / `none_in_common`), the words
  (`HOTFIX_PORT_OUTCOME_WORDS`, `HOTFIX_PORT_FLAG_WORDS`, `HOTFIX_PORT_FILES_WORDS`, `HOTFIX_PORT_NO_REPORT`,
  `hotfixPortLine`), the PR body's `hotfixPortBodyLine` (null with no claim or a flag), `hotfixPairLine({adapted})`,
  the wire `StoryBuildHotfixPort` on `StoryBuildRepoHotfix.port`. `release-check.ts`: the repo state `hotfix_only`.
- **Backend**: `sandbox/workspace/port-report.ts` (`PORT_REPORT_VALIDATOR_SOURCE` — ONE validator for the
  sandbox checker and the host — `validatePortReport`, `portClaimsOf`, `portReportFiles`, `readPortReport`,
  `portReportInstructionLine`); `seed.ts` (the hotfix section's investigate-then-port steps and the report, the
  checker + context files, one system-prompt line — hotfix only); `plan.ts planBuildInstruction({hotfix})` and
  `manager.ts buildInstruction({hotfix})` (the report line); `manager.ts extractHotfix` (reads, checks and
  stores the claims); `persist.ts storyBuildRepoPort` (the wire); `push-hotfix.ts hotfixPrBody` (the body line).
- **Frontend**: `lib/hotfix.ts hotfixPortView`; `BuildSection.tsx` (the line, the files, the ⓘ, the flag beside
  Push); `releasesModel.ts ticketRepoMark('hotfix_only')` ("hotfix only").
- **User docs**: `/docs/implement-story/hotfix` § The port report; CHANGELOG Unreleased.
- **Tests**: `coding/story-build/hotfix-port.test.ts` (34–37 over the fold; the validator and the host's clip;
  the checker run in Node; the seed and build instructions — hotfix only, an ordinary build byte-identical; the
  release check's `hotfix_only`), `coding/story-build/push-hotfix-db.test.ts` (34–37 through Push: PR 1 alone with
  its reason, defanged; both bodies; a flagged claim not sent; no report), `sandbox/session/session-flow-db.test.ts`
  § a hotfix build (the report read from the sandbox and stored; an entry for a read-only repository dropped and
  named), `apps/frontend/test/hotfixBuild.test.ts` (34–37: the tab's lines).
- **Deviations:** the report is a FILE the agent writes and checks (as the build and fix reports are), not a
  tool call, so Claude and Codex share one handler. A `not_needed` repository whose main checkout changed still
  opens both PRs (the patches win; the flag says so). The landing's build-tab mock still shows no hotfix build.

### Releasable repos and start tag (2026-11-15 rework)

> ⚠ SUPERSEDED in part by § Automatic candidate below: the start tag (its route, UI and fold input), the
> 40-tag window, the per-sync caps and the `unsynced_prs` warning are REMOVED. The releasable ticks stand.

The owner tried the tab on real data (~10 repos, two released): nothing was releasable — no release tag
meant ranges back through all history that never caught up, test repos blocked through "ships whole", and
the tickets panel said "released" for PRs older than the checked history. The rework, as decided:

- **Migration `0199_workspace_release_repos`** (registered in the journal): `workspace_release_repos` — one
  row per `(account, workspace, repo)` ticked "Released from this workspace", holding the START TAG
  (`start_tag_name` / `start_tag_sha` / `start_set_by_login` / `start_set_at`). Composite FKs to workspaces and
  repos (cascade); `accountScopedTables()`, erased explicitly; `deleteRepo` and `deleteWorkspace` delete their
  rows (a tick is never re-homed to Default). The same migration prefixes `-` to any stored suffix that lacks it.
- **Shared** `releases.ts`: `RELEASE_SUFFIX_PREFIX`, `suffixTypedPart`, `suffixFromTyped`;
  `normaliseReleaseSuffix` puts the hyphen in front when missing; `validateReleaseSuffix` checks the TYPED part
  (no leading hyphen); `validateReleaseSettings` compares typed parts; `ReleaseSettingsRepo`,
  `ReleaseSettingsResponse.repos`, `SetReleaseReposBody`. `release-check.ts`: THE FOLD REWRITTEN — each repo
  on its own; blockers are `not_done` / `unreadable` / `too_large` only (`not_whole`, `open_pr`,
  `range_pending`, the `linked_no_pr` warning, `acceptedRepos`, `rounds`, `releaseSelectionProblems` and the
  `released` / `merged_after_candidate` / `open_pr` / `linked_no_pr` / `hotfix_only` ticket states are
  REMOVED); ticket repo states `in_candidate` / `after_candidate`; repo status `reading`; per repo
  `latestVersion`, `baseline.kind` (`release` / `start`), `startTag` (+ `problem` `moved` / `missing`),
  `reading`, `versionTags` (the picker, ≤ 100). `releaseBaselineOf` (THE baseline: newer of the newest release
  tag and the start tag) and `tagRangeKeepFrom(ordered, all, views)` (shared by the fold and the range
  planner). With no baseline only the newest `TAG_RANGE_WINDOW` tags are listed and checked.
  `ReleasesResponse.hasReleasableRepos`; `SetReleaseStartTagBody`; `ReleasePreviewResponse.problems` removed.
  `hotfix.ts`: `HotfixBaseRepoInput.releasable` / `StoryBuildHotfixBase.releasable` — an unticked repo has no
  base (read only).
- **Backend**: `db/release-repos.ts` (`getReleaseRepos` ∩ current membership, `setReleaseRepos`,
  `setReleaseStartTag`, `releaseRangeViews`); `db/release-check.ts` loads ONLY ticked repos (and only range
  PRs — no other PRs of a ticket); `db/release-settings.ts` lists the repos with their ticks
  (`configuredReleaseSettings` removed); `db/hotfix-bases.ts` passes `releasable`; `releases/create.ts` folds
  over the releasable repos and refuses another id (`400 NotReleasable`); no untick re-check.
- **Sync**: `sync/tags-step.ts` reads `releaseRangeViews` once per run — releasable repos get ancestry checks
  (`ANCESTRY_CHECKS_RELEASABLE`, every tag read) and ranges (`TAG_RANGES_PER_SYNC` now 40, the whole window);
  others get neither (stored ranges dropped); an external repo runs the step only when releasable; work left
  ⇒ `markTagCatchUp`, taken by the settle sweep after 60 s (`takeTagCatchUp`). `sync/tag-ranges.ts`
  `planTagRanges({views})` keeps ranges only after each releasing workspace's baseline. `sync/repo-tags.ts`
  takes `ancestryCap` and reports `ancestryLeft`.
- **Routes**: `PUT /api/workspaces/:id/release-repos` (tier `read`, the workspaces line) and
  `PUT /api/releases/start-tag?workspace=` (tier `read`, decided in `tierFor`); both DB only, both mark the
  repo for catch-up. Client `api.setReleaseRepos`, `api.setReleaseStartTag`; hooks `useSetReleaseRepos`,
  `useSetReleaseStartTag`. docs/API.md § Releases.
- **Frontend**: Settings → Releases — the fixed "-" beside each suffix box, and a "Released from this
  workspace" section (a tick per member repo, saved whole). This Sprint → Releases — ONE setup line also when
  no repo is ticked; no tickets panel; rows show the pair (`repoRowText`, `repoRowCounts`,
  `repoReadingNote`); the expanded row lists tags with tickets (`tagContents`, `ticketMark`), "Start from this
  tag", and the start line (`startTagLine`, Change = a `Select` over `versionTags`, Clear). The dialog's
  `confirmStops(ticked)` only refuses an empty selection. `lib/hotfix.ts` `hotfixBaseLine`: "not released from
  this workspace — read only". The landing mock (`ReleasesPanel`, `SPRINT_RELEASES`) shows the pair and one
  expanded row. E2E fixtures carry `hasReleasableRepos` and `repos`.
- **Tests**: `db/release-check.test.ts` (acceptance 4–18 on the new fold; the unticked repo in the DB half),
  `api/routes/release-settings.test.ts` (acceptance 1–3, the hyphen, the ticks route, the start-tag route),
  `sync/tag-ranges.test.ts` (ranges only after the baseline, a start tag, no view ⇒ none),
  `sync/tags-step.test.ts` (the catch-up, the caps, an unreleased external repo), `releases/create.test.ts`
  (each repo on its own, `NotReleasable`), `coding/story-build/hotfix.test.ts` (an unticked repo is read only),
  `apps/frontend/test/releasesModel.test.ts`, `hotfixBuild.test.ts`, `rate-limit.test.ts`, `verify:isolation`.
- **Decisions**: unticking deletes the row, so a re-ticked repo starts with no start tag. The start-tag picker
  lists at most the 100 newest version tags on main (the tag read's cap). A repo in two workspaces gets ranges
  from the OLDER of their baselines. An External repo that is ticked runs the tags step, but its PRs are only
  light-synced, so range PRs not stored yet show as "not synced yet" warnings. The agent's hotfix seed still
  says "no release yet" for a read-only repository (prompt text unchanged); the user-facing lines say "no
  release here".

### Automatic candidate (2026-11-15, second rework)

> ⚠ SUPERSEDED in part by § One history pass below: the scan (ancestry compares, per-tag compare ranges, the
> 'history' closed-PR list, the missing-PR full syncs, the PR fetch failures, the worker's priority set) and
> its progress steps (`ancestry` / `ranges` / `prs`) are REPLACED. The fold's rules are REPLACED by § Simple
> rule (2026-11-16).

The owner: no "Start from this tag" — the app works out the starting point; check the WHOLE history it can
reach, fetch what it does not have, and show what it is doing.

- **Removed**: `PUT /api/releases/start-tag` (route, its `tierFor` line and test), `SetReleaseStartTagBody`,
  `api.setReleaseStartTag`, `useSetReleaseStartTag`, the row's start-tag line and picker (`startTagLine`,
  `noBaselineLine`, `versionTags`, `RELEASE_VERSION_TAGS_MAX`), `setReleaseStartTag` / `ReleaseRepoRow.startTag`
  (`db/release-repos.ts`), `ReleaseStartTag`, `ReleaseStartProblem`, `baseline.kind`, `noBaseline`, `reading`,
  `TAG_RANGE_WINDOW`, `TAG_RANGES_PER_SYNC`, the `unsynced_prs` warning. The `workspace_release_repos.start_tag_*`
  columns stay, DORMANT (never read or written, never dropped; DATA-MODEL.md). No migration.
- **The fold** (shared `release-check.ts`, rewritten): `releaseBaselineOf(ordered, settings)` = the newest
  release tag on main; `tagRangeKeepFrom(ordered, views)` = 0 with no baseline. The walk oldest → newest:
  each tag's OWN state `clear` / `held` / `checking` (`ReleaseTagState`); the first `held` holds every later
  tag; a `checking` tag (range missing or stale, a range PR not fetched, a ticket `not_read`, or an
  unknown-ancestry version/release tag sorting at or before it) stops the candidate there. Blockers
  `not_done` / `unreadable` / `pr_unreadable` (new: `ReleaseCheckRepoInput.unreadablePrNumbers`) /
  `too_large`. `ticketsReadable: false` turns `not_read` into a hold. Per tag `alsoHeldBy` (earlier held tags'
  own blockers, deduplicated). Per repo `status` `candidate` / `blocked` / `checking` / `nothing_new`,
  `firstVersion`, `firstBlocker`, `checking`, `progress`, `directCommits`. Per ticket `pending`. Words:
  `releaseBlockerText` (+ the PR sentence), `releaseBlockerShort`, `releaseScanLine`; `releasesChecking` (the
  poll switch).
- **Progress**: the fold DERIVES the first unfinished step from the stored rows (ancestry: dated tags with a
  known answer; ranges: fresh ranges after the baseline, the first missing tag's place; prs: stored + unreadable
  of all range PRs; tickets: read of all range tickets). The scan's LIVE step (`releases/scan-state.ts`
  `noteScanStep` / `liveScanStep`, in memory, fresh for 90 s; never for tickets) is laid over it in
  `db/release-check.ts` `withLiveProgress`, with `paused` ⇒ "(waiting for GitHub's rate limit)".
- **The scan** (`sync/tags-step.ts`): releasable repos only; the tag read pages to `REPO_TAGS_READ_CAP_RELEASABLE`
  (1000); ancestry with no count cap (`ANCESTRY_CHECKS_RELEASABLE`), `runAncestryChecks` against the last head
  on a re-run that skips the read; ranges OLDEST FIRST (`planTagRanges` order, `RangeWork.position`, no window,
  `deadline`, `onProgress`), only once ancestry is done; then `sync/release-scan.ts` `fetchMissingRangePrs`
  (`syncOnePr`, which now notes the GraphQL budget) and `queueRangeTickets`. Time boxes `WALK_RUN_MS` /
  `SCAN_RUN_MS` / `RANGES_SHARE`; `scanNext` (pure) decides `quick` (re-run after `QUICK_RERUN_MS`, ≤
  `QUICK_RERUN_MAX` in a row) / `catch_up` (the sweep, `CATCH_UP_DELAY_MS`) / `done`.
- **Ranges**: `TAG_RANGE_MAX_COMMITS` 10,000 (100 compare pages); the oldest tag's `'history'` range now reads
  GitHub (`github/tag-queries.ts` `fetchClosedPrsPage`, pure `historyPrNumber`, ≤ `HISTORY_MAX_PRS`) on top of the
  stored PRs; the DB half unions the row's numbers with the stored PRs read fresh.
- **Tickets** (docs/TRACKERS.md § Release-range PRs): `db/release-check.ts` `releaseTicketsOwed` (THE detection
  rule, DB only) → `tracker/worker.ts` `queueReleaseTicketReads` (priority set, ≤ 2000) +
  `kickReleaseTicketReads` (no window re-open); `runAccountPass` reads them first, missing-only. Refresh
  (`ticketsToRefresh`) also re-reads tickets not read yet.
- **Frontend**: `releasesModel.ts` `repoRowText` (the new sentences), `repoLatestNote`, `repoProgress`,
  `expandedTags`, `tagExplainer`, `releasesPollInterval` / `RELEASES_POLL_MS` (`useReleases`'s
  `refetchInterval`); `ReleasesView.tsx` draws the bar with `Activity/SprintProgressBar`. Landing mock
  (`SPRINT_RELEASES`, `ReleasesPanel`): the new rows, a checking row with its bar, tag explainers.
- **Cost bounds per run (one releasable repo)**: tag read ≤ 10 GraphQL points (10 pages); ancestry 1 REST call
  per tag asked, within the time box; ranges: per tag ≤ 100 REST compare pages + ≤ 200 GraphQL fallback
  queries (2 points each), the oldest tag ≤ 100 REST list pages; ≤ 120 single-PR syncs (~1–3 points each); the
  tracker: the worker's own per-pass budget (`PER_ACCOUNT_PASS`, 40) per kick. Every loop stops while
  `isBudgetLow` / `isLimited`.
- **Tests**: `db/release-check.test.ts` (acceptance 4–18, 38–42 on the pure fold; `releaseScanLine`,
  `releasesChecking`; the DB half: checking vs a tracker that cannot read, `releaseTicketsOwed`, the live
  overlay, an unreadable PR), `sync/tag-ranges.test.ts` (oldest first, no window, the history from GitHub, the
  deadline and progress, `historyPrNumber`), `sync/repo-tags.test.ts` (paging past 100, no ancestry cap),
  `sync/tags-step.test.ts` (the scan order, `scanNext`), `sync/release-scan.test.ts` (39–40),
  `tracker/worker.test.ts` (39: the priority read of a PR past the 90-day window),
  `api/routes/release-settings.test.ts` (the start-tag route is gone), `rate-limit.test.ts`,
  `apps/frontend/test/releasesModel.test.ts` (rows, 16, 17, 41, 42), `verify:isolation`.
- **Decisions / deferrals**: an External repo's ticket reads go through the tracker of its HOME workspace (the
  worker's existing mapping); the PR fetch failures and live progress are in memory (a restart re-asks); tags past
  1000 are not read (logged); the 'history' range treats "merged no later than the tag's commit date" as "at or
  before it", as before.

### One history pass (2026-11-15, the fast scan)

> ⚠ The fold's upper limit (`upperLimit` / `heldFrom`) and `RELEASE_TICKET_FAILS_HOLD` below are REMOVED by
> § Simple rule (2026-11-16). The history pass stands (it may now stop early).
>
> Supersedes, in § Automatic candidate: the per-tag ancestry compares, the per-tag REST compare ranges, the
> 'history' range's closed-PR list, the missing-PR full syncs, the PR fetch failures and the tracker worker's
> release priority set.

On real repos (hundreds of tags, thousands of PRs, no release yet) the scan made one REST call per tag for
ancestry, one compare per tag, a full single-PR sync per old PR (≤ 120 a burst) and read tickets one by one
(~40 a worker pass). Now:

- **Migration `0202_release_history_pass`** (registered in the journal): `release_history_scans` (one row per
  repo: the deep segment's cursor / expected commit / index / estimate, the tip segment's, `top_sha`,
  `max_base`), `release_history_commits` (one row per first-parent commit walked: `seq`, `pr_numbers`,
  `committed_at`), `release_range_prs` (the LIGHT record per (repo, number)), `tracker_ticket_status` (a
  batched status read per (workspace, ident): state, status, title, url, `attempts`, `fetched_at`). All
  account-scoped, composite FKs (repos / workspaces, cascading), `accountScopedTables()`, erased explicitly;
  `deleteRepo` drops the first three, `deleteWorkspace` the fourth. `repo_tag_ranges` and
  `repo_tags.on_default_branch` / `ancestry_head_sha` are DORMANT (no writer; kept, never dropped).
- **The walk** (`sync/release-history.ts` `walkReleaseHistory`): GraphQL `RELEASE_HISTORY_QUERY`
  (`github/tag-queries.ts`) — `object(oid: <segment start>) { history(first: 100, after:) }`, each commit with
  `parents(first: 1)` and `associatedPullRequests(first: 2)` (merged, base = the default branch, this repo:
  `releases/history-fold.ts` `historyPrsOf`), plus `sinceCount` (commits since the newest release tag's date,
  for the estimate). `walkHistoryPage` keeps the FIRST-PARENT chain (a commit is taken only when it is the
  expected next one, so a merged branch's own commits are passed over). Two segments: DEEP from the first head
  ever read, back until every releasing workspace's baseline commit is met (it PAUSES there, cursor kept, and
  goes on if a baseline moves older) or the root; TIP when the head moved — one REST compare `top...head`:
  `ahead` → the new commits down to `top_sha`, newest first, before the deep segment goes on; anything else
  (or a 404) → everything stored is dropped and the walk starts again. `seq`: deep `-idx`; each tip
  `max_base + 1e9 - idx`, so newer commits sort above. Each page is ONE transaction (commits, light records,
  cursor). Time box + budget pre-emption as before; never throws.
- **The assignment** (`releases/history-fold.ts` `historyView`, pure, on READ in `db/release-check.ts`): the
  commits from this workspace's floor (the newest walked release tag's `seq`) up, newest first; every commit
  takes the tag group most recently passed (the newest tagged commit at or after it); a tag's increment is
  complete once the walk passed the next tagged commit below it (or reached the root); tags on one commit:
  the first in `compareTagOrder` takes the increment, the others are empty. On `main` = walked; off it = not
  walked though the walk covers its date (and no newer head is pending); else unknown. Ranges reach the fold
  as before (method `'walk'`), so the fold's walk is unchanged; `history: {done, total, complete}` is new.
- **The fold** (shared `release-check.ts`): `ReleaseScanStep` is `'history' | 'tickets'`; `releaseScanLine`
  ("Reading main's history: 1,200 of 5,400 commits", "Reading tickets from Jira: 300 of 420", thousands
  separated by `releaseCount`); `releaseProgressPercent`; per repo `upperLimit` and `heldFrom` (the early upper
  limit); a held first tag is `blocked` only once the pass is complete; `ReleaseCheckPr.prId` (the stored PR,
  or null); `unreadablePrNumbers` removed (`pr_unreadable` / `too_large` are no longer produced; kept in the
  type for the words).
- **The DB half** (`db/release-check.ts` `loadReleaseCheck`): PRs from the light records (id = the record's
  id; `prId` when a `pull_requests` row exists); tickets by `releasePrDetectInput` → `detectKeysWithAccess`
  (the stored row when there is one, else the light record — ONE function) plus a stored PR's own
  `tracker_tickets` rows; each ticket's reads from the PR rows, the status rows and the sprint rows through
  `bestTicketRead` (freshest success wins, unless a LATER read said not found or no access — that wins, 2026-11-16; a batched read that failed fewer than
  `RELEASE_TICKET_FAILS_HOLD` (3) times in a row is "not read yet"). `releaseTicketKeysOwed` /
  `ticketKeysOwed`: not read, failed and due after `RELEASE_TICKET_RETRY_MS` (2 min), or older than
  `RELEASE_TICKET_TTL_MS` (10 min). Bot-ness: the light record's own rule (`historyAuthorIsBot`: GitHub typed a
  Bot, `isLikelyBot`, a vendor login) or `globalAutomationUserIds` (the stored author, or the login's user row).
- **Tickets** (`tracker/ticket-status.ts` `readTicketStatuses`; docs/TRACKERS.md § Batched status reads): the
  reader's optional `readStatuses` (Jira: `tracker/jira/statuses.ts`, one search per ≤ 100 keys), else
  one by one through `fetchTicket` (≤ 40 a call). Refresh and Confirm use it (`ReleaseWriteDeps.rereadTickets`,
  `rereadTicketStatuses`; Refresh now reads up to 500 tickets in one batch).
- **The tags step** (`sync/tags-step.ts`): tag read → `walkReleaseHistory` → the ticket step per releasing
  workspace; `scanNext({history, tickets})`. **Removed**: `sync/tag-ranges.ts`, `sync/release-scan.ts`, the
  ancestry half of `sync/repo-tags.ts` (`ancestryTargets`, `inheritedAncestry`, `ancestryFromCompareStatus`,
  `runAncestryChecks`, the caps), `db/repo-tags.ts` `getTagRanges`, the PR-failure half of
  `releases/scan-state.ts`, `fetchClosedPrsPage` / `buildCommitPrsQuery`, `tracker/worker.ts`
  `queueReleaseTicketReads` / `kickReleaseTicketReads` and the release priority set, `releaseTicketsOwed`.
- **Notes**: `releases/notes.ts` `storySummaryInputs` takes `{title, prId}` per story PR — the light record's
  title, and a body only for a PR also stored.
- **Frontend**: `releasesModel.ts` `repoRowText` ("Candidate at most … — checking older history (40%)",
  "Checking — 0.390.0 and later cannot be released"); a PR with no stored row links to GitHub
  (`ReleasesView.tsx` `PrLink`, `safeExternalUrl`). Landing mock: the checking row reads the upper limit.
- **Calls per scan** for a 5,000-commit / 400-tag / 1,500-PR / 600-ticket repo with no release, first scan
  (before → after): tag read 4 GraphQL pages → 4 (unchanged); ancestry 400 REST compares → 0; ranges ≈ 400
  REST compares + ≈ 100 GraphQL fallback queries (unmatched commits, 50 a query) + 15 closed-PR list pages →
  50 history pages (~3 points each); range PRs up to 1,500 single-PR syncs (≤ 120 a run) → 0; tickets 600
  one-ticket reads over ≥ 15 worker passes → 6 Jira searches. In all ≈ 2,400 GitHub calls → 54 (55 with the
  compare on a moved head); 600 tracker calls → 6. (A repo that merges with merge commits has more history
  pages: GitHub's `history` lists the merged branches' commits too.) A later scan with 20 new commits: 1 REST
  compare + 1 history page, and every 10 minutes 6 Jira searches; no new commit: nothing beyond the tag read.
- **Tests**: `releases/history-fold.test.ts` (the PRs that count; first-parent past a merge commit; the tip
  stop and the baseline pause; linear assignment, tags on one commit, a tag off main, commits above the newest
  tag, a partial walk, a pending tip), `sync/release-history.test.ts` (250 commits in 3 pages; the baseline
  pause and going on; resuming from the cursor; the incremental rescan: one compare + one page; rewritten
  history restarts; the notes builder reading light records), `tracker/jira/statuses.test.ts` (600 keys → 6
  searches; v3 → v2; a missing key split out; missing / 401 / 5xx / malformed), `db/release-check.test.ts`
  (acceptance 43 on the fold; the DB half over walked commits and light records; detection parity;
  `bestTicketRead`, `ticketKeysOwed`; the live overlay; Refresh in one batch), `sync/tags-step.test.ts`
  (`scanNext`, the walk then the tickets), `apps/frontend/test/releasesModel.test.ts` (the upper-limit row),
  `verify:isolation`.
- **Decisions / deferrals**: FIRST-PARENT only — a tag on a commit merged in from a side branch is "not on
  main". Increments are assigned in walk order but chained by `compareTagOrder` (commit date), so a tag whose
  commit date disagrees with its place on `main` can shift PRs between neighbouring tags. The estimate counts
  every reachable commit (GitHub's `history` totalCount), so on a repo with merge commits the bar moves faster
  near the end. Light records read no links: in a GitHub Issues workspace (links are the whole answer) a PR
  known only from the history read has no ticket, so it warns as untracked. Increments never hold as "too
  large" any more (the pass reads them whole). Ticket statuses read in a batch are per workspace; an External
  repo's tickets are read through the releasing workspace's tracker. The walked commits of a repo that is
  unticked stay (cheap; a re-tick walks only what is new).

### Simple rule (2026-11-16)

The owner: a ticket that cannot be found (or an old unfinished one) held its tag and every later one, so the
candidate fell back far into the past. Wanted: a simple, strict-from-the-latest answer — the latest tag that
covers finished work — with more onus on the reader to check what is shown. The rule: § The release check.

- **The fold** (shared `release-check.ts`, rewritten): spans (each version tag's own increment) as before; THE
  WALK is NEWEST → OLDEST; `evaluate(tag)` folds its SCOPE (own increment; with a known baseline also every
  earlier span, newest first, each reason carrying `fromTag`) into `blockers` (`not_done` / `open_pr`, certain
  reasons) or `checking` (a ticket not read yet, or `ident: null` = history not read: an incomplete span, a
  release tag whose place is unknown — a baseline not known yet, during which the scope is the own increment —
  or an unknown version tag newer than the tag, or after a known baseline) and `unverified` (`not_found` /
  `no_access` / `failed` / `not_read` on a tracker that cannot read — LISTED, never a block). Tag `state`:
  `qualifies` / `does_not_qualify` / `checking`; the first `qualifies` is the candidate and the walk stops; the
  first `checking` stops it too. Repo `status` `candidate` / `none` / `checking` / `nothing_new` (`none` only
  when no tag whose place is unknown is left); `checking` = status checking. New: `ReleaseCheckInput.openPrs`
  (`ReleaseCheckOpenPrInput`), `ReleaseOpenPr`, `ReleaseUnverified`, repo `scope` (`since_release` / `own_tag`),
  `newestReason`, `candidatePrIds`, `unverifiedCount`; tag `unverified`, `scopePrIds`, `historyRead`; ticket
  `unverified`, `openPrs`; words `releaseUnverifiedText`, `releaseBlockerShort` / `releaseBlockerText`
  rewritten ("BMD-1048 is In PO Review", "BMD-1050 has an open pull request in web (#812)", "BMD-1040 (from
  0.391.0) is In Progress", "BMD-12 is not read yet", "The history is still being read."). Progress: the
  history line when the stop waits for history, else the tickets of the tags read.
- **Removed**: cumulative holding (`alsoHeldBy`, `blocked`, `firstBlocked`, `firstBlocker`, `firstVersion`), the
  early upper limit (`upperLimit`, `heldFrom`, "Candidate at most …", `releaseProgressPercent`), `unreadable` /
  `pr_unreadable` / `too_large` blockers, the hold after three failures (`RELEASE_TICKET_FAILS_HOLD` →
  `RELEASE_TICKET_FAILS_MAX`: the read then stops "checking" and is listed as "could not be read"), untracked-PR
  warnings (`ReleaseWarning`, `warnings`, `warningCount`, the tab's warnings panel, `releaseWarningText`,
  `releaseWordsContext`, `shortBlocker`, `repoFirstBlocker`), the "Still reading later tags" bar, the ticket's
  `unreadable` blocker, `tagRangeKeepFrom` (unused), `RELEASE_SCAN_STEPS`, and from the inputs `method`,
  `truncated` (ranges) and `intoDefaultBranch` / `state` (PRs: light records are merged by definition) and
  from `ReleaseCheckPr` `state`.
- **The DB half** (`db/release-check.ts`): `openPrs` = the stored `pull_requests` rows OPEN in ANY releasable
  repo of the workspace (whatever repos were asked for), into the repo's default branch (a base not synced
  yet counts; `hotfix/…` does not), with THE detection rule on the row plus its own `tracker_tickets` rows on
  the site. `releaseCandidateProven(accountId, repoId, views)` — true when every releasing workspace's check
  names a candidate.
- **The history pass** (`sync/release-history.ts`): `deepEnough` (from `sync/tags-step.ts` →
  `releaseCandidateProven`), asked before the first deep page of a run and every `DEEP_ENOUGH_EVERY` (5) deep
  pages; true ⇒ the deep segment stops (cursor kept), `stoppedEarly`, `complete`. A later run asks again, so a
  candidate that stops qualifying lets the walk go on.
- **Confirm / Refresh**: Confirm re-reads every ticket in the scope of the included candidates
  (`releaseScopeTickets`) ∪ the snapshot's, then the check (the open PRs from the DB); any difference stops it
  ("T1 has an open pull request in web (#88)."). Refresh reads the tickets not Complete, not read yet, or not
  given (never one held only by an open PR). `releaseShippedTickets` = in scope AND ready (comments, snapshot,
  summaries); `releaseScopeTickets` = in scope (the notes, by key for one the tracker could not give).
- **Notes**: `ReleaseNotesRepo.scope`; `own_tag` adds "Earlier changes are not listed." and heads the stories
  "Stories in this tag".
- **Frontend** (`releasesModel.ts`): `repoRowText` ("No tag can be released — 0.394.0: …", "No tag since
  0.380.0-rc can be released — …", "Checking…"), `repoRowCounts` ("6 tickets · 1 to check"), `repoProgress` (no
  small bar), `expandedTags` (the tags read), `tagExplainer` (`{tone, text}` lines: reasons, then "BMD-123 not
  found. Check it by hand."), `ticketMark` (an open PR marks a Complete ticket), `tagContents` (the candidate
  lists its scope; `noTicket`), `noTicketLine`. `ReleasesView.tsx`: no warnings panel; the candidate tag says
  "everything since 0.380.0-rc" or "this tag’s own changes"; the ⓘ states the rule. The E2E fixture (check
  null) needed no change. Landing mock (`SPRINT_RELEASES`, `ReleasesPanel`): the new rows and reasons, no
  warnings list.
- **Tests**: `db/release-check.test.ts` (acceptance 4–18, 38–43 on the pure fold; the DB half: a not-readable
  tracker lists, a failed read listed after three, the open PR into `main` vs `hotfix/…`,
  `releaseCandidateProven`), `releases/release-write.test.ts` (21 open PR, 47, a not-found ticket in the notes
  and not commented), `releases/create.test.ts` (21 both ways), `sync/release-history.test.ts` (48),
  `coding/story-build/hotfix-port.test.ts` (36 at the fold), `apps/frontend/test/releasesModel.test.ts` (4, 5,
  7, 10, 11, 12, 16, 17, 18, 41, 42).
- **Decisions**: an open PR counts only into the DEFAULT branch (an open hotfix PR is not work on its way to
  `main`; acceptance 36 says a hotfix-only ticket neither blocks nor warns), and an open PR whose base is not
  synced yet counts. A not-Complete ticket with an open PR reads as not Complete (one reason per ticket). With
  a baseline not known yet (a release tag the pass has not placed), the scope is the own increment: its
  reasons are certain, but the tag cannot qualify until the baseline is known. Tags OLDER than the candidate
  are not in the result (not read) — superseded by § Tag list and ticket detail: they are listed in the older
  band, for checking, and never change the candidate; the candidate's row lists every ticket of its scope. The tickets in a
  candidate's scope that the tracker could not give are in the notes by key and get no tracker comment.

### Tag list and ticket detail (2026-11-16)

The owner approved the row layout of § Releases tab 3: one list in three bands, every reason on every newer
tag, older tags for checking, a ticket detail in place. THE RULE is unchanged.

- **The fold** (shared `release-check.ts`): after the walk, `foldRepo` evaluates the OLDER BAND — the spans
  below the candidate, newest first, at most `olderWanted` (`clampOlderTagsWanted`: 10 … 1000), each by the
  same `evaluate` (own increment with no baseline; spans exist only after the baseline, so after a release the
  band ends there). It can never change the candidate: it runs after the walk stopped. New on the repo:
  `olderTags`, `older {wanted, moreAvailable, loading, needsHistory, progress, lastRelease}` — `needsHistory`
  when fewer than wanted are placed and older version tags are not placed yet (the pass stopped early), or
  when a listed older tag's own increment is not read; `moreAvailable` = more placed spans or unplaced older
  version tags. On each tag: `url` (`releaseCommitUrl`), `band`, `noTicketPrIds`. On each PR: `authorLogin`,
  `tagName` (the version tag whose increment holds it). On each ticket: `stage`, `typeName`, `assigneeName`,
  `readAt`, `pullRequests` (`ReleaseTicketPr`: the light records with their tag, the stored merged PRs with no
  light record — `untagged` when merged after the repo's newest tag — and the open PRs), and the repo state
  `before_candidate`. The result is BOUNDED: `tickets` and `prs` are those of the tags listed; `trackerName`.
  `releasesChecking` also polls while an older band is `loading`. Inputs: `ReleaseCheckRepoInput.olderWanted`,
  `ReleaseCheckPrInput.authorLogin`, `ReleaseCheckOpenPrInput.title` / `authorLogin`, `mergedPrs`
  (`ReleaseCheckMergedPrInput`), `ReleaseCheckTicketInput.stage` / `typeName` / `assigneeName` / `readAt`.
- **The DB half** (`db/release-check.ts`): `olderWanted` from `releases/older-tags.ts`; the ticket's type and
  assignee from the chosen successful read (else the freshest successful read with one) across the PR rows,
  the status rows and the sprint rows; `readAt` = the freshest successful read; `stage` by THE stage resolver.
  `detail: true` (GET /api/releases only) also loads `mergedPrs`: the MERGED `pull_requests` rows into the
  default branch of a releasable repo whose `tracker_tickets` rows name one of the check's tickets. The
  open PRs carry title and author. `releaseCandidateProven` also requires `!older.needsHistory`, so the
  history pass goes on JUST FAR ENOUGH for the band (asked every 5 deep pages as before).
- **Migration `0203_ticket_status_detail`** (registered): `tracker_ticket_status.issue_type_name` /
  `assignee_name`. The batched read stores them (`TicketStatusAnswer.typeName` / `assigneeName`; Jira's
  search asks `fields=status,summary,issuetype,assignee`; the one-by-one read takes them from `fetchTicket`).
- **"Show 5 earlier tags"** (was "Show 50 more"): `POST /api/releases/older-tags?workspace=<id>` `{repoId, wanted}` → the band's size,
  IN MEMORY per (account, workspace, repo) (`releases/older-tags.ts`: only ever raised, back to 10 after a
  restart — the tab's count is component state too); a repo not released from the workspace → 404. When it
  grows, `scheduleTagSync(…, {rescan: true})` (else the catch-up): the walk reads on, then the tickets in a
  batch. Tier `sync` (it starts GitHub and tracker reads). No new table, so nothing for `verify:isolation`
  beyond the membership check through `getReleaseRepos`.
- **Refresh** skips a ticket listed only in older tags (`before_candidate`): it cannot change a candidate.
- **Frontend** (`releasesModel.ts`): `rowBands`, `BAND_WORDS`, `candidateScopeLabel`, `tagHeader`,
  `tagTickets` (replaces `tagContents`; `ticketRank` order), `ticketLine` (replaces `ticketMark`),
  `ticketStatusWords`, `ticketDetail`, `readAgoWords`, `noTicketPrLine`, `olderTagSummary`, `olderBandView`,
  `olderShowMore`, `openInTrackerWords`; `noTicketLine` now "3 pull requests with no ticket"; `tagExplainer`
  keeps only reasons the ticket lines do not show (from an earlier tag, the history). `expandedTags` removed.
  `ReleasesView.tsx`: `Band`, `TagBlock`, `OlderTag`, `TagBody`, `TicketLine` + `TicketDetailBlock`,
  `NoTicketList`, `PrLineLink`; `hooks/useReleases.ts` `useShowMoreOlderTags`. The E2E fixture (check null)
  needed no change. Landing mock (`SPRINT_RELEASES`, `ReleasesPanel`): the three bands, older summaries, a
  ticket detail, the untracked list.
- **Tests**: `db/release-check.test.ts` (49–54 on the fold, the untracked list per tag, acceptance 14's older
  band; the DB half: the older band, the commit URL, type / assignee / last read, a stored merged PR "not in a
  tag yet"; `releaseCandidateProven` false while the band needs history; the in-memory raise),
  `api/routes/release-settings.test.ts` (the route: 404, 400, never lowered, Default fallback),
  `api/plugins/rate-limit.test.ts` (`sync`), `tracker/jira/statuses.test.ts` (the fields asked, type),
  `apps/frontend/test/releasesModel.test.ts` (bands, headers, order, ticket words, older band and "Show 50
  more", the detail, the untracked line).
- **Decisions**: the band's size lives in memory, not the DB (the tab's own count is not persisted either; no
  migration, erasure or isolation surface). The older band is judged by the SAME `evaluate` (with a baseline
  that is the scope since the release — those tags are inside the candidate's scope anyway). A ticket line
  lists the tag's OWN increment's tickets (the candidate: its scope); reasons from an earlier tag stay text
  lines. "Elsewhere" reads stored merged PRs through their `tracker_tickets` rows (a PR the enricher never
  read is not listed), and a stored merged PR older than the history read shows its date with no tag. The
  bucket in brackets uses This Sprint's stage labels (`SPRINT_STAGE_LABEL`), so "Done (Complete)" shows for a
  tracker whose done status is "Done".

### Cumulative rule and ticket titles (2026-11-16, owner, after trying the simple rule on BNG)

The simple rule named the newest tag clear ON ITS OWN, so BNG's backend read 0.418.0 although 0.324.0 below it
holds BMD-1061 (In Code Review) and releasing 0.418.0 ships it. The fold's `evaluate` now folds every earlier
span after the baseline into every tag's scope (with or without a baseline; `scope` is `since_release` /
`since_start`, `own_tag` removed); while a newer baseline may still turn up the scope is the own increment, and
any version tag not placed yet keeps the tag CHECKING. The older band is evaluated `ownOnly` (they all qualify).
A tag's `listsScope` says whether its ticket lines are its scope (the candidate after a release) or its own
increment. Blockers and `unverified` carry the ticket `title` (only when known); `releaseBlockerShort` /
`releaseUnverifiedText` quote it beside the key. `tagExplainer` no longer repeats inherited reasons: a tag
held back only by older tags gets one line naming the oldest. The history pass's early stop
(`releaseCandidateProven`) needs no change: a candidate now implies the whole scope was read. The answer is
no longer bounded to the listed tags' PRs: the candidate's scope (the release's content) is sent whole. Refresh
shows a busy bar with "Reading tickets from Jira again". Notes for a first release list everything up to the
candidate.

### The tag list redesign (2026-11-16, owner)

⚠ SUPERSEDED the same day by § The ticket list below.

The three labelled bands are gone. `ReleasesView` `RepoDetail` draws ONE `<ol>` of `TagRow`s from
`tagWindow(repo, laterShown, earlierShown)` (5 + candidate + 5; `RELEASE_WINDOW_STEP`); every row is closed
and identical (`tagMark`, header, ›), the candidate highlighted with its `candidatePairs`. Reasons appear only
in an opened row (`candidateWhy`, `tagExplainer` with `{check, repoId}` for links). A link (`TagLink`) sets ONE
`focus` in `ReleasesView` (with a sequence number so a repeat press acts): the repository row opens,
`laterShownFor` widens the window, the row opens and scrolls into view. Removed: `rowBands`, `BAND_WORDS`,
`olderBandView`, `olderShowMore`, `olderShownLine`, `olderTagSummary`. `RELEASE_OLDER_TAGS_STEP` is 5; the
server still sends 10 older tags by default, so the first "Show 5 earlier tags" asks nothing.

### The ticket list (2026-11-16, owner)

The per-repository tag rows are gone: `ReleasesView` draws repository STRIPS (candidate, its commit, "Release…"
opening `ReleaseDialog` with `repoId` ticked) and ONE ticket list from `Sprint/releaseTicketsModel.ts`:
`ticketList` (cards + no-ticket groups, newest first by `tagAt`; `notTagged` apart; `anchor` = the newest card
`ticketInCandidates`), `ticketWindow` (anchor ± `TICKET_WINDOW_START`, steps of `TICKET_WINDOW_STEP`),
`releaseHolders` (the blocker of the tag above each candidate, a split resolved to `root`), `ticketCardLine`.
The fold adds `tagAt` (the holding tag's commit date) to every `prs[]` entry and `pullRequests[]` line, and
lists a ticket whose ONLY work is an open PR (`repos: []`); `loadReleaseCheckInput` reads the open PRs BEFORE the
tickets so their keys are read too. Removed from `releasesModel.ts`: `tagWindow`, `tagMark`, `candidatePairs`,
`candidateWhy`, `tagExplainer`, `tagHeader`, `tagTickets`, `ticketLine`, `ticketRank`, `ticketBlockerIn`,
`ticketDetail`, `repoRowText`, `repoRowCounts`, `showCreateRelease` and the window words. The tag-level
fields (`tags`, `olderTags`, `blockers`) stay on the wire: the holders and the notes read them.
Then (owner, same day): the per-repository strips went — only repositories with NO candidate get a line
(`reposWithoutCandidate`); the candidates, their commits and ONE "Release…" (`showCreateRelease`) sit on the ★
card (`CandidateBlock`); the dialog ticks every releasable repo as before. The list is its own bordered box; "Not
in a tag yet" and "Holding the release" moved to a second bordered box below it. "Show bot PRs" (off) filters a
no-ticket row's list (`noTicketShownPrs`).
Then: "Show PRs with no ticket" (off by default; `listedItems`) and the rail — `RailMarker` copies `PrActivityTab`'s disc
and line; `TicketCard railed` moves the mark onto it.

### Releasing without version tags (2026-11-19)

The spec: § Releasing without version tags. THE FOLD'S RULES are unchanged; points are fed in as tags.

- **Shared** `releases.ts`: `ReleaseBasis`, `ReleaseBasisSetting`, `RELEASE_BASIS_SETTINGS`, `releaseBasisOf`
  (THE basis rule), `releasePointName` / `releasePointNumber`, `releaseDateTagName`; `ReleaseSettingsRepo.basis` /
  `effectiveBasis`, `SetReleaseReposBody.bases`. `release-check.ts`: `ReleaseCheckRepoInput.basis` /
  `pointReleaseTagName`; `ReleaseRepoCheck.basis`, `candidate.point`; `releaseSplitWhere` drops "(in #n)" for a
  PR that is its own point. `release-write.ts`: `ReleaseNotesRepo.basis` / `sha` ("Built from #539 (e18c3b2).").
- **Speed** (`foldRepo`): a ticket's verdict is the same in every span, so each span caches its NOTABLE tickets
  (not clear, not Cancelled) and a tag's reasons walk only those; `incompleteUpTo` replaces the per-tag scan for
  unread history. `TagEval.full`: only the candidate, the tag the walk stopped at and the oldest read build the
  whole `scopeIdents` / `scopePrIds`; a newer tag carries its own (the wire's `scopePrIds` says so). 1,500 points
  went from ~1 s to ~0.1 s.
- **Migration `0212_release_basis`** (registered): `workspace_release_repos.release_basis`, `release_items.basis`.
- **Backend**: `releases/history-fold.ts` `releasePointsOf` (pure; dates nudged by 1 ms so points sort in walk
  order); `db/release-check.ts` per repo: the basis, then (prs) the points + the stored release / hotfix tags
  (a release tag on a point's commit takes the point's nudged date, so it sorts after it) through the same
  `historyView`, and the date-named release tag (taken = stored tags ∪ `release_items` names);
  `db/release-repos.ts` reads / writes `basis`; `db/release-settings.ts` adds `basis` / `effectiveBasis`;
  `PUT …/release-repos` takes `bases` (a changed one ⇒ catch-up); `releases/github.ts` `commitOnBranch`;
  `releases/create.ts` checks it for a point, stores `release_items.basis`.
- **Frontend**: Settings → Releases "Release from" (`Select`, `releaseBasisOptions`, `releaseBasesDirty`);
  `releaseTicketsModel.ts` `repoStripText` (points), a PR line drops "in #n" for its own point; the ⓘ.
- **Tests**: `releases/tagless.test.ts` (63–66, 68 on the pure parts), `db/release-check.test.ts` (63–66 on the
  DB half), `releases/create.test.ts` (66, 67), `api/routes/release-settings.test.ts` (the route's `bases`),
  `apps/frontend/test/releasesModel.test.ts` (the strip, the picker).
- **Landing mock** (`SPRINT_RELEASES`): acme/docs-site is released from merged pull requests ("Nothing merged
  since 2026.10.02-rc").

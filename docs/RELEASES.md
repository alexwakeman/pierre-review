# Releases (This Sprint → Releases) and hotfix builds

The spec agreed with the owner on 2026-11-14. It is the acceptance contract: § Acceptance checks is
what a build of this feature must pass. Implementation notes are added below § Implementation as the
work lands; keep the spec sections true.

## Purpose

Say, per repository, which version tag on `main` is safe to release: the newest one whose changes
link only to Done tickets, with every ticket shipping WHOLE across all its repositories. One reader
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
- Validation: a valid git ref fragment (no spaces, `~^:?*[\`, `..`, `@{`, no trailing `.lock`/`/`/`.`),
  1–32 characters, the two must differ, and neither may END WITH the other (a tag must classify one way).
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
- **Baseline** (per repo) — the newest RELEASE tag whose commit is an ancestor of `main`. None ⇒ the
  first release covers everything merged to `main`; PRs merged before Ensemble's synced history are not
  checked, said in ONE line.
- **Range of a version tag** — the PRs merged INTO THE DEFAULT BRANCH after the baseline, up to and
  including that tag's commit (commit → PR by the stored merge commit oid; fallback GraphQL
  `associatedPullRequests` for unmatched commits).
- **Done** — the ticket is in the workspace's Complete stage (`SPRINT_STAGES`; with automatic buckets
  that is the tracker's `done` category). "Won't do" is in Complete, so it counts as Done (owner may
  revisit).
- **Human vs bot PR** — by author through `globalAutomationUserIds`, never `hiddenBotUserIds`.

## The release check (one pure fold)

**Per repo:** the candidate is the newest version tag after the baseline whose range has no PR (into
the default branch) linked to a ticket that is not Done.

- A human PR with no ticket: a WARNING, never a block.
- A bot PR with no ticket: no warning; listed under "Dependency and bot changes" in the notes.
- A bot PR naming a not-done ticket: BLOCKS (the ticket rule ignores authorship).
- A ticket that could not be read (`not_found`, `no_access`, `failed`): BLOCKS, with the reason.
- No version tag after the baseline: "Nothing new" — not in the release.

**Across repos** — a ticket's repos are its accepted `sprint_ticket_repos` rows ∪ every repo with a
merged PR into the default branch that names it. For every ticket in any repo's range:

1. **Ships whole**: every merged PR into the default branch for the ticket, in each of its repos, is
   inside that repo's candidate. If not, the ticket is NOT READY: it blocks wherever its PRs appear and
   the check repeats until nothing changes (candidates only move back, so it ends). The reason names
   the fix ("PLAT-290 holds api at v2.4.0: its web PR is merged but not in a version tag yet").
2. **No open work**: an OPEN PR into the default branch on the ticket blocks. A PR into a hotfix branch
   never counts (merged or open) — it is a separate line.
3. **Linked repo with no PR**: a WARNING only.

The fold is pure and DB-only on a view (tags, ranges and ticket rows are synced/stored); it never
fetches on mount.

## Releases tab (This Sprint → Releases, the 4th inner tab, key `4`)

1. Header: "Latest release: none" / "Latest release: 12 Nov", Refresh, an ⓘ with the rules in a few lines.
2. Repo rows: `api ★ v2.4.0 → v2.4.0<suffix> · 6 tickets · 1 warning`; "Nothing new since …";
   "No candidate: v0.3.0 held by PLAT-301 (In review)". A row expands to its version tags (newest first),
   their PRs and ticket chips; the blocking one named, the candidate starred.
3. Tickets panel: per ticket, per repo: ✓ in candidate · ✗ merged after candidate · ✗ open PR ·
   ⚠ linked, no PR. A ticket chip opens the story tray (`useOpenStory()`), a PR opens its PR tab.
4. Warnings (untracked human PRs, linked repos without a PR) listed under the release; never block.
5. **"Create release…"** — shown only with ≥ 1 candidate in a writable repo (HIDE, never disable).
   Dialog: repos (ticked; unticking re-runs the check and blocks Confirm if a ticket would ship in
   part, naming it); release notes preview (editable); tracker comment preview; Confirm.
   Confirm FIRST re-reads every ticket in the release from the tracker and re-checks each version
   tag's commit; any change stops it and shows what — nothing is written.
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

## Release notes

One document per release, a section per repo (each section is also that repo's pre-release body).
Per story: key, title, link, the PRs per repo, and — when `me.ai.enabled` — a one-paragraph summary
from the ticket text and PR titles/descriptions through `ai/provider.ts` (`cheapComplete`, writing
rules). Without AI the same document minus summaries; never blocked. Version numbers and counts are
code-derived, never model-written. Then "Untracked changes" and "Dependency and bot changes". Stored
against the release and viewable again from the tab.

## Hotfix (an Implement option)

In the story view, Implement's Start offers **"Treat as a hotfix"** — only when both suffixes are set
and ≥ 1 workspace repo has a latest release. Start shows each repo's base:

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

## Invariants this feature adds

- Tag sync is part of the default-branch snapshot step: STRICTLY NON-FATAL, found by the settle sweep
  (tag pushes are updatedAt-silent). A version tag's range is computed once per (repo, tag, sha) and
  stored; a tag MOVED to another sha is re-computed and flagged.
- `pullRequests.mergeCommitOid` is cleared only on a positive statement from GitHub.
- New tracker write: the release comment (the reader's press). Added to the tracker-writes list.
- New GitHub writes: release tags, pre-releases, the hotfix base branch — each a reader's press,
  rate-limit tier in `tierFor`, settle-and-verify.
- New account-scoped tables join `accountScopedTables()`; composite FKs; hand-registered migration.

## Acceptance checks

Settings
1. Without both suffixes the Releases tab shows only the setup line, and "Treat as a hotfix" is absent.
2. Equal suffixes, or one ending with the other, are refused with a sentence.
3. Changing the release suffix after a release exists warns; after saving, old release tags no longer
   form the baseline.

Candidate
4. Tags v1.0.0, v1.1.0, v1.2.0, no release, all tickets Done → candidate v1.2.0.
5. v1.1.0's range adds a PR whose ticket is In review → candidate v1.0.0; v1.1.0 names the blocker.
6. That ticket moves to Done, Refresh → candidate v1.2.0.
7. A human PR with no ticket → still a candidate, with a warning naming the PR.
8. A bot PR with no ticket → no warning; listed under bot changes.
9. A bot PR naming a not-done ticket → blocks.
10. An unreadable ticket → blocks, with the reason.
11. "Won't do" with merged code → counts as Done.
12. No version tag after the baseline → "Nothing new", not in the release.
13. A merged PR into `hotfix/…` for a not-done ticket blocks no `main` candidate.

Cross-repo
14. PLAT-290 Done; api PR in v2.4.0; web PR merged after web's newest version tag → PLAT-290 not
    ready, api's candidate moves back before it, the reason says to cut a tag in web.
15. After a web version tag containing it → both candidates include PLAT-290.
16. A Done ticket with an open PR into the default branch in any repo → blocks.
17. A ticket linked to a repo with no PR there → warning only.
18. Unticking web when PLAT-290 needs it → Confirm blocked, PLAT-290 named.

Writes
19. Confirm creates `<version><release suffix>`, annotated, on the version tag's commit; no Ensemble wording.
20. An existing release tag name → refused for that repo; the others go ahead.
21. A ticket leaves Done between opening the dialog and Confirm → Confirm stops, shows it, writes nothing.
22. A repo fails to tag → its tickets get no comment; tickets only in other repos do; the result says so.
23. The comment is posted once per shipped ticket; pressing again writes nothing new.
24. After success every released repo reads "Nothing new" until the next version tag.

Hotfix
25. After a release, "Treat as a hotfix" shows each repo's base as its latest release; repos without one
    are read-only.
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
  when the sprint was never read; "Won't do" → Complete) and `bestTicketRow`. Ticket links are
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

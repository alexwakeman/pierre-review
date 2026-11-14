# Releases (This Sprint → Releases) and hotfix builds

The spec agreed with the owner on 2026-11-14. It is the acceptance contract: § Acceptance checks is
what a build of this feature must pass. Implementation notes are added below § Implementation as the
work lands; keep the spec sections true.

## Purpose

Say, per repository, which version tag on `main` is safe to release: the newest one whose changes
link only to Done tickets, with every ticket shipping WHOLE across all its repositories. One reader
press tags each safe version with the workspace's release suffix (the tag is the trigger for the
team's image build; Limn deploys nothing), publishes release notes and comments on each shipped
ticket. A hotfix is an Implement option that builds one fix twice: on the latest release and on
`main`, as two PRs per repository. Limn automates nothing after those PRs open.

Owner decisions: tags are cut from `main` only (by CI or by hand; Limn never cuts a version tag);
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
- **Release tag** — `<version tag><release suffix>`, annotated, on the version tag's commit. Limn
  creates these on the reader's press.
- **Hotfix tag** — a tag ending in the hotfix suffix. The team creates these by hand on a hotfix branch.
- **Latest release** (per repo) — the newest release OR hotfix tag (by the tagged commit's date, ties
  by tag creation). The hotfix base.
- **Baseline** (per repo) — the newest RELEASE tag whose commit is an ancestor of `main`. None ⇒ the
  first release covers everything merged to `main`; PRs merged before Limn's synced history are not
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

**No Limn wording** in tag messages, release notes, pre-release bodies or tracker comments. Comment:

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
- Plan first works as usual. The review loop and "Build end to end" are OFF for hotfix builds (v1).
- **Push** (reader's press, per repo): create `hotfix/<latest release tag>` at the release commit if
  missing; open PR 1 from `<KEY>` into it and PR 2 from `<KEY>-main` into `main`. Both titled
  `<KEY>: <title>`; each body links the other; draft by default (the existing toggle); the usual Push
  rules (reader's PR, `BRANCH_EXISTS` refused, permission re-checked). If the hotfix branch exists and
  has moved past the release commit, PR 1 still targets it and the tab names the PRs already on it.
- After the PRs open, Limn writes NOTHING more for that build.

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
19. Confirm creates `<version><release suffix>`, annotated, on the version tag's commit; no Limn wording.
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
31. After the PRs open, Limn writes nothing else for that build.

Notes
32. AI off: complete minus summaries. AI on: a summary per story, no model-written numbers.
33. No output contains the word "Limn".

## Implementation

(Filled in as it lands: modules, tables, routes, tests.)

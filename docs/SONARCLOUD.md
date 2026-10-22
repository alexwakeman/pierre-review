# SonarCloud

CORE and free. A workspace can save a SonarCloud token; Limn then reads each pull request's
SonarCloud analysis and feeds it to Claude Review, AI Fix and one GitHub review per commit. Code: `apps/backend/src/sonar/`
(server), `apps/frontend/src/components/ClaudeReviewSonar.tsx` + `components/settings/SonarSection.tsx`
(SPA), shared types in `packages/shared/src/sonar.ts`.

## The rules that must not move

- **The host is FIXED** (`SONARCLOUD_HOST` = `https://sonarcloud.io`). Nothing a customer types becomes a
  host: the organization and project keys travel only as URL-encoded query parameters (`sonar/client.ts`
  `sonarUrl`, which also refuses any path that is not `api/<letters>`).
- **Every call goes through the tracker's guarded GET** (`tracker/jira/fetch.ts` `jiraGetJson`) with the
  cloud policy always on: GET only, no redirect followed (a 3xx would hand the token to a host nobody
  chose), a 10 s timeout, a 5 MiB body cap, JSON only, https + public addresses. The token is sent as
  `Authorization: Bearer <token>`.
- **The token is WRITE-ONLY and SEALED.** Stored through `tracker/secret.ts` (`sealed:v1:` with an
  ENCRYPTION_KEY, always in cloud; else `plain:`). No response carries it (`hasToken` only), the
  account export reduces it to `hasToken`, and no log line names it. `readSonarAccessForPr` is the
  one function that opens it, and its callers send it to SonarCloud only.
- **Reads never call SonarCloud.** A snapshot per (account, PR, head) is stored in
  `sonar_snapshots`; the review tab, the review prompt, AI Fix's seed and the posted review all read that row.
  Only four things take a snapshot: a Claude Review run (before it builds the prompt), the Refresh
  button, an auto post (re-reading a head whose earlier read found no analysis of it) and opening /
  starting an AI Fix (waits at most 8 s; a slower read lands for the next open).
- **ONLY AN ANALYSIS OF THIS COMMIT IS STORED.** Every SonarCloud PR call is keyed by PR NUMBER and
  answers the LATEST analysis, whatever commit it was of — and SonarCloud usually finishes minutes after
  the push an auto review starts on. So `gather.ts` asks `api/project_pull_requests/list` which commit it
  analysed, BEFORE and AFTER reading; any other commit is `not_analyzed` with NOTHING kept (never the
  previous commit's issues under the new head). The one other sha accepted is GitHub's test merge commit
  whose SECOND parent is the head (a CI checkout of `refs/pull/N/merge`), proven by one GitHub REST read
  (`githubIsMergeOfHead`). A read that finds another commit never replaces an earlier `ok` read of this
  head (a Refresh in an older review's tab must not wipe it).
- **Nothing throws out of a review.** Every outcome is a NAMED state (`SonarSnapshotState`) with a
  sentence we wrote: `ok`, `not_configured` (nothing stored), `token_unreadable`, `no_project`,
  `not_analyzed`, `unauthorized`, `error`.
- **50 items, and the cut is stated.** Issues and hotspots are ranked together and capped at
  `SONAR_ISSUE_CAP` (50). The totals SonarCloud reported travel with the list, so every screen says
  "50 of 132".

## Settings (Settings → Workspace → SonarCloud)

One `workspace_sonar` row per workspace (migration 0114 / pg 0101): `organization`, the sealed
`auth_token`, and `project_keys` — a JSON map `repoId → key` of OVERRIDES only. A repo with no override
uses SonarCloud's GitHub-import default, `<owner>_<repo>` (`defaultSonarProjectKey`). A key equal to the
default is not stored; a key for a repo outside the workspace is refused (400); overrides for repos that
left the workspace are dropped on the next save. `workspace_id` arrives in a PATH, so the FK is the named
COMPOSITE one onto `workspaces (id, account_id)`.

The SPA section is the standard draft + Save: typing writes nothing, "Remove" on the token is a draft
change too. "Test connection" is click-gated, uses the SAVED token, and asks for a save first when the
draft differs. It reads `api/organizations/search` and, for up to 20 repos, `api/components/show`, and
marks each repo "Found" / "Not found".

## What is read (`sonar/gather.ts`)

1. `api/qualitygates/project_status?projectKey&pullRequest` — the gate, and the "is there an analysis?"
   probe. A 404 is told apart by `api/components/show`: no project (`no_project`, names the key) or no
   analysis for this PR yet (`not_analyzed`).
2. `api/issues/search?componentKeys&pullRequest&resolved=false&additionalFields=_all&s=SEVERITY` — up to
   2 pages of 500. Rule names come from the response's `rules`.
1b. `api/project_pull_requests/list?project` — the PR's analysed `commit.sha` (see the rule above). Not
   listed, no sha, or another commit ⇒ `not_analyzed`; read again after step 3b, and an analysis that
   landed mid-read is refused the same way.
3. `api/hotspots/search?projectKey&pullRequest&status=TO_REVIEW` — up to 2 pages of 500. A failure here
   costs the hotspots only (pages already read are kept).
3b. **Measures and the gate's files** (enrichments): `api/measures/component` (new-code coverage, lines to
   cover, uncovered lines, duplication density and lines, new lines) onto `qualityGate.measures`; and for
   each FAILING coverage / duplication condition, `api/measures/component_tree` sorted by
   `new_uncovered_lines` / `new_duplicated_lines` — the 10 worst files onto that condition's `files`. Both
   live inside the stored gate JSON, so no migration; old rows simply lack them.
4. **Rank + cap**: severity first (`blocker > critical > major > minor > info`), an issue before a
   hotspot of the same severity, then file and line. An issue's severity is its legacy `severity`, else
   the highest of its `impacts` (`BLOCKER/HIGH/MEDIUM/LOW/INFO` → blocker/critical/major/minor/info). A
   hotspot's is its review priority: HIGH → critical, MEDIUM → major, LOW → minor.
5. **Enrichments, for the kept items only**: each distinct rule's description (`api/rules/show`), turned
   into plain text — `whyIsThisAnIssue` from the `root_cause` / `introduction` / `assess_the_problem`
   sections, `howToFix` from `how_to_fix` (an old one-piece description is split at "Compliant
   solution"); and the flagged lines with two lines of context (`api/sources/lines`, at most 14 lines,
   HTML stripped). **Rules are cached per (account, organization, rule) for 24 h** (in process, at most
   2,000 entries). Enrichments run four at a time inside a 60 s deadline; a failure, or the deadline,
   costs that item its guidance or its code, never the snapshot.

**Reuse** (`sonar/snapshot.ts`): a head that read `ok` is not read again unless the reader presses
Refresh; `not_analyzed` is retried once it is 2 minutes old and any other failed read once it is 10,
because SonarCloud's PR analysis often finishes after the push a review starts on. Concurrent calls for one (account, PR, head) share one read.
A re-read replaces the issues but **never touches `post`**.

## Claude Review

`runPipeline` (claude-review/manager.ts) takes or reuses the head's snapshot after the thread plan.
When it read `ok` with items OR a gate that did not pass, the prompt gains "SonarCloud analysis of this
commit": the gate, the total, a fenced "SONARCLOUD QUALITY GATE" block (each failing condition in words —
"Coverage on new code is 40%. The quality gate needs at least 80%." — with its files, and the measures),
and the 25 most severe items (`SONAR_PROMPT_MAX`), each FENCED with the run's nonce as untrusted data
(rule, severity, place, message, a short "why"). The model is told to use them as evidence, to raise a
finding only when it agrees, and not to copy the list. The texts join the nonce-collision scan
(`untrustedTexts`). A skipped review (nothing substantive) takes no snapshot.

The tab's **SonarCloud** section (`ClaudeReviewSonarSection`, after CI check) reads the stored snapshot
for the reviewed head — never SonarCloud on mount. Header: the gate chip and "50 of 132 issues"; an ⓘ
holds the explanation. Actions: "Open in SonarCloud", Refresh, and "Post SonarCloud findings" (local only).
Each card (`SonarIssueRow`) shows severity, type, rule, effort, the message, the place (a link into
Changes when the PR touches the file), the flagged lines, and "How to fix" behind a chevron. The section
is absent when the workspace has no SonarCloud set up and nothing was stored.

## Posting (`sonar/post.ts`, `sonar/comment.ts`)

ONE GitHub REVIEW (event `COMMENT`) per (PR, head) — a separate review from Claude's, with its own
button, record and `sonar` auto kind. It replaced one PR-level comment (2026-10-22); older records
(`commentId`, no `inline`) still read as one comment.

1. a snapshot at that head that read `ok`, with issues or a failing gate;
2. the LIVE PR is open and still at that head (a moved head posts nothing — `409 HeadMoved`);
3. **THE SPLIT** (`splitSonarIssues`, pure) against the live diff with noise files stripped — the same
   anchor index the Claude review post uses (`github/diff-anchor.ts`):
   - an issue whose `path` + `line` is an addable RIGHT-side line → its OWN inline thread there
     (`sonarInlineBody`: severity, type, rule, effort, link, message, "How to fix");
   - everything else — no file, no line, a line outside the diff, a file the noise strip dropped, a
     gate item — goes IN FULL in the review body. ⚠ **NEVER on the file's first change**
     (`fallbackAnchor` is NOT used): a SonarCloud issue pinned to an unrelated line misleads;
   - ⚠ **DEDUPE BY ISSUE KEY ACROSS HEADS**: a key in an EARLIER head's `post.inline`
     (`sonarKeysAlreadyInline`; a `posting` record counts — it may be on GitHub; a `failed` one does
     not) is never threaded again — the body names it under "Already on GitHub from an earlier commit".
     Keys are stable across analyses (one dev-DB PR: 50 rows over 4 heads, 26 keys).
   - an unreadable diff (too large, `gh` failing) ⇒ nothing inline, everything in the body. Nothing new
     at all (every issue already threaded, gate not failing) ⇒ `nothing_to_post`, nothing claimed;
4. **THE CLAIM BEFORE THE WRITE** — `sonar_snapshots.post` NULL → `{status:'posting', inline:[planned
   keys]}` by compare-and-set. Two presses, two tabs or a restart can never post twice;
5. ONE `POST …/pulls/:n/reviews` pinned to the head (one write, so no partial state). ⚠ An error is NOT
   proof nothing posted: GitHub has answered 422 for a review it published, so the body's marker carries
   a per-attempt nonce (`sonarReviewMarker`) and `findLandedReview` (post-seam.ts) adopts THIS attempt's
   review. Then the inline comment ids are read back best-effort (`matchReviewComments`); then `posted`
   (`githubReviewId`, `inline[].commentId`, `summaryCount`, `alreadyCount`) or `failed` (with the
   error); then `settlePrAfterWrite`. **Never retried.** A post cut off mid-flight stays `posting` for good.

The tab's line says "Posted to GitHub: 12 on the changed lines, 5 in the summary, 3 already there from
an earlier commit."; the ⓘ explains the split.

The review BODY: a lead line ("SonarCloud on abc1234: 50 of 132 issues, highest severity first"), the gate's
failing conditions in words, the new-code measures, a link to the analysis, "N issues are on the changed
lines, as comments there.", the already-posted list (one line each), then one block per failing
coverage / duplication condition (with its files; not counted as issues), then per item: severity, type and rule name; the rule key,
place, effort and a link; SonarCloud's message; the flagged lines in a fence longer than any backtick run
in them; and "How to fix" in a `<details>`. Every SonarCloud string is made safe (`safeCommentText`: no
`@` pings, no `<!--`). ⚠ **PROSE OUTSIDE A FENCE IS HTML-ESCAPED** (`safeProse`: `&`, `<`, `>`): rule
guidance quotes its own code examples, `htmlToText` decodes them back to tags, and GitHub renders tags in
a comment — a quoted `</details>` closed our block early and a quoted `<a href>` became a live link posted
under the reader's name. Code spans and fences are literal and are NOT escaped. Built under 60,000 characters (GitHub's limit is 65,536); items that do not fit
are COUNTED in a closing line. The hidden marker `<!-- pierre:claude-review-sonar v=1 -->` (the body's
with `a=<nonce>` added) always ends the body AND every inline thread, so `isLimnPostedComment` knows them
and they never re-trigger an auto review — which also keeps them out of "other reviewers' threads" (no
thread judgement, no reply judging), and the distinct `-sonar` marker keeps posted-state / auto-resolve
from adopting one as a finding's thread. An auto post adds
`AUTO_POST_FOOTER`; a manual one does not (the same as every other manual post).

**Auto**: after a SUCCEEDED AUTO review, `maybeAutoPostSonar` posts when the workspace's auto-posting is
on with its `sonar` kind (`AutoPostKinds.sonar`, default on inside auto-posting, which is off until
switched on) and the PR passes `autoPostEligibility` (open, not a draft, not a bot's, and under scope
`mine` yours). A decision NOT to post writes nothing, so a person can still post by hand.

The post route registers **locally only**: it posts through the reader's `gh` session, like every
Claude Review post.

## AI Fix

`loadSeedInputs` (coding/ai-fix/manager.ts) first makes sure the PR's synced head has a read
(`freshenSonarForPrHead`, at most 8 s), then reads `getSonarIssuesForPrHead`: the snapshot AT THAT HEAD,
when it read `ok` (`[]` once the head moves) — its FAILING coverage / duplication gate conditions first
(`sonarGateItems`, shared, derived on read and never stored, so the counts stay SonarCloud's; kind
`'gate'`, key `sonar:gate:<metric>`, the files behind it in "how to fix"; ratings and issue counts are not
items, the issues behind them are), then the issues and hotspots. The review tab draws the same gate
cards above the issues. Each item is a seed candidate:

- key `sonar:<SonarCloud's key>` (stable, what `include` names), section `sonar`, kind `sonar_issue`;
- ref **`Q<n>`** — positional after selection like F/P/T/C. Not `S`: `S<t>-AC<n>` is the story's;
- body, fenced like every item: rule and name, place, message, the hotspot note, the flagged lines
  (`>` marks them), "why", and SonarCloud's "how to fix" (clipped to 1,500 characters);
- budget priority: blocker/critical 1, major 3, minor 5, info 7. Info is offered, not ticked.

The picker draws the review tab's own card (`card: {kind:'sonar', issue}`) with the tick box, under
"SonarCloud issues". An auto fix follows `AutoFixInclude.sonar` (default on).

## Routes

| Route | Tier | |
|---|---|---|
| `GET /api/workspaces/:id/sonar` | read | `WorkspaceSonarSettings` — never the token |
| `PUT /api/workspaces/:id/sonar` | read | partial `WorkspaceSonarUpdate`; 400 `InvalidSonarSettings` |
| `POST /api/workspaces/:id/sonar/check` | search + read | `SonarConnectionCheck` with the saved token |
| `GET /api/prs/:id/sonar?head=` | read | `SonarPrResponse` — stored, no SonarCloud call |
| `POST /api/prs/:id/sonar/refresh {headSha?}` | search + read | read SonarCloud now; 409 `SonarNotConfigured` |
| `POST /api/prs/:id/sonar/post {headSha}` | github_write | local only; 409 `AlreadyPosted` / `HeadMoved` / `NothingToPost` / `NotOpen` |

Every id is a PATH id: another account's workspace or PR is a 404.

## Storage and tenancy

- `workspace_sonar` — composite FK onto `workspaces (id, account_id)`, unique `(account_id, workspace_id)`.
- `sonar_snapshots` — unique `(account_id, pr_id, head_sha)`, **no FK on `pr_id`** (the tracker_tickets
  precedent): BOTH delete paths (`deleteRepo`, retention's `deletePrSubtree`) delete it explicitly.
- Both are in `accountScopedTables()`, erased by `eraseAccountData`, and checked by `verify:isolation`.
- The export carries `workspaceSonar` (organization, overrides, `hasToken`); snapshots are a cache of
  SonarCloud and are not exported.

Tests: `sonar/gather.test.ts` (ranking, cap, cut, rule cache, states), `sonar/comment.test.ts`,
`sonar/sonar-db.test.ts` (token never returned or exported, settings, post once, inline vs summary, cross-head key dedupe, a 422-but-landed review adopted, auto post),
`coding/ai-fix/review-seed.test.ts` § SonarCloud items, `claude-review/prompts.test.ts` § SonarCloud.

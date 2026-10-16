# SonarCloud

CORE and free. A workspace can save a SonarCloud token; Limn then reads each pull request's
SonarCloud analysis and feeds it to Claude Review, AI Fix and one PR comment. Code: `apps/backend/src/sonar/`
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
  `sonar_snapshots`; the review tab, the review prompt, AI Fix's seed and the comment all read that row.
  Only two things take a snapshot: a Claude Review run (before it builds the prompt) and the Refresh
  button.
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
3. `api/hotspots/search?projectKey&pullRequest&status=TO_REVIEW` — one page of 500. A failure here costs
   the hotspots only.
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
Refresh; a failed read is retried once it is 10 minutes old, because SonarCloud's PR analysis often
finishes after the push a review starts on. Concurrent calls for one (account, PR, head) share one read.
A re-read replaces the issues but **never touches `post`**.

## Claude Review

`runPipeline` (claude-review/manager.ts) takes or reuses the head's snapshot after the thread plan.
When it read `ok` with items, the prompt gains "SonarCloud analysis of this commit": the gate, the total,
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

ONE PR-level comment per (PR, head):

1. a snapshot at that head that read `ok`, with issues or a failing gate;
2. **THE CLAIM BEFORE THE WRITE** — `sonar_snapshots.post` NULL → `{status:'posting'}` by
   compare-and-set. Two presses, two tabs or a restart can never post twice;
3. the LIVE PR is open and still at that head (a moved head posts nothing — `409 HeadMoved`);
4. the comment; then `posted` (with GitHub's comment id) or `failed` (with the error); then
   `settlePrAfterWrite`. **Never retried.** A post cut off mid-flight stays `posting` for good.

The body: a lead line ("SonarCloud on abc1234: 50 of 132 issues, highest severity first"), the gate's
failing conditions, a link to the analysis, then per item: severity, type and rule name; the rule key,
place, effort and a link; SonarCloud's message; the flagged lines in a fence longer than any backtick run
in them; and "How to fix" in a `<details>`. Every SonarCloud string is made safe (`safeCommentText`: no
`@` pings, no `<!--`). Built under 60,000 characters (GitHub's limit is 65,536); items that do not fit
are COUNTED in a closing line. The hidden marker `<!-- pierre:claude-review-sonar v=1 -->` always ends
it, so `isLimnPostedComment` knows it and it never re-triggers an auto review. An auto post adds
`AUTO_POST_FOOTER`; a manual one does not (the same as every other manual post).

**Auto**: after a SUCCEEDED AUTO review, `maybeAutoPostSonar` posts when the workspace's auto-posting is
on with its `sonar` kind (`AutoPostKinds.sonar`, default on inside auto-posting, which is off until
switched on) and the PR passes `autoPostEligibility` (open, not a draft, not a bot's, and under scope
`mine` yours). A decision NOT to post writes nothing, so a person can still post by hand.

The post route registers **locally only**: it posts through the reader's `gh` session, like every
Claude Review post.

## AI Fix

`loadSeedInputs` (coding/ai-fix/manager.ts) reads `getSonarIssuesForPrHead`: the snapshot AT THE PR'S
SYNCED HEAD, when it read `ok` (`[]` once the head moves). Each item is a seed candidate:

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
`sonar/sonar-db.test.ts` (token never returned or exported, settings, post once, auto post),
`coding/ai-fix/review-seed.test.ts` § SonarCloud items, `claude-review/prompts.test.ts` § SonarCloud.

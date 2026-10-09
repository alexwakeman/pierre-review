# Issue trackers — the tracker seam (CORE, free, both modes)

The issue tracker links the tickets a pull request names, reads each ticket when the PR arrives,
and feeds every surface that shows a ticket: the PR pane's ticket chips and story panel, the Open
PRs ticket row and ticket stacks (with their "Merged (n)" panel), the ticket modal, the ticket
review's members and story, and a deep PR review's "Related PRs". It is **CORE and FREE on every
tier, in local and cloud, and in the public `npx limn-review` install** (which ships without the
private plugin). It lived in the plugin until **apiVersion 23**; this document is the contract
since the move. Code: `apps/backend/src/tracker/`.

> Phases. Phase 1: the seam, Jira as the first adapter, Linear kept link-only. Phase 2: the GitHub
> Issues adapter (§ GitHub Issues below). Phase 3: the Linear reader (§ Linear below). Each slots in by
> adding an adapter (`tracker/registry.ts`), its key shape in shared `parseTicketIdent`, and its name
> to shared `TRACKER_PROVIDERS_AVAILABLE`. Nothing else should need to change.

## The seam (`tracker/types.ts`)

ONE tracker per workspace (`workspace_trackers`), ONE adapter per provider
(`TrackerProvider = 'jira' | 'github' | 'linear'`). An adapter answers five questions:

| Concern | Member | Jira | GitHub Issues | Linear |
|---|---|---|---|---|
| IDENTITY | `siteRoot(baseUrl)`, `isKey(key)`, `normalizeKey(raw)` | shared `jiraApiRoot` (the ONE fold) | fixed `https://github.com`; key `owner/repo#12` | shared `linearSiteRoot`: `https://linear.app/<urlKey>`; key `ENG-123` |
| LINKING | `detect(cfg, pr)`, `browseUrl(base, key)`, optional `linker` | `PREFIX-123` in title (+ branch with an allowlist) → `{base}/browse/KEY` | the issues the PR CLOSES (`linker` reads them; `required`) → `…/owner/repo/issues/12` | the issues the PR is ATTACHED to (`linker`, not `required`) ∪ Jira-style detection → `{root}/issue/KEY` (stored rows keep Linear's own URL) |
| FETCH | `reader.fetchTicket(call, key)` | REST v2 `issue/KEY?fields=*all&expand=names,schema` | one GraphQL call per issue | one GraphQL POST per issue to the fixed `api.linear.app` |
| PEERS | not per-adapter | stored rows sharing `(provider, api_root, issue_key)` | same | same |
| CREDENTIAL | `reader.credential` | `'token'` (sealed, per workspace) | `'none'` — the account's GitHub token | `'token'` — a personal API key, the same sealed slot |

Everything else is written ONCE over the seam: the stored tickets (`tracker/store.ts`), the
worker (`tracker/worker.ts`), the PR chips (`tracker/enricher.ts`), the routes
(`tracker/routes.ts`, `links.ts`, `merged.ts`), the ticket review's source
(`tracker/peers.ts` via `tracker/ticket-source.ts`) and the credential at rest
(`tracker/secret.ts`). The modules take ONE context argument, `TrackerContext`
(`tracker/context.ts`) — the `AgentContext` precedent: built from direct core imports
(`tracker/runtime.ts`), never `ProContext`; tests hand in an in-memory SQLite and a fake seal.

- ⚠ **A provider with no adapter is "no tracker".** The settings PUT accepts only
  `TRACKER_PROVIDERS_AVAILABLE` (`['jira', 'github', 'linear']`); a stored value naming another provider reads
  as `provider: null` (`tracker/settings.ts` `liveProvider`). The Settings picker lists the same
  shared array — never a hard-coded list.
- ⚠ **Only a READING provider is walked.** The worker's population is workspaces whose adapter has
  a `reader` and the credential it needs; a link-only workspace gets chips and nothing else.

## Identity — one ident per ticket

`<provider>:<root>#<KEY>` (shared `ticketIdent`). `root` is the adapter's canonical site root, so
the same site and key are the same ticket across workspaces, repos and callers. **Jira idents are
unchanged from the plugin era** (`jira:<apiRoot>#<KEY>`, `jiraTicketIdent`), so every stored
ticket review, member, item and card kept its key — nothing was migrated.

- ⚠ **`jiraApiRoot` is the ONE derivation of a Jira root** (shared `claude-review.ts`): the server
  runs it on the workspace's base URL, the SPA on a ticket's browse link. A second copy that drifts
  by one character splits one ticket into two idents.
- `parseTicketIdent` accepts a provider ONLY when its key shape is set (`TICKET_KEY_SHAPE`; Jira's
  today). `isTrackerIdent(parsed)` is the test every consumer uses — never `kind === 'jira'`, so a
  new provider needs no consumer change.

## Linking — detection

`tracker/detect.ts` (the plugin's `issue-links/extract.ts`). Exactly two places are ever read: the
PR **title** and the **head branch**. ⚠ Commit messages are not scanned and never were; the PR body
is not stored under lean storage and is not a source either.

- A configured **project-key allowlist** makes detection exact; without it, precision heuristics
  apply (uppercase in the title, a denylist of look-alikes, version tags dropped) and the branch is
  NOT scanned (`eng-123` is indistinguishable from `node-18`).
- **Match scope** `'title' | 'title_branch'` (NULL = `'title_branch'`, the behaviour before the
  setting): narrows an allowlisted setup to the title. Inert without keys — the Settings control
  is disabled and says why.
- ⚠ **The workspace is the PR's own.** A repo belongs to exactly one workspace; a repo with NO
  membership row, or another tenant's repo, has NO tracker — absent, never a neighbour's.
- `detectForAccess` is the ONE rule; the PR chips, the ticket routes, the Open PRs batch and the
  worker all call it. It also appends the tickets a person added by hand (§ Adding a ticket by hand).

## Adding a ticket by hand — the Story check's paste box

A ticket that is not in the PR's title, branch or links can be ADDED by a person: the Story check's
paste box (`components/TicketPasteBox.tsx`, the DEFAULT way in; "Input manually" reveals the typed
story form) takes one or more ticket links or keys — `PROJ-123`, `owner/repo#12`, `#12` (an issue in
the PR's own repo), `…/browse/KEY`, a Jira board `?selectedIssue=KEY`, a Jira Cloud issue view `…/projects/P/issues/KEY`, `github.com/o/r/issues/12`,
`linear.app/<ws>/issue/KEY`. Parser: shared `ticket-refs.ts` (`parseTicketRef`, `splitTicketRefs`),
run by the SPA for chips and again by the server. Route: `POST /api/prs/:id/tracker-ticket/resolve
{refs, link}` (`tracker/manual-links.ts`, `[search, read]` tier, ≤ `TICKET_REFS_MAX` (10) refs). A hand-added
ticket the detection would not name carries `TicketRef.manual` and is removable from the PR pane's Ticket
row (`DELETE /api/prs/:id/tracker-ticket/manual?key=`, deletes only the `'manual'` row).

- ⚠ **Decided against the PR's OWN workspace tracker.** A link for another provider or another
  site/Linear workspace is `other_tracker` with a sentence — refused BEFORE any call, never read with
  this workspace's credential. Roots compare through the shared folds (`jiraApiRoot`,
  `linearSiteRoot`, `GITHUB_TRACKER_ROOT`). The project allowlist does NOT apply: a person named it.
- `link: false` reads each ticket once (`adapter.reader.fetchTicket`) for the chip, stores nothing.
  `link: true` writes a placeholder `tracker_tickets` row with **`detected_from = 'manual'`** (no
  migration: the column is free text) and reads exactly those keys through `syncOnePrNow` (forced keys
  now rank FIRST in the worker's queue, so an existing row cannot lose its one slot to a new key). A
  ticket that does not read `ok` is DELETED again — a typo never becomes one of the PR's tickets. At
  most `MANUAL_LINKS_PER_PR` (20) per PR.
- ⚠ **Detection UNIONS the manual rows** (`DetectInput.manualKeys`, filled by `manualKeysOf` from rows
  on the workspace's CURRENT provider + site; `detectPrTickets` reads them itself). So a hand-added
  ticket is the PR's everywhere — chips, the Open PRs row, `resolvePrTickets`, the ticket review's
  members and its `{prId, ident}` start — and the worker's prune KEEPS it and refreshes it on its TTL.
  A key both detected and hand-added stays `'manual'`, so a later title edit cannot prune it. A manual
  row left on another site after a tracker change is not a ticket and is pruned like any other.
- This widens "not a tracker proxy" deliberately and only this far: a key a PERSON named, on the
  workspace's own site, with its own credential, capped and rate-limited. There is no "unlink" yet.

## Fetch on receipt — the stored tickets and the worker

**A tracker is read when a PR is RECEIVED, never when it is VIEWED.** The worker stores each
detected ticket in `tracker_tickets`; every consumer reads the row.

- **`tracker_tickets`** — one row per `(account_id, pr_id, issue_key)` (the conflict target):
  provider, workspace, site (`api_root`), browse URL, `detected_from` + `detect_order`, title,
  description and acceptance criteria (markdown), the criteria field and its source
  (`setting`/`default`), issue type, status + category, assignee, every candidate text field
  (`candidates_json`), the read state (`ok`/`not_found`/`no_access`/`failed`, `error_code`,
  `fetched_at`, `checked_at`, `next_check_at`) and `changed_at`. No FKs; pruned in BOTH delete
  paths; in `accountScopedTables()`.
- **`pro_jira_ac_fields`** — the criteria field per `(account, workspace, site, issue type)`.
  ADOPTED IN PLACE from the plugin (same name, columns and index). Jira-specific by nature.
- **The worker** (`tracker/worker.ts`) is PULL-BASED: each pass re-derives "open PRs in a reading
  workspace" → detection → a ticket is DUE with no row, a row from another site/provider, or a past
  `next_check_at`. A key the PR no longer names has its row deleted. **TTLs**: 30 min after a good
  read, 10 min after a transient failure (content kept, state stays `ok`), 6 h after
  `not_found`/`no_access` (content cleared).
- **Merged PRs** keep the rows they had when open (never refreshed or pruned); a PR that merged
  before the worker saw it gets its rows ONCE (90-day window, missing-only, one read per ticket —
  copied from a stored row of the same ticket when one exists). The per-repo window is scanned once
  per process; a repo walk re-opens it at most every 30 min.
- **Bounds**: 40 tickets per account per pass, 200 per tick, 4 at a time, each key once per
  workspace per pass. **Triggers**: the `*/2` tick (`sync/scheduler.ts`), a kick after every repo
  walk (`sync/repo-synced-hooks.ts`, registered by `startTracker`), a kick on a settings save, and a
  targeted kick from `POST /api/ticket-links` for listed PRs with no row.
- ⚠ **Budgets are pre-empted, never surfaced**: a 401 / 403 / refused address / redirect backs the
  WORKSPACE off for 30 min (a 429 for 5), keyed on a fingerprint of (provider, site, email, token),
  so a new token ends it at once. A person pressing Refresh bypasses it. Logs carry account +
  workspace + the error CODE only.
- **The criteria field is server-side**: `deriveAc` = the workspace's field for the issue type when
  the ticket has it, else the STRONG name match, else none — ONE rule for the worker, the route and
  the re-derivation. "None of these" stays a per-tab choice, never stored.
- `changed_at` moves ONLY when membership or story text moves (`storyOrMembershipMoved`); a status
  or assignee change is not a change (the ticket review would re-bill for nothing).

## Peers — the ticket review's source

`tracker/peers.ts`, read by the ticket review and a deep PR review through
`tracker/ticket-source.ts` (it was the OPTIONAL plugin seam `AgenticProviders`; core always answers
now). ⚠ **STORED ROWS ONLY** (`resolvePrTickets(…, { storedOnly: true })`) — these are view paths.

- `ticketsForPr(account, pr)` — the PR's readable tickets as clipped, validated stories.
- `ticketMembers(account, ident)` — every PR on the ticket: this account, the same provider + site,
  ANY workspace, state `ok`; merged PRs included (the caller decides open/merged/closed).
- `ticketStory(account, ident)` — ⚠ **ONE story per ticket for every caller**: the FRESHEST stored
  row across every PR on it (newest `fetched_at`, then id). Never "the first member's row".
- `listChangedTicketIdents(account, since)` — feeds the sweeper.
- ⚠ `ticket-source.ts` imports its reader LAZILY: `tracker/runtime.ts` opens the database client at
  import time, and a test that statically imported the chain before pointing `DATABASE_URL` at a
  throwaway file once wrote into the developer's real database.

## Automatic default — GitHub Issues when a repo uses it

A workspace with **no stored tracker choice** (no `workspace_trackers` row, or `provider` NULL) uses
**GitHub Issues** when at least one of its repos uses it, else no tracker. A **stored choice always
wins, "None" included** — a chosen None is stored as the literal `'none'` (`NONE_PROVIDER`;
`maybeAdapterFor('none')` is null, so it reads as no tracker), because NULL means "no choice"
(migration sqlite `0094` / pg `0081` turned only an ALL-NULL pre-existing row — the one a None save alone writes — into `'none'`; a NULL provider beside any other stored value, e.g. a legacy-moved match scope, stays unchosen, and `tracker/legacy-import.ts` leaves its NULL providers NULL so both upgrade orders agree).

- **A repo "uses GitHub Issues"** when issues are ENABLED and at least one issue was linked to a PR
  in the last 90 days: `repos.uses_github_issues` (+ `github_issues_checked_at`), written by
  `tracker/github/issues-usage.ts`. ONE GraphQL call per repo (`repository.hasIssuesEnabled` +
  `search(type: ISSUE)` returning only `issueCount` for `repo:o/n is:issue linked:pr
  updated:>=<90d>`; 1 point, no paging), from the tracker tick, at most once a day, ≤ 10 repos per
  tick, and ONLY for repos in an unchosen workspace. ⚠ `pull_requests.closing_issues` cannot be the
  source: it is read only for workspaces that ALREADY use GitHub Issues. ⚠ The column is written only
  on a POSITIVE answer (a nulled selection leaves it); a low budget stamps nothing.
- **ONCE PER WORKSPACE ADD, TOO** (`checkReposGithubIssuesUsage`, kicked by `kickGithubIssuesCheck`
  in `tracker/index.ts`): a repo that JOINS a workspace — `POST /api/workspaces/:id/repos`, a PATCH's
  added repos, and the repos a PATCH re-homes to Default — is asked NOW, whatever its last answer's
  age and whatever the target's tracker choice, so the automatic default is right at once instead of
  after the daily tick. A brand-new repo (which lands in Default with no answer) is asked once after
  its FIRST walk (the repo-synced hook, `onlyUnasked`). A newly-true answer kicks that account's
  ticket pass. Same positive-answer and low-budget rules; fire-and-forget, never fails the route.
- ⚠ **ONE RESOLVER.** `readWorkspaceTrackerRow` (`tracker/settings.ts`) returns the EFFECTIVE row
  (`effectiveTrackerRow`), so the enricher, the worker, the ticket routes, the merged panel, the
  closing-issues step and the SPA's `useTrackerOn` all agree. The worker's population
  (`readingWorkspaces`) is a set query and adds `autoDetectedWorkspaces`. Only the WRITER (and the
  fold itself) reads the stored row (`readStoredTrackerRow`) — a patch that names no provider must
  leave an unchosen workspace automatic, never freeze today's detection into a choice.
- **The wire** (`GET`/`PUT /api/workspaces/:id/tracker`) carries the effective `issue.provider`,
  `providerChosen` (false = automatic) and `githubIssuesRepos` (the workspace's repos that use it,
  sent whatever the choice). Settings preselects the effective provider, labels the option "GitHub
  Issues (detected)" and, when it was picked automatically, says which repo caused it. Saving None
  from there stores `'none'`.

## GitHub Issues (phase 2) — `tracker/github/`

A workspace whose tracker is GitHub Issues needs NOTHING typed in: no base URL, no project keys, no
token (shared `TRACKER_PROVIDER_FIELDS`; the Settings section prints one sentence). The adapter has a
fixed site (`fixedBaseUrl`), so read a tracker's base URL through `trackerBaseUrl(issue)`, never
`issue.baseUrl` — the stored Jira URL is ignored but KEPT, so switching to GitHub and back keeps the
Jira token (the token is dropped only when the stored URL itself moves to another host).

- **LINKING IS EXACT.** A PR's tickets are GitHub's `closingIssuesReferences` — "Fixes #12",
  "Closes owner/repo#12" (cross-repository included) or a Development-panel link. A bare "#12" is
  not a ticket; the PR title and branch are not read at all. The adapter's `linker`
  (`github/links.ts`) reads them and stores them on the PR: `pull_requests.closing_issues`
  (+ `closing_issues_checked_at`, migration sqlite `0089` / pg `0076`).
- ⚠ **COST: ZERO FOR EVERY OTHER WORKSPACE.** The links are NOT a field on the repo walk's query
  (shared by every workspace). The worker runs the linker first in each pass, for PRs in a GitHub
  Issues workspace only: `nodes(ids:)` over ≤ 50 PRs with one `closingIssuesReferences(first: 10)`
  each — 1 point per batch, ≤ 200 PRs per pass. A PR is due when never read, when GitHub's
  `updatedAt` passed the last read, or every 30 min while open (a Development-panel link may not move
  `updatedAt`). Merged PRs are read once.
- ⚠ **NULL IS "NEVER READ", NOT "CLOSES NOTHING".** `[]` is GitHub's statement. A PR whose links are
  NULL is neither pruned nor read by the worker, the PR pane shows NO ticket row (never "No ticket
  found"), and the Open PRs row omits it and answers `titlesComplete: false`, which kicks the worker.
  A node GitHub did not return, or returned with the selection nulled, is left as it was.
- **IDENTITY.** Every GitHub row is stored on ONE site, `api_root = 'https://github.com'`, with
  `issue_key = 'owner/repo#12'` (lower-cased; shared `githubIssueKey` / `canonicalTicketKey`), so
  every "same site" comparison in the worker, routes and peers holds unchanged and one PR may close
  issues in several repositories. The IDENT names the repository in its root —
  `github:https://github.com/owner/repo#12`; ⚠ the two spellings meet ONLY in shared
  `trackerTicketIdent` (row → ident) and `trackerTicketRow` (ident → row). `parseTicketIdent` accepts
  a GitHub ident only with a numeric key and a `https://github.com/<owner>/<repo>` root. Every key a
  request carries goes through the adapter's `normalizeKey` (Jira upper-cases, GitHub lower-cases).
- **FETCH** (`github/reader.ts`): one GraphQL call per issue with the ACCOUNT's token
  (`TrackerContext.github`, resolved per call through `getAccessToken` — no cache): title, body
  (markdown), state + reason (→ status `Open` / `Closed…`, category `new` / `done`), issue type, the
  first assignee, ≤ 50 sub-issues. Labels are not read (nothing shows them).
- **ACCEPTANCE CRITERIA** (`github/ac.ts`), first that has something: SUB-ISSUES (`- [x] Title (#n)`
  per sub-issue) → a TASK LIST in the body → an "Acceptance criteria" SECTION (heading or bold label)
  → none (the whole body is the story). Code fences never count; criteria taken from the body are cut
  out of the description. They travel as ONE strong candidate (`github:sub_issues` /
  `github:task_list` / `github:heading`), so `deriveAc` picks them on a read and on a merged PR's copy
  alike; there is no field to change (the SPA hides "Change"; the ac-field route refuses the id).
- **PRIVATE / INACCESSIBLE ISSUES**: NOT_FOUND → state `not_found`; FORBIDDEN or an SSO wall →
  `no_access` (a new transport code that is a statement about the TICKET, never a workspace
  backoff — one private repository does not stop the rest). Both are STORED, and the ticket route
  answers our sentence "Can't read this issue. …", which the modal and story disclosure print — never
  "no story".
- ⚠ **RATE LIMITS ARE PRE-EMPTED**: the linker and the reader skip on `isBudgetLow` (hard-limited, or
  under the walks' 100-point floor) and feed `noteBudget` from each response; a limit becomes an HTTP
  429 inside the worker — a 5-minute workspace backoff, no row written, read on a later pass.
- **PEERS** need nothing new: every PR whose stored rows share `(github, https://github.com,
  owner/repo#12)` — the stack, across repos and workspaces of this account. `closedByPullRequests-
  References` is NOT read (it would only find PRs in repos the workspace does not track).
- `ClaudeReviewTicketSource` stays `'jira'` for a GitHub-read story: it means "read from the
  tracker", and the key + link say which.

## Linear (phase 3) — `tracker/linear/`

A Linear workspace asks for three things (shared `TRACKER_PROVIDER_FIELDS`): the **workspace URL**
(`https://linear.app/acme` — an IDENTITY, never fetched), an optional **team-key allowlist** + match
scope (detection, exactly as Jira), and a **personal API key** (write-only, sealed — § Credential).
Cloud OAuth (a Linear OAuth app per Limn install) is NOT built; it is the obvious next step for cloud,
where pasting a personal key is the only route today.

- **IDENTITY.** The root is the Linear WORKSPACE (Linear's API calls it the organisation):
  `https://linear.app/<urlKey>`, lower-cased — shared `linearSiteRoot`, the ONE fold, run on the
  Settings URL, on Linear's issue URLs and on a chip's link alike. The key is the team key + number,
  upper-cased (`ENG-123`); the ident is `linear:https://linear.app/acme#ENG-123` and `parseTicketIdent`
  accepts a Linear ident only with that root shape. A row is `(linear, https://linear.app/acme,
  ENG-123)`, so peers, stacks and the ticket review need nothing new.
  - ⚠ **A KEY FOR ANOTHER LINEAR WORKSPACE IS REFUSED, NOT STORED.** A personal key belongs to ONE
    Linear workspace. The reader checks every issue's URL folds to the workspace's root; a mismatch is
    `bad_url` — workspace-wide, a 30-minute backoff, no row — because storing it would key another
    workspace's ticket under this one's ident. The connection check names the key's workspace and
    says when it is not the saved URL (`matchesBaseUrl`). Moving the URL to another Linear workspace
    drops the saved key (the "site" of a Linear URL is the workspace, not the host).
- **LINKING, BEST FIRST.** (1) The issues Linear's GitHub integration ATTACHED the PR to —
  `attachmentsForURL(url: "https://github.com/<owner>/<repo>/pull/<n>")`. That integration reads the
  branch (`alex/eng-123-…`), the title, magic words in the BODY ("Fixes ENG-123") and links made in
  Linear, so it sees what lean storage never keeps. (2) Then the keys detection finds in the title and
  branch, with the allowlist + match scope, exactly as Jira. `detect` is the UNION, links first
  (`from: 'link'`). The links are stored on the PR — `pull_requests.linear_links` (+ `linear_links_root`,
  `linear_links_checked_at`; migration sqlite `0090` / pg `0077`).
  - ⚠ **THE LINKS ADD; THEY NEVER GATE** (`linker.required = false`, unlike GitHub's). NULL ("never
    read", or read against another root) is simply "detection alone": the PR pane never goes blank, a
    workspace without the integration still links by key, and a link-only Linear workspace (no key)
    behaves exactly as it did before phase 3.
  - Issues Linear returns from any other workspace are dropped; at most 10 per PR.
- ⚠ **COST: ZERO FOR EVERY OTHER WORKSPACE, AND FOR A LINEAR WORKSPACE WITH NO KEY.** The worker runs
  the linker per WORKSPACE (each has its own key and root), only for a Linear workspace whose call
  prepared. ONE request carries ≤ 25 aliased `attachmentsForURL(first: 10)` fields (≈ 22 complexity
  points each), ≤ 200 PRs per pass. A PR is due when never read on this root, when GitHub's
  `updatedAt` passed the last read, or every 30 min while open (a link made in Linear does not move the
  PR); a merged PR is read once. Steady state, a workspace with 100 open PRs costs ≈ 8 link requests an
  hour plus one issue read per ticket per 30 min — far inside Linear's per-key budget.
- **FETCH** (`linear/client.ts`): one `issue(id: "ENG-123")` query per ticket (≈ 120 complexity
  points with 50 children): identifier, title, description (markdown), url, state `{name, type}`,
  assignee, project name, ≤ 50 children (+ `hasNextPage`). Status category from the state TYPE:
  backlog/unstarted/triage → `new`, started → `indeterminate`, completed/canceled → `done`. Linear has
  no issue types (`issue_type_*` NULL). The project is appended to the description as one line
  (`Linear project: …`) — context for the ticket review. ⚠ The CYCLE is deliberately NOT read: it rolls
  over every few weeks for carried work, and a story-text change re-bills the ticket review
  (`storyOrMembershipMoved`) exactly as a status change would. Priority and labels are not read
  (nothing shows them). The stored `url` is Linear's own (with its slug).
- **ACCEPTANCE CRITERIA** — the SHARED rule (`tracker/ac.ts`, GitHub's too, one copy): CHILD ISSUES
  (`- [x] Title (ENG-124)`, completed ticked, CANCELED left out, "… and more sub-issues" past 50) → a
  TASK LIST in the description (issue-form / first-person groups dropped) → an "Acceptance criteria"
  SECTION → none. One strong candidate `linear:<source>`, so `deriveAc` picks it; no field to change
  (the SPA hides "Change"; the ac-field route refuses the id).
- **THE CALL** goes to ONE FIXED HOST, `https://api.linear.app/graphql`, as a POST through the same
  transport as Jira's (`jira/fetch.ts` `nodeTransport`, which takes an optional body): no redirects, a
  10 s timeout, a 5 MiB cap, https + connect-time public-address check in cloud. The key is sent as
  `Authorization: <key>` — ⚠ never `Bearer` (Linear 400s an API key sent that way).
- **ERRORS.** `AUTHENTICATION_ERROR` / 401 → `unauthorized` (workspace backoff 30 min; route sentence
  "Linear rejected this key. Save a new personal API key in Settings."); "Entity not found" →
  `not_found`; `FORBIDDEN` on the issue → `no_access` (both STORED per ticket, 6 h); a key for another
  workspace → `bad_url` (above).
  - ⚠ **RATE LIMITS ARE PRE-EMPTED, NEVER SURFACED.** Linear meters per user (an API key: 2,500
    requests and 3,000,000 complexity points an hour, ≤ 10,000 per query). Each answer's
    `x-ratelimit-*-remaining` headers feed a per-KEY budget in memory; under 25 requests or 25,000
    points the next call throws a 429 without calling, until Linear's reset. `RATELIMITED` (HTTP 400
    or 429) is the same 429. A 429 — from the reader or the linker — is a 5-minute WORKSPACE backoff
    with no row written. A person pressing Refresh bypasses the backoff, not the budget.
- **SETTINGS.** Settings → Issue tracker: "Workspace URL", "Team keys", "Where to look", and — once
  Linear is SAVED with a URL — the **Linear API key** block (`LinearApiAccess.tsx`): a password field,
  "Saved" + Replace / Remove, and **Check connection** (`GET …/tracker/linear-check`: `viewer` +
  `organization`, one call, click-gated). The PUT refuses a value that is not shaped like a personal
  key (`lin_api_…`) with a sentence, so a pasted GitHub or Jira token is never sealed and sent.

## Credential — the sealed per-workspace token

`workspace_trackers.auth_token` (with `auth_email`). Jira: email set → HTTP Basic
`email:apiToken` (Cloud); no email → `Bearer <PAT>` (Server / Data Center). Linear: a personal API
key, sent bare as `Authorization: <key>` (the wire's `jira` block is the workspace's ONE credential
block, named for its first provider — `jira.token` / `jira.hasToken` / `jira.clearToken`).

- ⚠ **WRITE-ONLY.** No route returns it (`hasToken` only); saving without a token keeps it;
  `clearToken` removes it; and pointing the base URL at a different SITE removes it — a different
  host, or for Linear a different workspace (`linear.app/acme` → `linear.app/other`) — so a token typed
  for one site is never sent to another.
- **Sealed whenever the process can seal**: `sealed:v1:<iv:tag:ct>` (core `auth/crypto.ts`,
  AES-256-GCM, ENCRYPTION_KEY — always in cloud); `plain:<token>` on a local install without a key,
  the same trust as that machine's `gh` token. Both prefixes stay readable; an unopenable `sealed:`
  value reads as `unreadable` ("save it again"), never sent as garbage.
- The account export carries the tracker row with the token reduced to `hasToken`
  (`db/export-account.ts`); erasure deletes all three tables.

## Outbound calls — the SSRF guard (`tracker/jira/fetch.ts`)

Every call to a customer-named host goes through ONE helper — never a bare `fetch`. (Linear's host is
FIXED, never customer-named; its POST rides the same transport for the same no-redirect, timeout and
size rules — § Linear.) GET only, a 10 s
timeout, a 5 MiB cap, **no redirects** (a 3xx is an error; following it would forward the
Authorization header), JSON only. In **cloud**: https only, and the host must resolve to PUBLIC
addresses, checked at CONNECT time through the socket's own `lookup` (closes DNS rebinding).
Local allows http and LAN hosts (an on-prem Jira is normal). Details: [SECURITY.md](SECURITY.md).

## Routes (`tracker/routes.ts`; contracts in [API.md](API.md))

| Route | What | Tier |
|---|---|---|
| `GET /api/workspaces/:id/tracker` | the workspace's tracker (`hasToken`, never the token); 404 if not yours | `read` |
| `PUT /api/workspaces/:id/tracker` | partial patch `{issue?, jira?}`; kicks the worker | `search` |
| `GET /api/workspaces/:id/tracker/jira-fields` | the Settings connection check (one Jira call) | `search` |
| `GET /api/workspaces/:id/tracker/linear-check` | the Linear connection check (one Linear call) | `search` |
| `GET /api/prs/:id/tracker-ticket?key=` | one detected ticket's STORED row (read once if never reached) | `search` |
| `POST /api/prs/:id/tracker-ticket/refresh` | re-read now (backoff bypassed) | `search` |
| `PUT /api/prs/:id/tracker-ticket/ac-field` | the criteria field for the ticket's issue type | `search` |
| `POST /api/ticket-links` | the Open PRs ticket row, ONE request per board | `search` |
| `GET /api/ticket-merged-prs?workspace=&keys=` | the stacks' "Merged (n)" panel, DB-only | `read` |

⚠ **NOT A TRACKER PROXY.** The ticket routes address a PULL REQUEST (ownership → 404), re-run
detection on it and answer only for a key detection found. Every failure is a 502 carrying a
sentence we wrote, never the tracker's body, URL or header. Tenancy of `workspace_trackers` is ALSO
structural — the named composite FK `workspace_trackers_workspace_account_fk`.
`verify:isolation` covers every route and table (both accounts share a site AND a key, so a dropped
account predicate has something to leak).

## The move from the plugin (apiVersion 23)

- **Migration** sqlite `0088` / pg `0075`: creates `workspace_trackers` and `tracker_tickets`,
  adopts `pro_jira_ac_fields`. It copies NO data — the source tables are the plugin's, absent on a
  fresh or plugin-less install, and SQLite cannot test for a table in SQL.
- **The boot-time MOVE** (`tracker/legacy-import.ts`, run by `startTracker` AFTER the plugin binds,
  so its own migrations have run): tests each source table and column for existence, copies
  `pro_workspace_settings.issue_*`/`jira_email`/`jira_token` → `workspace_trackers` and
  `pro_pr_jira_tickets` → `tracker_tickets` (provider `'jira'`) with ON CONFLICT DO NOTHING, and in
  the SAME transaction NULLs those columns / deletes those rows. A MOVE, so it runs every boot with
  no marker: a second boot finds nothing, a token is never at rest in two places, and a value
  cleared in core is never resurrected. The token moves in its stored form — nobody re-enters it.
- **Plugin side**: `src/jira/` and `src/issue-links/` deleted; plugin migrations `0038`/`0039`
  stripped to `SELECT 1;` (an install that ran them keeps what they made; a fresh install no longer
  grows the old table, and 0039's bare `ALTER` would otherwise fail and drop the whole plugin to OSS);
  the tracker columns on `pro_workspace_settings` are DORMANT (undeclared, never read or written).
- **Contract**: `ProCapabilities.issueLinks`, `ProContext.registerPrDetailEnricher` (required — its
  removal alone forces the bump), `registerAgenticProviders`, `registerRepoSyncedHook` and
  `host.sealSecret`/`openSecret` are gone; **apiVersion 22 → 23** in all four literals. A 22 plugin
  would run its own Jira worker and routes against tables core now owns, so the gate refusing it is
  the safe outcome.
- **SPA**: no capability gate. The Open PRs "Group by ticket" view and ticket row show wherever THIS
  workspace has a tracker (`useTrackerOn`); the PR pane's slim story check reads
  `PrDetail.tickets != null`; Settings → Issue tracker is ungated (both modes, every tier), and the
  Jira API access block is no longer behind `me.ai.enabled` — the token feeds free surfaces too.

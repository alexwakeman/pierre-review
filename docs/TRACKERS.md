# Issue trackers — the tracker seam (CORE)

The issue tracker links the tickets a pull request names, reads each ticket when the PR arrives,
and feeds every surface that shows a ticket: the PR pane's ticket chips and story panel, the Open
PRs ticket row and ticket stacks (with their "Merged (n)" panel), the ticket modal, the ticket
review's members and story, and a deep PR review's "Related PRs". It is **CORE**: it lived in
the private Pro plugin until the plugin's apiVersion 23 (2026-10), and this document is the contract
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
| FETCH | `reader.fetchTicket(call, key)` | REST v2 `issue/KEY?fields=*all&expand=names,schema` (+ its comments, § Ticket comments) | one GraphQL call per issue (+ `comments(last: 20)`) | one GraphQL POST per issue to the fixed `api.linear.app` (+ `comments(last: 20)`) |
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
  membership row, or another account's repo, has NO tracker — absent, never a neighbour's.
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
detected ticket in `tracker_tickets`; every consumer reads the row. The ONE exception is the sprint list read
(§ The sprint list read), and it is still never triggered by a view.

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

## Ticket comments — read in the same issue read (`tracker/comments.ts`, `tracker_ticket_comments`)

The discussion under a ticket: people clarify a criterion, drop one, add one. The worker reads it in the
SAME issue read it already makes, stores it per TICKET, and the ticket review and the story docs check
are given it as discussion — never as the story.

- **READ, NO NEW CALL** (`FetchedTicket.comments`, `FetchedTicketComment`): **Jira** — `fields.comment`
  from the `fields=*all` answer (wiki markup / ADF bodies → markdown through `jira/text.ts`). Only when
  Jira cut the field short (`total` > the comments sent) does the reader make ONE more call,
  `/issue/KEY/comment?startAt=<total-20>&maxResults=20`, for the newest page; an answer with no comment
  field, or that extra call failing, leaves the comments UNKNOWN (never the oldest page, which would
  prune newer stored ones). **GitHub Issues** — `comments(last: 20)` in the one issue query (still 1
  point). **Linear** — `comments(last: 20)` on `issue(id:)` (≈ 40 complexity points). Bodies are markdown.
- **STORED PER TICKET** (`tracker_ticket_comments`, migration `0142`): `(account_id, provider,
  api_root, issue_key, comment_id)` — a ticket on five PRs has its comments once. The worker writes once
  per ticket per read (`writeTicketComments`): the newest `TICKET_COMMENTS_KEPT` (20) are upserted, each
  body cut to `TICKET_COMMENT_BODY_MAX` (4000), and the ticket's other rows deleted. A merged PR's copy
  from a stored sibling makes no read and writes no comments (they are already the ticket's).
- ⚠ **POSITIVE-ANSWER RULE.** `comments: undefined` (not in the answer) writes nothing; `[]` (the
  tracker's "none") clears; a FAILED read — transient or refused — never touches them. A comment write
  failure is logged and never fails the ticket. When the last PR stops naming a ticket (the worker's key
  prune) or its PRs are deleted (BOTH delete paths, `db/ticket-comments-prune.ts`), comments of tickets
  no `tracker_tickets` row names are deleted. Erased with the account.
- **BOTS** are STORED with `is_bot` and left out of every prompt and every list a person reads: Jira
  `author.accountType === 'app'` (Automation for Jira, Connect / Forge apps) or an automation NAME (shared
  `isAutomationCommentName`, for Server / Data Center); GitHub `author.__typename === 'Bot'`, a `[bot]`
  login, or a login the automation or review-bot vocabulary claims (`isAutomationCommentLogin`); Linear
  a comment with no `user` (an integration's).
- **WHERE THEY GO.** `ticketComments(account, ident)` (peers.ts, the ticket source) → the ticket review
  (`review/ticket-review/prompts.ts`) and the story docs check (`review/story-docs/`) get a nonce-fenced
  `TICKET COMMENTS` block, oldest first, `Author, YYYY-MM-DD:` per comment, at most
  `TICKET_COMMENTS_PROMPT_CHARS` (6000) — the NEWEST kept when cut, the lead line saying how many older
  were left out — and in the untrusted-text collision scan. The system prompts say: discussion, not the
  ticket; a comment may clarify or change scope when it says so plainly; a later one outweighs an earlier
  one; cite author and date when a verdict relies on one; never a requirement on its own. The sprint
  ticket checks start the same ticket review, so they get them too. The sprint briefs do NOT (their text
  hash is the sprint read's; comments would re-bill them).
- ⚠ **NOT STORY TEXT. A COMMENT NEVER RE-BILLS.** Comments are outside `storyOrMembershipMoved`
  (`changed_at`), the story hash, the ticket review's fingerprint and the docs check's `storyHash`. A run
  stores what it was given instead (`ticket_reviews.comments_seen {ids, count, hash}`, migration `0143`),
  and `TicketReviewState.newComments` counts the people comments since — "2 new comments since this
  check" beside the result, so the reader decides whether to Re-check.
- **SHOWN** under the ticket as written (`components/TicketComments.tsx`, in `StoryDisclosure`):
  "Comments (n)", collapsed, author · date · body. They ride `GET /api/prs/:id/tracker-ticket`
  (`JiraTicketDetails.comments`), already click-gated — no request of their own.
- **A NEW ADAPTER** (Notion, …) plugs in by returning `FetchedTicket.comments` from its
  `reader.fetchTicket` — `{id, authorName, authorId, isBot, body (markdown), createdAt, updatedAt}`,
  `isBot` by its own rule, `undefined` when its answer did not carry them. Nothing else changes: the
  worker stores them under the ticket's `(provider, api_root, issue_key)`.

## The sprint list read — the ONE read not triggered by a received PR (`tracker/sprint/`)

⚠ **A deliberate exception to "read when received".** This Sprint needs the tickets of the
tracker's CURRENT sprint, and most of them have no PR yet, so no PR can trigger their read. The rule
it keeps: **a view still never calls a reader.** `GET /api/sprint-graph` only stamps
`sprint_reads.viewed_at` and kicks; the read runs in the worker.

- **Demand-gated**: a workspace is read only while `viewed_at` is within `SPRINT_VIEW_TTL_DAYS` (7),
  at most every `SPRINT_READ_INTERVAL_MS` (20 min, `next_read_at`), only when its tracker READS (the worker's population, including the automatic GitHub
  default), its call prepares (`prepareTrackerCall`) and the worker has not backed it off. ≤ 5
  workspaces per tick, at the end of `runTrackerTick`; `POST /api/sprint-stories/refresh` marks it due
  and kicks.
- **Providers** (`SPRINT_LISTERS`): Jira `project in (<keys>) AND sprint in openSprints()` through
  `jiraGetJson` (`/rest/api/3/search/jql`, one retry on Server's `/rest/api/2/search` after a 404),
  sprint names from the `gh-sprint` field; Linear each team's `activeCycle`; GitHub Issues the
  nearest-due open milestone across the workspace's repos (never an overdue one; ≤ 20 repos per pass,
  `truncated` when cut). Project keys / team keys are the ones seen on this workspace's stored
  `tracker_tickets` (+ the tracker's `project_keys`); none → `no_projects`.
- **The sprint's DATES** (migration `0111`, `sprint_reads.sprint_starts_at / _ends_at`): read
  off the same answers, never a second call — the Jira sprint field's `startDate` / `endDate` (Cloud
  objects; Server's `…[startDate=…,endDate=<null>,…]` string, `sprintsOf`), Linear's `activeCycle {
  startsAt endsAt }`, a GitHub milestone's `dueOn` as the END only. Several active sprints / cycles →
  the one holding the most read tickets (`busiestSprintDates`, ties to the earliest start). Written on
  every good read (the status fallback, or none given, clears them). The page header ("14 Oct – 27 Oct ·
  day 1 of 14") and the pace's and the sprint builder's day facts read them; the cadence window is only the fallback.
- **Fallback** when the tracker has no sprint concept or none is active: To do + In progress tickets
  touched in the workspace's reporting window (`getReportingWindow`), else the trailing 14 days. The
  `source` says which (`sprint` / `cycle` / `milestone` / `status_fallback` + reason).
  ⚠ Jira's JQL says `updated >= -<N>m` (a relative duration), never a date literal: Jira reads a
  literal in the token owner's profile time zone.
- **Storage**: `sprint_tickets` (keyed `(account, workspace, ident)` — they cannot live in
  `tracker_tickets`, which is keyed on a PR). A ticket the read no longer returns flips `in_sprint`
  false; one unseen for 90 days is deleted with its accepted repos. A failure records `error_code` and
  keeps the last good list (5 min retry after a rate limit, else 20 min). A workspace the worker has
  BACKED OFF is recorded the same way, with the worker's code — never skipped silently, or a first
  read would show "Reading…" for ever. After a good read the BRIEF pass runs (`review/sprint-briefs/`,
  local + AI only; docs/CLAUDE-REVIEW.md § Sprint briefs). `sprint_reads` remembers the
  `provider` + `api_root` it read; a workspace that moved tracker or site since is reset on the next
  view (no source, no read time, due now). It also stores the automatic status order (§ The status
  order) and each ticket's blocking links + status id (§ Blocking links).
- **Referenced tickets and GHOST CHAINS** (`tracker/sprint/ref-status.ts`, `sprint_ref_tickets`,
  sqlite `0106` + `0107` + `0094`): the sprint's fold (`GET /api/sprint-graph`) carries the
  tickets a sprint ticket depends on, runs alongside, builds on or replaces — inside the sprint or not —
  and follows the chain outside it (A → B → C); the Critical path view draws the ones a path names in
  "Outside the sprint". So after storing the list the read asks the tracker for them **WITH THEIR
  TEXT** (description, the workspace's criteria field, type, assignee, links):
  - **Depth 1** (`sprintReferencedKeys`, pure): every key the in-sprint rows NAME — every tracker link,
    plus shared `ticketMentionsInText` over description + criteria (a link on this site always, a bare
    key only in a project the workspace reads or the ticket's own) — minus the sprint's own keys,
    ≤ `SPRINT_REF_LOOKUP_MAX` (200). All of them, so a ticket named only as context still has its status
    and title (and the story view its text).
  - **Depth 2–3**: what a GHOST points at through an EDGE (a blocking link, or its CURRENT brief's
    depends_on / concurrent / builds_on / supersedes reference) that nothing stores yet — the graph
    fold's `missing` (`db/sprint-graph-fold.ts`, the SAME fold the page draws), bounded so the graph
    never holds more than `SPRINT_GHOST_MAX` (60) ghosts, ≤ `SPRINT_GHOST_DEPTH_MAX` (3) hops. A ghost's
    references come from its brief, written AFTER the read, so the brief pass asks for the next hop
    itself (`expandSprintGhosts` through the `setSprintGhostExpander` seam, mode `missing`: only keys
    nothing stores, never a delete) — still the read's pipeline, ⚠ never a view.
  - **The call**: Jira only — JQL `key in ("A-1",…)`, `fields=*all&expand=names,schema` (the same fold
    as the sprint list), `SPRINT_REF_CHUNK` (40) keys per call through `jiraGetJson` (404 → the v2
    search). ⚠ Jira answers 400 for the WHOLE query when one key does not exist, so a 400 chunk is
    BISECTED down to the lone bad key, which is dropped — `SPRINT_REF_CALLS_MAX` (16) calls per lookup.
    Linear and GitHub Issues look nothing up (not built; their sprint tickets still link to each other).
  - **The store**: a FULL lookup that finished REPLACES the workspace's rows (`depth` = hops from the
    sprint); one cut short keeps what it could not re-read; a failure never fails the read.
    `knownTicketsFor` reads them as its LAST source.

## Blocking links — read in the same issue read (`blocked_by_json`)

The links a ticket WAITS ON, stored on both `tracker_tickets` and `sprint_tickets` as
`blocked_by_json` (shared `TicketLinkBlocker[]`: the linked issue's key, title, status + category, the
relation phrase from THIS ticket's side, and an https browse URL; ≤ 20). Migration migration `0103`. They feed the "Blocked" story issue (docs/CLAUDE-REVIEW.md § Story issues). No extra call:

- **Jira** — `fields.issuelinks` from the `fields=*all` answer the reader and the sprint list already
  make (`blockedByOf`, `jira/client.ts`). A link carries the OTHER issue on one side: `inwardIssue` →
  the phrase is `type.inward` ("is blocked by"), `outwardIssue` → `type.outward` ("depends on"). Kept
  iff shared `isBlockingRelation(phrase)` (the ONE predicate: "is blocked by", "depends on", "requires",
  "waits on"…; never "blocks", "is depended on by", "relates to"). Jira inlines the linked issue's
  summary and status, so the link needs nothing more.
- **Linear** — `inverseRelations` (another issue's relation TO this one) with `type: "blocks"`: the
  other issue blocks this one. 20 per issue on the one-issue read, 10 on the sprint list (complexity).
- **GitHub Issues** — none (`blockedBy: null`); a GitHub ticket is "Blocked" only from its text.
- ⚠ **POSITIVE-ANSWER RULE** (`store.ts` `linkColumns`, shared by the worker and the sprint read): an
  answer without the field leaves the stored value; `[]` clears it; a refused read clears it with the
  rest of the content. A link change is NOT story text — `changed_at` does not move.
- A linked blocker whose status category is `done` is kept (shown as finished) but never raises the
  issue; the fold decides that, not the read.
- `status_id` (both tables) stores the tracker's own status id (Jira `status.id`, Linear state id) —
  a board's column order is written in ids. GitHub has none.

## The status order and buckets — This sprint's columns (`sprint_reads.status_order_json`)

Statuses are per project and per tracker, so nothing hard-codes a name. The sprint list read stores the
AUTOMATIC order (shared `SprintStatusAutoOrder`) with the list. Every status sits in ONE **bucket**; a
bucket has an id, a name (≤ 24 characters) and a **meaning** — one of the five stages Not started, In
progress, Code review, Product review, Complete (`SPRINT_STAGES`; Code review's id stays `in_review`,
because stored settings and snapshots carry it). A ticket's `stage` is its bucket's meaning, so every
reader of `stage` works whatever the buckets are.

- **Automatic** (`buckets: null`): five buckets, one per stage (id = the stage, named
  `SPRINT_STAGE_LABEL`), each status in the bucket of its automatic stage (below). "Won't do" is a
  done-category status, so it lands in Complete.
- **The workspace's buckets** (`workspaces.sprint_statuses` = `{version, buckets, mergedColumn}`,
  `db/sprint-status-settings.ts`, `PUT /api/sprint-stories/statuses`, edited from This Sprint's gear):
  1–10 buckets in reading order; meanings must be NON-DECREASING (two Code review buckets are fine, a Not
  started bucket after a Complete one is not); a status in at most one bucket; ≤ 60 statuses in all.
  Every refusal is ONE plain sentence from shared `sprintBucketsProblem`, which the editor runs before
  Save and the route returns as the 400's `message`. ⚠ Placement beats category. ⚠ A status no bucket
  names (new on the board since) keeps its automatic stage and joins the FIRST bucket with that
  meaning; with none, the bucket of the nearest EARLIER meaning (never more progress than the status
  shows), else the nearest later one; either way it is `auto: true` and the editor marks it "not placed
  yet".
- **Product review is a first-class bucket** (since 2026-10-19; it replaced the DERIVED "Merged, not
  signed off" column, id `merged`, which is gone — `merged` is still refused as a bucket id). It holds
  QA, UAT, PO and other sign-offs: the statuses the workspace places there, and automatically the names
  that read that way. Columns are now exactly the buckets (`sprintColumnsOf`; `SprintColumn` lost
  `derived`).
- **The merge rule** (`mergedColumn`, default on — the key kept its old name): a ticket whose bucket
  means Code review and that has ≥ 1 merged PR and none open (closed unmerged ones ignored) is DRAWN in
  the FIRST Product review bucket (`mergeRuleTarget`); with no such bucket, it stays put. ⚠ Only Code
  review moves — an In progress ticket with everything merged stays In progress (user decision; the old
  derived column took both). ⚠ Its `stage` and `bucketId` stay its status's; only
  `SprintGraphNode.column` moves, computed ONCE in the graph fold (`sprintColumnOf`). The pace's
  `productReview` counts both kinds; Out of step no longer lists such a ticket as "in code review with its
  code already merged".
- **Stored values are converted on read, no migration**: `{sections}` (per-stage lists) and the older
  `{order, deliveredFrom}` become buckets named `SPRINT_STAGE_LABEL`; ⚠ any stored value WITHOUT
  `version: SPRINT_STATUS_SETTINGS_VERSION` (saved before Product review) is read with a Product review
  bucket added after its last Code review bucket (else after the last In progress one, else before the
  first Complete one; not when it already has ten buckets or the name is taken), which takes that Code
  review bucket's statuses whose names read as Product review; a Code review bucket named exactly "In
  review" reads as "Code review" (`withProductReview`). Nothing is written until the reader saves; a
  saved value carries the version, so a Product review bucket the reader removed stays removed. Only the
  new shape may be POSTED. The default (`{buckets: null, mergedColumn: true}`) is stored as NULL.
- "Coding begins" / "Coding ends" = the first status of the first In progress / Code review bucket
  (else the first Product review one), derived.

- **Jira** (`tracker/sprint/jira.ts`): the board of the active sprints holding the most tickets
  (`boardId` on a Cloud sprint object, `rapidViewId=` in an old Server string) →
  `GET /rest/agile/1.0/board/{id}/configuration` (`columnConfig.columns[].statuses[].id`, column
  order) + `GET /rest/api/2/status` (id → name + category). Two calls per list read, through
  `jiraGetJson`; unknown ids are dropped. The status fallback has no board → null.
- **Linear**: the teams' workflow `states` (read in the teams query) by type (triage / backlog /
  unstarted → started → completed / canceled), then `position`; several teams concatenate, active-cycle
  teams first, names deduped.
- **GitHub Issues**: Open, then the closed names. Projects v2 status is NOT stored on tickets, so it is
  not read — every GitHub ticket's category is `new`, so all are "Not started".
- ⚠ **AN ORDER FAILURE NEVER FAILS THE LIST.** A failed board read returns `statusOrder: undefined`
  (the stored order stands) and a code that is logged; `null` (no board) clears it, and the page falls
  back to category then name.
- **The automatic stage**: category `new` → Not started, `done` → Complete. An in-progress status is
  Product review when its NAME reads as QA / test / sign-off / release (`SPRINT_PRODUCT_REVIEW_STATUS_RE`,
  checked first: "Ready for QA", "In Test", "UAT", "In PO Review", "Awaiting Deployment", "Release"…);
  else Code review when its name reads as review (`SPRINT_REVIEW_STATUS_RE`: "Code Review", "In
  Review", "Ready for review") or it sits at or after the PR-evidence
  boundary — the first in-progress status where at least 60% of the tickets with a PR have every PR
  merged and none open, with at least 2 such tickets (`SPRINT_DELIVERED_MIN_*`); else In progress. Evidence = `tracker_tickets` (state `ok`, this workspace and site) ⨝
  `pull_requests`, closed-unmerged PRs ignored; a ticket's status is the sprint row's where it is in the
  sprint, else the freshest of its stored rows and any out-of-sprint sprint row — and ⚠ only when read
  AT OR AFTER its last merge (the worker stops re-reading a merged ticket, so an older "In Code Review"
  would drag the split earlier). The boundary is found over the AUTOMATIC order
  (`db/sprint-status-layout.ts` `inferReviewFrom`, `loadSprintStatusEvidence`).

## The status change — THE ONE TRACKER WRITE (`tracker/status-change.ts`)

Limn writes to a tracker in exactly one place: **the Jira status transition the reader picks** from
the story view's status chip (`components/Ticket/TicketStatusPicker.tsx`, mounted by the story view's
one stack header — so the story TAB and This Sprint's story TRAY share it). Jira only; GitHub Issues
and Linear show the status chip as before. Nothing else writes — no worker, no automation, no retry,
no confirm step (the reader picks the status by name, and it changes AT ONCE). The old per-ticket
write-back (`tracker/write/`, `tracker_writes`) stays removed (2026-10-12, migration `0107`).

- **The list** — `GET /api/ticket-status/transitions?workspace=&ident=` → `TicketTransitionsResponse`.
  Made when the picker OPENS, never on mount (`useTicketTransitions`, `enabled: open`, `gcTime: 0`):
  `GET /rest/api/2/issue/{key}/transitions?expand=transitions.fields` (v2, like every other call, so
  Server / Data Center work too). Only what can be made without Jira's own form is listed:
  `isAvailable: false` is dropped, and so is any transition with a REQUIRED field that has no default
  (Limn fills no fields). Jira lists NOTHING both when the workflow has nowhere to go and when the token
  may not transition, so an empty list costs ONE more call (`/rest/api/2/mypermissions?…
  &permissions=TRANSITION_ISSUES`) → `canTransition: false` → "Your Jira token cannot change this
  issue." (shared `TICKET_STATUS_NO_PERMISSION`); a failed or silent check is `null` → "Jira offers no
  other status from here." The SPA also hides a transition into the CURRENT status.
- **The change** — `POST /api/ticket-status?workspace=` `{ident, transitionId}` →
  `TicketStatusChangeResponse`: `POST …/transitions {transition:{id}}` (`jiraPostJson`, the same guard
  as every Jira call), then **SETTLE**: `GET …/issue/{key}?fields=status` and write the status Jira
  reports (name, category, and the status id only when sent) to every stored row of the ticket IN THIS
  ACCOUNT — `tracker_tickets` on that site (every PR, every workspace), `sprint_tickets` and
  `sprint_ref_tickets` by ident. `changed_at` does not move (a status is not story text). A failed
  re-read answers `status: null` (the change WAS made) and marks the PR rows due (`next_check_at` = 0),
  so the worker reads them at its next pass. The SPA writes the answer into the story view's two
  caches at once, then refetches `ticket-prs`, `ticket-story`, the sprint graph + token, `ticket-links`
  and `jira-ticket`.
- ⚠ **STILL NOT A TRACKER PROXY.** Both routes refuse (`404 TicketNotFound`, before any Jira call) an
  ident that does not parse, names another site than the workspace's Jira, or names a ticket Limn holds
  NO row for in this account (a PR's `tracker_tickets` row, or this workspace's `sprint_tickets` /
  `sprint_ref_tickets` row). A workspace whose tracker is not Jira → `400 NotJira`. `transitionId` is
  schema-checked (`^[A-Za-z0-9_-]{1,64}$`).
- **Refusals are our own sentence**, `502 {error:'JiraError', code, message}`: 403 → "Your Jira token
  cannot change this issue."; a POST's 400 (Jira's answer for a refused transition) → "Jira refused this
  change."; everything else → `jiraErrorMessage`. The SPA keeps it as one line beside the chip until the
  next pick. The log carries account, workspace, code and HTTP status — never Jira's body.
- **Rate tier** `[search, read]` on both (they spend the customer's Jira quota). `verify:isolation`
  pins the settle (a key both accounts hold moves only the caller's rows) and the gate (a ticket only
  the other account holds → 404). The demo answers a fixed workflow and keeps the pick in its overlay
  (`ticketStatuses`), folded into the story view's reads and the sprint graph.

## Created and resolved dates (`tracker/dates.ts`, `tracker/dates-backfill.ts`)

Every reader returns the ticket's OWN created / resolved instants on `FetchedTicket`
(`issueCreatedAt` / `issueResolvedAt`), and the worker stores them on `tracker_tickets`
(`issue_created_at` / `issue_resolved_at`, migration `0098`). The story label run buckets
stories by the CREATED week.

| Provider | Created | Resolved | Cost |
|---|---|---|---|
| Jira | `fields.created` | `fields.resolutiondate` | none — the issue read is already `?fields=*all` |
| GitHub Issues | `createdAt` | `closedAt` | two scalars on the existing issue query |
| Linear | `createdAt` | `completedAt` | two scalars on the existing issue query |

- **The positive-answer rule** (`trackerDate`, ONE parse for all three): a field ABSENT from the
  answer is `undefined` and its key is left out of the write, so the stored value stands; `null` means
  the tracker said there is none (an unresolved ticket) and clears the column; an UNPARSEABLE value is
  treated as not received, never as none. Jira's `+hhmm` offset is normalised before parsing.
- **Not story text**: neither column moves `changed_at` (`storyOrMembershipMoved` is unchanged), so a
  date arriving never re-runs the ticket review.
- **A copied row carries the source's dates** (`withoutIdentity`), like every other column.
- **THE TICKET-DATES NUDGE** (`tracker/dates-backfill.ts`). An OPEN PR's rows are re-read on their TTL
  and fill by themselves; a MERGED PR's rows are history (missing-only mode) and would stay dateless.
  So `runAccountPass`, ONLY on the cron tick's unscoped pass (`datesNudge`, passed by `runTrackerTick`
  alone — a repo-walk kick never nudges, because those passes sit outside `MAX_PER_TICK`) and ONLY
  when its own pass left nothing due (`pending === 0`, no forced keys), hands
  the worker at most `DATES_BACKFILL_BATCH` (6) tickets out of what remains of the pass budget: tickets
  whose 'ok' row on a PR merged in the last 90 days has no created date and was read more than a TTL
  ago. They go through the worker's ONE body (`syncPrTickets` with `datesOwed`): a stored sibling that
  already HAS the dates is copied (no call), else the ticket is read — under the same backoff and
  budget as any read. Ticks are two minutes apart, so the backlog drains at a walking pace, never a
  burst. ⚠ Each ticket is tried ONCE per process (`tried`, in memory): one whose tracker gives no
  created date is never looped on. Once a scan over EVERY reading repo finds nothing owed the account
  is DONE until restart or a settings change (`reopenDatesBackfill`); ⚠ a scan narrowed to one repo
  (`fullScope` false) never marks it done — one quiet repo says nothing about the others.

## Peers — the ticket review's source

`tracker/peers.ts`, read by the ticket review and a deep PR review through
`tracker/ticket-source.ts` (it was the plugin seam `AgenticProviders`; core always answers now). ⚠ **STORED ROWS ONLY** (`resolvePrTickets(…, { storedOnly: true })`) — these are view paths.

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
(migration migration `0094` turned only an ALL-NULL pre-existing row — the one a None save alone writes — into `'none'`; a NULL provider beside any other stored value, e.g. a legacy-moved match scope, stays unchosen, and `tracker/legacy-import.ts` leaves its NULL providers NULL so both upgrade orders agree).

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
  (+ `closing_issues_checked_at`, migration migration `0089`).
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
Linear OAuth is NOT built; pasting a personal key is the only route.

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
  `linear_links_checked_at`; migration migration `0090`).
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
- **FETCH** (`linear/client.ts`): one `issue(id: "ENG-123")` query per ticket (≈ 240 complexity
  points with 50 children, 20 relations and 20 comments): identifier, title, description (markdown), url, state
  `{id, name, type}`, assignee, project name, ≤ 50 children (+ `hasNextPage`), ≤ 20 inverse relations
  (§ Blocking links). Status category from the state TYPE:
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
  10 s timeout, a 5 MiB cap. The key is sent as
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
  AES-256-GCM, when the operator set ENCRYPTION_KEY); `plain:<token>` without a key,
  the same trust as that machine's `gh` token. Both prefixes stay readable; an unopenable `sealed:`
  value reads as `unreadable` ("save it again"), never sent as garbage.
- The account export carries the tracker row with the token reduced to `hasToken`
  (`db/export-account.ts`); erasure deletes all three tables.

## Outbound calls — the SSRF guard (`tracker/jira/fetch.ts`)

Every call to a customer-named host goes through ONE helper — never a bare `fetch`. (Linear's host is
FIXED, never customer-named; its POST rides the same transport for the same no-redirect, timeout and
size rules — § Linear.) GET only — the ONE exception on a customer-named host is `jiraPostJson`, the
status transition (§ The status change), with every rule below unchanged (a 2xx with no body is fine) — a 10 s
timeout, a 5 MiB cap, **no redirects** (a 3xx is an error; following it would forward the
Authorization header), JSON only. http and LAN hosts are allowed (an on-prem Jira is normal; the
policy flag is `{ cloud: false }`). The STRICT policy (`{ cloud: true }`: https only, and the host
must resolve to PUBLIC addresses, checked at CONNECT time through the socket's own `lookup`, which
closes DNS rebinding) is what SonarCloud's fixed host is called with. Details: [SECURITY.md](SECURITY.md).

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
| `GET /api/ticket-status/transitions?workspace=&ident=` | Jira's allowed transitions, on the picker's open (§ The status change) | `search` |
| `POST /api/ticket-status?workspace=` | the ONE tracker write: make the picked Jira transition, then settle | `search` |

⚠ **NOT A TRACKER PROXY.** The ticket routes address a PULL REQUEST (ownership → 404), re-run
detection on it and answer only for a key detection found. Every failure is a 502 carrying a
sentence we wrote, never the tracker's body, URL or header. Ownership of `workspace_trackers` is ALSO
structural — the named composite FK `workspace_trackers_workspace_account_fk`.
`verify:isolation` covers every route and table (both accounts share a site AND a key, so a dropped
account predicate has something to leak).

## The move from the plugin (2026-10)

- **Migration** migration `0088`: creates `workspace_trackers` and `tracker_tickets`,
  adopts `pro_jira_ac_fields`. It copies NO data — the source tables are the plugin's, absent on a
  fresh or plugin-less install, and SQLite cannot test for a table in SQL.
- **The boot-time MOVE** (`tracker/legacy-import.ts`, run by `startTracker` AFTER the platform binds,
  so the platform's migrations have run): tests each source table and column for existence, copies
  `pro_workspace_settings.issue_*`/`jira_email`/`jira_token` → `workspace_trackers` and
  `pro_pr_jira_tickets` → `tracker_tickets` (provider `'jira'`) with ON CONFLICT DO NOTHING, and in
  the SAME transaction NULLs those columns / deletes those rows. A MOVE, so it runs every boot with
  no marker: a second boot finds nothing, a token is never at rest in two places, and a value
  cleared in core is never resurrected. The token moves in its stored form — nobody re-enters it.
- **Plugin side**: `src/jira/` and `src/issue-links/` deleted; plugin (now platform) migrations
  `0038`/`0039` stripped to `SELECT 1;` (an install that ran them keeps what they made; a fresh
  install no longer grows the old table, and 0039's bare `ALTER` would otherwise fail);
  the tracker columns on `pro_workspace_settings` are DORMANT (undeclared, never read or written).
- **Contract**: `ProContext.registerPrDetailEnricher`, `registerAgenticProviders`,
  `registerRepoSyncedHook` and `host.sealSecret`/`openSecret` are gone.
- **SPA**: The Open PRs "Group by ticket" view and ticket row show wherever THIS workspace has a
  tracker (`useTrackerOn`); the PR pane's slim story check reads `PrDetail.tickets != null`;
  Settings → Issue tracker is always shown, and the Jira API access block is not behind
  `me.ai.enabled` — the token feeds non-AI surfaces too.

# The AI adoption report

Reports → **Download report** makes a PDF shaped like a slide deck: 16:9 pages, one idea per page, a
headline, a chart or a table, and two to four sentences of plain English beside it. A head of
engineering or a consultancy forwards it to a board, a finance director or a client to show what AI
is doing for software delivery, with MEASURED figures instead of self-reported ones. (The UK
government's 2026 AI adoption survey found 32% of businesses using AI, up from 16% in 2025, but its
impact figures are what businesses said. This report is the measured version.)

The contract is `packages/shared/src/ai-adoption-report.ts` (the wire, the floors, the grounding gate,
the template commentary) and `packages/shared/src/ai-vendor-detect.ts` (the ONE detector).

## The rules

1. **Measured, never guessed.** Every figure comes from code over the DB. A figure that cannot be
   stated honestly is WITHHELD with a named reason (`AdoptionFigure.available === false`) and drawn as
   "—" with the reason. Unknown is never zero.
2. **Declared AI use only.** Detection reads the markers AI tools write by default (bot accounts,
   agent emails, co-author trailers, "Generated with X", a tool's task URL, a tool's default branch).
   An engineer who uses AI and leaves no marker looks human. The method slide says so. Precision beats
   recall: a false positive is a false claim in a forwarded document.
3. **The report names nobody** (the owner's decision, 2026-11-23). "How widely AI is used" counts
   PEOPLE, overall, per tool and per period, and never says who: no name, login or per-person row is
   on the wire (`AiAdoptionReport`), in the PDF or sent to the model. ⚠ A count of 1 or 2 people is
   withheld `few_people` and printed "Fewer than 3" (`ADOPTION_REPORT_FLOORS.minPeople`): in a small
   team, "1 person used Devin" points at someone as surely as a name. A share of people is withheld
   whenever its count is, so the count cannot be worked back from it. Limit, stated in the method:
   in a tiny team any aggregate can still narrow things down (the complement — "all but one" — is
   shown, because hiding it would hide the most useful figure).
4. **Before and after is not cause.** The commentary may not claim one (the gate refuses "caused",
   "thanks to", "due to", "led to"…); the method slide says so.
5. **The ONE reporting window.** "After" is `getReportingWindow` (db/reporting-window.ts), resolved
   ONCE per request; "before" is the equal-length span just before it. Never a second resolver.
6. **Code writes every number.** The model writes `{{key}}` placeholders; code substitutes them. Any
   numeral in model text (Unicode too), any number or multiplying word ("three", "half", "twice",
   "double", "percent"), or a move word ("rose", "fell") beside a change that is not clear refuses the
   text; the slide falls back to template sentences built from the same figures.
7. **Made on the reader's machine.** The backend serves figures; the SPA builds the PDF in the
   browser. Nothing is sent anywhere unless the reader sends the file. With AI commentary on, the
   model receives aggregate figures and vendor names only: never a repo name or "Prepared for".
8. **Never US$ on a subscription.** Ensemble's own AI spend is US$ on an API key and a share of a
   week on a subscription (the AI usage report's one cost unit, `AiUsageCostUnit`). Review-bot SEAT
   prices are what the reader entered, in US$, and say "as entered".

## Detection

### Vendors

| Id | Label | Maker |
|---|---|---|
| `claude` | Claude | Anthropic |
| `codex` | Codex | OpenAI |
| `copilot` | GitHub Copilot | GitHub |
| `cursor` | Cursor | Anysphere |
| `devin` | Devin | Cognition |
| `google` | Gemini / Jules | Google |
| `amazon` | Amazon Q / Kiro | Amazon |
| `windsurf` | Windsurf | Windsurf |
| `aider` | Aider | Aider |
| `factory` | Factory | Factory |
| `amp` | Amp | Amp |
| `ensemble` | Ensemble | AI Fix and Implement story pushes |

Ensemble's own runs use Claude or Codex, but count under **Ensemble** only, so one piece of work is not
counted twice. Code-REVIEW bots (CodeRabbit, Copilot's reviewer, Cursor's Bugbot, Gemini Code Assist)
are not here: they review, they do not write. They are slide 7's.

⚠ This vocabulary is SEPARATE from `AUTOMATION_VENDORS` / `REVIEW_BOTS`. Adding a coding agent there
would move every period metric's people-vs-automation split and need a `workspace_reviewers`
migration. Do not.

### Sources and markers

| Source | Read from | Markers (exact, case-blind) |
|---|---|---|
| `commit_author` | git author and committer: login, email, name | agent accounts `claude`, `copilot-swe-agent`, `chatgpt-codex-connector`, `cursor`, `devin-ai-integration`, `google-labs-jules`, `amazon-q-developer`, `factory-droid` — each ONLY as a bot (`<slug>[bot]`, typed `Bot`, or `<id>+<slug>[bot]@users.noreply.github.com`); GitHub's reserved `Copilot` account (also `<id>+Copilot@users.noreply.github.com`); agent emails `noreply@anthropic.com`, `noreply@openai.com` (Codex CLI), `cursoragent@cursor.com`, `noreply@aider.chat`, `amp@ampcode.com`; an author name ending ` (aider)` |
| `commit_trailer` | `Co-authored-by:` lines, and tool-only trailer keys | the same emails and accounts; the name `Cursor Agent`; `Amp-Thread:` / `Amp-Thread-ID:`; `Claude-Session:`; `Ensemble-Run:` / `Limn-Run:` `ai-fix/…` or `story-build/…` (NOT `conflict/`, `auto-merge/`, `deps/`, `update-branch`: not AI) |
| `commit_message` | the full message | "Generated with/by/using Claude Code / Codex (also "Created by Codex") / Copilot / Windsurf / Gemini CLI / Amazon Q / Aider"; a subject starting `aider: ` |
| `pr_title` | the title | the same phrases |
| `pr_body` | `bodyText`, and the markdown `body` when fetched | the same phrases; Jules's footer "PR created automatically by Jules"; task URLs `chatgpt.com/codex/tasks/`, `app.devin.ai/sessions/`, `jules.google.com/task/` (markdown body only), `ampcode.com/threads/`, `claude.ai/code/session_` |
| `pr_author` | PR author login + `__typename` | the agent accounts (bot only, as above) |
| `pr_branch` | head branch | default prefixes `codex/`, `copilot/`, `devin/`, `claude/`, followed by something — ⚠ CORROBORATION ONLY: recorded only when the same vendor is already seen in the PR's author, title or description, so a person's hand-named `claude/…` branch never counts |
| `ensemble` | Ensemble's ledgers, ON READ | `ai_fixes.pushed_at` (by `pr_id`); `story_build_prs.pushed_pr_number` / `loop_pushed_sha`, resolved within `(accountId, repoId)` |

- The text is attacker-authored: substring tests, table lookups and LINEAR regexes over capped lines
  only (`MAX_TEXT` 64 KB, `MAX_LINE` 400, `MAX_LINES` 600). A megabyte of `<`, spaces or near-miss
  phrases finishes in milliseconds (pinned).
- ⚠ **A phrase counts only at the START of a line** (a title: at its start), after nothing but
  decoration (whitespace, an emoji, a list bullet, a heading or emphasis mark). A phrase inside a
  sentence, inside quote marks or backticks, or on a quoted (`>`) line is a MENTION ("Strip the
  'Generated with Claude Code' footer") and never counts. The same goes for "is generated with Amazon Q
  …" mid-sentence: an undercount, by design.
- ⚠ **A task URL counts only as the tool writes it**: `https://` + the path + an id, standing as a line
  of its own, as a link target (`](…)`, `<…>`), or after a short label ending in a colon ("Link to
  Devin session: …"). "Links like chatgpt.com/codex/tasks/ …" is a mention.
- ⚠ **A git NAME is free text**: an account name counts only in its App form (`claude[bot]`), plus the
  exact tool name `Cursor Agent`. A person whose git name is "Copilot", or a co-author "Claude Shannon
  <claude.shannon@example.com>", is never a signal.
- **Deliberately NOT markers** (each could match prose or a person): a "Generated by" phrase for Cursor
  ("generated by cursor position"), Amp ("generated with AMP") or Kiro (a person's name); a `cursor/`
  branch (database and pagination cursors); `cursor.com/…` URLs (Bugbot writes them into people's PR
  descriptions). Cursor's cloud agent is read from its `cursor[bot]` account and `Cursor Agent` trailer;
  Kiro has no marker yet. The `cursor` account also posts Bugbot REVIEWS, but the detector reads PR and
  commit authors only, never reviews or comments.
- An applied Copilot review suggestion carries `Co-authored-by: Copilot <…+Copilot@users.noreply.github.com>`
  and counts as Copilot: the code in that commit was Copilot's.
- ⚠ **Any change to a rule or table bumps `AI_SIGNALS_VERSION`.** The backfill re-scans every PR stored
  under an older version. (Version 1 was the first ship; version 2 anchored phrases to a line's start,
  read task URLs only as written, and made the branch corroboration-only.)
- ⚠ `limn_actions` 'push' rows and `commits.limn_pushed_by_user_id` also cover plain branch updates and
  hand-made conflict resolutions. They are NOT AI and are not read.
- Every marker has a fixture (`apps/backend/src/sync/__fixtures__/ai-vendors/`, run by
  `apps/backend/src/shared-ai-vendor-detect.test.ts`), labelled `observed` (seen on real public PRs or
  commits, 2026-11, names and ids replaced), `documented` or `unconfirmed`. The one unconfirmed marker,
  the "Generated with Windsurf" phrase, is kept only because it is a specific tool name after
  "Generated with"; Windsurf has no other marker.
- The demo seed (`apps/backend/scripts/seed-demo-ai-signals.ts`) runs the REAL detector on each
  tool's raw footprint (trailers, bot commit authors, "Generated with Claude Code", a Codex task URL
  with its `codex/` branch…) and stores only the verdicts, as sync does; it throws if a footprint detects
  nothing, so a detector change that breaks a marker breaks `pnpm demo` too.

### What sync fetches

- PR fields: `title`, `bodyText`, `headRefName`, `author { login __typename }` (already fetched).
- Commits (`commits(last: 100)` in `PR_NODE_FIELDS`): add `message` UNCONDITIONALLY (today it is
  lean-gated by `commitMessageField`) and `name email` beside `user` under `author` and `committer`.
  Scalars: no GraphQL points, a larger payload.
- STORAGE stays lean: `commits.message` is still stored only when `PERSIST_BODIES=true`; emails and
  names are never stored. Only the VERDICT is stored. Payload estimate: [SYNC.md](SYNC.md) § Lean storage
  interaction.
- ⚠ The `commitIsLimn` call (upsert.ts, rule (d) of db/limn-bots.ts) keeps receiving the message ONLY
  when `PERSIST_BODIES` is on, exactly as today. Turning the rule on for lean installs would
  re-attribute commits and move the period metrics: a separate decision.

### Storage: columns, no new table

| Column | Meaning |
|---|---|
| `pull_requests.ai_signals` text | JSON `[{vendor, source}]` from the PR's OWN fields (`pr_title`, `pr_body`, `pr_author`, `pr_branch`). NULL = never scanned |
| `pull_requests.ai_signals_version` integer | the detector version of that scan, and of its commits' scan |
| `pull_requests.ai_signals_checked_at` integer (timestamp) | when it was scanned |
| `commits.ai_signals` text | JSON from that commit (`commit_author`, `commit_trailer`, `commit_message`). NULL = not scanned, `[]` = scanned clean |

- Migration `0219_ai_signals.sql`, hand-written and additive; journal entry `idx 219`,
  `when 1795680000000`. No SQL backfill: NULL means not scanned.
- Three-state writes (the security-columns precedent, upsert.ts `securityColumnsFor`), through ONE pair of
  helpers for both writers, `aiPrColumnsFor` / `aiCommitColumnsFor` (sync/upsert.ts): the PR columns are
  written only when the payload carried `title`, `bodyText` AND every commit's `message` (the version stamp
  vouches for the commits' scan too); a commit's only when `typeof c.message === 'string'`. Otherwise the key
  is omitted, never cleared. Detection runs BEFORE `runTransaction`.
- Columns on existing tables need no new delete path, FK or `accountScopedTables()` entry. The values
  are verdicts, never text.
- The PR's verdict for the report = `pr.ai_signals` ∪ its commits' `ai_signals` ∪ the Ensemble ledgers
  (`db/ai-signals.ts` `getPrAiSignals`). A PR is SCANNED when `ai_signals_version >= AI_SIGNALS_VERSION`.

### The backfill

`sync/backfill-ai-signals.ts`, modelled on `backfill-pr-security.ts` and `backfill-commit-headlines.ts`:

- Worklist per (account, repo): `(state = 'open' OR merged_at >= now − 90 days) AND
  (ai_signals_version IS NULL OR ai_signals_version < AI_SIGNALS_VERSION)`, newest first, plus an
  in-process `attempted` set.
- `nodes(ids:)` over PRs (`AI_SIGNALS_NODES_QUERY`): title, bodyText, headRefName, author,
  `commits(last:100)` with message and author/committer name, email, login; plus `rateLimit`. No markdown
  `body`. 60 PRs per run in batches of 20.
- The SAME column builders as the walk. Commit verdicts are written by `(pr_id, sha)` onto rows the walk
  stored; none is created. A PR with more than 100 commits is stamped anyway (its older commits are never
  seen; the method slide says so). A PR not returned, or returned with a selection nulled, stays unstamped
  and is asked at most once per process.
- Budget: skip on `isLimited` / `isBudgetLow` (before the run and before each batch); `noteLimited` on a
  limit and stop; `noteBudget` on every response; never clears `limitedUntil`. Strictly non-fatal. A limit is
  never surfaced as an error.
- Coverage: `db/ai-signals.ts` `aiSignalsFirstScanMs(accountId, repoIds)` is the earliest
  `ai_signals_checked_at`; the report states coverage from that minus `AI_SIGNALS_BACKFILL_DAYS` (90).
- Runs from both sync-manager tails (manual post-walk and scheduled walk), after the commit-headline
  backfill, lazily imported, logging `(non-fatal)`. The worklist joins `verify:isolation`.

## The report

### Windows and population

- **After** = `[w.fromMs, measuredTo(w, now))` from `getReportingWindow`. In sprint mode this is
  "this sprint so far", so early in a sprint most figures fall below their floors. The title slide
  states both spans; there is no silent fallback.
- **Before** = `[w.fromMs − span, w.fromMs)` with `span = measuredTo − w.fromMs`.
- **Trend periods** (slide 3): step back whole window lengths (`w.toMs − w.fromMs`) from `w.fromMs`;
  in sprint mode these are the earlier sprints. At most `maxTrendPeriods` (12), at most 12 weeks back,
  at least two. The last period is the after window (`partial` while running).
- **One repo set** (coverage bias): `getPeriodCoverage` from the oldest period; leading periods with
  no tracked repo dropped; the narrowed scope built ONLY by `resolveWorkspaceScope`. `repos` echoes
  measured / total.
- **The adoption population**: merged PRs whose true author (`trueAuthorId`; an Ensemble-opened PR is
  the person's) is in the `human` lane (`resolveActorLanes`), PLUS PRs whose own author is an AI coding
  agent (a `pr_author` signal). Other automation (dependency, release, housekeeping) is left out and
  counted (`otherAutomationPrs`).
- **Detection coverage**: the share of the population scanned. A period or side below
  `detectionScannedPct` (90%) shows no AI figure (`detection_incomplete`). `coversFrom` = the backfill
  horizon.

### Floors (`ADOPTION_REPORT_FLOORS`)

| Floor | Value | Applies to |
|---|---|---|
| `sharePrs` | 5 | any share of merged PRs (adoption, human review coverage, an AI-vs-other side) |
| `shareChangePts` | 5 points | a share's change to be significant |
| `detectionScannedPct` | 90% | AI figures in a period or side |
| `botActedOnThreads` | 10 | a review bot's acted-on share |
| period metrics | `PERIOD_METRIC_META` | `sampleFloor`, `absoluteFloor` (the `buildDeltas` rule) |

A comparison is SIGNIFICANT only when both sides meet their floor and the change meets its absolute
floor. A non-significant change is shown as two figures, never as a move.

### Slides

| # | Slide | Figures and folds |
|---|---|---|
| 1 | Title | workspace name, `reportingWindowTitle`, both spans, optional "Prepared for", generated date, "Made with Ensemble". No commentary |
| 2 | Summary | 3–5 `headlines`: `ai_share` first when available, then significant comparisons from slides 4–9 by size of change, significant first. Each carries its sample size (the denominator). Fewer when fewer qualify |
| 3 | AI adoption | `periods[]` (share per period + PRs per vendor); `aiShare` before/after; per vendor PR counts and share; `sources` (where it was seen); markers from `listWorkspaceSettingEvents`, `settingHistoryFrom` |
| 4 | How widely AI is used | `peopleUsingAi` before/after (people who merged a PR with AI involved), `peopleShare` (of `peopleWithMergedPrs`), `periods[]` (people and the share using AI per trend period), per tool `people` and `prShare` (after window), `agentPrs` (agent-opened PRs: no person). Person = true author in the human lane, counted once. 1 or 2 people ⇒ `few_people`. Per-tool figures withheld when detection is incomplete. ⚠ Never a name or login (`users` is not read) |
| 5 | Delivery flow | `getPeriodMetrics` for both windows: `merged_prs`, `human_merged_prs`, `automation_merge_share_pct`, `median_lead_time_hours`, `median_time_to_first_human_review_hours`, `median_human_pr_size_lines`, `merge_ci_success_pct`, `reviewer_concentration_pct`. Plus `aiVsOther` (after window): median lead time, median size, CI passing at merge, human approval, for PRs with AI vs the rest of the population |
| 6 | Where the time goes | `getFlowCourts` for both windows (before via a synthetic `{fromMs, toMs, mode}`): reviewer / author / landing share of open hours; `measuredPrs` (null, drawn "—", when the fold failed: unknown, never 0); its refusals. Merged PRs a person touched; bot-authored PRs left out. Names nobody |
| 7 | AI review | `getBotAnalytics({kind:'sprint', fromMs, toMs})` both windows. Third-party = role `review`, kind ≠ `'pierre'`; per bot comments per merged PR, acted-on share (before and after), seat price as entered, seat price per acted-on thread. Ensemble = the `'pierre'` rows summed: `ensembleActedOn`. "Acted on" = resolved, likely addressed, or a person followed up |
| 8 | Guardrails | `merge_ci_success_pct`, `threads_replied_within_36h_pct`, NEW `human_review_coverage`, and the same over PRs with AI involved (`ai_human_review_coverage`) |
| 9 | Cost | `getAiUsageReport` both windows: total and per merged PR in the ONE unit (`usd` / `week_pct` / null); runs; tokens (both null, drawn "—", when the usage read failed or AI is off: unknown, never 0); machine-wide runs left out and disclosed; review-bot seat prices as entered. AI off ⇒ `aiEnabled: false`, the spend figures withheld `ai_off` |
| 10 | Method and limits | fixed text: what each figure counts, declared use only, last 100 commits per PR, before/after is not cause, the floors, detection coverage, setting history start, AI-written commentary labelled |

**Human review coverage** (new, `db/human-review-coverage.ts`, read by `db/adoption-report.ts`): of merged PRs in `[from, to)` (on
`merged_at`), the share with at least one `reviews` row where `state = 'approved'`, `submitted_at <=
merged_at`, not dismissed before the merge (`dismissed_at` NULL or later than `merged_at`), and the
review's `authorId` is in the `human` lane of `resolveActorLanes(accountId, scope)`. Read `authorId`,
NOT `trueAuthorId`: an approval Ensemble posted is Ensemble's (`limn` lane), and a manual "this is a
person" judgement wins. Floor `sharePrs`.

`human_review_coverage` is over EVERY merged PR in the window (any author, like `merged_prs`);
`ai_human_review_coverage` and the AI-vs-other split are over the adoption population. A review with
a NULL author (a deleted account) does not count: it cannot be shown to be a person's.

### How the fold decides (implementation notes)

- **Before not covered.** When the measured repo set was not yet tracked at `before.from` (every
  earlier trend period was dropped for having no tracked repo), every BEFORE figure is withheld
  `partial_coverage`. When no repo was tracked even at `after.from`, the after window is measured over
  the workspace as it is, with `repos.measured = total`, and the before side is `partial_coverage`.
- **Significance per comparison.** Period metrics: `PERIOD_METRIC_META` (`sampleFloor` both sides,
  `absoluteFloor` on the change — the `buildDeltas` rule; core's table is read, the platform copy is
  untouched). Shares of PRs (`ai_share`, human review coverage): `sharePrs` + `shareChangePts`.
  Courts: `sharePrs` on `measuredPrs` + `shareChangePts`. `ensemble_acted_on`: `botActedOnThreads` +
  `shareChangePts`. `people_using_ai`: the merged-PR floors (5 people, a change of 3); a side withheld
  `few_people` is never significant. Cost: NEVER
  significant (shown as two figures; spend has no floor).
- **Withheld below a floor.** A period-metric statistic (not a count) below its `sampleFloor` is
  withheld `low_sample`; a count is always shown. Medians in the AI-vs-other split and shares use
  `sharePrs`.
- **Summary.** `ai_share` first when its after figure is shown; then the significant comparisons
  by size of change (points for a share, percent of the before otherwise); then, only while there are
  fewer than three, comparisons with both sides shown. At most five, one per key.
- **Review bots.** Rows with no comments and no threads in the window (dormant) are left out. A
  seat price per acted-on thread is the analytics fold's (prorated to the window), withheld
  `no_price` with no price and `low_sample` below `botActedOnThreads`.
- **Cost.** Machine-wide runs are taken out by running the usage fold a second time over NO repo
  (exactly the machine-wide rows) and subtracting. A window whose runs were all Codex (tokens only)
  is `no_cost_unit`. With AI off the ledger is not read: runs and tokens are 0, spend `ai_off`.
  Seat prices are the workspace's third-party review bots with a price entered, summed within the
  workspace only.
- **Courts / bots / usage failures** are caught: that slide's figures read `no_data` (Chronology adds
  "Where the time goes could not be measured."); the report still downloads.

## The commentary and its grounding

One completion per commentary slide (eight: summary, adoption, people, delivery, courts, review_bots,
guardrails, cost), so the progress bar can say "slide i of N".

1. Both sides build the slide's FIGURE TABLE with `commentaryFigures(report, slide)`: every
   placeholder (`{{lead_time.after}}`, `{{ai_share.change}}`, `{{vendor.claude.prs}}`, `{{bot.a.name}}`,
   `{{period.after}}`…), its label, code's words for it, and whether it is `usable`. Keys are lowercase
   letters, `_` and `.` only. A `.change` is usable only when the comparison is significant; a
   withheld figure is never usable. Review-bot names are placeholders too (a custom label may hold
   digits). No person, login or repo is in the table.
2. The server sends the model the table (key, label, words, usable) and the rules. The prompt asks
   for two to four plain sentences that interpret, name every number only by placeholder, prefer
   `.change` over direction words, and never claim a cause.
3. `validateCommentary(text, table)` refuses the WHOLE text on any of: an unknown or unusable key, a
   malformed brace, no placeholder at all, any numeral outside placeholders
   (`/^[^\p{Nd}\p{No}\p{Nl}]*$/u`), any number or multiplying WORD outside placeholders (case-blind,
   whole words: zero to twenty, the tens, hundred, thousand, million, dozen, half/halved, third,
   quarter, double/doubled/doubling, triple/tripled, twice, thrice, percent / per cent, -fold, `×`,
   `%` — so "double the share before" or "three times as many" cannot state a quantity no code
   computed), a MOVE word (rose, fell, grew, dropped, jumped, climbed, declined, increased, decreased,
   surged, halved, improved, worsened, "a rise"…) in a sentence that names the before or after of a
   comparison whose `.change` is not usable while both sides are (the figures may sit side by side,
   never be narrated as a move), Markdown / HTML / links, `@`, a causal claim, fewer than one or more
   than four sentences, more than 600 characters.
4. Valid ⇒ the route returns the TEMPLATE; the SPA fills it with `fillCommentary` from its own table,
   so every number in the PDF is code's. Refused or failed ⇒ `{source: 'fallback'}` and the SPA uses
   `fallbackCommentary(report, slide)`: deterministic sentences from the same table. AI off, no
   credential, or the box unticked ⇒ every slide uses the fallback, with no call.
   "Nothing to interpret" means no usable key besides `period.*`, the `.sample` sizes and counts of
   zero: then the route answers `nothing_to_say` without a call.
5. The PDF labels AI-written text apart ("Commentary written by AI from the figures on this page") and
   the dialog's done line says how many slides it wrote.

The cost formatter is injectable (`AdoptionFigureFormatter`): the SPA passes one that words `usd` and
`week_pct` through `usageCostText`, so the PDF uses the app's one cost wording.

## Routes

| Route | What | Tier |
|---|---|---|
| `GET /api/reports/ai-adoption?workspace=<id>` | `AiAdoptionReport`. DB only, always registered (AI off too). Unknown workspace ⇒ Default | `[TIERS.search, TIERS.read]`, exact path |
| `POST /api/reports/ai-adoption/commentary` `{workspaceId, slide, generatedAt}` | `AdoptionCommentaryResponse`. Registered only from `registerAgenticRoutes`; 404 when AI is off; 503 `no_credential` / `runtime`; 502 on any other failure | `[TIERS.ai, TIERS.aiHourly]` |

- Core, not the platform (every fold is core); outside `/api/pro/`.
- The GET memoises the computed report in process (at most 32 reports), keyed
  `accountId:workspaceId:generatedAt`, with a two-minute TTL that SLIDES: every commentary read renews
  it, so a long download (eight sequential calls on a slow provider) keeps its figures. ⚠ A miss NEVER
  recomputes: a fresh report would carry a new `generatedAt` (every later slide would miss again and
  rerun the whole fold) and figures the PDF may not show. The route answers `{source: 'fallback',
  reason: 'stale'}` with no call and the SPA uses the template. It never trusts figures from the client.
- The commentary goes through `cheapComplete` (ai/provider.ts; the WRITING RULES are added at the
  provider door), records usage `{seam: 'summary', feature: 'adoption_report'}`, and is the reader's
  click: no `automaticRunAllowed`. The SPA's `AiRunGate kind="complete"` handles the over-budget
  two-press.

## The UI

- Reports' `PageHeader` gets a **Download report** action (and a ⌘K command). Its own file, never a
  tab-shaped literal in `InsightsView.tsx`.
- A dialog on `InfoModal`: **Prepared for** (optional), **Write commentary with
  AI** (shown only when `me.ai.enabled`, inside `AiRunGate kind="complete"`; with it ticked the
  Download button is the gate's `data-ai-run` control). Nothing is fetched on mount.
- On Download, a NEUTRAL determinate progress bar (`role="progressbar"`, one `aria-live` stage line):

  | Stage | Range |
  |---|---|
  | Fetching figures | 0–15% |
  | Writing commentary · slide i of N (AI ticked only) | 15–85% |
  | Drawing slides | 85–95% |
  | Building the PDF | 95–100% |

  ⚠ After each stage is reported the build waits for a paint (`nextPaint` in `buildReport.ts`): the
  stages after the figures arrive are synchronous, and without it React batches them and the bar
  jumps from 0 to the end.
  Closing the dialog aborts the build (one AbortController). Done ⇒ the file downloads
  (`ensemble-ai-adoption-<workspace>-<date>.pdf`) and one line says what happened.
- The PDF: pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1, exact pins, dynamic-imported in a `pdf` chunk;
  subset Inter TTF (plain glyf, never WOFF2) embedded; real selectable text, tables as text, charts as
  vector paths; no images. 960 × 540 pt pages, a white ground whatever the app theme, text colours at
  least 4.5:1 on white. Title, author "Ensemble", language en-GB.
- **No "Anonymise" option**: there is nothing to hide. Slide 4 is one page: a bar per period (the
  share of people using AI, "—" when withheld), a per-tool table (people, share of merged PRs; most
  people first), and the notes "the report names nobody" and "1 or 2 people show as Fewer than 3".

## Privacy

The report is built on the reader's machine and goes nowhere unless they send it. It names nobody:
counts of people only, with 1 or 2 withheld, so it can be shared outside the team without carrying
colleagues' personal data. With AI commentary, only the slide figures and vendor names go to the
reader's AI provider: never repos or "Prepared for". The landing Privacy page § 3 and the user docs
say this.

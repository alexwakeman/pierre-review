# Changelog

What changed in each release of Ensemble (`npx ensemble-review`), newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the
npm package. Every push to `main` publishes a patch release; the release workflow moves everything
under "Unreleased" to the new version's heading in the same commit as the version bump
(`docs/RELEASE.md` § The changelog).

How to write an entry: one line per change a person using Ensemble would notice, in plain English,
under Added, Changed, Fixed or Removed. Name the screen in the app's own words. No file names,
no internals.

## [Unreleased]

### Added

- A pricing page: free for up to 3 people, then one licence a year for the organisation, from £600 plus VAT,
  priced by how many people use Ensemble.
- Settings → Licence: says who may use Ensemble free and who needs a licence, with a link to the prices.
- A comparison page: Ensemble beside CodeRabbit, GitHub Copilot code review and Claude Code Review, with
  each vendor's facts linked and dated, and where the others are stronger.
- A security and trust page for security and procurement reviewers: where your data goes, what the AI
  agents can do, what happens without a click, and how to report a security problem.

### Fixed

- Terms, the npm page and the README: they now say that AI Fix and Implement story run commands in a
  sandbox, and where your data goes. Ensemble is now made by Corevo Systems Limited.

### Changed

- The site and README no longer say there is nothing to buy or that setup takes one minute: your own AI
  usage is billed by your provider, and builds and fixes need a container runtime.
- Settings → Dependencies: every switch (merge, approve, resolve conflicts, fix with AI) is now off until
  you switch it on. Workspaces where nobody changed these settings are switched off; a workspace whose
  dependency settings someone saved keeps them.

## [1.0.72] - 2026-11-21

### Added

- Implement story: the agent can read what the ticket attaches or links (designs, screenshots, sketches, JSON). It
  asks for the files it needs, and Ensemble reads them from your tracker. Jira attachments for now; links from any
  tracker. Your tracker token stays on your computer, and each read shows in the session's **Network** panel.
- Implement story: when the work changes a screen, the plan has a **Screens** part: the design it uses from the
  ticket, your design system and the nearest existing screens (code Ensemble checks), and what it still has to
  choose. With no design in the ticket, the agent builds to fit your existing screens.
- Implement story: **Give the build a browser** at Approve, when the plan changes a screen. The agent looks at the
  screens it builds in a headless Chromium on your computer, which reaches only what the sandbox reaches. The agent
  can also ask for one during the build. Docker only.
- **Settings → Integrations → Figma**: an optional Figma token. With it, Implement story reads the Figma frames a
  ticket links (an outline of the layers and a picture). Without it, the agent works from the ticket's other files.
- Implement story: the build tab's **Screens** block. When the agent looked at its screens in the browser, it says
  for each whether it matches the design (or your existing screens), and **Show screenshots** shows what it saw.
- Implement story: **Screenshots** in the build tab show what the agent sees in the browser while it builds, newest
  first, as it takes each one.
- Implement story: **Post screenshots to** the Jira ticket, from the build tab's Screens block. One press adds the
  screenshots as attachments and one comment that shows them with the agent's verdicts.
- **Build end to end**: its comment on the Jira ticket now shows the screenshots the agent took of the screens it
  built.

## [1.0.71] - 2026-11-20

### Changed

- Bots Monitoring and the severity model cover review bots only. SonarCloud summaries, dependency bots and other
  automation get no severity or category, and no longer appear in any Bots Monitoring figure or list.
- Bots Monitoring → ROI: the **Time to first review** chart uses a log scale (1m, 10m, 1h, 6h, 1d, 3d), so a bot
  that answers in minutes and one that answers in days fit on one chart.
- Bots Monitoring → ROI: the **Inflation** column and the **Severity inflation** chart are hidden when Ensemble is
  the only review bot.
- Charts draw CodeRabbit in magenta instead of orange, so its line no longer looks like Ensemble's.

### Fixed

- Bots Monitoring → ROI: the top label of the **Follow-up rate** chart ("100%") is no longer cut off.

### Removed

- Pending and the Slack digest no longer flag a pull request that only a bot reviewed.
- Bots Monitoring: the "Only a bot reviewed N open PRs" callout, the "bot-only open PRs" link under the tiles, the
  list they opened and the ⌘K command "Bots: open PRs only a bot reviewed".
- Bots Monitoring → ROI: the **Quality checks** section. Bots Monitoring shows review bots only; quality checks are
  in Settings → Bots.

## [1.0.70] - 2026-11-20

### Added

- Feed → Bots has two new chip rows: **Severity** (Critical, Major, Minor, Nit, Unscored) and **Bot type** (Review
  bot, Quality check, Dependency updates, Code agent, Release automation, Housekeeping). The Bots side opens on
  Review bot, or on every type when the feed shows one pull request. Turn every chip in a row off to see all. ⌘K toggles each chip.
- Bots Monitoring → ROI has two tiles across the workspace's review bots: **Time to first review** (median, with
  p90 and the number of pull requests) and **Follow-ups after first review** (the share of pull requests a review
  bot posted on again, with the average number of extra posts).
- Bots Monitoring → ROI: new weekly charts **Time to first review** and **Follow-up rate** beside Thread volume,
  and new table columns **First review** and **Follow-ups**.
- Bots Monitoring: click a bot in a chart legend to show only that bot. The other bots fade in every chart on the
  page. Click it again to show all.

### Changed

- A rendered Markdown file in Changes now looks like the diff: a bordered panel with a "README.md · rendered"
  header, a `+` beside each block with added lines, hidden-line rows like the diff's, and code blocks in the diff's
  font and colours.
- Bots Monitoring → ROI: click a bot's name to open its own charts. The **Depth** column is gone.
- Bots Monitoring → ROI: **Bot effectiveness** and **Used vs not addressed** moved into **Workspace charts**.
- Each Ensemble poster ("Ensemble · alice") and each account of a bot with several accounts gets its own shade of
  that bot's colour.
- Bots Monitoring → Findings density: the bot picker under the chart is replaced by the same click-to-isolate
  legend as the other charts.

### Removed

- Bots Monitoring → ROI: the columns **Unanswered after Nh**, **Oldest not addressed**, **High**, **Nits** and
  **Not addressed by severity**.
- Bots Monitoring: the per-bot list of comments and pull requests is gone, and the **Comments/PR** figures no
  longer open a list of merged pull requests.

## [1.0.69] - 2026-11-20

### Changed

- Maintenance release: no changes you would notice.

## [1.0.68] - 2026-11-20

### Added

- Releases work without version tags. A repository with no version tags is released from its merged pull requests:
  each one merged into the default branch counts as a release point, and the same rules pick the newest one whose
  tickets, and every earlier one's since the last release, are Complete with no pull request still open. Release…
  tags that commit with the date and your release suffix (2026.11.19-rc), and that tag is where the next release
  starts. Settings → Releases → "Release from" (Auto, Version tags, Merged pull requests) picks it per repository;
  Auto uses merged pull requests until the repository has a version tag.

### Changed

- Claude now runs on your Anthropic API key by default. When `ANTHROPIC_API_KEY` is set, every Claude run uses it,
  even while you are signed in to Claude Code. "Use my API keys first" in Settings → AI is now ticked unless you
  untick it. Without a key, Ensemble still falls back to a Claude Code login; the docs and Settings link to
  Anthropic's terms on that use.
- Settings → AI downloads each agent on its own. Claude and Codex each have a line with **Download** (Claude about
  110 MB, Codex about 360 MB) or **Remove**, and only the ones you pick are downloaded. A new install downloads Claude
  alone; an install that already had Codex keeps it. An agent that is not downloaded is not used: AI features, Auto
  and Claude + Codex reviews use the other one, and a feature with neither says how to download one. From a terminal,
  `ensemble ai install claude|codex` and the new `ensemble ai remove claude|codex` do the same.
- Settings save as you go: there is no Save button on any Settings tab. A switch, choice or tick saves at once;
  a typed value saves when you stop typing or leave the box, and a value that is not allowed is not saved and
  says why beside the box. A token, API key or Slack webhook saves when you press Enter or leave the box, and is
  never shown again. Each section says "Saved" when its change is stored; a change that could not be saved says
  so beside it and in the corner of the window.
- This Sprint: only the Critical path view draws arrows, and each arrow's reason is now written beside it, in the
  space between the tickets, instead of behind a number you had to hover. The Theme and People views draw no
  arrows; a ticket that waits on another still wears the hourglass mark.

## [1.0.67] - 2026-11-19

### Added

- Story checks read code outside the ticket: the workspace's other repositories at their default branch (related
  repositories first, at most 12; the check names the ones it left out) and open pull requests in related
  repositories on the same branch but not linked to the ticket. A criterion only that code does is met and says
  where, for example "Already in acme/api (no PR on this ticket)", and counts name it apart ("3 of 4 met,
  1 already outside the ticket"). Work that belongs in a repository with no pull request reads "No PR yet in
  acme/api" and is never posted. A change in that code does not start a new check; turning the switch on or off
  does. Settings → AI review → "Story checks read every repository" (on by default) turns it off. The review
  rounds of Implement story, AI Fix and a local branch review keep working on a criterion that only an unlinked
  pull request does.

## [1.0.66] - 2026-11-19

### Changed

- Maintenance release: no changes you would notice.

## [1.0.65] - 2026-11-19

### Added

- Review a local branch from Claude Code or Codex: add Ensemble as an MCP server
  (`claude mcp add ensemble -- npx ensemble-review mcp`) and your coding agent can ask the running Ensemble to review
  the branch it is working on, uncommitted changes included, before anything is pushed. It gets the findings and,
  when Ensemble finds the ticket, the acceptance criteria not yet met; it can answer them and review again.
  `ensemble review` does the same in the terminal. Nothing is posted or pushed. Reports → AI usage counts these runs
  as code review and story review.
- Pull request Overview: "Someone else" asks anyone in the workspace for a review. Type a name, pick one or
  more people, and press "Request review". People who merged in the repository come first. If GitHub refuses
  someone (for example, they have no access to the repository), the reason shows on their name.
- Settings → AI: three blocks, Review, AI Fix and Implement story, set the vendor, model and effort each runs on.
  Review has one row per vendor, each switched on or off with its own model and effort, so Claude and Codex can
  review at different efforts. AI Fix and Implement story each have one vendor, model and effort. The run menus
  open on these and can pick another model for one run. If the AI Fix or Implement story vendor is not signed in or
  is over its usage limit, the other vendor runs, and the run says so. Until you change a block, it runs as before.
- Settings → AI → Implement story: "Review rounds" sets how many review rounds a build runs. The start panel opens
  on it and can still change it for one build.
- AI Fix: every fix, manual or automatic, is reviewed by Ensemble before anything is pushed. The agent fixes,
  answers or pushes back on each point, and Ensemble reviews again, up to 5 rounds. The AI Fix tab shows each round
  ("Reviewing, round 2 of 5.") with Stop, and Push shows once the rounds end. After the push, the last review is
  the pull request's AI review of the new commit, so auto review does not review it again. Settings → AI → AI Fix →
  "Review rounds" sets the number (1 to 6).
- AI Fix and Implement story: the agent can say a criterion cannot be done, and why. It stays not met, the reason
  shows beside it (and in the pull request's description for Implement), and the review rounds stop when only such
  criteria are left.
- AI Fix: the sandbox also holds the workspace's other repositories, read only at their default branch, so the agent
  can check code that calls or serves the pull request. A repository with another open pull request of the same
  ticket is at that pull request's latest commit instead. At most 12: the pull request's own, its ticket's, your
  related repositories, then the rest by name; the session names the ones it did not load. Settings → Sandbox → "AI Fix
  reads every repository" (on by default) switches this off for a workspace. AI Fix still pushes only to the pull
  request's branch. Dependency fixes keep the short list.
- AI Fix: fixes of pull requests of the same ticket in different repositories take turns. While a fix of #12 runs, a
  fix that reads #12 waits ("Waiting for the fix of #12 (same ticket).") and starts by itself when that fix is built,
  stopped or failed. It then reads #12 with its fix applied, even if that fix is not pushed yet. Start now starts a
  waiting fix at once. Plan first's Start fix waits the same way.
- AI Fix: when another pull request of the ticket changes after a fix is built, the fix says "#12 changed after this
  fix was built." Push automatically and Push when done do not push it, and do not push a fix that builds on another
  pull request's fix that is not pushed yet. Push still pushes it. Nothing runs again by itself.
- AI Fix: the workspace's reference documents come into the sandbox, read only, as they do for Implement story:
  the ticket's own choice, else the whole library when it is small, else the sections that best match the pull
  request's words and changed files.

### Changed

- Asking for a review: when GitHub refuses a person, the message now says who and why in plain English.
- Implement: the plan asks the points to settle one at a time ("Point 2 of 4", with the acceptance criteria it is
  about). Pick 1. Agree or 2. Keep the story (the 1 and 2 keys work), or Reply. Each answer is saved when you
  pick it. The last step, Review, lists every answer and holds Approve and start. Picking the chosen answer
  again no longer clears it.
- Implement story: the review loop runs up to 5 rounds by default (was 4).
- Settings → AI: the single "Effort for reviews and AI Fix" menu is replaced by the effort in each block.
- Settings → AI review: "Auto reviews use" now offers Claude + Codex or one vendor: the first that is on in
  Settings → AI and signed in. A vendor switched off there does not review.
- AI Review: the reason an auto fix did not start is one line, in the Auto fix section, shown after the review
  finishes. It names the cause: AI not signed in, the review or the pull request could not be read, an error,
  the limit of 3 auto fixes in 24 hours, or the daily limit of auto reviews.

### Fixed

- AI Fix: the review rounds now also check the points earlier AI reviews posted on the pull request. After the
  push, the AI Review tab shows which ones the fix dealt with, and on your own pull request Ensemble resolves those
  threads. Before, they stayed open and showed as current findings.
- AI Fix: after "Push when done" or "Push automatically" pushes a fix, the tab says "Pushed to" the branch with
  the commit, and no longer offers Push for a fix that is already pushed. While the push runs it says "Pushing
  to" the branch. A failed automatic push says why and keeps Push.
- AI Review: with Claude + Codex reviews, an auto fix now waits for both reviews to finish. It no longer says
  "No auto fix: the fixer could not start." while the review runs.

## [1.0.64] - 2026-11-18

### Changed

- Maintenance release: no changes you would notice.

## [1.0.63] - 2026-11-18

### Changed

- Maintenance release: no changes you would notice.

## [1.0.62] - 2026-11-17

### Changed

- Maintenance release: no changes you would notice.

## [1.0.61] - 2026-11-17

### Changed

- Maintenance release: no changes you would notice.

## [1.0.60] - 2026-11-17

### Changed

- Maintenance release: no changes you would notice.

## [1.0.59] - 2026-11-17

### Changed

- Maintenance release: no changes you would notice.

## [1.0.58] - 2026-11-17

### Changed

- Maintenance release: no changes you would notice.

## [1.0.57] - 2026-11-17

### Changed

- AI Review: "Where this PR stands" is now "Latest review by each person" and shows each person's newest
  review. Before, a withdrawn Request changes from last week could show instead of today's review of the
  latest commit. An earlier Request changes that still blocks the merge shows under that person's row.

## [1.0.56] - 2026-11-17

### Changed

- This Sprint → Releases: the candidate is now the tag just below the oldest tag that can't be released, because
  releasing a tag ships everything below it. A tag whose own tickets are Complete says which older tag holds it
  back. Before your first release the whole history is checked, and a candidate shows once it has all been read.
- This Sprint → Releases: every reason names the ticket's title beside its number, for example "PAY-1061
  “Export statements” is In Code Review".
- This Sprint → Releases: Refresh shows a progress bar saying what it reads.
- This Sprint → Releases: a cancelled ticket, such as "Won't Do", no longer stops a release. It is listed with a
  tick and gets no comment.
- This Sprint → Releases: the repositories are picked together. A Complete ticket with work in several tags or
  repositories is released whole or not at all, and the tag that would ship part of it says what it would
  ship without and the ticket that is really holding things up, for example "… which waits on
  web 0.341.0: PAY-1061 is In Code Review".
- Release notes for a first release list everything up to the tag.
- This Sprint → Releases is now a list of tickets, newest tag first, with one card per ticket even when its work is
  in several repositories. It opens on the newest ticket in the release candidates, with "Show 3 later tickets"
  and "Show 3 earlier tickets". Each card shows its status, its latest tag in each repository, and one line: what
  it waits on, or what was done. The ticket holding the release is always shown, tickets with only open pull
  requests sit apart, and pull requests with no ticket are narrow rows between the cards. A ticket the
  tracker can't find has a dashed card.
- This Sprint → Releases: the newest ticket in the release candidates names each repository's candidate and its
  commit, linked to GitHub, and has one Release… button for all of them. Only repositories with no candidate are
  listed above the tickets. "Not in a tag yet" and "Holding the release" sit in their own box below the list.
- This Sprint → Releases: lists of pull requests with no ticket leave out bot pull requests unless you tick "Show
  bot PRs". The counts still include them. Pull requests with no ticket are hidden until you tick "Show PRs with no ticket".
- This Sprint → Releases: the ticket list has a line down its left side, like a pull request's Activity tab, with
  each ticket's mark on it and a merge mark for each group of pull requests with no ticket.

### Fixed

- This Sprint → Releases: a ticket deleted from Jira since it was last read no longer blocks with its old
  status. It is listed as "not found in Jira — check by hand".

## [1.0.55] - 2026-11-17

### Added

- Implement story: when a build finishes, Ensemble asks the story's chat "How to test" for you. The next time
  you open the build tab, a line at the top says the answer is ready, with Open in the story.

### Changed

- Open PRs: tickets that share a pull request are one group. Each ticket is on its own line, and each pull
  request is listed once beneath them.

### Fixed

- Story view → Ask about this story: the chat now reads every pull request of the story and each one's changes
  in full, however large, and the latest Implement story build's changes, pushed or not. Before, it could read
  a large change only in part and skipped pull requests past the sixth.

## [1.0.54] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.53] - 2026-11-16

### Changed

- Story view → How the code meets each criterion: one list, with no lines. Each pull request under a
  criterion is marked Merged or Open, with one line on how it meets the criterion; select it to read it in
  full and see the files.

## [1.0.52] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.51] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.50] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.49] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.48] - 2026-11-16

### Changed

- This Sprint → Releases: a repository opens to one list in three parts — every tag newer than the candidate
  with all its tickets, the candidate, and the 10 older tags below it for checking, one line each, with
  "Show 50 more". After a release the list stops at that release. Older tags never change the candidate.
- This Sprint → Releases: each tag shows its date, its commit (a link to GitHub) and how many pull requests and
  tickets it has. Tickets that stop a tag come first, then those to check by hand, then Complete ones.
- This Sprint → Releases: select a ticket to see its type, assignee, when its status was read, its pull requests
  in the tag and elsewhere (open, or the tag that holds them), with "Open in Jira" and "Story". Select "3 pull
  requests with no ticket" to list them.

## [1.0.47] - 2026-11-16

### Changed

- This Sprint → Releases: the candidate is now the newest tag whose tickets are Complete with no pull request
  still open. It checks from the newest tag down and stops at the first one that qualifies. After a release, a
  tag's tickets are everything merged since that release; before the first release, only what the tag itself
  added. Each newer tag says why it does not qualify, for example "PAY-1048 is In PO Review" or "PAY-1050 has
  an open pull request in web (#812)".
- This Sprint → Releases: a ticket the tracker cannot find no longer holds the release back. It is listed under
  its tag, "PAY-123 not found", for you to check, and so are pull requests with no ticket.
- Release notes before the first release list only the tag's own stories and say "Earlier changes are not
  listed."

### Removed

- This Sprint → Releases: the "Candidate at most …" line and the warnings for pull requests with no ticket.

## [1.0.46] - 2026-11-16

### Changed

- Maintenance release: no changes you would notice.

## [1.0.45] - 2026-11-15

### Changed

- This Sprint → Releases checks much faster: it reads main's history once, newest first, instead of asking
  GitHub about each tag and each old pull request, and reads tickets from Jira up to 100 at a time. Later
  checks read only the new commits.
- This Sprint → Releases: while a repository is still being read it already says "Candidate at most 0.388.0 —
  checking older history (40%)".

## [1.0.44] - 2026-11-15

### Added

- Repos & workspaces: click a repository to open its panel, with its first sync of the last 90 days while it runs, how many pull requests were synced, and its Bot scoring switch. A repository you add opens there.
- This Sprint → Releases finds the candidate by itself. It checks every version tag on main after the last
  release, or from the very first tag when there is none, oldest first. The first tag with a ticket that is not
  Complete, or that could not be read, holds itself and every later tag, and the tag before it is the candidate.
  Pull requests and tickets older than the synced history are fetched for the check.
- This Sprint → Releases: a repository still being checked says "Checking…" with a progress bar and one line of
  what it is doing ("Fetching pull requests: 35 of 80"). The tab updates by itself until every repository is done.
- This Sprint: a sixth column, Cancelled, after Complete. Closed statuses such as "Won't do", "Duplicate" and
  "Closed as not planned" go there, and you can give any bucket this meaning in Statuses. Cancelled tickets never
  count as complete. The column is closed at first, like Complete. Saved buckets gain a Cancelled bucket when read.

### Changed

- Bot scoring is now off for every repository until you switch it on in its panel. Switched on, the panel shows how many of its bot comments are scored. If the bot comment model is not downloaded, the panel says so and links to Settings → Features.
- This Sprint → Releases: only a Complete ticket is Done. A cancelled ticket ("Won't do") now holds a tag back like
  any other unfinished ticket.
- This Sprint → Releases: one row per repository: "Release 0.388.0 → 0.388.0-rc" (with the latest version tag
  beside it when different), or "No tag can be released: the oldest tag, 0.12.0, already contains PAY-127 (In
  Progress)". Open a row to see every tag after the candidate and why each one is held back. The separate tickets
  list is gone.

### Fixed

- Settings → Features: pressing Escape right after a download question opens now closes only the question, not Settings.

## [1.0.43] - 2026-11-15

### Added

- Settings → Features: switches for AI (Claude and Codex) and Bot comment analysis. Switching one on that is not downloaded asks first, then downloads it; an installed one lists what was found. Switched off, AI features show how to set them up again and nothing runs automatically, and no new bot comments are scored. Nothing is deleted.
- Repos & workspaces: a Bot scoring switch on each repository leaves its bot comments out of severity scoring. Every repository is scored by default.

### Changed

- AI and bot comment analysis now download only from Settings → Features (or the terminal). The Set up buttons elsewhere link there, and bot comment scoring left Settings → Bots.

### Fixed

- Builds: you can now dismiss a failed build from the builds circle in the corner, and it stays dismissed.

## [1.0.42] - 2026-11-15

### Added

- Settings → Releases → "Released from this workspace": tick the repositories you release. Releases checks, tags
  and offers hotfix bases for those only, and ignores the rest. Nothing is ticked at first.
- This Sprint → Releases → "Start from this tag": treat a version tag on main, and everything before it, as
  accepted, so only later tags are checked. Change or clear it from the repository row. Nothing is written to GitHub.

### Changed

- This Sprint → Releases: one row per repository with the latest version tag and the candidate ("Latest 0.394.0 ·
  candidate 0.390.0 → 0.390.0-rc"). Open a row to see each tag's tickets and status. The separate tickets list is gone.
- This Sprint → Releases: a version tag is held back only by its own tickets that are not Done or could not be read.
  A ticket's pull requests in other repositories, and open pull requests, no longer hold anything back.
- This Sprint → Releases: tags whose changes are still being read say "Reading changes…" instead of holding the
  release back, and repositories you release catch up much sooner.
- Settings → Releases: the hyphen before each suffix is fixed. Type `rc`, and the tag is `v2.4.0-rc`. A suffix saved
  without a hyphen now has one.
- Implement → "Treat as a hotfix": a repository not released from this workspace is read only.

## [1.0.41] - 2026-11-15

### Fixed

- Repos & workspaces: adding a repo from the search no longer resizes the window, and the search list no longer jumps to show more results after you add one.

## [1.0.40] - 2026-11-15

### Changed

- Maintenance release: no changes you would notice.

## [1.0.39] - 2026-11-15

### Changed

- Maintenance release: no changes you would notice.

## [1.0.38] - 2026-11-15

### Changed

- Maintenance release: no changes you would notice.

## [1.0.37] - 2026-11-15

### Added

- This Sprint → Releases: per repository, the newest version tag whose pull requests link only to Done tickets,
  with the tickets and warnings behind it. "Create release…" tags each one with your release suffix, publishes the
  release notes as a GitHub pre-release and comments on each ticket.
- Settings → Releases: the release suffix and hotfix suffix the Releases tab needs.
- Implement → "Treat as a hotfix": the agent fixes your latest release, then ports the fix to the default branch in
  the same sandbox. Push opens two pull requests per repository, one into `hotfix/<tag>` and one into the default
  branch, each linking the other.
- Implement → a hotfix build ends with a port report per repository: "Applied to both", "Applied to both, adapted for
  main" or "Not applied to main", with the agent's reason. When main does not need the fix, Push opens only the pull
  request into `hotfix/<tag>`. The build tab says when the report and the two diffs disagree.

## [1.0.36] - 2026-11-15

### Added

- Implement and Fill gaps on a team: when a teammate is building a ticket, the story view says "robin is building
  this" instead of offering the button. Ensemble marks the ticket on GitHub when you press Start (an empty commit
  on the ticket's branch with an "ensemble/build" status), keeps the mark while your build runs, and clears it
  when the build ends. A mark whose computer went away for 30 minutes shows Clear.
- The review loop ("After the build: review and fix, then open the pull request") now shows each review round as
  a status on the branch: "alex is reviewing with Claude", then "alex reviewed · kept in Ensemble".
- The story view shows "How the code meets each criterion": each criterion beside the pull requests that say they
  move it forward, with how and the files. A criterion no pull request claims says so.
- A ticket with one pull request now shows that pull request's design in the story view, with Draw design and
  Redraw design.

### Changed

- Limn is now called Ensemble. Run it with `npx ensemble-review`, or `ensemble` once installed; the old
  `limn-review` command still works and points you to the new one.
- Your data moves from `~/.limn` to `~/.ensemble` the first time Ensemble starts.
- The website and the docs moved to ensemble.ac. Links to limn-review.com still work and take you there.
- Settings you set as `LIMN_…` environment variables still work. The new names start with `ENSEMBLE_`
  (for example `ENSEMBLE_AI_PROVIDER`), and win when both are set.
- Teams: your Ensemble still sees the claims of teammates on Limn. Limn does not read Ensemble's new
  `ensemble/` status lines, so update the whole team together.
- Settings → Dependencies: every switch is now on by default — Merge them automatically, Approve them
  automatically, Resolve their conflicts and Fix them with AI. This also turns them on in workspaces where they
  were off before, so check the tab if you want any of them off. Switching one off now stays off.
- Settings → Dependencies: Dependabot and Renovate are trusted by default. Any other dependency bot still needs a
  tick under Trusted bots, and unticking Dependabot or Renovate stays unticked.

### Fixed

- Dependency updates on a team: when Ensemble stops partway through an action, its "ensemble/deps" status on the commit
  is cleared the next time it starts, instead of holding teammates back for half an hour. A status GitHub did not
  accept is sent again.
- Dependency updates on a team: a teammate's Ensemble that armed a merge no longer holds it for ever. Its status is
  renewed while the merge is armed, is cleared when the merge ends without landing, and runs out after two hours if
  that computer is off, so your Ensemble can arm it.
- Dependency updates on a team: when a teammate's Ensemble asked the bot to rebase but cannot run AI, its status now
  says so ("AI step open to teammates") and your Ensemble resolves the conflicts after the 30-minute wait.
- Dependency updates on a team: a teammate's claim that expired is cleared once ("Cleared by alex: robin's claim
  expired"), and the "AI pushed this commit" status is sent again if GitHub did not accept it, so no one merges an
  AI-written commit before its CI passes.

### Changed

- Implement: "After the build: review and fix, then open the pull request" is now ticked by default. Untick it at
  Start to push by hand. Approving the plan is still yours.
- The licence is now called the Ensemble License 1.0. Only the name changed.

## [1.0.33] - 2026-11-13

### Changed

- Ask about this story: the agent is ready sooner. It reads each repository from one copy kept between chats and
  brought up to date when the default branch moves.

## [1.0.32] - 2026-11-13

### Added

- The story view: "Ask about this story". Ask how to prove the ticket is done once its pull requests are merged,
  what is still missing, or how it fits with the rest of the system. The answer comes from the ticket, the pull
  requests' changes and code, every repository in the workspace, the reference documents, the sprint's other
  stories, and your Claude memory, CLAUDE.md and skills; nothing is run or changed. Chats are saved with the story.

### Fixed

- Build end to end: the summary in the Jira comment keeps words like "Q3" and "P1" instead of removing them.

## [1.0.31] - 2026-11-12

### Added

- Manage repos & workspaces: a repository can be in more than one workspace. It is Maintained in one at most and
  External in any number of others. Making it Maintained in a workspace turns it External where it was before.
- Manage repos & workspaces: a Grid view shows every repository against every workspace. Click a cell to change it.
- Manage repos & workspaces: "Add one of your repos…" adds a repository you already have to the workspace, and
  "Add as" picks Maintained or External for new ones.
- The sidebar's Repositories list shows the workspace's External repositories too, marked External, and their
  pages open.

### Changed

- Manage repos & workspaces: "Watched" is now "Maintained". The dialog is wider, each repository fits on one line,
  and the workspace you pick lists its Maintained and External repositories. "In other workspaces" is gone.
- Manage repos & workspaces: the repository search lists nothing until you type, except before your first
  repository.
- Build end to end: the Jira comment lists the pull requests, then a short plain summary of what changed on the
  ticket and why, and the lines removed and added. It no longer names Limn, the review rounds or internal
  references.

### Fixed

- Repository search: Next and Prev show a spinner while the page loads.
- Manage repos & workspaces: removing a repository fades its line and shows a spinner, and you can remove another
  one at the same time. Before, the other remove buttons did nothing until the first removal finished.
- Opening Limn after a restart comes back to the workspace you last had open from a link, not Default.

## [1.0.30] - 2026-11-12

### Added

- Manage repos & workspaces: mark a repository External when your team changes it but does not maintain it,
  such as a shared infrastructure repository. Implement story and AI Fix still work in it, and its pull requests
  link to your tickets. Open PRs, Pending and AI reviews show only its pull requests that have one of your
  project keys or that your team's maintainers opened. Reports, the Timeline, the Feed and Bots leave it out,
  and nothing runs on it automatically.
- Open PRs: "Copy GitHub URL" in a row's right-click menu.
- Open PRs: the side panel shows a "Merge queue" row while GitHub's merge queue holds the pull request.
- Story check: a Stop button on a check that is waiting in line or running. A stopped automatic check does
  not start again until the ticket's pull requests or the ticket change.
- Implement story: "Build end to end" in the caret menu of Implement and Fill gaps. One press plans, approves the
  plan, builds, reviews and fixes for up to 4 rounds, opens the pull request, then updates the Jira ticket from the
  plan and comments on it as you, with links to the pull requests. It never changes the ticket's status.
- AI Fix: "Push when done", ticked by default. A fix that finishes on your own pull request with nothing left
  unfixed is pushed to its branch without a press; otherwise the session says why it waited.

### Changed

- Implement story and Fill gaps: the agent always gets the workspace's reference documents when there are any, and
  uses only the parts that help with the ticket. The plan says which it used. "Implement with docs" and the docs box
  are gone.
- Implement story: the review and fix loop runs up to 4 rounds by default (was 3).

## [1.0.29] - 2026-11-12

### Added

- AI Fix: up to three fixes now run at once. When every sandbox is busy, a fix (yours or an auto fix) waits in
  line and starts by itself as soon as one frees, your own presses first. The AI Fix tab shows its place in line,
  with Cancel. To make room, a fix session of yours that has done nothing for a minute is closed; its changes
  are kept.

## [1.0.28] - 2026-11-12

### Added

- Changes tab: Markdown files show rendered, with a Plain text button in the file's header to see the diff.
  Limn remembers your choice.
- Implement story and Fill gaps: "After the build: review and fix, then open the pull request". Limn pushes the
  branch, reviews it and checks it against the ticket, the agent fixes, answers or pushes back on each point, and
  Limn reviews again, for up to the number of rounds you pick (3 by default). Then it opens the pull request, ready
  for review. The review stays in Limn. The build tab shows each round, and Continue goes on after a pause (for
  example when the AI spend limit is reached).
- Implement story and Fill gaps: "Approve the plan automatically". Limn agrees with every change the plan
  proposes and starts the build without asking. It does not change the ticket: once the pull request is open,
  the build shows the ticket changes so you can update the ticket or leave it. With "After the build: review and
  fix" ticked too, Start is the only press. The Start panel remembers both boxes.
- A hammer circle among the notifications shows each running build's progress, and counts the builds that
  wait for you (a plan to approve, a build to push, a paused review, a failure, ticket changes to check).
  Select a build to open it.
- Auto fix now starts on CI failures too, not only after an auto review. It waits for the CI jobs to finish,
  gives the AI review of the same commit a short time so one fix covers both, and queues a fix behind one that
  is running; each starts from what is still open on the latest commit. The AI Review tab shows what the next
  auto fix waits for and lists every auto fix of the pull request, and an "Auto fixes" circle among the
  notifications shows the ones running or failed.
### Changed

- Implement is now offered on In progress tickets with no pull request, as well as Not started ones.
- Implement story and Fill gaps: the pull request and its commit are now yours, not your Limn bot's, so they
  count like any pull request of yours (auto review included). The branch is the ticket key, such as
  PAY-142, with no `limn/` in front. The pull request body no longer ends with "Built with Limn".
- Implement story: after planning, you can review and edit the whole ticket (description and acceptance
  criteria), with the changed words highlighted, and update it in Jira with one press. The update keeps the ticket's layout.

### Fixed

- Update ticket now writes the acceptance criteria in the field's own format, so lists and headings show
  correctly in Jira. When a ticket keeps its criteria in the description, they go into that section, and the
  rest of the description (colours, images, panels) is left exactly as it is.
- Implement story: when the branch already exists on GitHub, Push now offers a new branch name (such as
  PAY-142-v2) and pushes to it. Before, there was no way past it.

## [1.0.27] - 2026-11-11

### Added

- Settings → AI: **Use my API keys first**. Tick it to run Claude on the `ANTHROPIC_API_KEY` in Limn's
  environment even while you are signed in to Claude Code. The box says whether `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY` are set. Codex keeps using your ChatGPT sign-in: Codex runs on an API key are not
  available yet. `LIMN_AI_USE_API_KEY=true` or `false` still decides it from the environment.
- Implement story: before you press Start, the build tab says what the agent gets beside the code — how
  many of your Claude memories (and from how many projects), your CLAUDE.md, your own skills and the
  skills your repositories keep in `.claude/skills`. **Change** opens Settings → Sandbox.
- Implement story and AI Fix sessions: the agent is told about every skill your repositories keep in
  `.claude/skills`, and reads one when its task comes up.

## [1.0.26] - 2026-11-11

### Changed

- When Claude or Codex is at its usage limit, Limn uses the other one until the limit resets: replies to that
  model's findings, Check threads, CI and ticket reviews and the review chat run on the model with capacity
  instead of failing. A Claude + Codex review you start runs the other model alone, and the AI Review menu
  does not pick the pair first.
- On your own pull request, when a teammate's Limn has reviewed the commit with Claude, your Limn no longer
  runs Codex alone on it. Their findings show in the AI Review tab, and your replies are still judged.

### Fixed

- CI check: a failing SonarCloud check is now explained, from SonarCloud's own analysis of the commit
  (the quality gate and the issues), and posted like any other failing check. Before, it had no log to read,
  so when it was the only red check nothing was explained. This runs whether or not an AI review runs.
- AI Review tab → SonarCloud: the section now shows the pull request's latest commit, the one AI Fix uses.
  Before, it showed the reviewed commit, so once the pull request moved on it stayed empty and Refresh said
  "SonarCloud has not analysed this commit yet" while naming the latest commit.
- SonarCloud findings are now posted when SonarCloud finishes after the auto review, for up to 2 hours.
  Before, the one try at the end of the review usually came too early, and nothing was posted.
- Replies to a Codex finding were sent to Codex even while it was at its usage limit, so every replies check
  on them failed. They are now judged by Claude.

## [1.0.25] - 2026-11-11

### Changed

- Story check: when the latest check found every acceptance criterion met, Limn no longer checks the ticket
  again by itself after a push, a pull request joining or merging, or a new comment. The line says "No
  automatic story check — the last one found every criterion met". A change to the ticket text starts
  automatic checks again. Re-check still runs one now.
- This Sprint → Refresh: no longer starts a story check for a ticket whose last check found every acceptance
  criterion met, unless the ticket text has changed since.

## [1.0.24] - 2026-11-11

### Fixed

- AI Review tab → Reviews on this PR: on your own pull request, a review of yours that approved or requested
  changes reads "Approve (posted as Comment)" or "Request changes (posted as Comment)", matching "Where this
  PR stands".

## [1.0.23] - 2026-11-11

### Added

- Settings → AI review → Auto AI Fix: "Merge conflicts with the base branch" under Always include (off
  by default). With it on, an automatic fix of a pull request that conflicts with its base merges the
  base first. Limn checks the merge before any push, and a merge that fails the check is never pushed.
- This Sprint and the story view: assign a ticket. On Jira, GitHub Issues and Linear the assignee in the
  story view's header is a menu of the people your tracker lets you assign, plus "Unassigned". The
  ticket changes at once and the People board follows. On GitHub the person you pick becomes the
  issue's only assignee. Notion tickets show the assignee as before.
- The story view shows the assignee of a ticket that has pull requests but is not in the sprint.

### Changed

- Settings → AI review: three settings are now always on and their switches are gone: the status Limn
  puts on a commit it is reviewing (was "Mark auto reviews on GitHub"), resolving Limn's threads once a
  later automatic review finds them fixed (was "Resolve Limn's threads once fixed"), and dismissing a
  teammate's Limn "changes requested" once every point is fixed (was the two "Teammates' Limn “changes
  requested”" boxes). Approvals are still limited by the impact boxes. When GitHub refuses the status
  (no write access), the review goes ahead without it and nothing is shown.
- Settings → AI review → Auto AI Fix: the rows no longer name one provider. "Claude's findings" is now
  "Limn's findings" (Claude's and Codex's alike), and "Threads Claude says to fix" is now "Threads my
  agent says to fix". The Auto review description says "Limn reviews…".
- Settings → AI review → What to post: "SonarCloud issues, in one PR comment" is now "SonarCloud
  issues": they are posted on the lines they flag.
- Settings → Sandbox: "Your local folder" and "Starting folder" are gone. Limn finds your clones
  through the folders where you use Claude Code, places each repository at the same path in the
  sandbox, and brings the Claude notes of each clone. **Find** shows what it found. The AI starts in
  the repository with the most notes.
- Settings → Sandbox → Services: **Choose compose files** lists every compose file in the
  workspace's repositories, from Limn's own copies. Tick the ones you want.
- Implement and AI Fix: while the repositories load, the setup counts them ("Loading repositories
  3/7" and the repository's name).
- AI Fix loads only the pull request's repository and the repositories of the other pull requests of
  its ticket, not every workspace repository.
- Implement and AI Fix with Claude: the CLAUDE.md of every repository loads at the start, not only
  the one the AI starts in.

### Fixed

- AI Fix: when one half of a Claude + Codex review failed, the earlier findings the other half then
  found still open were left out of the fix. They are now included with the other earlier findings.
- Implement and AI Fix brought no Claude notes unless a local folder was set, and none was set by
  default. The notes of each repository's clone now come in without a setting.
- Settings → Integrations → Ticket fields: the menus now line up in two columns, "Criteria" and "Open
  points", one row per issue type.

## [1.0.22] - 2026-11-10

### Changed

- AI Review: "Where this PR stands" now uses the same columns as "Reviews on this PR", and both lists
  show the time with the date ("10 Nov 14:04", 24-hour clock). The short note after each verdict is
  gone.
- AI Review: the review's summary is headed "Summary". The run name ("Codex's review", "Claude +
  Codex review", "Robin's review") and "reviewed 1 day ago" are gone, and so is the block repeating
  them on the right. The models and the cost stay behind the ⓘ. The same goes for the CI check and
  Story check headings: no "reviewed … ago" and no model name (hover the story's heading, or open the
  CI check's ⓘ, for when and with what).
- AI Review: "Run a review" no longer says "Waiting for a teammate's Limn to review" or "@robin-dunn
  reviewed this commit with Claude · approved"; the teammate's verdict is in "Where this PR stands".
  A teammate's Limn reviewing the commit right now is still named. Pending's "Waiting on others" row
  keeps its line.
- AI Review: a little more space at the bottom of the tab.

### Fixed

- AI Review: "Where this PR stands" showed a teammate as having only commented when their Limn had
  approved after checking replies. It now shows the verdict GitHub holds: an approval in force reads
  "Approve", a withdrawn one "Approve (withdrawn)".
- A pull request with more than 50 reviews lost its newest ones, so a teammate's latest approval
  could show as an older comment or a withdrawn approval. Limn now reads every review.
- AI Review: on your own pull request, your row in "Where this PR stands" reads "Comment" (what
  GitHub holds), not the verdict your review would have given.
- AI Review: on your own pull request, findings no longer offer "Post reminder".
- AI Review: a review half that did not finish no longer repeats itself ("Codex didn't finish: Codex
  could not finish: …"); it reads "Codex didn't finish: you've hit your usage limit".

### Removed

- AI Review: the "In this review" counts, the "Ticket" panel (the pull request's header links the
  ticket), and the "Review threads" section when there are no other review threads.

## [1.0.21] - 2026-11-10

### Added

- Settings → Sandbox: one line says how many Limn sandboxes are running now, with "Stop all" to stop
  them. Stored changes are kept; an automatic AI Fix that is running is cancelled.
- Open pull requests: right-click a row and choose "Start review" to start an AI review with your
  default choice (Claude + Codex when both are signed in). The item is greyed out, with the reason,
  while AI is not set up or signed in, or a review is starting, queued or running. Over your AI spend
  budget it asks once more. "Review started for #615" shows in the bottom-right corner.
- Auto review: a pull request whose author reviewed it with their own Limn (which can never approve
  it) is picked up by a teammate's Limn for the verdict, ahead of other automatic reviews, and first
  when the author's Limn would have approved. One teammate takes it through the usual status line; if
  their Limn stops renewing it for 25 minutes, another takes over. It counts toward the daily limit
  and asks the spend budget like any automatic review. The teammate's AI Review tab says why, for
  example "Queued: needs a verdict (alex’s own review would approve)".
- Your own pull request: the AI Review tab and the "Waiting on others" row say "Waiting for a
  teammate’s Limn to review" while your Limn's review is the only one at the latest commit, when a
  teammate's Limn has run automatic reviews in the workspace in the last two weeks.
- Auto review after a break: when Limn starts or the computer wakes, auto review waits (30 minutes at
  most) until your repositories have synced, then reviews what changed while you were away, the
  verdicts teammates wait for first.

### Changed

- Sandboxes (AI Fix, Implement story): a sandbox is stopped and removed whenever its session ends,
  whatever ended it, including Limn stopping (Ctrl-C included). A session with nothing to do now closes
  after 15 minutes (was 60); its changes are kept and Resume starts a new sandbox. One turn of the AI
  that runs for more than 2 hours is stopped. Every few minutes, Limn removes any sandbox of its own that
  no open session uses.
- AI Review: the earlier findings are part of "Findings". Still-open ones sit under "Open" with the
  new findings; the rest under "Resolved or addressed". Each earlier finding says in one line how it
  was dealt with, or what is still needed, with the reply and its buttons on the same row.
- The "?" button at the foot of the sidebar opens the Limn docs in a new browser tab, on the page
  for where you are (Pending opens the Pending docs). The in-app help is in Search or jump ("Help and
  keyboard shortcuts"), the "?" key still opens the shortcut sheet, and Search or jump has "Open the
  Limn docs".
- The docs website: the pages under /docs no longer have the site footer. They end on one line with
  Privacy, Cookies, Terms and Cookie settings.
- Auto review, "Which PRs: Mine": a pull request that waits for a teammate's verdict (its author's own
  Limn review is at the latest commit, or new commits came after teammates' Limn reviews) now counts
  as yours, so the verdict reaches GitHub.

### Removed

- AI Review: the separate "Previous review" section (its findings are now in "Findings").
- AI Review, Story check: "What this PR adds" and the "N more criteria are met by other PRs" line.
  Both stay in the ticket's story view.
- Story check: typing or pasting a story's text by hand ("Input manually", "+ Add story"). Add a
  ticket by its link or key instead; without an issue tracker there is no story check. Older checks of
  typed stories are no longer shown.

## [1.0.20] - 2026-11-10

### Changed

- AI Review: the right-hand column starts with the pull request's latest commit (click to open it,
  or copy it) under "Where this PR stands". "Reviews on this PR" lines up in columns (who, when,
  commit, outcome, what ran it), shows the newest 10 with "Show all" for the rest, and the column is
  a little wider.

### Removed

- AI Review: the "Check replies" button (the replies check still runs by itself), the per-review
  "Auto review", "From scratch", "Deep review" and cost labels (the cost is behind the review's ⓘ),
  the live token count while a review runs, "Marked on GitHub", and routine "No auto fix" lines such
  as "auto AI Fix is off for this workspace".

## [1.0.19] - 2026-11-10

### Added

- Open tabs: hover a tab in the sidebar (or move to it with the keyboard) to see a short card that
  says which tab it is. For a pull request: its repository, author, state, CI, review, AI review and
  threads. For a ticket, a person, a bot or a list: what that tab shows.
- AI Review: when your Limn's review approves a pull request and a teammate's Limn "changes requested"
  still stands, your Limn dismisses it if it came from their automatic run, every point in every Limn
  review of theirs on the pull request is fixed at the latest commit, and the teammate has been away for
  4 hours without their Limn looking at that commit. No setting is needed beyond
  "Approve or request changes for me"; the AI Review tab says when it happened.

### Changed

- The Timeline is now optional and off by default. Switch it on in Settings → Features. While it is
  off, it leaves the sidebar, `g t` and the search menu, a link to it opens Open pull requests, and
  pull requests open in their own tab instead of a Focus tab.
- AI usage and Settings → AI spend show the 5-hour session bar and setting only when your plan has a 5-hour limit; weekly-only plans see the week alone, and a 5-hour share no longer pauses automatic runs on them.
- Claude's Max 20x plan is now called Ultra everywhere Limn names it.

### Removed

- Website: the separate Getting started page. Its steps live in the docs' Getting started section,
  which gains a "Set up the rest" list, and the old address now goes there.

## [1.0.18] - 2026-11-10

### Changed

- Maintenance release: no changes you would notice.

## [1.0.17] - 2026-11-10

### Changed

- Docs: the Claude pages present your own Claude Code login and an Anthropic API key as two equal
  choices, with plain steps for each, and a short factual note on Anthropic's policy in place of
  the earlier warnings.
- Docs: pages no longer carry "Developer" / "Engineering manager" boxes, and the docs footer drops
  the large Limn wordmark.

## [1.0.16] - 2026-11-10

### Added

- Documentation at limn-review.com/docs: every page and tab of the app, AI review, AI Fix,
  Implement story, merging, every Settings tab, one page for each integration, security and
  running locally, and this changelog.

## [1.0.15] - 2026-11-09

### Added

- The story view shows the ticket's comments, open, for Jira, GitHub Issues, Linear and Notion:
  the newest three with "Show all", who wrote each and when, and a "New since the check" chip.
  It shows in the Ticket tab, the pull request's story and This Sprint's tray, also for a ticket
  with no pull request. Bot comments are left out.
- A "Met outside code changes" citation in a story check opens the comment it cites.

### Changed

- "As written in …" no longer repeats the ticket's comments, so each comment shows once.

### Fixed

- When a new ticket comment is waiting to be checked, the story check line names the comment.
  It no longer says it is waiting after a push that the last check already covered.

## [1.0.14] - 2026-11-09

### Added

- Findings that Limn posts as a pull request comment (because they could not go on a line) now
  follow the same life as review threads. Limn reads people's replies in the conversation, says
  whether each finding is still open, and closes the ones that were dealt with.
- Every follow-up item and thread judgement carries one short line that says how the point was
  dealt with, or the one thing still needed.
- A story check can mark an acceptance criterion "Met outside code changes" when a person's
  comment on the ticket shows it was done another way (a sign-off, a setting, uploaded content).
  It counts as done and is never posted or offered to Fill gaps. Every story check reads the
  ticket's comments again first.
- When Claude and Codex both review, each one now follows up the other's open findings when only
  one of them runs next. If one half of a pair fails, the other checks the failed half's open
  findings before the review is posted.
- A withdrawn Limn approval stays visible: "Approve (withdrawn)" in the reviews list, with the
  reason, and the Feed shows the dismissal message.
- `pnpm dev:scratch` runs a throwaway copy of Limn from a source checkout, for contributors, and
  only one Limn can now use a data folder at a time.

### Changed

- The thread pill shows the newest Limn judgement, also when a teammate's Limn made it
  ("Robin's Limn: addressed").
- A replies check now runs after a push even when a teammate's Limn holds the review of that
  commit, so a reply after a push is judged.
- A review that only comments while nothing is open can now approve, through the same checks as
  any approval. The "Not approved" line no longer says "left a comment"; it says what is still
  open, including an unmet ticket criterion.
- The automatic story check waits two quiet minutes after the newest push, ticket change or
  comment (at most 20 minutes in a busy run), then starts. The per-ticket limit is gone; the
  workspace's daily limit is now 60, and tickets with a pull request of yours do not count
  towards it. The AI Review tab and the Ticket view say when the check will start, or why not.

### Fixed

- AI Fix's "Resolve merge conflicts" could fail to bring the base branch into the sandbox
  ("remote did not send all necessary objects"). It now works, and when it cannot it says why.
- A Claude-only run after a failed Claude + Codex pair could lose a still-open Codex finding.

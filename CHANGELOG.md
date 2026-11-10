# Changelog

What changed in each release of Limn (`npx limn-review`), newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the
npm package. Every push to `main` publishes a patch release; the release workflow moves everything
under "Unreleased" to the new version's heading in the same commit as the version bump
(`docs/RELEASE.md` § The changelog).

How to write an entry: one line per change a person using Limn would notice, in plain English,
under Added, Changed, Fixed or Removed. Name the screen in the app's own words. No file names,
no internals.

## [Unreleased]

### Added

- Settings → Sandbox: one line says how many Limn sandboxes are running now, with "Stop all" to stop
  them. Stored changes are kept; an automatic AI Fix that is running is cancelled.
- Open pull requests: right-click a row and choose "Start review" to start an AI review with your
  default choice (Claude + Codex when both are signed in). The item is greyed out, with the reason,
  while AI is not set up or signed in, or a review is starting, queued or running. Over your AI spend
  budget it asks once more. "Review started for #615" shows in the bottom-right corner.

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

# Ensemble (`ensemble-review`)

A **local dashboard for tracking your team's GitHub PR activity** across
multiple repositories. Run it on your machine, see at a glance who's doing what,
which PRs are stalled, which review threads are sitting untouched, and what needs
_your_ attention right now — all rendered as an interactive timeline.

There's no hosted backend, no database server, and no stored credentials. It
authenticates by shelling out to your already-logged-in `gh` CLI, syncs activity
into a local SQLite file, and serves the dashboard from a single local process.

**Every feature, free for up to 3 people**, with no sign-up. Larger organisations
buy one licence a year (see [License](#license)).

> **Renamed.** This package used to be `limn-review` (and before that
> `pierre-review`). The command is now `ensemble`; both old packages only forward
> to this one, and say so. On first start, an existing `~/.limn` (or
> `~/.pierre-review`) is moved to `~/.ensemble` — your database, settings and
> clones come with it. If `~/.ensemble` already exists, nothing is moved.
> Settings named `LIMN_…` still work; their new names start `ENSEMBLE_…`.

## Quick start

```bash
npx ensemble-review
```

This starts the server, prints a local URL, and opens your browser to it.

Or install globally and use the short command:

```bash
npm install -g ensemble-review
ensemble
```

## Review and fix with Claude or Codex, on your own account

Claude Review (a code review of any PR, follow-ups, a check against a user
story, and a chat about the review), AI Fix and Implement story run on your own
AI account. Ensemble charges nothing for them; your AI provider bills you for the
usage as usual. By default they use `ANTHROPIC_API_KEY` when it is set, and your
local Claude Code login when it is not. Ensemble stores no key. They can run on
Codex instead (below).

- **Claude and Codex work out of the box.** The first time Ensemble starts, it
  downloads both in the background (Claude about 110 MB, Codex about 360 MB
  unpacked) into `~/.ensemble/ai-runtime`, at the exact versions this release was
  tested with. The package itself stays small. Signing in is the only step.
  `ensemble ai install codex` runs the same download by hand;
  `ENSEMBLE_AI_AUTO_INSTALL=false` skips the automatic one.
- Set `ENSEMBLE_CLAUDE_PATH` to the `claude` you already have to use it instead of
  the bundled copy (the download then skips it).
- The reviewer reads code. It cannot edit files, run commands or reach the web.
- AI Fix and Implement story run commands, but only in a sandbox (a container or
  virtual machine on your computer) with no GitHub credentials. They need a
  container runtime such as Docker, Colima or Podman.
- Nothing is posted or pushed until you press the button, unless you switch on an
  automatic setting yourself.
- Untick **Use my API keys first** (Settings → AI), or set
  `ENSEMBLE_AI_USE_API_KEY=false`, to use your Claude Code login even when
  `ANTHROPIC_API_KEY` is set.
- `ENSEMBLE_AI_DISABLED=true` turns every AI feature off.

### Codex instead of Claude

Every AI feature can run on Codex, on your own ChatGPT plan. One provider runs
everything at a time.

Codex comes with Ensemble. Sign in from **Settings → AI**, or:

```bash
ensemble ai login codex     # sign in with ChatGPT (add --device-auth on a headless machine)
```

Ensemble keeps its own
Codex sign-in in `~/.ensemble/codex`; your `~/.codex` is not read or changed. Codex
with an OpenAI API key is not available yet.

- Pick the provider in **Settings → AI**, or set `ENSEMBLE_AI_PROVIDER` to
  `claude`, `codex` or `auto` (the default: Claude when both are signed in,
  Codex when only Codex is).
- Each run is labelled with the provider and model that ran it.
- `ensemble ai status` shows whether Codex is set up and signed in.
- `ensemble ai logout codex` signs Ensemble's Codex out.

## Prerequisites

- **Node.js ≥ 22** (with npm).
- **GitHub CLI**, installed and authenticated. Install it from
  <https://cli.github.com>, then run:

  ```bash
  gh auth login
  ```

  `ensemble` reads your team's activity using your `gh` token. It pre-checks this on
  startup and exits with a friendly message if `gh` is missing or not authed.

> **Native module note:** `ensemble-review` depends on `better-sqlite3`, a native
> addon. npm installs a prebuilt binary for common platforms; if none matches your
> Node/OS/arch, npm compiles it from source on install (needs a C++ toolchain —
> Xcode Command Line Tools on macOS, `build-essential` + Python on Linux, MSVC
> build tools on Windows).

## Usage

```
ensemble [options]
ensemble status [options]
ensemble ai install
```

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--no-open` | `NO_OPEN` | — | Don't open the browser on start. |
| `--port <n>` | `PORT` | `4000` | Port to listen on. |
| `--db <path>` | `DATABASE_URL` | `~/.ensemble/pierre-review.sqlite` | SQLite DB path. |
| — | `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Where Ensemble keeps its data. |
| — | `PERSIST_BODIES` | `false` | Also store PR descriptions, diff hunks and commit messages instead of loading them on demand (larger DB, but PR detail works fully offline). |
| `-h`, `--help` | — | — | Show usage. |

Examples:

```bash
ensemble --port 4123 --no-open
ensemble --db /tmp/ensemble.sqlite
```

## Data directory

Everything Ensemble keeps lives in `~/.ensemble`:

```
~/.ensemble/pierre-review.sqlite   the database
~/.ensemble/clones/                git clones Claude Review and AI Fix read
~/.ensemble/ai-runtime/            the AI runtime, once you set AI up
```

The directory is created automatically. Override it with `ENSEMBLE_DATA_DIR`, or
just the database with `--db` / `DATABASE_URL`. Ensemble sends nothing to its
author. Your data goes only to GitHub, and, when you use those features, to your AI
provider (Anthropic or OpenAI) under your own account and to the issue tracker,
Slack or SonarCloud you connect.

## How it works

Once running, open the printed URL (default <http://localhost:4000>). Add the
repositories you want to watch from the in-app picker; the app syncs their PR
activity (full backfill on first sync, incremental every few minutes thereafter)
into your local DB and renders it as a timeline.

Repos are grouped into **Workspaces**, and the selected workspace is the scope for
everything — the feed, the timeline, the metrics, the review-bot settings. Every
repo belongs to exactly one workspace; new ones land in **Default** (renameable, not
deletable), and you can create more and move repos between them from *Manage repos &
workspaces*.

To keep the database small and backfills fast, bulky text (PR descriptions, diff
hunks and commit messages) isn't stored; it's fetched from GitHub (using your `gh`
token) the first time you open a PR and cached in your browser, so re-opening an
unchanged PR is instant and offline. Comment and review text is always stored. Set
`PERSIST_BODIES=true` to store the rest locally too: a larger database, but PR
detail then works fully offline.

## License

Source-available under the **Ensemble License 1.0** — see [LICENSE](./LICENSE).
Ensemble is free for individuals, and for organisations where no more than 3 people
use it (affiliates count together). More users than that need a licence: one a
year for the organisation, from £600 plus VAT, priced by how many people use it —
see [pricing](https://ensemble.ac/pricing). You may
**not** offer Ensemble, or a product built from it, as a competing commercial
product or service.
The AI runtimes Ensemble downloads on first use (Anthropic's Claude Agent SDK and
OpenAI's Codex CLI) are under their makers' own terms; they are not part of this
package.

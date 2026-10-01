# Limn (`limn-review`)

A **local dashboard for tracking your team's GitHub PR activity** across
multiple repositories. Run it on your machine, see at a glance who's doing what,
which PRs are stalled, which review threads are sitting untouched, and what needs
_your_ attention right now — all rendered as an interactive timeline.

There's no hosted backend, no database server, and no stored credentials. It
authenticates by shelling out to your already-logged-in `gh` CLI, syncs activity
into a local SQLite file, and serves the dashboard from a single local process.

> **Renamed.** This package used to be `pierre-review`. The command is now `limn`
> (the `pierre-review` package now only forwards to this one, and says so). On first start, an existing
> `~/.pierre-review` is moved to `~/.limn` — your database, settings and clones
> come with it. If `~/.limn` already exists, nothing is moved.

## Quick start

```bash
npx limn-review
```

This starts the server, prints a local URL, and opens your browser to it.

Or install globally and use the short command:

```bash
npm install -g limn-review
limn
```

## Review and fix with Claude — free, on your own Claude

Claude Review (a code review of any PR, follow-ups, a check against a user
story you paste, and a chat about the review) and AI Fix are free. They run on
your own Claude Code or Anthropic API key: sign in to Claude Code, or set
`ANTHROPIC_API_KEY`. Limn stores no key and charges nothing for it.

- **First use downloads the AI runtime, once (about 110 MB).** Press
  **Set up AI** in the app, or run `limn ai install`. It goes to
  `~/.limn/ai-runtime`, at the exact versions this release was tested with. The
  package itself stays small for everyone who never uses AI.
- Set `LIMN_CLAUDE_PATH` to the `claude` you already have to use it instead of
  the bundled copy (the download then skips it).
- The reviewer reads code. It cannot edit files, run commands or reach the web.
- The fixer edits files. It has no shell, and builds and tests nothing.
- Nothing is posted or pushed until you press the button.
- `LIMN_AI_DISABLED=true` turns every AI feature off.

## Prerequisites

- **Node.js ≥ 20** (with npm).
- **GitHub CLI**, installed and authenticated. Install it from
  <https://cli.github.com>, then run:

  ```bash
  gh auth login
  ```

  `limn` reads your team's activity using your `gh` token. It pre-checks this on
  startup and exits with a friendly message if `gh` is missing or not authed.

> **Native module note:** `limn-review` depends on `better-sqlite3`, a native
> addon. npm installs a prebuilt binary for common platforms; if none matches your
> Node/OS/arch, npm compiles it from source on install (needs a C++ toolchain —
> Xcode Command Line Tools on macOS, `build-essential` + Python on Linux, MSVC
> build tools on Windows).

## Usage

```
limn [options]
limn status [options]
limn ai install
```

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--no-open` | `NO_OPEN` | — | Don't open the browser on start. |
| `--port <n>` | `PORT` | `4000` | Port to listen on. |
| `--db <path>` | `DATABASE_URL` | `~/.limn/pierre-review.sqlite` | SQLite DB path. |
| — | `LIMN_DATA_DIR` | `~/.limn` | Where Limn keeps its data. |
| — | `PERSIST_BODIES` | `false` | Store full comment/PR text in the DB instead of loading it on demand (larger DB, but PR detail works fully offline). |
| `-h`, `--help` | — | — | Show usage. |

Examples:

```bash
limn --port 4123 --no-open
limn --db /tmp/limn.sqlite
```

## Data directory

Everything Limn keeps lives in `~/.limn`:

```
~/.limn/pierre-review.sqlite   the database
~/.limn/clones/                git clones Claude Review and AI Fix read
~/.limn/ai-runtime/            the AI runtime, once you set AI up
```

The directory is created automatically. Override it with `LIMN_DATA_DIR`, or
just the database with `--db` / `DATABASE_URL`. No team activity data or
credentials are ever sent anywhere — everything stays on your machine.

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

To keep the database small and backfills fast, bulky text — PR/comment/review
bodies and diff hunks — isn't stored; it's fetched from GitHub (using your `gh`
token) the first time you open a PR and cached in your browser, so re-opening an
unchanged PR is instant and offline. Set `PERSIST_BODIES=true` to store that text
locally instead — a larger database, but PR detail then works fully offline.

## License

Source-available under the **Functional Source License (FSL-1.1-MIT)** — see
[LICENSE](./LICENSE). You may use, self-host, and modify Limn freely; you may
**not** offer it as a competing commercial or hosted product. Each release
automatically converts to the **MIT License** two years after its publication.
The AI runtime Limn downloads on first use is Anthropic's, under Anthropic's own
terms; it is not part of this package.

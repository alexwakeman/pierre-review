# pierre-review

A **local-only dashboard for tracking your team's GitHub PR activity** across
multiple repositories. Run it on your machine, see at a glance who's doing what,
which PRs are stalled, which review threads are sitting untouched, and what needs
_your_ attention right now — all rendered as an interactive timeline.

There's no hosted backend, no database server, and no stored credentials. It
authenticates by shelling out to your already-logged-in `gh` CLI, syncs activity
into a local SQLite file, and serves the dashboard from a single local process.

## Quick start

```bash
npx pierre-review
```

This starts the server, prints a local URL, and opens your browser to it.

Or install globally and use the short command:

```bash
npm install -g pierre-review
pierre
```

## Prerequisites

- **Node.js ≥ 20.**
- **GitHub CLI**, installed and authenticated. Install it from
  <https://cli.github.com>, then run:

  ```bash
  gh auth login
  ```

  `pierre` reads your team's activity using your `gh` token. It pre-checks this on
  startup and exits with a friendly message if `gh` is missing or not authed.

> **Native module note:** `pierre-review` depends on `better-sqlite3`, a native
> addon. npm installs a prebuilt binary for common platforms; if none matches your
> Node/OS/arch, npm compiles it from source on install (needs a C++ toolchain —
> Xcode Command Line Tools on macOS, `build-essential` + Python on Linux, MSVC
> build tools on Windows).

## Usage

```
pierre [options]
pierre-review [options]
```

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--no-open` | `NO_OPEN` | — | Don't open the browser on start. |
| `--port <n>` | `PORT` | `4000` | Port to listen on. |
| `--db <path>` | `DATABASE_URL` | `~/.pierre-review/pierre-review.sqlite` | SQLite DB path. |
| `-h`, `--help` | — | — | Show usage. |

Examples:

```bash
pierre --port 4123 --no-open
pierre --db /tmp/pierre.sqlite
```

## Data directory

By default the local SQLite database lives at:

```
~/.pierre-review/pierre-review.sqlite
```

The directory is created automatically. Override the location with `--db` or the
`DATABASE_URL` environment variable. No team activity data or credentials are ever
sent anywhere — everything stays on your machine.

## How it works

Once running, open the printed URL (default <http://localhost:4000>). Add the
repositories you want to watch from the in-app picker; the app syncs their PR
activity (full backfill on first sync, incremental every few minutes thereafter)
into your local DB and renders it as a timeline.

## License

MIT

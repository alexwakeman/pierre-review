# Frontend e2e / perf checks

Lightweight, **local** browser-driven checks that drive the real app via Playwright
+ the system Google Chrome. They are diagnostics/regression guards, not a CI gate
— they need the dev server running against your synced SQLite data.

## Setup

`playwright-core` downloads no browsers (it drives system Chrome), so the install
is fast and can live in a throwaway dir:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright-core
```

Then point the check at that install via `PW_CORE_DIR` and run it from the repo
root (with `pnpm dev` already running):

```sh
PW_CORE_DIR=/tmp/pw node apps/frontend/e2e/cluster-back-nav.mjs
```

(If you instead add `playwright-core` as a dev dependency, drop `PW_CORE_DIR` —
the script resolves it relative to its own location.)

On a non-mac machine, or if Chrome lives elsewhere, set `CHROME=/path/to/chrome`.

## cluster-back-nav.mjs

Reproduces and guards the timeline cluster-popover **back-navigation** perf bug:
open a cross-user cluster → pick a comment (collapses the board to a two-person
focus) → press "‹ back". Before the fix this froze the main thread for ~1.9s on a
large board; the script measures the worst `longtask` during the back press and
fails if it exceeds `THRESHOLD_MS`.

Env: `URL` (default `http://localhost:5173/?preset=90d&repos=1`), `CHROME`,
`HEADED=1` (watch it run), `THRESHOLD_MS` (default 600).

> Needs a board with at least one cross-user cluster in view. If the script
> reports none, point `URL` at a busier repo/zoom, e.g. `?preset=90d&repos=<id>`.

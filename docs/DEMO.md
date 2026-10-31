# The static demo (`/demo/` on the website)

> The website hosts a frontend-only demo of Limn at `https://limn-review.com/demo/`. It is the
> REAL SPA, built from a second entry, with every `/api/*` request answered in the browser from a
> recording of sample (Acme) data. Nothing is sent anywhere and there is no backend behind it; a
> reload starts from the recording again. The runtime's own reference — the recording format, the
> matching order, the time rebase, simulated writes and agentic runs — is
> **[`apps/frontend/src/demo/README.md`](../apps/frontend/src/demo/README.md)**. This page is the
> pipeline around it. Client-side landmines: [FRONTEND.md](FRONTEND.md) § The static demo runtime.

## The pipeline, end to end

```
seed (pnpm demo)  →  record  →  apps/frontend/src/demo/data/recording.json
                                         │
              pnpm --filter @pierre-review/frontend build:demo  →  apps/frontend/dist-demo/ (base /demo/)
                                         │
              apps/site serves it at /demo/  ←  Dockerfile + deploy-site.yml → Railway
```

### 1. Seed — fictional `acme/*` data in an isolated stack

`pnpm demo` (`scripts/demo-stack.mjs`) seeds `/tmp/pierre-demo.sqlite` with the fictional Acme
workspace and boots an ISOLATED stack — backend `:4100`, frontend `:5273` — that never touches
the real dev servers or database. ⚠ The backend runs with `gh` OFF the PATH (a shim directory
holding only `node`): `ensureLocalAccount()` would otherwise overwrite the seeded "Morgan Diaz"
account with your own GitHub identity and empty My Turn. `--no-seed` reuses the existing demo DB.
The same stack feeds the landing screenshots (`pnpm shots`) and the walkthrough video
(`pnpm demo:video`).

### 2. Record — capture what the SPA asks for

A recording is a JSON file of `{ method, path, status, body | stream }` entries plus
`capturedAt` (`DemoRecording`, `src/demo/recording.ts`). The recorder runs against the seeded
stack and must write EXACTLY the format the README specifies:

- `path` is the pathname plus the query with its parameters **sorted**; time-window parameters
  and ISO / epoch-ms values are dropped before matching on both sides, so they may stay in.
- `stream` replaces `body` for an SSE response — one object per `data:` frame with its `delayMs`.
- The batched read POSTs (`/api/claude-review/states`, `/api/ticket-links`,
  `/api/reactions/lookup`, …) are recorded ONCE per path, covering every id the demo shows.
- ⚠ **At least one FINISHED run per agentic kind** must be in it — a succeeded Claude review, AI
  Fix, ticket review, CI review, Check threads run and docs check — because a "start" in the demo
  replays a recorded finished run of the same kind. Without one, that start answers "Not
  available in the demo."
- Record the DEFAULT workspace first: the pathname-only fallback serves the first entry recorded
  for a path.

The recorder is `pnpm demo:record` (`scripts/record-demo.mjs`, the walk in
`scripts/record-demo-steps.mjs`); its isolation rules and how it answers the live GitHub reads are in
the runtime README § The real recording. It writes TWO files: `data/recording.json` (one entry per
line, so a re-record's diff names the answers that changed) and `data/recording-steps.json`, the
STEPS INDEX — which steps recorded each answer, and how long each step took. Commit both together;
the index is never shipped (the demo build reads only `recording.json`).

#### Fast: several pages, a production build

A full record runs every step on six browser pages at once (`--concurrency=<n>`; `1` is the old
serial walk) against three backend processes reading the same scratch database (`--backends=<n>`),
and serves a PRODUCTION build of the SPA (`vite build` + `vite preview`, cached by a hash of its
sources; `--dev` uses the Vite dev server). Quiet windows are halved (`--settle-scale=0.5`), which is
safe because `settle()` waits for two things: no request to the SPA's own origin in flight (lazy
chunks included) for the window, AND the page's main thread idle without asking for more — on a busy
machine, rendering a big answer outlasts any fixed window. A virtualised list is walked one screen at a
time (`h.scrollThrough()`, the Feed), so the same rows, and their threads, are fetched on every run.

- ⚠ **The output does not depend on the concurrency.** Each step records into its own bucket; an
  answer belongs to the FIRST step in declared order that recorded it, and entries are sorted by
  (that step, method + normalised path). The default workspace's steps come first, so its answers
  still win the demo's query-less fallback.
- ⚠ **Every step starts from a clean browser** (storage and IndexedDB cleared): a step must not
  depend on what an earlier step left behind, and it records every answer its view needs by itself.
- ⚠ **Nothing a step does may change what another step reads.** The writes the SPA makes on its own
  (`mark-viewed` when a PR opens, the Feed's `mark-seen`) are answered in the browser
  (`STUBBED_WRITES`), the way the demo answers them; the backend never sees them, so every view reads
  the SEEDED "viewed" state. A step that must write sets `mutates: true` and runs alone, in its
  declared place. The recorder lists any other write a step sent.
- `timeline:open-details` is one step per PR (`expand`), so the pages share the ~200 PR overviews.

Ports: `--api-port` / `--web-port` (default 4310 / 5383); lane *i* uses `+i` on both.

#### Incremental: re-record only what a change touches

```sh
pnpm demo:record --only=pr:113,docs        # these steps (a plain name takes its `name:…` children; `*` globs)
pnpm demo:record --changed                 # the steps the working tree's changes touch
pnpm demo:record --changed=main            # …the branch's changes since main, too
```

The chosen steps are re-recorded and MERGED into the existing recording: their fresh answers replace
the old ones, answers only they had recorded and no longer see are dropped, everything else is kept.
⚠ **It runs as of the old recording's `capturedAt`**: the seeder, the backend and the browser have
their clocks moved back (`scripts/lib/demo-clock.mjs`), so the new answers carry the same sprint keys,
ages and windows as the answers around them. ⚠ The clock starts a MINUTE BEFORE `capturedAt`
(`INCREMENTAL_SEED_LEAD_MS`): a full record stamps `capturedAt` after seeding, so seeded rows must be
older than it — a row newer than the demo's "now" (a docs check created after the click) read as
stale and broke `ticket:PLAT-301:docs-reuse`. (A column whose default is SQLite's `unixepoch()` still
reads the real clock.) `--only` needs `recording-steps.json` from the same record; without it, run a
full record first.

`--changed` maps each changed file (`scripts/lib/demo-changes.mjs`, the tables at the end of
`record-demo-steps.mjs`):

| Changed | Re-records |
|---|---|
| the seed, the schema, migrations, `packages/shared`, the SPA's data layer (`api/`, `hooks/`, `store/`, `lib/`, `App.tsx`), the recorder | EVERYTHING (a full record) |
| a backend file the demo seeder imports | everything |
| any other backend file | for each answer on a route that imports it (walking imports up to the route file), the FIRST step that recorded it |
| a frontend component | the steps of its `COVERAGE` row AND of every row naming a file that imports it, walked up to the files that mount views (a shared component re-records every view it renders in); a component in no row, or one the shell (top bar, sidebar) renders through files no row names → everything |
| tests, docs, the website, the demo replayer | nothing |

⚠ A backend change that makes a view ASK for something new (a longer list whose new rows the SPA
then fetches) is not found by the import walk — run a full record for that.

`node scripts/lib/compare-recordings.mjs a.json b.json [--order]` compares two recordings modulo
time (answer set, statuses, bodies; `--order` the entry order too).

### 3. Rebase — recorded time moves to now

On load, every recorded body is shifted by `Date.now() − capturedAt`, once, on first use: full
ISO-8601 timestamps, and numbers under keys ending in `At` / `Ms` within ±3 years of `capturedAt`.
Durations and date-only strings (`2026-10-20`, `sprint-2026-10-06`) do NOT move — the SPA sends the
period keys back in request paths, where they must still match the recording.

### 4. Build — `build:demo`

```sh
pnpm --filter @pierre-review/frontend build:demo   # → apps/frontend/dist-demo/, base /demo/
pnpm --filter @pierre-review/frontend dev:demo     # the same, on the Vite dev server
```

`vite build --mode demo` swaps `index.html`'s entry to `src/demo/entry.ts` (wrap `fetch`, clear the
persisted query cache, mount the notice bar "Demo: sample data, nothing is sent.", then load the
app). ⚠ The normal `pnpm build` is byte-for-byte unchanged — nothing outside `src/demo/` imports
from it — and the npm release (`pnpm package`) never contains the demo.

### 5. Serve — `apps/site` at `/demo/`

The site service ([RELEASE.md](RELEASE.md) § The website) serves `dist-demo` at `/demo/` with an
SPA fallback (paths without a file extension get its `index.html`), `/demo` → 301 `/demo/`, and a
short "coming soon" page when no demo build is present. Its demo CSP is strict (`script-src
'self'`, no `eval`), which the demo build is written to satisfy. Locally:

```sh
pnpm --filter @pierre-review/site dev   # serves DEMO_DIR (default ../frontend/dist-demo) at /demo/
```

The root `Dockerfile` runs `build:demo` (`--if-present`) after the landing build and copies
`dist-demo` into the image; `.github/workflows/deploy-site.yml` rebuilds and redeploys on pushes to
`main` that touch `apps/frontend/**` among others.

## Keeping it current

The demo runs the current SPA code, so a change that only touches the UI reaches it on the next deploy
with nothing to do. The DATA is the committed `recording.json`, so any change to what the SPA reads needs
a re-record **in the same commit**:

| Change | What to do |
|---|---|
| New view, tab, drawer or popover that fetches | add a step to `scripts/record-demo-steps.mjs` and a row to `VIEWS` in `scripts/verify-demo.mjs` |
| New feature, or one with no rows in the demo | seed it in `apps/backend/scripts/seed-demo*.ts` (fictional Acme data only; model output written as stored rows, never a live call) |
| New route, new field, or a changed response shape | re-record so the stored answers have the new shape |
| New write (a button that changes something) | simulate it in `apps/frontend/src/demo/routes.ts` (or `runs.ts` for an agentic run) so it does not answer "Not available in the demo" |

Then: `pnpm demo:record` (or `--changed` / `--only=…`, above) → `pnpm --filter @pierre-review/frontend build:demo`
→ `pnpm demo:verify` and `node scripts/verify-demo.mjs --later=40` → commit
`apps/frontend/src/demo/data/recording.json` and `recording-steps.json`. `verify-demo` opens its views
on four pages at once, each in a fresh browser context (`--concurrency=<n>`, `--port=<p>`,
`--shots=<dir>` so two runs do not share screenshots), and takes `--only=<names>` (comma list;
substrings or `*` globs; matching no view is a failure).
`pnpm demo:verify:phone` (`--phone`) runs the same views and actions at 390 × 844 on a touch screen
(screenshots in `/tmp/limn-demo-shots-390`); an `act` that differs on a phone branches on `PHONE`
(Settings is reached through the drawer; a phone's Settings tab carries its summary line; Docs
opens a document in Read, its row facts are back on Library). It is not in CI yet.
A `VIEWS` row may carry `{ act, expect }`: a click the view hides behind (Settings has no URL) and
text the page must then show (the run list and both providers' labels on #105 after picking Codex's model, "Default: Codex." after the switch).

**What guards it.** PR CI (`ci.yml`, on any PR that touches the frontend, the site, `packages/shared`, the
demo scripts, a manifest or a workflow — docs/TESTING.md) and the site deploy (`deploy-site.yml`, which will
not push the image on a failure) both run `verify-demo`: every listed view must load with no page error, no blank page and no
request the recording cannot answer. It cannot see a view missing from `VIEWS`, or a stored answer whose
SHAPE is stale but still renders. The re-record is the author's job.

## What the demo simulates

- **Writes** — merge, approve / request changes / withdraw, reply, resolve, comments, auto-merge
  arm and disarm, workspace edits and every settings PUT — land in an in-memory overlay
  (`overlay.ts`) and are read back for the rest of the session.
- **Agentic runs** play a recorded finished run of the same kind over a few seconds with a
  simulated progress stream (`runs.ts`, `sse.ts`).
- **Questions** (the review chat, the docs chat, This Sprint's "Ask") answer with one plain line
  saying the active provider is not connected in the demo.
- **Settings → AI** (Auto / Claude / Codex) and the Codex sign-in are simulated (`provider.ts`),
  starting at Auto = Claude; the AI spend reading (`aiBudget.ts`) and every run started afterwards
  follow the choice. The stored runs are a seeded mix of Claude and Codex, each labelled by what ran;
  #105 holds a Claude Opus and a Codex GPT-6.1 Sol review of the same head, both at effort High.
- **Settings → AI → Effort** is simulated too (`provider.ts`, PUT `/api/ai/effort`): a review or AI
  Fix started afterwards stores the level (Default: Claude medium, Codex by depth), and its label
  says it ("Claude Opus 5.5 · high"). Seeded runs carry the effort they were seeded with.
- **Anything it cannot fake** (adding a repository, syncing, …) answers "Not available in the
  demo." in the SPA's own error shape; an unrecorded GET is `404 NotInDemo`, an unrecorded write
  `409`, a DELETE `204`.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### The static demo

- **The static demo** (`apps/frontend/src/demo/`, `build:demo` → `dist-demo/`, base `/demo/`) is
  the real SPA with `window.fetch` wrapped: every `/api/*` answered in the browser from a
  RECORDING (Acme data, timestamps rebased to now), writes simulated in an in-memory overlay,
  agentic runs replayed from a recorded finished run of the same kind. ⚠ A normal `vite build`
  must stay byte-for-byte free of it (separate entry, `--mode demo` only), and it must hold the
  site's CSP (no inline script, no eval). `data/recording.json` replaces the sample when present.
  Format and matching rules: [apps/frontend/src/demo/README.md](../apps/frontend/src/demo/README.md).

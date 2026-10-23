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

⚠ **No recorder is checked in yet.** Until `data/recording.json` exists, the build uses
`data/sample-recording.json`, generated from the typed e2e fixtures plus one hand-written finished
Claude review:

```sh
./apps/backend/node_modules/.bin/tsx apps/frontend/src/demo/tools/make-sample.ts
```

It boots to Activity → Open PRs (five PRs in `acme/web`), opens any of them, and replays a Claude
review. `window.__limnDemo.log` in the browser console lists every request the demo answered and
which stage answered it (`runs`, `route`, `recording:exact`, `recording:path`, `fallback`,
`missing`) — the quickest way to see what a recording lacks.

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

## What the demo simulates

- **Writes** — merge, approve / request changes / withdraw, reply, resolve, comments, auto-merge
  arm and disarm, workspace edits and every settings PUT — land in an in-memory overlay
  (`overlay.ts`) and are read back for the rest of the session.
- **Agentic runs** play a recorded finished run of the same kind over a few seconds with a
  simulated progress stream (`runs.ts`, `sse.ts`).
- **Questions to Claude** (the review chat, the docs chat, This Sprint's "Ask Claude") answer with
  one plain line saying Claude is not connected in the demo.
- **Anything it cannot fake** (adding a repository, syncing, …) answers "Not available in the
  demo." in the SPA's own error shape; an unrecorded GET is `404 NotInDemo`, an unrecorded write
  `409`, a DELETE `204`.

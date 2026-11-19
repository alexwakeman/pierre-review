# Packaging & publishing

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Packaging & publishing

Ships to npm as a **single unscoped package `ensemble-review`** (`npx ensemble-review`, or
`ensemble` global; both bins → `dist/cli.js`). ⚠ The DEPRECATED commands (`limn`, `limn-review`,
`pierre-review`, `pierre`) are the forwarding stubs' bins ONLY, never ensemble-review's: npm refuses
to link a global bin another package owns, so declaring one in the new package made `npm install -g`
fail with EEXIST for every old global install. Started through a stub, the CLI prints a one-line
rename notice. ⚠ The `ensemble-review` bin is LOAD-BEARING: with several bins, `npx` runs the one
named after the package and errors when none is, so `npx ensemble-review` needs it.
`build-release.mjs` asserts the bins are exactly `ensemble` + `ensemble-review`, and that each stub is
named, binned and forwarding as it should. Renamed `pierre-review` → `limn-review` (the release that
made Claude Review and AI Fix free) → `ensemble-review`; each old name gets a hand-published
forwarding stub (`scripts/deprecated-limn-review/`, `scripts/deprecated-pierre-review/`, each
README carries the manual `npm deprecate` step — see [RELEASE.md](RELEASE.md)). Tarball is **built artifacts only** (no
`.ts`/src/configs/tests). CI publishing (version computation, atomic tag+commit, idempotent
publish) is in **[RELEASE.md](RELEASE.md)** — **never run `npm publish`/`npm login`
from here**; let CI (or the user) do it.

**Single-process production.** One Fastify server serves the JSON API (`/api`) and the SPA
(`/app`). Static serving is gated on a sibling `public/index.html` (in the release, **absent in
the dev tree**, so `pnpm dev`'s Vite proxy is unchanged). All routing is the **single**
`setNotFoundHandler` (`api/plugins/error-handler.ts`): unknown `/api` → JSON 404; `/app*` → SPA;
`/` + anything else → 302 `/app/`. SPA built `base:'/app/'`. **The npm package ships the app
only** — the marketing site (landing, contact form) is a separate service,
`apps/site`, deployed on its own (below and [RELEASE.md](RELEASE.md) § The website).

**The landing is PRERENDERED at build time** (`apps/landing/prerender.mjs`, chained after
`vite build`) and served by `apps/site`, never by the backend. It used to be a pure CSR SPA:
every URL returned the same ~7.8 KB shell whose whole `<body>` was an empty `#root` + a splash
caret, so anything that doesn't execute JS — an AI agent, a link unfurler, a text browser, a
crawler on a render budget — saw a site with no content and no way to tell `/pricing` from
`/privacy`. Now a Vite **SSR build** of `src/entry-server.tsx` renders each route through
`renderToStaticMarkup` into `dist/<route>/index.html` (21–70 KB of real content), with that
route's own title/description/**canonical** baked in. Load-bearing details:
- **`src/lib/routes.ts` is the ONE source of truth** for per-route SEO copy — read by the
  pages' `useSeo()` (which now only matters for client-side hops) AND by the prerenderer, so
  the static head and the hydrated head cannot drift.
- **`index.html` carries `<!-- seo:start/end -->` + `<!-- app:start/end -->` markers**; the
  prerenderer replaces those regions and **throws if they're missing**. Deleting them silently
  reverts the whole site to a contentless shell.
- **`createRoot`, NOT `hydrateRoot`** — several components deliberately differ between the
  static and browser trees (`HeroWordmark` starts resolved so crawlers see the finished word,
  not the mid-animation one; `CookieBanner` renders nothing until it has read `localStorage`).
  A fresh client render reaches the same end state with no mismatch failure mode.
- **`router.setStaticPath()`** pins `currentPath()` per render — without it every route
  prerenders as the home page.
- The legacy routes (`/features`, `/how-it-works`, `/bots`, `/pro`, `/pricing`, `/insights`,
  `/reviews`) are ALIASES written by the prerenderer: each gets a copy of whichever page now
  carries its content, whose canonical already points there (⚠ `/pricing` goes to CONTACT —
  the licence path). It also writes `dist/404.html`, which `apps/site` answers unknown paths
  with.
- **Guardrails, because the failure is SILENT** (a broken prerender still looks perfect in a
  browser): `prerender.mjs` asserts every route in `PRERENDER_PATHS` plus a hard floor and a
  per-page byte floor. `deploy-site.yml` runs the landing build before it builds the image, so
  a broken prerender fails the deploy, not the live site.

**CLI** (`cli.ts` → `dist/cli.js`): the **`ensemble status` subcommand** (peeled off argv
BEFORE `parseArgs`, whose default case rejects bare tokens) renders the cross-repo My-Turn
queue in the terminal via `status.ts` — one section per type in the reader's order (Settings → My
Turn), with a dim footer naming the types switched off — OSC-8 clickable links (non-TTY falls back to
`label (url)`), `--watch` repaint loop (new-since-tick bullets), `--sync` (re-syncs ≤ every
5 min under watch), `--interval/--db`; refuses to create an
empty DB without `--sync`, one-shot `runMigrations → ensureLocalAccount → getMyTurn →
closeDb` lifecycle, env mapped before any config/db import. The server path parses
`--no-open/--port/--db` (+ env),
maps them to env **before** importing config, sets `NODE_ENV=production`. It first moves a
pre-rename `~/.limn` (or `~/.pierre-review`) to `~/.ensemble` (below), then defaults the DB to
`~/.ensemble/pierre-review.sqlite` (never the read-only install dir; the FILE keeps its old name so the
move carries it and its WAL files untouched) + pre-checks `gh auth token`. Prints the banner + URL, boots via `start()` (guarded run-as-main), opens the
browser (built-in, no dep) unless `--no-open`. **`ensemble ai install` / `ensemble ai status`** run the
same AI-runtime download the app starts by itself on the first boot (below); refused under
`ENSEMBLE_AI_DISABLED=true`. `ensemble ai install codex` adds the Codex CLI; **`ensemble ai login codex`**
(`--device-auth` on a headless machine) / **`ensemble ai logout codex`** sign the app's own Codex home in
and out (§ The Codex CLI). **`ensemble ai clean-sessions`** (`--dry-run` lists first) deletes the
`~/.claude/projects` folders older runs left (the same one-off cleanup the boot runs once;
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § The provider seam). **`ensemble ml install`** downloads the bot-comment severity model
([ML-SEVERITY.md](ML-SEVERITY.md)).

**User-set environment variables are `ENSEMBLE_X`; the older `LIMN_X` is still read** (`env-name.ts`
`readEnv(env, 'X')`: ENSEMBLE_X when set and not blank, else LIMN_X). Every user-set read goes through
it; test-only variables and the ones the backend passes to its own children (`LIMN_PROXY`,
`LIMN_CODEX_GUARD`, `LIMN_ML_SCORER_INIT` …) keep their one name. `vitest.config.ts` blanks every
`ENSEMBLE_` user name (`USER_ENV_NAMES`), so a shell setting never overrides a test's `LIMN_` one.

**The data directory is `~/.ensemble`** (`data-dir.ts`; `ENSEMBLE_DATA_DIR` overrides; `config.dataDir`).
It holds the CLI's DB, the clone cache (`CLONE_DIR` overrides), `config.json` (the per-review
budget), `ai-runtime/` and `codex/` (the app's own Codex home: its sign-in, `config.toml` and run
records; never the reader's `~/.codex`), and `docs/` — the reference-docs libraries, ONE ROOT PER
DATABASE (`ENSEMBLE_DOCS_DIR` overrides): the CLI's own DB uses `docs/` itself, any other DB (`pnpm dev`,
a worktree, `--db`) `docs/db-<hash of its path>/`, and every workspace folder carries an `.owner`
marker the janitor checks ([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Ownership). ⚠ The clone cache
is still SHARED by every backend on the machine (`pnpm dev` and the CLI both default to `clones/`);
it holds no data a database owns, but a second process's boot sweep drops every
`refs/pierre/conflict/*` and so breaks a resolver session open in the first. ⚠ **The move from the NEWEST old directory (`~/.limn`, else `~/.pierre-review`) is ONE
`renameSync`, and it NEVER CLOBBERS**: run by the CLI before it picks the DB path and again (a no-op
by then) at the top of `start()` for `pnpm dev`. An existing `~/.ensemble` means nothing moves and the
old directory is left as it is; an explicit `ENSEMBLE_DATA_DIR` / `LIMN_DATA_DIR` is never migrated
into. Until the move happens (a pinned `DATABASE_URL`/`CLONE_DIR` inside the old directory, a failed
rename) the old directory IS the data directory. No copy-then-delete exists, on
purpose — a half-copied SQLite file beside a deleted original is the failure it avoids.
`data-dir.test.ts` pins every case over a temp home, from both old directories.

**Two load-bearing traps:**
- **`@pierre-review/shared` is NOT a published dep, and is NOT types-only** — the conflict
  resolver's `foldFile`/`foldToText`/`CONFLICT_MODEL_VERSION` are real code the SPA and the
  server's land path must agree on to the byte. `build-release.mjs` compiles the package,
  VENDORS it at `release/dist/shared` and rewrites every emitted `@pierre-review/shared`
  specifier to a relative path; the guardrail fails on a specifier the rewrite MISSED. Never add
  the package to the curated manifest, and never fork a shared fold to dodge this.
- **pnpm is pinned** (`packageManager: pnpm@9.15.9`) so CI, the site's `Dockerfile`, and
  local dev match; a newer pnpm blocks native builds (`ERR_PNPM_IGNORED_BUILDS` on
  `better-sqlite3`/`esbuild` — also in `pnpm.onlyBuiltDependencies`). Bumping = regenerate
  `pnpm-lock.yaml`.

**`pnpm package`** (`scripts/build-release.mjs`) assembles `./release/`: builds
frontend (`/app`) + backend + shared, copies compiled JS + the core migration folder + SPA →
`public/`, vendors shared at `dist/shared`, copies the platform's `migrations` and `data`
(the bundled peer-benchmark corpus) to `dist/platform/` beside the compiled modules that read
them, and generates `package.json` (curated deps: `@fastify/cors`, `@fastify/static`,
`@octokit/graphql`, `better-sqlite3`, `drizzle-orm`, `fastify`, `node-cron` …; **no AI SDK** (`@anthropic-ai/*`, `@modelcontextprotocol/sdk`,
`zod`) and no model runtime). Sanity asserts fail on a missing key file (including
`dist/platform/index.js`, its first migration and `benchmark-fit.json` — ⚠ a missing `data`
copy fails ONLY in the release: dev reads it from `src/` and looks perfect, while the package
answers the benchmark with `available:false`), a leaked `.ts`, an un-rewritten shared
specifier, **any AI SDK in `dependencies` / `optionalDependencies` / `peerDependencies`**, a
missing or inexact AI-runtime pin, or **an AI SDK specifier in any emitted JS file other than
`dist/ai/runtime.js`**. `better-sqlite3` is a native runtime dep: ⚠ keep it ≥ 13 (N-API, binaries INSIDE the package, no install script). 11.x had no Node 24 prebuild and relied on an install script; under npx that left no binary ("Could not locate the bindings file").

### The client subcommands: `ensemble review` and `ensemble mcp` (2026-11-19)

`dist/cli.js` also answers `ensemble review [options]` and `ensemble mcp` (docs/CLAUDE-REVIEW.md § Reviewing a
local branch). Both are CLIENTS of the running Ensemble: they never boot a server, never move the data
directory and print no banner (⚠ `mcp`'s stdout IS the JSON-RPC stream). They are peeled off in `main()` before
the server's own argument parser, like `status` / `ai` / `ml` / `sandbox`. Users add the MCP server with
`claude mcp add ensemble -- npx ensemble-review mcp` (Codex: an `[mcp_servers.ensemble]` entry running
`npx ensemble-review mcp`).

⚠ **`build-release.mjs` asserts the client loads NO AI package**: it walks every import of
`dist/local-review/mcp-server.js` and `dist/local-review/cli-review.js` (after the shared rewrite) and fails on
anything but a `node:` built-in or a relative file — the MCP server is hand-rolled, never
`@modelcontextprotocol/sdk` — then RUNS `node dist/cli.js mcp` from the release tree against an empty data
directory: initialize, tools/list (the five tools) and a tool call that must answer "Ensemble is not running."

### No AI SDK in the manifest; downloaded on the first boot

Every model-backed feature (Claude Review, AI Fix, the reports and narration, …) ships in
the package **as code** and runs on the user's own Claude Code login or `ANTHROPIC_API_KEY` —
the ONE credential ladder in `ai/credentials.ts` ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § The
credential ladder). The four SDKs they run on —
`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` — are
NOT dependencies: the Agent SDK carries a native `claude` binary, ~110 MB to download and ~240 MB
unpacked per platform, against a ~18 MB package. `optionalDependencies` is no escape (npm installs
them by default, and a dependent package cannot switch off its dependency's platform binary under
`npx`). So:

- **The pins ride the manifest as a NON-dependency field, `limnAiRuntime`**, GENERATED by
  `build-release.mjs` from what `apps/backend/node_modules` actually holds (what the tests ran
  against), each asserted EXACT and asserted to satisfy the range `apps/backend/package.json`
  declares. ⚠ The field name is spelled twice — the script and `AI_RUNTIME_MANIFEST_FIELD` in
  `ai/runtime.ts` — and the script fails if they diverge.
- **Claude and Codex are INCLUDED BY DEFAULT — no click** (`ai/auto-install.ts`). After `listen`
  (never before, never awaited — it cannot slow the boot), a boot that finds either runtime not
  `ready` (absent, stale, no native program) downloads what is missing (`['claude', 'codex']`;
  `['claude']` when only Claude is; ⚠ `['codex']` ALONE over a ready Claude, which `runCodexOnly`
  stages apart and moves in WITHOUT re-downloading or swapping Claude's packages under a live run). `MeResponse.ai.autoInstall` says it is on; while it runs,
  `runtime: 'installing'` with the current STEP in `runtimeMessage` (the app's own words, never npm's
  lines — `currentStep` in `ai/runtime.ts`), polled by the SPA where "Set up AI" used to be. A failure
  is retried ONCE automatically (3 min later), then left to the SPA's Retry (which re-POSTs with
  `provider: 'codex'`, i.e. both), `ensemble ai install codex` or the next boot — never a loop. Skipped
  under `ENSEMBLE_AI_DISABLED=true` and `ENSEMBLE_AI_AUTO_INSTALL=false` (the demo and recording stacks set
  the latter: a download would turn `/api/me` into 'installing' mid-shot). Signing in to each
  provider is then the only step.
- **The download** (`installAiRuntime`): the automatic one above, the SPA's Retry / Set up (where
  the automatic one is off) → `POST /api/ai/runtime/install` (SSE progress; registered only when
  `config.aiEnabled`; `sync` rate-limit tier), or `ensemble ai install [codex]`. It writes a `package.json`
  carrying the pins into a STAGING dir and runs `npm install --prefix <staging> --ignore-scripts
  --no-package-lock` — npm's own `npm-cli.js` under `process.execPath`, `shell: false`, no string
  interpolation (pins are regex-checked exact versions) — verifies every package landed at its pin,
  then swaps it in at `<dataDir>/ai-runtime` (old one moved aside first, so a failure leaves one
  whole runtime, never half of two). Single-flight (a second POST joins), 10-minute timeout, and a
  plain failure sentence naming `ensemble ai install`. `ENSEMBLE_CLAUDE_PATH` adds `--omit=optional`
  (skips the bundled binary) and is passed to the SDK as `pathToClaudeCodeExecutable` — opt-in
  only, because the bundled binary is version-locked to the SDK and the user's `claude` may not be.
- **The loader, `apps/backend/src/ai/runtime.ts`, is the ONE module that imports an AI SDK.**
  Every other file (`review/agent.ts`, `review/chat-agent.ts`, `coding/agent.ts`, `review/llm.ts`,
  both `schema.ts`) calls `loadAgentSdk()` / `loadAnthropicSdk()` / `loadZod()`; type-only imports
  are fine (erased at emit). ⚠ It locates a package the way ESM does (walk `<dir>/node_modules`,
  NOT `createRequire().resolve.paths()`, which adds NODE_PATH + global folders ESM ignores), and
  picks the entry with the ESM conditions (`node`/`import`/`default`), NEVER `require.resolve`:
  zod's `require` entry is `index.cjs`, and a CJS zod is a SECOND zod instance beside the one the
  SDK imports, which silently breaks tool-schema conversion. `runtime.test.ts` pins the identity.
  Both `schema.ts` files therefore BUILD their shapes from a zod handed in
  (`buildSubmitReviewShape(z)`), and `submitReviewShape()` is async.
- **Dev is unchanged**: when the workspace's own `node_modules` resolve the Agent SDK + zod
  (`pnpm dev`, the test suite) the loader imports by plain bare specifier, first, and a package
missing from one source falls through to the other (the `<dataDir>/ai-runtime` install).
- **Status** (`getAiRuntimeStatus()` → `MeResponse.ai.runtime`): `ready` | `absent` | `installing` |
  `failed` (+ `runtimeMessage`). A runtime installed at OTHER versions (an upgrade moved the pins)
  reads `absent` with "Set up AI again", but still loads until replaced.
- The SDKs are Anthropic's, under Anthropic's terms — installed from npm on the user's machine,
  never vendored into our tarball (that would be redistribution).
- **The reference-docs converters ride the same download** — `mammoth` (Word → HTML), `turndown` and
  `turndown-plugin-gfm` (HTML → markdown with tables): small, pure JS, used ONLY by the agentic docs
  library ([REFERENCE-DOCS.md](REFERENCE-DOCS.md)). They are in `AI_RUNTIME_PACKAGES` (both spellings:
  `ai/runtime.ts` and `build-release.mjs`), declared in `apps/backend/package.json` so the pins are
  generated like the SDKs', forbidden in the manifest's dependency fields, and value-imported ONLY by
  `ai/runtime.ts` (`loadMammoth` / `loadTurndown` / `loadTurndownGfm` — the dist grep covers them). ⚠ A
  runtime installed BEFORE them is **stale, not absent** (`AI_RUNTIME_LATER_PACKAGES`): every agent
  still loads, the status says "Set up AI again", and only a Word or web-page build refuses until then.

### The sandbox image (never in the package)

The Implement sandbox's image (docs/SANDBOX.md § The image) is pulled from GHCR or built locally; the
package carries only what that needs:

- **`release/dist/sandbox-image/`** (`Dockerfile`, `limn-svc`, `limn-svcd.cjs`), the whole folder
  copied by `build-release.mjs` (step 6d; `mustExist` names all three): the local-build fallback, read by
  `dist/sandbox/runtime/image.js`. The recipe hashes every file in the folder, so a change to `limn-svc`
  rebuilds the image.
- **`limnSandboxImage`**, a NON-dependency manifest field: `{recipe, buildArgs}` always, plus
  `{repository, tag, digest}` when CI pushed the image for this release (docs/RELEASE.md § The sandbox
  image). The recipe is computed by the compiled `image.js`, never a copy of its formula, and checked
  against the shipped Dockerfile.
- **`dist/sandbox/proxy/server.js`** — the egress proxy's whole program, run in the proxy container with
  `node -e` (and, on microsandbox, as a host child process on unix sockets). `build-release.mjs` loads it
  through `dist/sandbox/proxy/source.js`, which refuses any import that is not a `node:` built-in.
- **No container runtime is installed or bundled.** The reader brings Docker, Colima, Podman or
  microsandbox (docs/SANDBOX.md § Setting up a runtime); the app drives their CLI and adds no npm
  dependency for it. `ensemble sandbox prune [--dry-run] [--store]` (`src/cli.ts`) removes leftovers (`--store`: also the kept repo store).

### The Codex CLI (downloaded with Claude's packages)

Codex is the second AI provider ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Codex, the second
provider). The app runs the Codex CLI's native program; it never imports a Codex package.

- **The pin**: `@openai/codex` **0.164.0**, DECLARED exact in `apps/backend/package.json`'s own
  `limnAiRuntime` field. The CLI is not a workspace dependency (its native program is about 360 MB
  unpacked per platform), so `build-release.mjs` COPIES the declared pin into the release manifest
  rather than reading `node_modules`, and `ai/runtime.ts` reads the same field in dev. The models
  (`CODEX_MODEL_FOR_ROLE`) are pinned for this version: re-check them, and the spike's checks, on
  every bump.
- **Downloaded on the first boot with Claude's packages** (the automatic download above), into the
  same `~/.ensemble/ai-runtime`; by hand, `ensemble ai install codex` or the SPA's Retry
  (`POST /api/ai/runtime/install {provider: 'codex'}`: Codex only when Claude is ready, else both). A
  plain `ensemble ai install` stays Claude-only. npm brings the
  platform package (`@openai/codex-<platform>`); `codexBinaryIn` finds the native program the way
  the package's own `bin/codex.js` does. ⚠ Codex is STAGED APART from Claude's packages: a Codex
  failure is recorded as Codex's alone and never fails Claude's install, and a Claude-only "Set up
  AI" carries an existing Codex over (moved, not downloaded again) and never removes it.
- **Status** (`getCodexRuntimeStatus()` → `MeResponse.ai.providers.codex.runtime`): `ready` |
  `absent` | `installing` | `failed`. A Codex at another version (an upgrade moved the pin) reads
  `absent` with "Set up Codex again", but still runs until replaced. `ENSEMBLE_CODEX_PATH` points at a `codex` program of the reader's own and counts as
  ready.
- **Sign-in** lives in `~/.ensemble/codex` (`CODEX_HOME` for every Codex process the app starts). From the
  app it goes through `codex app-server` (`/api/ai/codex/login`, [API.md](API.md)); from the
  terminal, `ensemble ai login codex` runs `codex login` with the terminal attached. Only a ChatGPT
  sign-in runs; an OpenAI API key is refused until the app can price it.
- **What `build-release.mjs` checks for Codex**:
  - the declared pin is an exact version, and `limnAiRuntime` declares nothing else (the other pins
    come from the workspace install);
  - the written manifest carries the same pin;
  - no `@openai/codex*` package (or `@openai/codex-sdk`) in `dependencies`,
    `optionalDependencies` or `peerDependencies`;
  - no emitted file imports a Codex package at all, `dist/ai/runtime.js` included (it only locates
    the program on disk);
  - Codex's two helper processes exist — `dist/ai/codex/workspace-mcp-main.js` and
    `dist/ai/codex/path-guard-hook-main.js` — and import only `node:` built-ins and relative files
    (Codex starts them by file path, from an install that may carry no AI package);
  - both actually run from the release tree: the MCP server lists `read_file`, `list_files` and
    `search`, and the hook denies a call to a foreign MCP server with exit 2.

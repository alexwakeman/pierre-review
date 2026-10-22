# Packaging & publishing

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Packaging & publishing

Ships to npm as a **single unscoped package `limn-review`** (`npx limn-review`, or `limn`
global; both bins → `dist/cli.js`). ⚠ The DEPRECATED `pierre-review` command is the forwarding
stub's bin ONLY, never limn-review's: npm refuses to link a global bin another package owns, so
declaring it in limn-review made `npm install -g limn-review` fail with EEXIST for every old global
install. Started through the stub, the CLI prints a one-line rename notice. ⚠ The `limn-review` bin is LOAD-BEARING: with several bins, `npx` runs the one
named after the package and errors when none is, so `npx limn-review` needs it. Renamed from `pierre-review` in the release that made Claude Review and AI Fix
free; the old name gets a hand-published forwarding stub (`scripts/deprecated-pierre-review/`, its
README carries the manual `npm deprecate` step — see [RELEASE.md](RELEASE.md)). Tarball is **built artifacts only** (no
`.ts`/src/configs/tests). CI publishing (version computation, atomic tag+commit, idempotent
publish) is in **[RELEASE.md](RELEASE.md)** — **never run `npm publish`/`npm login`
from here**; let CI (or the user) do it.

**Single-process production.** One Fastify server serves the JSON API (`/api`) and the SPA
(`/app`). Static serving is gated on a sibling `public/index.html` (in the release, **absent in
the dev tree**, so `pnpm dev`'s Vite proxy is unchanged). All routing is the **single**
`setNotFoundHandler` (`api/plugins/error-handler.ts`): unknown `/api` → JSON 404; `/app*` → SPA;
`/` + anything else → 302 `/app/`. SPA built `base:'/app/'`. **The npm package ships the app
only** — the marketing site (landing, contact form, the static demo) is a separate service,
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

**CLI** (`cli.ts` → `dist/cli.js`): the **`limn status` subcommand** (peeled off argv
BEFORE `parseArgs`, whose default case rejects bare tokens) renders the cross-repo My-Turn
queue in the terminal via `status.ts` — one section per type in the reader's order (Settings → My
Turn), with a dim footer naming the types switched off — OSC-8 clickable links (non-TTY falls back to
`label (url)`), `--watch` repaint loop (new-since-tick bullets), `--sync` (re-syncs ≤ every
5 min under watch), `--interval/--db`; refuses to create an
empty DB without `--sync`, one-shot `runMigrations → ensureLocalAccount → getMyTurn →
closeDb` lifecycle, env mapped before any config/db import. The server path parses
`--no-open/--port/--db` (+ env),
maps them to env **before** importing config, sets `NODE_ENV=production`. It first moves a
pre-rename `~/.pierre-review` to `~/.limn` (below), then defaults the DB to
`~/.limn/pierre-review.sqlite` (never the read-only install dir; the FILE keeps its old name so the
move carries it and its WAL files untouched) + pre-checks `gh auth token`. Prints the banner + URL, boots via `start()` (guarded run-as-main), opens the
browser (built-in, no dep) unless `--no-open`. **`limn ai install` / `limn ai status`** run the
same AI-runtime download as the app's "Set up AI" button (below); refused under
`LIMN_AI_DISABLED=true`. **`limn ml install`** downloads the bot-comment severity model
([ML-SEVERITY.md](ML-SEVERITY.md)).

**The data directory is `~/.limn`** (`data-dir.ts`; `LIMN_DATA_DIR` overrides; `config.dataDir`).
It holds the CLI's DB, the clone cache (`CLONE_DIR` overrides), `config.json` (the per-review
budget) and `ai-runtime/`. ⚠ **The move from `~/.pierre-review` is ONE `renameSync`, and it NEVER
CLOBBERS**: run by the CLI before it picks the DB path and again (a no-op by then) at the top of
`start()` for `pnpm dev`. An existing `~/.limn` means nothing moves and the old directory is left
as it is; an explicit `LIMN_DATA_DIR` is never migrated into. No copy-then-delete exists, on
purpose — a half-copied SQLite file beside a deleted original is the failure it avoids.
`data-dir.test.ts` pins all four cases over a temp home.

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
`@octokit/graphql`, `better-sqlite3`, `drizzle-orm`, `fastify`, `node-cron`, `yaml` (the
advisor's config emitters) …; **no AI SDK** (`@anthropic-ai/*`, `@modelcontextprotocol/sdk`,
`zod`) and no model runtime). Sanity asserts fail on a missing key file (including
`dist/platform/index.js`, its first migration and `benchmark-fit.json` — ⚠ a missing `data`
copy fails ONLY in the release: dev reads it from `src/` and looks perfect, while the package
answers the benchmark with `available:false`), a leaked `.ts`, an un-rewritten shared
specifier, **any AI SDK in `dependencies` / `optionalDependencies` / `peerDependencies`**, a
missing or inexact AI-runtime pin, or **an AI SDK specifier in any emitted JS file other than
`dist/ai/runtime.js`**. `better-sqlite3` is a native runtime dep.

### No AI SDK in the manifest; installed on first use

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
- **The download** (`installAiRuntime`): "Set up AI (one-time ~110 MB download)" in the app →
  `POST /api/ai/runtime/install` (SSE progress; registered only when
  `config.aiEnabled`; `sync` rate-limit tier), or `limn ai install`. It writes a `package.json`
  carrying the pins into a STAGING dir and runs `npm install --prefix <staging> --ignore-scripts
  --no-package-lock` — npm's own `npm-cli.js` under `process.execPath`, `shell: false`, no string
  interpolation (pins are regex-checked exact versions) — verifies every package landed at its pin,
  then swaps it in at `<dataDir>/ai-runtime` (old one moved aside first, so a failure leaves one
  whole runtime, never half of two). Single-flight (a second POST joins), 10-minute timeout, and a
  plain failure sentence naming `limn ai install`. `LIMN_CLAUDE_PATH` adds `--omit=optional`
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

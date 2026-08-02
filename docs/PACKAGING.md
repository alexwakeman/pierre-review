# Packaging & publishing

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Packaging & publishing

Ships to npm as a **single unscoped package `pierre-review`** (`npx pierre-review`, or
`pierre` global — both bins → `dist/cli.js`). Tarball is **built artifacts only** (no
`.ts`/src/configs/tests). CI publishing (version computation, atomic tag+commit, idempotent
publish) is in **[docs/RELEASE.md](docs/RELEASE.md)** — **never run `npm publish`/`npm login`
from here**; let CI (or the user) do it.

**Single-process production.** One Fastify server serves the JSON API (`/api`), the SPA
(`/app`), and — in cloud — the landing (`/`). Static serving is gated on sibling
`public/index.html` + `public-landing/index.html` (in the release, **absent in the dev
tree**, so `pnpm dev`'s Vite proxy is unchanged). All routing is the **single**
`setNotFoundHandler` (`api/plugins/error-handler.ts`): unknown `/api` → JSON 404; `/app*`
→ SPA; `/` + other → landing (cloud) or 302 `/app` (local). SPA built `base:'/app/'`.

**The landing is PRERENDERED at build time** (`apps/landing/prerender.mjs`, chained after
`vite build`). It used to be a pure CSR SPA: every URL returned the same ~7.8 KB shell whose
whole `<body>` was an empty `#root` + a splash caret, so anything that doesn't execute JS —
an AI agent, a link unfurler, a text browser, a crawler on a render budget — saw a site with
no content and no way to tell `/pricing` from `/privacy`. Now a Vite **SSR build** of
`src/entry-server.tsx` renders each route through `renderToStaticMarkup` into
`dist/<route>/index.html` (21–70 KB of real content), with that route's own
title/description/**canonical** baked in. Load-bearing details:
- **`src/lib/routes.ts` is the ONE source of truth** for per-route SEO copy — read by the
  pages' `useSeo()` (which now only matters for client-side hops) AND by the prerenderer, so
  the static head and the hydrated head cannot drift.
- **`index.html` carries `<!-- seo:start/end -->` + `<!-- app:start/end -->` markers**; the
  prerenderer replaces those regions and **throws if they're missing**. Deleting them silently
  reverts the whole site to a contentless shell.
- **`createRoot`, NOT `hydrateRoot`** — several components deliberately differ between the
  static and browser trees (`HeroWordmark` starts resolved so crawlers see "Pierre" not the
  mid-animation "PR"; `CookieBanner` renders nothing until it has read `localStorage`). A
  fresh client render reaches the same end state with no mismatch failure mode.
- **`router.setStaticPath()`** pins `currentPath()` per render — without it every route
  prerenders as the home page.
- Serving: `@fastify/static` (`wildcard: false`) already answers `/pricing/` from its
  directory-index scan; **`/pricing` (the canonical form) falls through to the not-found
  handler**, which resolves it against a Set of routes scanned **once at boot** — so a URL can
  only ever select an entry found on disk and no request path is ever joined onto a filesystem
  root. Legacy `/insights` + `/reviews` get a copy of `/pro`'s HTML (canonical → `/pro`).
- **Guardrails, because the failure is SILENT** (a broken prerender still looks perfect in a
  browser): `prerender.mjs` asserts 8 routes and a per-page floor, `build-release.mjs` asserts
  each `public-landing/<route>/index.html` exists and contains real content, and
  `api/plugins/landing-routes.test.ts` covers the routing + traversal.

**CLI** (`cli.ts` → `dist/cli.js`): the **`pierre status` subcommand** (peeled off argv
BEFORE `parseArgs`, whose default case rejects bare tokens) renders the cross-repo My-Turn
queue in the terminal via `status.ts` — OSC-8 clickable links (non-TTY falls back to
`label (url)`), `--watch` repaint loop (new-since-tick bullets), `--sync` (re-syncs ≤ every
5 min under watch), `--interval/--db`; LOCAL-only (refuses cloud), refuses to create an
empty DB without `--sync`, one-shot `runMigrations → ensureLocalAccount → getMyTurn →
closeDb` lifecycle, env mapped before any config/db import. The server path parses
`--no-open/--port/--db/--cloud/--mode` (+ env),
maps them to env **before** importing config, sets `NODE_ENV=production`. Local defaults
the DB to `~/.pierre-review/…sqlite` (never the read-only install dir) + pre-checks
`gh auth token`; `--cloud` skips both (Postgres `DATABASE_URL`; `assertCloudConfig` at
boot). Prints the banner + URL, boots via `start()` (guarded run-as-main), opens the
browser (built-in, no dep) unless `--no-open`.

**Two load-bearing traps:**
- **`@pierre-review/shared` is types-only** and NOT a published dep — the backend must
  `import type` only (offenders use local `const` copies); the release greps `release/dist`
  and **fails** on any real shared import/require.
- **pnpm is pinned** (`packageManager: pnpm@9.15.9`) so CI, the Railway `Dockerfile`, and
  local dev match; a newer pnpm blocks native builds (`ERR_PNPM_IGNORED_BUILDS` on
  `better-sqlite3`/`esbuild` — also in `pnpm.onlyBuiltDependencies`). Bumping = regenerate
  `pnpm-lock.yaml`.

**`pnpm package`** (`scripts/build-release.mjs`) assembles `./release/`: builds
frontend(`/app`)+landing+backend, copies compiled JS + both migration folders +
SPA→`public/` + landing→`public-landing/`, generates `package.json` (curated deps:
**drop** shared **and all AI SDKs** (`@anthropic-ai/*`, `@modelcontextprotocol/sdk`, `zod`),
**add** `@fastify/static|cookie|secure-session`, `pg`). Sanity asserts fail on a missing key
file, a leaked `.ts`, a shared runtime import, or **any AI SDK dep leaking into the manifest**.
`better-sqlite3` is a native runtime dep; `pg` loads only in cloud. **No AI ships in npm** —
the AI SDKs load only when the private `@pierre/pro` plugin is present (dev/author checkout),
via dynamic `await import()`; an npm-local user (`proEnabled` true, plugin absent) never
touches them, and the public npm publish never registers AI routes.

**`--with-pro` (the PAID cloud image ONLY).** `build-release.mjs --with-pro` additionally: builds
`@pierre/pro` to `packages/pro/dist` (via the new `tsconfig.build.json` + `pnpm --filter @pierre/pro
build`), copies `packages/pro/{dist,migrations,migrations-pg}`→`release/pro/` (preserving the
dist↔migrations sibling layout so the plugin's `../migrations` URL resolves), adds **only**
`@anthropic-ai/sdk` to the manifest (core's `review/llm.ts` raw metered path — the agentic SDKs +
`zod` stay forbidden even here), and extends the shared-import grep to `release/pro`. The `Dockerfile`
gates this on `ARG WITH_PRO=` (empty default = byte-identical OSS image): non-empty ⇒ build the plugin
+ `pnpm package --with-pro` + `ENV PRO_PLUGIN_PATH=/app/pro/dist/index.js`. `.github/workflows/deploy-cloud.yml`
(workflow_dispatch) checks out the private submodule via `PRO_DEPLOY_KEY`, `docker build --build-arg
WITH_PRO=true`, pushes to private GHCR; Railway deploys that image. The public `release.yml` NEVER
passes `--with-pro`, so its zero-AI-deps guarantee is intact. See `docs/DEPLOY-RAILWAY.md` §"the paid
Pro tier".

**Credit metering (paid cloud).** `AI_CREDITS_PER_USD` is **1250** ($1 model cost = 1250 credits;
also inlined in `pro/insights/routes.ts` + `db/credits.ts` — keep the three in lockstep). Core owns
the allowance math: `db/credits.ts` `aiCreditStatus(account,now)` → `{allowanceCredits,usedCredits,
remainingCredits,blocked}` (local `isLocal` = null/unmetered; paid cloud = `accounts.aiCreditAllowance
?? 2500`; free cloud = 0), summed from the `ai_usage` ledger since the UTC month start (auto-resets on
the 1st; migration `0026` added the nullable column). Exposed as **`ctx.aiCredits.check`**; the plugin
gates the digest (`runRefresh`) + sprint (`refreshSprintReport`) generators on `blocked`, returning a
`creditsExhausted` state (the SPA disables Generate/Regenerate + shows the used/2500 meter in
`TrackUsage`). Agentic entry points aren't gated yet — dead code while agentic is off in cloud +
unmetered locally; wire them when a metered agentic tier ships.



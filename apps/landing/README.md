# @pierre-review/landing

Public marketing landing page for pierre-review (cloud mode). Built independently — it
shares no runtime code with the timeline SPA — and is served at `/` by the Fastify server
in cloud mode for anonymous visitors. The primary call to action is **Sign in with GitHub**
(`/api/auth/login`).

## Structure

A small, dependency-free multi-page site (React + Vite + Tailwind). Five routes with real,
clean URLs:

| Route | Page | Focus |
|---|---|---|
| `/` | `pages/Home.tsx` | The pitch + the *why* (GitHub overwhelm → one calm board) |
| `/features` | `pages/Features.tsx` | Timeline, Focus, My Turn, Feed, threads, PR detail, filters |
| `/insights` | `pages/Insights.tsx` | The 12 analytics charts, each explained |
| `/reviews` | `pages/Reviews.tsx` | Claude Review — persistence + deep/quick routing |
| `/how-it-works` | `pages/HowItWorks.tsx` | Sync pipeline, architecture, security + roadmap |

- **Routing** (`src/router.tsx`): a ~80-line client router (`useRoute`, `navigate`, `Link`)
  — no router dependency. The Fastify not-found handler serves the landing `index.html` for
  any non-`/api`, non-`/app` path, so deep-links / reloads of every route work. `Link`
  full-navigates app/API/external URLs and client-routes the rest.
- **Shared UI** (`src/components/ui.tsx`): `Shot` (responsive macOS-window screenshot frame),
  `Section`, `SectionHeading`, `FeatureRow`, `Stat`, `Pill`, `Glow`. `Nav.tsx` is the sticky
  header + mobile hamburger drawer; `Footer.tsx` the site footer.
- **Per-page SEO** (`src/lib/seo.ts`): `useSeo({ title, description, path })` sets the
  document title, meta description, canonical and Open Graph / Twitter tags on mount.
  Home-page defaults + JSON-LD live in `index.html`. `public/sitemap.xml` + `public/robots.txt`
  list the routes. Update the sitemap when routes change.

Everything is mobile-first; the app itself is desktop-only today (called out on the site),
so the marketing pages are the phone-friendly surface.

## Google Analytics (fill in later)

GA4 is wired but silent until you provide a Measurement ID (`G-XXXXXXXXXX`). Either:

- set `VITE_GA_ID` at build time (e.g. `apps/landing/.env` → `VITE_GA_ID=G-XXXXXXXXXX`), or
- paste it into `GA_MEASUREMENT_ID` in `src/lib/analytics.ts`.

While empty, gtag.js is never loaded and nothing is tracked. Once set, `initAnalytics()`
(called from `main.tsx`) loads gtag and `trackPageView()` fires a page_view on every
client-side route change (`App.tsx`).

## Favicons

Generated from the brand mark into `public/` (`favicon-16/32/48.png`,
`apple-touch-icon.png`, `icon-192/512.png`, referenced from `index.html` +
`site.webmanifest`). To regenerate from a new source image with `sips`:

```sh
sips -c 130 130 logo.png --out /tmp/sq.png            # crop to a centred square
for s in 16 32 48 180 192 512; do sips -z $s $s /tmp/sq.png --out public/icon-$s.png; done
# then rename: favicon-16/32/48.png, apple-touch-icon.png (180), icon-192/512.png
```

## Product screenshots

The shots in `public/shots/` come from a **throwaway seeded demo DB** (fictional `acme/*`
team — no real GitHub data, no PII), captured by `scripts/capture-shots.mjs` from the repo
root. The Pro shots (Insights, flow metrics, sprint report, digests, AI Analysis & Fix,
Settings) need the **private `packages/pro` submodule checked out**
(`git submodule update --init`) — the seeder then also populates the plugin tables
(`repo_digests`, `sprint_reports`, `pro_settings`, AI analyses/fixes).

Capture is **TWO PASSES against the same seeded DB**, selected by `SHOT_SET` (default
`pro`). The FREE pass restarts the backend with **`PRO_DISABLED=true`** — which forces
pure-OSS mode even with the pro submodule present — so the plain (no-FYI) feed and the
digest-less repo console can be captured.

**The one-command way** (`scripts/demo-stack.mjs` — from the repo root):

```sh
pnpm shots        # seed → boot Pro stack → all PRO shots → restart OSS → FREE shots → teardown
pnpm shots claude-review.png   # one shot only (pro set)

pnpm demo         # seed + boot the Pro demo stack and LEAVE IT RUNNING for browsing
pnpm demo --free  #   … in pure-OSS mode        (backend :4100, frontend :5273)
pnpm demo --no-seed  # … reusing the existing /tmp/pierre-demo.sqlite
```

Or run the passes by hand:

```sh
# 1. seed the demo DB (also seeds the Pro tables when packages/pro is present)
pnpm --filter @pierre-review/backend seed:demo

# ---- PRO pass (default SHOT_SET=pro) --------------------------------------
# 2. run an ISOLATED stack against it (leave your real :4000/:5173 dev server alone).
#    Run the backend with `gh` OFF its PATH so it keeps the seeded Morgan Diaz identity.
#    PRO_DIGEST_ENABLED + PRO_ADVANCED_AI_ENABLED turn on the Pro surfaces;
#    ANTHROPIC_API_KEY=dummy just makes the AI tabs render as authed (nothing generates —
#    every AI artifact in the shots is pre-seeded).
( cd apps/backend && PATH="$HOME/.nvm/versions/node/$(node -v)/bin:/usr/bin:/bin" \
  DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
  PRO_DIGEST_ENABLED=true PRO_ADVANCED_AI_ENABLED=true ANTHROPIC_API_KEY=dummy \
  node_modules/.bin/tsx src/index.ts & )
( cd apps/frontend && BACKEND_PORT=4100 node_modules/.bin/vite --port 5273 & )
# 3. capture the Pro shots (all, or one: `node scripts/capture-shots.mjs insights.png`)
node scripts/capture-shots.mjs

# ---- FREE pass (SHOT_SET=free) --------------------------------------------
# 4. RESTART the backend with PRO_DISABLED=true (kill the Pro backend above first);
#    the frontend can stay up. This forces OSS mode even though packages/pro is present.
( cd apps/backend && PATH="$HOME/.nvm/versions/node/$(node -v)/bin:/usr/bin:/bin" \
  DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
  PRO_DISABLED=true ANTHROPIC_API_KEY=dummy \
  node_modules/.bin/tsx src/index.ts & )
# 5. capture the free shots (the capture asserts no "My Turn" surface is present)
SHOT_SET=free node scripts/capture-shots.mjs
```

Shot lists (→ `public/shots/`, plus `og-image.png` at the public root):

- **PRO pass** (`SHOT_SET=pro`): `timeline.png` (30-day board), `activity-feed-pro.png`
  (feed with the yellow FYI/My-Turn cards), `repo-console.png` (with the AI digest),
  `insights.png`, `flow-metrics.png`, `sprint-report.png`, `pr-detail.png`,
  `claude-review.png`, `ai-fix.png`, `settings.png`, `open-pr-strip.png` (30-day preset
  so the stalled count shows), `og-image.png` — plus the **walkthrough step crops** used
  by the Pro page's step-by-step demos (captured at a narrow viewport for legibility):
  `flow-review-{1-run,2-memory,3-findings,4-post}.png` (#113) and
  `flow-fix-{1-ci,2-analysis,3-diff,4-push}.png` (#114).
- **FREE pass** (`SHOT_SET=free`): `activity-feed.png` (the PLAIN feed — no FYI cards or
  toggle) and `repo-console-free.png` (repo console without the digest card).

`scripts/capture-landing.mjs` screenshots the built landing pages at desktop + mobile widths
(into `scripts/.ui-artifacts/landing/`) and reports horizontal-overflow — handy for checking
responsive regressions.

## Commands

`pnpm --filter @pierre-review/landing {dev,build,preview,typecheck}` — dev server on `:5174`.

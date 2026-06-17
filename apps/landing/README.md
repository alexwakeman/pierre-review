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
root. Regenerate them:

```sh
# 1. seed the demo DB
pnpm --filter @pierre-review/backend seed:demo
# 2. run an ISOLATED stack against it (leave your real :4000/:5173 dev server alone).
#    Run the backend with `gh` OFF its PATH so it keeps the seeded Morgan Diaz identity.
( cd apps/backend && PATH="$HOME/.nvm/versions/node/$(node -v)/bin:/usr/bin:/bin" \
  DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
  ENABLE_CLAUDE_REVIEW=true ANTHROPIC_API_KEY=dummy node_modules/.bin/tsx src/index.ts & )
( cd apps/frontend && BACKEND_PORT=4100 node_modules/.bin/vite --port 5273 & )
# 3. capture (all shots, or one: `node scripts/capture-shots.mjs feed.png`)
node scripts/capture-shots.mjs
```

`scripts/capture-landing.mjs` screenshots the built landing pages at desktop + mobile widths
(into `scripts/.ui-artifacts/landing/`) and reports horizontal-overflow — handy for checking
responsive regressions.

## Commands

`pnpm --filter @pierre-review/landing {dev,build,preview,typecheck}` — dev server on `:5174`.

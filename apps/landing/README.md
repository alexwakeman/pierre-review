# @pierre-review/landing

Public marketing site for Limn (limn-review.com). Built independently — it shares no
runtime code with the timeline SPA — and served at `/` by the small site service in
[`apps/site`](../site/README.md), which also serves the static demo at `/demo/` and the
contact form's API.

**Limn is local-only and 100% free.** There is no hosted app, no sign-in and no paid tier,
so the site's calls to action are **Try the demo** (`/demo/`, a static build of the app on
sample data) and the npm command (`npx limn-review`). The one limit — free for individuals and for
organisations where no more than three people use it; more users than that need a licence — is stated in the hero, in the closing
block on every page, on `/contact` and in `/terms`, always from `FREE_TEAM_SIZE` in
`src/lib/site.ts` (which mirrors the Limn License at the repository root).

## Structure

A small, dependency-free multi-page site (React + Vite; Tailwind only for its preflight reset). **Five content routes** (home, `/getting-started`, `/reporting`, `/how-we-measure`, `/contact`)
plus the three legal ones:

| Route | Page | Focus |
|---|---|---|
| `/` | `pages/Home.tsx` | "Plan your day": the hero, Gather / Check / Act, velocity, bots, cost, the licence table, the FAQ and the closing call to action |
| `/getting-started` | `pages/GettingStarted.tsx` | Install and run, turn on Claude, add the scoring model, add repositories, connect Jira or Linear, connect Slack |
| `/reporting` | `pages/Reporting.tsx` | Reporting and metrics: the one window, period reports, Chronology, 26 weeks, where the work is happening, what bots are worth, This Sprint |
| `/how-we-measure` | `pages/HowWeMeasure.tsx` | The two ML models in plain English — what each is for, how it was built, how we know it works |
| `/contact` | `pages/Contact.tsx` | **Also the licence path** for organisations with more than three users, and where `/pricing` resolves. The only page that talks to a server (`POST /api/contact` → a Slack webhook) |
| `/privacy` · `/cookies` · `/terms` | `pages/{Privacy,Cookies,Terms}.tsx` | Legal. Linked from the footer and the consent banner. Terms summarise the Limn License and defer to it |

**THE DESIGN IS ONE DARK "BOARD OF TILES"**, on every page. `src/board.css` holds the
tokens (the dark ground, the four pigments lapis / verdigris / madder / gold), the self-hosted
Albert Sans face, the shared header (`.lb-nav`) and footer (`.lb-foot`), and the tile grid; its
header comment lists the classes. Every page renders a root `<div className="lb <page>">`
with `useReveal` (`components/board/useReveal.ts`, which lifts `.rise` tiles in as they
scroll into view and leaves everything visible without JS) and keeps its own rules in a
page-scoped file under that root: `pages/getting-started.css`, `reporting.css`,
`how-we-measure.css`, `contact.css`, `legal.css`, and `components/chrome.css` for the 404, the
cookie banner and the lightbox. The home page's sections are `components/board/*`. Images
are bundled from `src/assets/` (`board/` for the home page, `pages/` for the screenshots on
Getting started and Reporting and metrics).

**THE SITE WAS FIVE FEATURE-AREA PAGES** (`/features`, `/bots`, `/pro`, `/pricing`,
`/how-it-works`) plus an arcade game, and they were removed together. The two role pages
that replaced them (For developers, For managers) were in turn replaced by Getting started
and Reporting and metrics. Organising by feature
area meant a developer and an engineering manager read the same five pages and neither found
the half addressed to them.

⚠ **`pnpm dev` here needs the site service for the contact form.** Vite proxies `/api` to
`http://127.0.0.1:4300` (`LANDING_API_TARGET` overrides it) — run
`pnpm --filter @pierre-review/site dev` beside it. Without the proxy a bare
`fetch('/api/contact/ticket')` hits Vite's SPA fallback — 200, with HTML — and the form reads
that as "not configured" and renders its unavailable state, which looks exactly like a working
failure path rather than a missing server.

⚠ **`/demo/` is not a landing route.** The router treats it as external (a full navigation),
`ROUTE_SEO` and the sitemap leave it out.

⚠ **The old URLs are aliased, not deleted.** `App.tsx` maps each of them to whichever page
now carries its content — `/pricing` to `/contact`, `/how-it-works` to `/how-we-measure`, `/for-developers` and `/features` to `/getting-started`, `/for-managers`, `/bots`, `/pro`, `/insights` and `/reviews` to `/reporting` — and the header's `ALIAS_OF` (`components/Nav.tsx`) marks the matching link — and `prerender.mjs` writes the same mapping to disk so an old
inbound link gets real HTML with a canonical pointing at the surviving page. Change both
tables together. `prerender.mjs` also writes `dist/404.html`, which `apps/site` serves with a
404 status for any unknown path.

- **Routing** (`src/router.tsx`): a ~80-line client router (`useRoute`, `navigate`, `Link`)
  — no router dependency. `apps/site` serves each route's prerendered page, so deep-links /
  reloads of every route work. `Link` full-navigates demo/API/external URLs and
  client-routes the rest.
- **Shared UI**: `Nav.tsx` is the sticky header + mobile drawer; `Footer.tsx` the site
  footer; `legal.tsx` the shell the three legal pages share; `Lightbox.tsx` the screenshot
  lightbox; `CookieBanner.tsx` the consent banner.
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
(called from `App.tsx` on mount, and only with a stored consent grant) loads gtag and `trackPageView()` fires a page_view on every
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

## Screenshots and the walkthrough clip

The pages no longer use `public/shots/` or `public/media/`. Their screenshots are cropped
JPEGs bundled from `src/assets/`. The two public folders stay because other things still
write or read them: `pnpm shots` (`scripts/capture-shots.mjs`, `scripts/demo-stack.mjs`)
writes `public/shots/`, the repository README embeds three of those shots, and
`pnpm demo:video --publish` (`scripts/capture-demo-video.mjs`) writes the walkthrough clip
to `public/media/`. Both pipelines film the fictional `acme/*` demo stack, never real
GitHub data. A screenshot on a page is still a CROP OF ONE ELEMENT, never a whole browser
window.

## Reading the copy

`node scripts/dump-copy.mjs [out.md]` writes every word the site renders — in page
order, with the per-route `<title>` and meta description — to one markdown file, for
proofreading. It reads `apps/landing/dist`, so **build first**; what comes out is what a
reader actually gets rather than a hand transcription that drifts from it.

`scripts/capture-landing.mjs` screenshots the built landing pages at desktop + mobile widths
(into `scripts/.ui-artifacts/landing/`) and reports horizontal-overflow — handy for checking
responsive regressions.

## Commands

`pnpm --filter @pierre-review/landing {dev,build,preview,typecheck}` — dev server on `:5174`.

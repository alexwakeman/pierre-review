# @pierre-review/landing

Public marketing landing page for pierre-review (cloud mode). Built independently — it
shares no runtime code with the timeline SPA — and is served at `/` by the Fastify server
in cloud mode for anonymous visitors. The primary call to action is **Sign in with GitHub**
(`/api/auth/login`).

## Structure

A small, dependency-free multi-page site (React + Vite + Tailwind). **Four content routes**
plus the three legal ones:

| Route | Page | Focus |
|---|---|---|
| `/` | `pages/Home.tsx` | The pitch, the numbers, and the split to the two role pages |
| `/for-developers` | `pages/ForDevelopers.tsx` | The free tier in full, then what Pro adds for an IC |
| `/for-managers` | `pages/ForManagers.tsx` | The free metrics, then the paid scoreboard and reports |
| `/how-we-measure` | `pages/HowWeMeasure.tsx` | The two ML models in plain English — what each is for, how it was built, how we know it works |
| `/privacy` · `/cookies` · `/terms` | `pages/{Privacy,Cookies,Terms}.tsx` | Legal. Linked from the footer and the consent banner |

**THE SITE WAS FIVE FEATURE-AREA PAGES** (`/features`, `/bots`, `/pro`, `/pricing`,
`/how-it-works`) plus an arcade game, and they were removed together. Organising by feature
area meant a developer and an engineering manager read the same five pages and neither found
the half addressed to them. One page per reader, each of which leads with the free tier in
full, then Pro, then the shared comparison table and sign-up block
(`components/feint/TierTable.tsx` — rendered at the bottom of all three).

⚠ **The old URLs are aliased, not deleted.** `App.tsx` maps each of them to whichever role
page now carries its content, and `prerender.mjs` writes the same mapping to disk so an old
inbound link gets real HTML with a canonical pointing at the surviving page. Change both
tables together.

⚠ **`components/feint/FeatureShot.tsx` exists because a screenshot in the two-column rail
renders at roughly half size.** Captures are taken at a 1180px viewport; in a ~500px column
that puts 12px interface text at 6px. Anything with a table, a chart row or more than one
panel goes through `FeatureShot` (full canvas width, ~1:1); only genuinely narrow crops keep
the two-column `ShotFrame`.

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
root. The Pro shots (flow metrics, the period report, Chronology, the bot ROI table and the
benchmark) need the **private `packages/pro` submodule checked out**
(`git submodule update --init`) — the seeder then also populates the plugin tables
(`repo_digests`, `sprint_reports`, `pro_settings`, AI analyses/fixes).

Capture is **TWO PASSES against the same seeded DB**, selected by `SHOT_SET` (default
`pro`). The FREE pass restarts the backend with **`PRO_DISABLED=true`** — which forces
pure-OSS mode even with the pro submodule present — so the LOCKED Reports pane a free
account actually sees can be captured rather than faked.

**The one-command way** (`scripts/demo-stack.mjs` — from the repo root):

```sh
pnpm shots        # seed → boot Pro stack → all PRO shots → restart OSS → FREE shots → teardown
pnpm shots bot-roi.png   # one shot only (pro set)

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
# 3. capture the Pro shots (all, or one: `node scripts/capture-shots.mjs bot-roi.png`)
node scripts/capture-shots.mjs

# ---- FREE pass (SHOT_SET=free) --------------------------------------------
# 4. RESTART the backend with PRO_DISABLED=true (kill the Pro backend above first);
#    the frontend can stay up. This forces OSS mode even though packages/pro is present.
( cd apps/backend && PATH="$HOME/.nvm/versions/node/$(node -v)/bin:/usr/bin:/bin" \
  DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
  PRO_DISABLED=true ANTHROPIC_API_KEY=dummy \
  node_modules/.bin/tsx src/index.ts & )
# 5. capture the free shot (the locked Reports pane)
SHOT_SET=free node scripts/capture-shots.mjs
```

Shot lists (→ `public/shots/`, plus `og-image.png` at the public root). **Every shot is a
CROP OF ONE ELEMENT**, not a browser window: the previous set photographed whole 1600px
windows, and at the width a marketing column renders them the feature being described was
forty pixels tall somewhere in the middle. `crop()` in the capture script clips to a
locator's bounding box with a little padding.

- **PRO pass** (`SHOT_SET=pro`): `pending-board.png`, `pending-card.png`, `feed.png`,
  `flow-metrics.png`, `repo-rows.png`, `reach.png`, `period-report.png`, `chronology.png`,
  `bot-roi.png`, `bot-settings.png`, `benchmark.png`, `pr-detail.png`, `pr-threads.png`,
  `bot-severity.png`, `og-image.png`.
- **FREE pass** (`SHOT_SET=free`): `free-reports.png` — the Reports pane on a free account,
  which is the one piece of evidence for the visible-but-locked posture the tier table
  claims. It has to be a real free-tier capture; cropping the paid one would not show the
  lock.

⚠ **There is deliberately no `pr-changes` shot.** The Changes tab hydrates its patches from
GitHub on demand and the demo's repositories do not exist there, so against this database it
correctly renders "inline diffs aren't available for this PR". That is the honest output and
it is not a picture of the feature — do not re-add the shot without first giving the demo a
real diff to render.

⚠ **The demo data is TWO seeders.** `scripts/seed-demo.ts` is the hand-curated fixture whose
rows are addressed by id from this capture script (#113's threads, #114's red build).
`scripts/seed-estate.ts` adds the SCALE around it — five more repositories, six more people,
seven more bots and a few hundred more pull requests — without which the multi-repo rollups
and the bot-volume surfaces have nothing to roll up. `scripts/seed-periods.ts` then computes
the stored period reports from the real core fold, so the figures on the report agree with
the figures on every other screen.

## Reading the copy

`node scripts/dump-copy.mjs [out.md]` writes every word the site renders — in page
order, with the per-route `<title>` and meta description — to one markdown file, for
proofreading. It reads `apps/landing/dist`, so **build first**; what comes out is what a
reader actually gets rather than a hand transcription that drifts from it.

The comparison table is the one thing it does not walk: it is a CSS grid whose
mobile-only "Free" / "Pro" markers interleave with the cells, so its rows are read
straight from `TierTable.tsx` and rendered as a real table.

`scripts/capture-landing.mjs` screenshots the built landing pages at desktop + mobile widths
(into `scripts/.ui-artifacts/landing/`) and reports horizontal-overflow — handy for checking
responsive regressions.

## Commands

`pnpm --filter @pierre-review/landing {dev,build,preview,typecheck}` — dev server on `:5174`.

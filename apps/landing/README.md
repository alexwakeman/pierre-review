# @pierre-review/landing

Public marketing landing page for pierre-review (cloud mode). Built independently — it
shares no runtime code with the timeline SPA — and is served at `/` by the Fastify server
in cloud mode for anonymous visitors. The primary call to action is **Sign in with GitHub**
(`/api/auth/login`).

## Structure

A small, dependency-free multi-page site (React + Vite + Tailwind). **Five content routes**
plus the three legal ones:

| Route | Page | Focus |
|---|---|---|
| `/` | `pages/Home.tsx` | The pitch, the numbers, and the split to the two role pages |
| `/for-developers` | `pages/ForDevelopers.tsx` | The free tier in full, then what Pro adds for an IC |
| `/for-managers` | `pages/ForManagers.tsx` | The free metrics, then the paid scoreboard and reports |
| `/how-we-measure` | `pages/HowWeMeasure.tsx` | The two ML models in plain English — what each is for, how it was built, how we know it works |
| `/contact` | `pages/Contact.tsx` | **Also the purchase path.** Checkout is unwired, so Pro is given free for a month to anyone who asks — every Pro call-to-action on the site points here, and `/pricing` resolves to it. The only page that talks to the backend (`POST /api/contact` → a Slack webhook) |
| `/privacy` · `/cookies` · `/terms` | `pages/{Privacy,Cookies,Terms}.tsx` | Legal. Linked from the footer and the consent banner |

**THE SITE WAS FIVE FEATURE-AREA PAGES** (`/features`, `/bots`, `/pro`, `/pricing`,
`/how-it-works`) plus an arcade game, and they were removed together. Organising by feature
area meant a developer and an engineering manager read the same five pages and neither found
the half addressed to them. One page per reader, each of which leads with the free tier in
full, then Pro, then the shared comparison table and sign-up block
(`components/feint/TierTable.tsx` — rendered at the bottom of every content page, `/contact`
included, because `/pricing` now lands there and a visitor asking what it costs must find an
answer rather than only a form).

⚠ **`pnpm dev` here needs the backend for the contact form.** Vite proxies `/api` to
`http://127.0.0.1:4000` (`LANDING_API_TARGET` overrides it). Without the proxy a bare
`fetch('/api/contact/ticket')` hits Vite's SPA fallback — 200, with HTML — and the form reads
that as "not configured" and renders its unavailable state, which looks exactly like a working
failure path rather than a missing backend.

⚠ **The old URLs are aliased, not deleted.** `App.tsx` maps each of them to whichever page
now carries its content — `/pricing` to `/contact`, the rest to a role page — and `prerender.mjs` writes the same mapping to disk so an old
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

## Demo video

Two clips, from the **same seeded demo stack the screenshots come from** — fictional `acme/*`
data, no real GitHub data, no PII. Both are silent, both carry a poster still, and neither has
an audio track at all.

| File | What it is | Where it renders |
|---|---|---|
| `public/demo/limn-hero.mp4` | 8.05s, 119 kB, one slow pass down the Pending board, **loops, plays by itself** | Home, under the headline |
| `public/demo/limn-walkthrough.mp4` | 29.66s, 954 kB, four screens with burned-in captions, **click to play** | Home, `02 · The tour` |

Each ships with a `-poster.jpg` beside it (86 kB and 89 kB), which is **frame 0 of its own clip** —
so pressing play does not make the picture jump, and the reduced-motion reader sees the same
first frame everyone else does.

```sh
pnpm demo:video                 # seed → boot the Pro stack → film both → teardown
pnpm demo:video --publish       #   … and also write the copies under apps/landing/public/demo/
pnpm demo:video --scenario hero # just one

# or, against a stack you already have up (`pnpm demo --no-seed`):
node scripts/capture-demo-video.mjs --scenario walkthrough --out ~/ --publish
node scripts/capture-demo-video.mjs --keep-frames   # leave phase 1's PNGs on disk to inspect
```

`--out` defaults to your home directory. `--publish` additionally writes
`apps/landing/public/demo/`, which is what the site serves.

### Adding a scene, or a whole new scenario

**A scenario is data, and a different tour is a different FILE** —
`scripts/demo-video/scenario.<name>.mjs`, picked with `--scenario <name>`. Never fork the
capture script. A scene looks like this:

```js
{
  id: 'pending',
  caption: 'Pending — one ranked queue',      // burned BELOW the app's pixels; null for none
  url: '?view=activity&activityRepo=attention',
  ready: '[data-testid="attention-view"]',    // the selector that means "this screen painted"
  settleMs: 3400,
  scale: 1,                                   // deviceScaleFactor; 2 if the scene zooms
  pane: 430,                                  // optional: the PR detail pane's height
  steps: [
    { hold: 2600 },
    { scroll: { selector: '…', to: 1000, ms: 3000 } },
    { zoom: { selector: '…', ms: 1500, maxWidth: 620, anchor: 'left', offset: [0, 138] } },
    { zoomOut: { ms: 1000 } },
  ],
}
```

Four things the script will refuse rather than film quietly, each of which has already cost a
run:

- **a scene that produced no frames** — `pnpm shots <name>` silently no-ops on an unmatched
  name, and a scenario that films nothing is the same defect one medium over;
- **a `scroll` over an element that does not scroll** — it would film a still;
- **a `zoom` whose target ends up wider than 92% of the frame.** Every panel in this app is
  full-width at a 1180px viewport, so a bare selector almost always lands there; cap it with
  `maxWidth` and shift the framing with `offset`. A zoom to the whole frame is not a zoom, and
  it fails by simply holding still;
- **a timeline over the scenario's `budgetMs`** (30s for the walkthrough, 10s for the hero).

⚠ **Anchor a zoom on the pane's own chrome, not on its content.** `reviewer-provenance` and
`bot-triage-card` each cost a failed run: they are present on most loads and absent when the
query behind them 502s against a demo stack that has no GitHub behind it.

⚠ **There is no `changes` scene**, for the same reason there is no `pr-changes.png` still: the
Changes tab hydrates its patches from GitHub on demand, and against this database it correctly
renders "inline diffs aren't available for this PR".

### How it is made, and why it is this shape

`scripts/capture-demo-video.mjs`, in two phases.

1. **Capture** — open each scene, let it settle, and photograph it frame by frame with
   `page.screenshot()`. A scroll is driven by EASING `element.scrollTop` between frames rather
   than by the browser's smooth-scroll, which is wall-clock-dependent and would pan differently
   every run. A zoom costs **no extra screenshots at all**: it is the same photograph drawn from
   a shrinking source rectangle.
2. **Replay and record** — a second page paints those frames into a canvas on a rAF clock and
   records it with `MediaRecorder` (`video/mp4;codecs=avc1.42E01E`). This phase is realtime by
   construction: a 30-second clip takes 30 seconds.

The viewport, theme, reduced-motion setting and onboarding localStorage seed all come from
`scripts/lib/demo-browser.mjs`, which `capture-shots.mjs` imports too — so the stills and the
clips can never drift into being pictures of two different products.

**Measured, so nobody re-derives it:**

| | 30s clip |
|---|---|
| H.264 via MediaRecorder | **954 kB** (what ships) |
| VP8 via Playwright's bundled ffmpeg | 1,280 kB |
| Animated WebP | 165 kB held-only, but **7,919 kB** for a pan (48×) |

Motion costs roughly **5.1× the bitrate of a held frame whatever the codec**, so the size of
these files is decided by how much of them MOVES, not by encoder settings. That is why the
scenarios hold more than they pan, why the hero drifts 700px over 4.2s instead of 1,300px over
3.2s, and why every cut between scenes is hard — a cross-fade changes every pixel in the frame
for its whole duration, which is the most expensive thing you can ask of an inter-frame codec.
One further measurement, stated as what was actually run rather than per-lever: the walkthrough
at 25 fps / 1.1 Mbps / three 4-second scrolls came out at **1,640 kB**; at 12 fps / 0.7 Mbps /
three 3-second scrolls it is **954 kB**, for a picture that looks the same held still. Those
three moved together, so none of them owns the 42% on its own.

**⚠ `canvas.captureStream(fps)` IS A TRAP, and it fails silently.** Asked for a frame rate,
Chromium only hands the encoder a frame when the canvas content actually CHANGES — and these
clips are mostly held frames, so a 29.55-second timeline recorded as **8.37 seconds of video
playing 3.5× too fast**, with no error anywhere and a poster that still looked right. The fix,
and the assertion that now guards it, is `captureStream(0)` plus one explicit `requestFrame()`
per slot.

**⚠ Playwright's bundled ffmpeg cannot help with any of this.** It is built
`--disable-everything`: its entire filter set is crop / format / hflip / null / pad / scale /
transpose / trim / vflip. No `drawtext`, no `overlay`, no `fade`, no `zoompan`. So the captions,
the zoom and the frame timing all happen on the canvas before the encoder sees a pixel — and
there is no transcoding step anywhere in this repo. **The master and the published copy are the
same encode**; the tuning lives in the scenario file, not in a post-pass.

**⚠ These are fragmented MP4s straight out of MediaRecorder, so they carry no total duration in
the header** — a player discovers the length as it downloads. That is why the walkthrough mounts
no `<video>` until the Play button is pressed: the scrub bar then fills in during the first
second of playback rather than sitting visibly wrong on a page nobody has clicked.

### The motion policy

The site's standing rule is that it does not move, and the CSS blanket in `src/index.css`
enforces it by killing `animation` and `transition`. **A playing `<video>` is neither**, exactly
like the hero rain's rAF canvas loop. So `components/feint/VideoFrame.tsx` checks
`matchMedia('(prefers-reduced-motion: reduce)')` itself, subscribes to its `change` event, and
under reduced motion renders the poster still and mounts no `<video>` at all.

⚠ **Do not reach for a header instead.** MEASURED in Chromium: a script-initiated `play()` on a
muted video succeeds under `Permissions-Policy: autoplay=()` exactly as it does with no policy —
and a header says what is ALLOWED, never what the reader asked for. (For the same reason nothing
in `apps/backend/src/api/plugins/security.ts` needed changing for these clips: the landing CSP
has no `media-src`, so it inherits `default-src 'self'`, which a same-origin `/demo/*.mp4`
already satisfies.)

⚠ **The click-to-play walkthrough deliberately plays under reduced motion too.** A reader who
presses Play has asked. Reduced motion means "do not move unless I ask", not "never move".

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

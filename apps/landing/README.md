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

**ONE clip**, filmed against the **same seeded demo stack the screenshots come from** —
fictional `acme/*` data across eight repositories, no real GitHub data, no PII. It is
silent, it has no audio track at all, and it **plays once**: nothing on this site loops.

| File | Bytes | What it is |
|---|---|---|
| `public/demo/limn-walkthrough.mp4` | 2,186,482 | 28.013 s, 1770×996. Six screens, hard cuts, hold → short push-in → hold. No scrolls |
| `public/demo/limn-walkthrough-poster.jpg` | 210,099 | **Frame 0 of the clip itself**, so pressing play does not make the picture jump and the reduced-motion reader sees the same first frame everyone else does |
| `public/demo/limn-walkthrough.cues.json` | 1,198 | The six chapters — `{ id, startMs, endMs, title, text }`, integer milliseconds, contiguous, `startMs[0] === 0` |

It renders under the home-page headline (`pages/Home.tsx`, `components/feint/VideoFrame.tsx`),
autoplaying, with the chapters beside it as a list.

**It is a FRAGMENTED MP4, and that is the fact the player is built around.** Straight out of
MediaRecorder: 6 `moof`/`mdat` fragment pairs, **no `sidx`**, and `mvhd`'s duration field is
literally `0`. Verify it in twenty lines of `node` — walk the top-level boxes — because ffmpeg
and ffprobe are not installed in this repo and nothing here transcodes. See § The chapters for
what that costs a player.

⚠ **THE DEMO'S AI OUTPUT IS SEEDED, NOT COMPUTED, AND A FUTURE READER MUST NOT MISTAKE IT FOR
LIVE MODEL OUTPUT.** The demo stack runs with `ANTHROPIC_API_KEY=dummy`, so no model call in it
can succeed and none is made. Two things on screen would otherwise look like model output:

- the **addressed check** in the "Was it dealt with?" chapter — one hand-written row seeded by
  `apps/backend/scripts/seed-addressed-check.ts` into the plugin's `pr_comment_annotations`,
  read back through the ordinary cached-read route;
- the **ML severity labels** on bot comments — 2,945 `ml_comment_labels` rows seeded by
  `seed-demo.ts` / `seed-estate.ts`, which no `severity-api` ever scored.

Nothing is stubbed, intercepted or special-cased to achieve either: the rows are real rows and
the app reads them by its real route. What is seeded is the *content*, not the mechanism.

### The chapters

**Captions are no longer burned into the pixels.** They used to be `fillText` into a strip below
the app, which is why the frame used to be 1180×710 rather than 1180×664. Burned text cannot be
selected, translated, searched, read by a screen reader or restyled, and it pins the clip to one
language and one column width forever. So phase 2 now writes `limn-walkthrough.cues.json` beside
the video and `VideoFrame.tsx` renders it as a chapter list.

`Home.tsx` **imports that JSON file directly** (`../../public/demo/limn-walkthrough.cues.json`)
rather than retyping the strings — the capture pipeline's output IS the source, so the words on
the page cannot drift out of step with the frames they describe. It costs ~1.2 kB in the bundle.
The same file is also served at `/demo/limn-walkthrough.cues.json`.

Four things the player has to get right, each with a reason:

- **`loop` is never set, and the clip is never rewound on `ended`.** It stops on its last frame
  and an obvious **Replay** button appears over it. Returning to the poster instead would throw
  the reader back to the first screen the instant the last one finished, and un-light the chapter
  they were reading; the last frame is the thing the last chapter is about, so it stays up.
- ⚠ **Nothing may read `video.duration`.** This is a fragmented MP4 straight out of MediaRecorder
  with no `sidx` and no total duration in its header, so `duration` reads `Infinity`/`NaN` until
  enough has buffered. Every position in the player is an absolute `currentTime` compared against
  an absolute cue `startMs`. No fractions of a duration, no progress bar of our own.
- ⚠ **The last cue's `endMs` overshoots the file** — 28,123 ms of cues against 28,013 ms of video,
  one frame plus container rounding. So `endMs` is never consulted at all: the active chapter is
  the last one whose `startMs` has been passed, which makes the final cue "until the end" by
  construction and means nothing can seek to an `endMs`.
- ⚠ **Seeking needs HTTP Range, and `seekable.length === 0` is NOT the tell.** Through
  `@fastify/static` (what `app.ts` serves this site with) the file answers `accept-ranges: bytes`
  and a ranged GET returns `206` with a correct `content-range`, so the chapter list seeks —
  MEASURED. Behind a server that ignores Range, MEASURED in Chromium: `seekable.length` is **1**,
  not 0; it simply ends at 8.32 s of a 28 s clip, `duration` reports that same wrong 8.32 s, no
  error is raised anywhere, and clicking a later chapter moves the playhead *backwards*. So the
  player VERIFIES after the fact that the playhead landed where it was sent, and a control that
  did not move it stops rendering as a `<button>`. A dead control that still looks clickable is
  worse than no control.

The chapter list is in the **prerendered HTML**, so it is readable with JavaScript off, before
play, and by a crawler. The `<video>` is not: it is mounted by an effect, which is also what
keeps a `<video>` out of the static output — see § The motion policy.

### Adding a scene, or a whole new scenario

**A scenario is data, and a different tour is a different FILE** —
`scripts/demo-video/scenario.<name>.mjs`, picked with `--scenario <name>`. Never fork the
capture script. A scene looks like this:

```js
{
  id: 'bots',
  title: 'Bots',                              // the chapter heading
  text: 'Every review bot: how much it says…', // the chapter sentence
  url: '?view=activity&activityRepo=bots',
  ready: '[data-testid="bot-roi-panel"]',      // the selector that means "this screen painted"
  settleMs: 3400,
  scale: 1,                                    // deviceScaleFactor; higher if the scene zooms
  before: async (page) => { /* position a scroller for free, emits no frames */ },
  expect: { selector: '…', min: 4 },           // refuse to film a screen with no data on it
  steps: [
    { hold: 1900 },
    { zoom: { selector: '…', ms: 480, width: 900, anchor: 'left', offset: [-245, 60] } },
    { hold: 2000 },
  ],
}
```

`title` + `text` become that scene's cue, so **a new scene is a new chapter on the landing page
for free** — and they are product voice like any other string on the site: plain English,
shortest honest version, name the thing.

Things the script will refuse rather than film quietly, each of which has already cost a run:

- **a scene that produced no frames**, and a scene whose `expect` count is not met — a screen
  that films itself empty is the defect that matters most here;
- **a `zoom` whose target ends up wider than 92% of the frame.** Every panel in this app is
  full-width at a 1180px viewport, so a bare selector almost always lands there; cap it with
  `width`/`maxWidth` and shift the framing with `offset`. A zoom to the whole frame is not a
  zoom, and it fails by simply holding still;
- **a `zoom` that would upscale** — at `scale` 1 the no-upscale floor is 1770 CSS px in a 1180px
  frame, so a zooming scene needs `scale: 2` or more;
- **a timeline over the scenario's `budgetMs`** (45 s), and odd encode dimensions.

⚠ **Anchor a zoom on the pane's own chrome, not on its content.** `reviewer-provenance` and
`bot-triage-card` each cost a failed run: they are present on most loads and absent when the
query behind them 502s against a demo stack that has no GitHub behind it.

⚠ **There is no `changes` scene**, for the same reason there is no `pr-changes.png` still: the
Changes tab hydrates its patches from GitHub on demand, and against this database it correctly
renders "inline diffs aren't available for this PR".

⚠ **There is no `pending` scene either, and that was deliberate.** A ranked queue reads as a
plain list of rows until you know what ranked it, and a clip cannot explain a scoring function.
Its argument moved to the landing copy — `Home.tsx` § `02 · The board` — where the weights,
the buckets and the approval rule are stated in words. If Pending ever comes back to the clip,
that copy is what has to earn its place beside it.

### Re-recording it

```sh
pnpm demo:video                 # seed → boot the Pro stack → film → teardown
pnpm demo:video --publish       #   … and also write the copies under apps/landing/public/demo/

# or, against a stack you already have up (`pnpm demo --no-seed`):
node scripts/capture-demo-video.mjs --out ~/ --publish
node scripts/capture-demo-video.mjs --scenario ./my-scenario.mjs
node scripts/capture-demo-video.mjs --keep-frames   # leave phase 1's PNGs on disk to inspect
node scripts/capture-demo-video.mjs --bpp 0.13      # the ONE size knob (see below)
```

`--out` defaults to your home directory (the masters). `--publish` additionally writes
`apps/landing/public/demo/`, which is what the site serves — all three files, video, poster and
cues. **Publishing all three together is the point:** a cue file that does not match the video
beside it lights the wrong chapter with no error anywhere.

### How it is made, and why it is this shape

`scripts/capture-demo-video.mjs`, in two phases.

1. **Capture** — open each scene, let it settle, and photograph it frame by frame with
   `page.screenshot()`. A zoom costs **no extra screenshots at all**: it is the same photograph
   drawn from a shrinking source rectangle. A `before` hook repositions a scroller for free.
2. **Replay and record** — a second page paints those frames into a canvas on a rAF clock and
   records it with `MediaRecorder` (`video/mp4;codecs=avc1.42E01E`), stamping each scene's real
   start and end into the cue file as it goes. This phase is realtime by construction: a
   28-second clip takes 28 seconds.

The viewport, theme, reduced-motion setting and onboarding localStorage seed all come from
`scripts/lib/demo-browser.mjs`, which `capture-shots.mjs` imports too — so the stills and the
clip can never drift into being pictures of two different products.

⚠ **CRISPNESS CAME FROM RESOLUTION, NOT BITRATE, AND THE ENCODER IS WHY.** MEASURED on this
scenario, same six scenes, three target bitrates:

| target | keyframe | motion | held frame | file |
|---|---|---|---|---|
| 0.050 bpp | 0.148 bpp | 0.125 bpp | 0.8 kB | 1,129 kB |
| 0.133 bpp | 0.182 bpp | 0.237 bpp | 1.9 kB | 2,707 kB |
| 0.150 bpp | 0.188 bpp | 0.230 bpp | 1.9 kB | 3,250 kB |

**Chromium's MediaRecorder H.264 encoder saturates at about 0.133 target bits-per-pixel.** Above
it the per-frame sizes stop responding — 0.133 and 0.150 produce *identical* per-frame sizes and
differ only in wasted bytes. "Keyframes near 0.5 bpp" is **not reachable through this encoder at
any setting**. The achieved figures in the shipped file are keyframes **0.193 bpp**, motion
**0.127 bpp**, held frames **0.015 bpp**.

So the picture was fixed by pixels instead:

```
capture   1180 CSS px @ deviceScaleFactor 3   =  3540 device px
encode    1180 × OUT_SCALE (1.5)              =  1770 × 996
display   up to 885 CSS px @ 2 dppx           =  1770 device px      ← 1:1
```

⚠ **And a held screen is not as cheap as its per-frame number suggests.** H.264 keeps spending
~3 kB/frame on a frame that has not changed, refining the *same* picture — so a 2.4-second hold
is roughly **0.45 bpp on what the reader is actually looking at**. Only genuinely moving frames
sit at the low figure. This is the thing that makes 0.127 bpp of motion look alarming and not be.

**Motion is the budget.** MEASURED at the shipped 1770×996 / 12 fps / 0.133 bpp:

| | cost | share of the file |
|---|---|---|
| one keyframe (6 of them) | ~40 kB | 12% |
| one second of zoom | ~333 kB | 46%, from 2.9 s |
| one second held | ~36 kB | 42%, from 24.7 s |

⚠ **A zoom costs roughly 9× a held second**, and 2.9 seconds of it is nearly half the clip. That
is why six scenes fit in 2.5 MB only as hard cuts and short push-ins — which is the edit that was
wanted anyway, so the budget and the taste agree here rather than fighting. A cross-fade changes
every pixel in the frame for its whole duration, which is the most expensive thing you can ask of
an inter-frame codec: five dissolves would cost more than every zoom here. A **scroll** costs the
same bitrate as a zoom AND ~28 MB of decoded bitmap per frame in phase 1, which is why there are
none.

**⚠ `canvas.captureStream(fps)` IS A TRAP, and it fails silently.** Asked for a frame rate,
Chromium only hands the encoder a frame when the canvas content actually CHANGES — and these
clips are mostly held frames, so a 29.55-second timeline once recorded as **8.37 seconds of video
playing 3.5× too fast**, with no error anywhere and a poster that still looked right. The fix, and
the assertion that now guards it, is `captureStream(0)` plus one explicit `requestFrame()` per
slot.

**⚠ Playwright's bundled ffmpeg cannot help with any of this.** It is built
`--disable-everything`: its entire filter set is crop / format / hflip / null / pad / scale /
transpose / trim / vflip. No `drawtext`, no `overlay`, no `fade`, no `zoompan`. So the zoom and
the frame timing happen on the canvas before the encoder sees a pixel, and there is no transcoding
step anywhere in this repo. **The master and the published copy are the same encode**; the tuning
lives in the scenario file, not in a post-pass.

### The motion policy

The site's standing rule is that it does not move, and the CSS blanket in `src/index.css`
enforces it by killing `animation` and `transition`. **A playing `<video>` is neither**, exactly
like the hero rain's rAF canvas loop. So `components/feint/VideoFrame.tsx` checks
`matchMedia('(prefers-reduced-motion: reduce)')` itself, subscribes to its `change` event, and
under reduced motion mounts **no `<video>` at all** — no element, no 2.1 MB fetch, nothing
playing.

**That fallback is now a good one rather than a concession**, and it is the whole argument for
moving the captions out of the pixels: a reader on reduced motion gets the poster still plus
every word the clip would have shown them, as real text. A **Play** button is offered beside it,
because reduced motion means "do not move unless I ask", not "never move" — a reader who presses
Play has asked.

⚠ **Do not reach for a header instead.** MEASURED in Chromium: a script-initiated `play()` on a
muted video succeeds under `Permissions-Policy: autoplay=()` exactly as it does with no policy —
and a header says what is ALLOWED, never what the reader asked for. (For the same reason nothing
in `apps/backend/src/api/plugins/security.ts` needed changing for these clips: the landing CSP
has no `media-src`, so it inherits `default-src 'self'`, which a same-origin `/demo/*.mp4`
already satisfies.)

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

// The landing-page demo video, filmed from the ISOLATED demo stack (seeded
// acme/* data — no real GitHub data, no PII).
//
// ===========================================================================
// HOW IT WORKS, AND WHY IT IS TWO PHASES
//
// PHASE 1 — CAPTURE, deterministically and as slowly as it likes. The app is
// opened once per scene, allowed to settle, and photographed frame by frame with
// `page.screenshot()`. Where a scene scrolls, the script EASES `element.scrollTop`
// itself between frames rather than letting the browser animate: a smooth-scroll
// is wall-clock-dependent and would produce a different pan every run.
//
// PHASE 2 — REPLAY AND RECORD, in real time. A second page paints those frames
// into a canvas on a rAF clock and records it with `MediaRecorder`. This phase is
// REALTIME by construction — a 30-second clip takes 30 seconds — because
// MediaRecorder encodes a live stream and there is no way to ask it to hurry.
//
// ⚠ WHY NOT PLAYWRIGHT'S OWN `recordVideo`? It records the whole viewport at
// whatever rate the compositor happens to run, it emits VP8 in WebM, and the
// bundled ffmpeg it uses is built `--disable-everything`: its entire filter set
// is crop/format/hflip/null/pad/scale/transpose/trim/vflip. No drawtext, no
// overlay, no fade, no zoompan. So the zoom and the frame timing both have to
// happen before the encoder sees a pixel — which is what the canvas in phase 2
// is for.
//
// ===========================================================================
// THE TWO THINGS THAT DECIDE HOW THIS LOOKS: RESOLUTION, THEN BITRATE
//
// RESOLUTION. The clip used to be encoded at the scenario's CSS width (1180) and
// displayed in 1166 CSS px, which on a 2 dppx screen is 2332 device pixels drawn
// from a 1180-pixel source — a 1.98x UPSCALE before the encoder was involved. It
// sat on a page whose PNG stills are 1788px and lossless, so the clip was the
// only soft thing there. Now:
//
//     capture   1180 CSS px @ deviceScaleFactor 3  =  3540 device px
//     encode    1180 x OUT_SCALE (1.5)             =  1770 x 996
//     display   up to 885 CSS px @ 2 dppx          =  1770 device px
//
// so the wide shot is a 2x DOWNSCALE (supersampling, which is what makes 12px UI
// text legible), and the tightest legal zoom is drawn 1:1 from native pixels.
// Nothing is ever upscaled — `fitRect` refuses a source rect narrower than
// `OUT_W / scale` CSS px, which is why the capture scale is not optional.
//
// BITRATE, AND THE CEILING NOBODY DOCUMENTED. The old clip encoded motion at
// 0.093 bits/pixel and keyframes at 0.258 bpp, against poster JPEGs beside it at
// 0.87-0.90 bpp — PRESSING PLAY VISIBLY DEGRADED THE PICTURE. The obvious fix is
// to raise `videoBitsPerSecond`, and it only half works:
//
// ⚠ CHROMIUM'S MediaRecorder H.264 ENCODER SATURATES, AND ASKING FOR MORE THAN IT
// WILL SPEND IS FREE AND USELESS. MEASURED on this scenario, same six scenes,
// only the target changed:
//
//     target bpp    keyframe      motion       held        file
//        0.050      0.148 bpp    0.125 bpp    0.8 kB     1,129 kB
//        0.133      0.182 bpp    0.237 bpp    1.9 kB     2,707 kB
//        0.150      0.188 bpp    0.230 bpp    1.9 kB     3,250 kB
//
// Between 0.133 and 0.150 the per-frame sizes stop moving: the encoder is already
// at the quality it will give this content and the extra budget goes nowhere. So
// "keyframes near 0.5 bpp" is NOT REACHABLE through this encoder at any setting —
// `MOTION_BPP` is set AT the ceiling (0.133) and the size is controlled by how
// many frames MOVE, which is the only lever left.
//
// ⚠ AND THE KEYFRAME NUMBER UNDERSTATES WHAT THE READER SEES. A held screen keeps
// receiving ~1.9 kB per frame for as long as it is held, which H.264 spends
// REFINING the same picture: a 2.4-second hold is 40 kB of keyframe plus ~55 kB of
// refinement, about 0.45 bpp on the thing the reader is actually looking at. Only
// the moving frames are stuck at the lower figure, and nobody reads a screen while
// it is moving.
//
// ===========================================================================
// MOTION IS THE BUDGET — AND IT IS WHY THE EDIT IS SNAPPY
//
// MEASURED at the old 1180x710 / 12fps / 0.7 Mbps:
//
//     one scene keyframe            ~27 kB
//     one second HELD              ~2.6 kB
//     one second of slow drift      ~17 kB
//     one second of fast motion    ~116 kB
//
// So a second of motion costs ~45x a second of a held screen. (The "5.1x" this
// header used to claim was a whole-clip average across three codecs, not a
// per-second ratio — it made motion look affordable and it was wrong.)
//
// MEASURED at the CURRENT 1770x996 / 12fps / 0.133 bpp, on the shipped scenario:
//
//     one keyframe (6 of them)      ~40 kB     12% of the file
//     one second of zoom            ~333 kB    46% of the file, from 2.9s
//     one second HELD                ~36 kB    42% of the file, from 24.7s
//
// ⚠ A ZOOM COSTS ROUGHLY 9x A HELD SECOND HERE, and 2.9 seconds of it is nearly
// half the clip. That is why six scenes fit in 2.5 MB only as hard cuts and short
// push-ins — which is the edit that was asked for anyway, so the budget and the
// taste agree here rather than fighting. A zoom is exactly as expensive as a
// scroll IN BYTES; what a zoom saves is PHASE 1 (one photograph instead of one
// per frame), which is disk, memory and capture time, not file size.
//
// ===========================================================================
// CAPTIONS ARE NOT IN THE PIXELS
//
// They used to be `fillText` into a strip below the app. They are now a CUES
// FILE written beside the video — `<name>.cues.json`, a list of
// `{ id, startMs, endMs, title, text }` — which the landing page renders as HTML
// beside the clip and as a clickable chapter list. Burned text cannot be
// selected, translated, searched, read by a screen reader or restyled, and it
// pins the clip to one language and one column width forever.
//
// ⚠ CUE TIMES ARE THE RECORDING'S OWN CLOCK, NOT THE PLAN'S. MediaRecorder is
// realtime: if the rAF loop slips, frames are pushed late and the encoded stream
// is shorter than the timeline that drove it. So phase 2 stamps
// `performance.now()` at every `track.requestFrame()` and the cue boundaries are
// read off THOSE stamps. The script prints the worst gap between planned and
// real, and refuses a recording whose real duration missed the plan.
//
// ⚠ THE MP4 IS FRAGMENTED — it comes straight out of MediaRecorder, as four
// `moof`/`mdat` pairs with no duration in the file header. MEASURED, because the
// guess here was wrong in both directions:
//
//   · Served by something that HONOURS Range, `<video preload="auto">` reports
//     the real duration (27.98s against a 28.12s cue list) and `seekable` covers
//     the whole clip as soon as `canplaythrough` fires. Chapter clicks work.
//   · Served by something that does NOT honour Range — a hand-rolled dev server,
//     a proxy that strips it — `duration` reads 8.3s (the FIRST FRAGMENT) and
//     `seekable.end(0)` is 0. Seeking is then a silent no-op: `currentTime = 20`
//     leaves `currentTime` at 0 and no event fires. Nothing errors.
//
// So a chapter list is fine on any normal static host, and the thing to check
// when it stops working is Range support, not the cue file. Read progress off
// absolute `currentTime`, never `currentTime / duration`.
//
// ⚠ THE LAST CUE'S `endMs` CAN EXCEED THE FILE'S OWN DURATION by up to one frame
// (83ms) plus container rounding — it is the last frame's start plus the slot it
// is displayed for, and the container rounds differently. Treat the final cue as
// "until the end" rather than seeking to its `endMs`.
//
// ===========================================================================
// USAGE
//
//   node scripts/capture-demo-video.mjs                        # the walkthrough
//   node scripts/capture-demo-video.mjs --scenario ./my.mjs --out /tmp
//   node scripts/capture-demo-video.mjs --keep-frames          # leave phase 1 on disk
//
// It needs the demo stack already running (`pnpm demo --no-seed`), or use the
// one-command wrapper which boots and tears it down: `pnpm demo:video`.
//
// `--out` DEFAULTS TO THE HOME DIRECTORY (the masters). The copies under
// apps/landing/public/demo/ are written by `--publish`.
// ===========================================================================
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ctx, launch, open, watchPage } from './lib/demo-browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PUBLIC_DEMO = join(ROOT, 'apps', 'landing', 'public', 'demo');

// ---------------------------------------------------------------------------
// Output geometry. See the header's display arithmetic — these three constants
// are the whole of it.
// ---------------------------------------------------------------------------

/** Encoded size ÷ the scenario's CSS layout width. 1180 x 1.5 = 1770 x 996. */
const OUT_SCALE = 1.5;

/**
 * `deviceScaleFactor` every scene is photographed at unless it says otherwise.
 *
 * ⚠ 3 IS LOAD-BEARING TWICE. It makes the wide shot a 2x supersampled downscale
 * (3540 -> 1770), and it sets the zoom floor: `fitRect` will not draw a source
 * rect narrower than `OUT_W / scale` CSS px, so scale 3 permits a 2x push-in
 * (590 CSS px) at native sharpness while scale 2 only permits 1.33x and scale 1
 * FORBIDS ZOOMING ALTOGETHER. A scene may lower it, but then it may not zoom far.
 *
 * The cost is memory in phase 2, where every DISTINCT frame image is decoded at
 * once: a 3540x1992 bitmap is ~28 MB. That is affordable only because the
 * scenario is built from holds and zooms — a zoom reuses its scene's ONE
 * photograph. A three-second SCROLL at this scale would be 36 images and a
 * gigabyte, which is the real reason there are no long scrolls.
 */
const CAPTURE_SCALE = 3;

/**
 * Bits per pixel the encoder is aimed at DURING MOTION. `videoBitsPerSecond` is
 * derived from it so the number in the log is arithmetic rather than folklore.
 * 0.20 is the middle of the 0.15-0.25 band screenshot-grade text needs; held
 * frames undershoot it by an order of magnitude on their own, which is why the
 * whole-clip average comes out far below this figure.
 */
const MOTION_BPP = 0.133;

// ---------------------------------------------------------------------------
// Frame rates. TWO of them, and the split is the whole size argument.
//
// A held screen is emitted as ONE captured image repeated by the replay clock —
// the encoder sees an identical frame and spends almost nothing on it. Only the
// moving parts are photographed repeatedly, at 12 fps: below that a zoom judders
// visibly, above it the file grows for detail nobody can follow.
//
// ⚠ THE TWO RATES ARE DELIBERATELY EQUAL. Recording the canvas at 25 fps while
// the content only changes 12 times a second does not make the clip smoother —
// it hands the encoder a second identical frame to spend bits on. If you raise
// one of these, raise both, and re-measure.
// ---------------------------------------------------------------------------
const MOTION_FPS = 12;
const MOTION_STEP_MS = 1000 / MOTION_FPS;
/** The rate the canvas is captured at in phase 2. Must match MOTION_FPS — see above. */
const RECORD_FPS = MOTION_FPS;

// ---------------------------------------------------------------------------
// The two ceilings. Both are ASSERTED, not aspired to.
// ---------------------------------------------------------------------------
const MAX_MS = 45_000;
const MAX_BYTES = 2_500_000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) return true;
  return v;
};
const SCENARIO_ARG = String(flag('scenario', 'walkthrough'));
const OUT_DIR = String(flag('out', homedir()));
const KEEP_FRAMES = flag('keep-frames', false) === true;
const PUBLISH = flag('publish', false) === true;
// `--bpp 0.13` — the tuning knob, and the ONLY one that moves file size without
// re-cutting the scenario. It exists because the encoder does not track the
// target exactly (MEASURED on the old clip: motion came out at ~1.3x the target
// while held frames came out at a fraction of it), so the number that fits the
// budget has to be found by recording, not by arithmetic. Put the value you
// settle on into MOTION_BPP.
const BPP = Number(flag('bpp', 0)) || null;

// ---------------------------------------------------------------------------
// easing — one curve, used by both the scroll and the zoom so a scene that does
// both does not appear to change its mind about how it moves.
// ---------------------------------------------------------------------------
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function loadScenario(arg) {
  const path = arg.includes('/') || extname(arg) === '.mjs'
    ? (isAbsolute(arg) ? arg : resolve(process.cwd(), arg))
    : join(HERE, 'demo-video', `scenario.${arg}.mjs`);
  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (err) {
    fail(`cannot load scenario "${arg}" (${path})\n  ${err.message}`);
  }
  const s = mod.default;
  if (!s || !Array.isArray(s.scenes) || s.scenes.length === 0) {
    fail(`scenario "${arg}" exports no scenes`);
  }
  return { scenario: s, path };
}

// ===========================================================================
// PHASE 1 — capture
// ===========================================================================

/**
 * Photograph one scene into `dir`, appending manifest entries.
 *
 * A manifest entry is `{ file, hold, src }`: the image to draw, how long to hold
 * it, and WHICH RECTANGLE OF IT to draw. The third field is what makes a zoom
 * cost one screenshot — a zoom is the same photograph drawn from a shrinking
 * source rect, not a second photograph.
 */
async function captureScene(browser, scenario, scene, dir, frames, report) {
  const scale = scene.scale ?? scenario.scale ?? CAPTURE_SCALE;
  const W = scenario.width;
  const H = scenario.height;
  const outW = Math.round(W * OUT_SCALE);
  const c = await ctx(browser, { width: W, height: H, scale, pane: scene.pane });
  const page = await c.newPage();
  const errors = watchPage(page);

  await open(page, scene.url, scene.ready, { settleMs: scene.settleMs ?? 2500 });
  if (scene.before) await scene.before(page);

  // ---- the scene's own precondition ---------------------------------------
  // ⚠ "THE READY SELECTOR PAINTED" IS NOT "THE SCREEN HAS CONTENT". The timeline
  // is the case that proves it: `.vis-timeline` and all 47 group rows appear
  // while every PR bar is still at x=0, because vis-timeline positions items
  // inside rAF and a throttled renderer never runs one. Filming that produces an
  // empty board with no error anywhere — so a scene may demand a MINIMUM count of
  // something only a real screen has.
  if (scene.expect) {
    const { selector, min } = scene.expect;
    const n = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (n < min) {
      fail(
        `scene "${scene.id}": expected at least ${min} of "${selector}", found ${n}.\n` +
          `  The screen painted but it is empty. For the timeline this is the rAF landmine — check the\n` +
          `  browser was launched with CAPTURE_LAUNCH_ARGS (scripts/lib/demo-browser.mjs). Do not ship\n` +
          `  the scene without its content; leave it out instead.`,
      );
    }
    report.push(`    expect ${selector} ≥ ${min} → ${n} ✓`);
  }

  let shotIndex = 0;
  const shoot = async () => {
    const file = `${scene.id}-${String(shotIndex++).padStart(4, '0')}.png`;
    await page.screenshot({ path: join(dir, file) });
    return file;
  };

  const FULL = { x: 0, y: 0, w: W * scale, h: H * scale };
  let lastFile = null;
  let src = FULL;

  for (const step of scene.steps) {
    // ---- hold: one photograph, held ---------------------------------------
    if (step.hold != null) {
      const file = await shoot();
      lastFile = file;
      frames.push({ file, hold: step.hold, src });
      continue;
    }

    // ---- set: reposition WITHOUT filming the journey -----------------------
    // The cheap alternative to a scroll, and the reason there are no long pans in
    // the shipped scenario. It emits NO frames: it moves an element's scroll
    // offsets and the NEXT `hold` photographs the new position, so the clip cuts
    // there. One screenshot, zero motion, zero bitrate.
    //
    // It is the only way to film the ROI table's right-hand columns at all — that
    // table is 1680px wide inside an 868px panel, so its Inflation column is 375px
    // outside the frame until something sets `scrollLeft`.
    if (step.set) {
      const { selector, scrollTop, scrollLeft } = step.set;
      const moved = await page.evaluate(
        ([sel, top, left]) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          if (top != null) el.scrollTop = top;
          if (left != null) el.scrollLeft = left === 'end' ? el.scrollWidth : left;
          return { top: el.scrollTop, left: el.scrollLeft };
        },
        [selector, scrollTop ?? null, scrollLeft ?? null],
      );
      if (!moved) fail(`scene "${scene.id}": set selector matched nothing — ${selector}`);
      // ⚠ ASSERT IT ACTUALLY MOVED. A `scrollTop` on an element that does not
      // scroll silently stays 0, and the scene then films the position it was
      // already in — the same "it just held still" failure a no-op zoom has.
      if (scrollTop != null && Math.abs(moved.top - scrollTop) > 2 && moved.top === 0) {
        fail(`scene "${scene.id}": "${selector}" did not take scrollTop ${scrollTop} (it does not scroll vertically)`);
      }
      if (scrollLeft != null && moved.left === 0 && scrollLeft !== 0) {
        fail(`scene "${scene.id}": "${selector}" did not take scrollLeft ${scrollLeft} (it does not scroll horizontally)`);
      }
      await page.waitForTimeout(step.set.settleMs ?? 500);
      // A reposition is a CUT, and a cut comes back to the wide frame. Keeping a
      // zoom rect across it would crop a screen the zoom was never aimed at.
      src = FULL;
      report.push(`    set ${selector.slice(0, 40)} → top ${moved.top}, left ${moved.left}`);
      continue;
    }

    // ---- scroll: eased scrollTop, one photograph per motion frame ----------
    // ⚠ EXPENSIVE ON BOTH AXES NOW. Every frame is a distinct 3540x1992 image, so
    // a scroll costs bitrate AND ~28 MB of decoded bitmap per frame in phase 2.
    // Reposition a screen with `before()` (free) and move the CAMERA with a zoom
    // (one photograph) unless the scroll itself is the point.
    if (step.scroll) {
      const { selector, to, ms } = step.scroll;
      const from = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
      }, selector);
      if (!from) fail(`scene "${scene.id}": scroll selector matched nothing — ${selector}`);
      if (from.max < 40) {
        fail(
          `scene "${scene.id}": "${selector}" does not scroll (scrollHeight - clientHeight = ${from.max}px). ` +
            `A scroll step over a non-scrolling element films a still and says nothing.`,
        );
      }
      const target = Math.min(to, from.max);
      if (target < from.top + 40) {
        fail(`scene "${scene.id}": scroll target ${to} is at or above the current position`);
      }
      const n = Math.max(2, Math.round(ms / MOTION_STEP_MS));
      for (let i = 1; i <= n; i++) {
        const y = from.top + (target - from.top) * easeInOut(i / n);
        await page.evaluate(
          ([sel, v]) => {
            const el = document.querySelector(sel);
            if (el) el.scrollTop = v;
          },
          [selector, y],
        );
        const file = await shoot();
        lastFile = file;
        frames.push({ file, hold: MOTION_STEP_MS, src });
      }
      report.push(`    scroll ${selector.slice(0, 44)} → ${Math.round(target)}px over ${ms}ms (${n} frames)`);
      continue;
    }

    // ---- zoom: same photograph, shrinking source rect ----------------------
    if (step.zoom) {
      if (!lastFile) fail(`scene "${scene.id}": a zoom needs a held frame before it`);
      const { selector, ms } = step.zoom;
      // A SHORT timeout on purpose. The element is meant to be on a screen that
      // has already settled, so "not there in 8 seconds" means the scenario is
      // pointing at something conditional — say it, rather than stalling for the
      // 30-second default and then throwing a stack trace.
      const box = await page
        .locator(selector)
        .first()
        .boundingBox({ timeout: 8000 })
        .catch(() => null);
      if (!box) {
        fail(
          `scene "${scene.id}": zoom target never appeared — ${selector}\n` +
            `  Anchor a zoom on something that is ALWAYS on the settled screen. A chip that ` +
            `depends on a GitHub-backed query is not: the demo stack has no GitHub behind it.`,
        );
      }
      // ⚠ THE TARGET MUST BE IN THE PHOTOGRAPH. `boundingBox()` answers in page
      // coordinates and happily reports an element below the fold or off the right
      // edge of a horizontally-scrolling table — the ROI table's Inflation column
      // is exactly that. `fitRect` then CLAMPS the frame back into the viewport,
      // so the zoom silently lands on whatever happens to be at the edge instead.
      // Refuse it: scroll the target into the shot with `before()` first.
      //
      // ⚠ CLIP TO THE FRAME, THEN JUDGE THE REMAINDER. `fitRect` frames around the
      // box's CENTRE, so a box that hangs off the bottom would be framed around a
      // centre that is not in the picture — but demanding full containment refuses
      // honest targets, because nearly every panel in this app is taller than a
      // 664px viewport (`workspace-flow-metrics` is 842px). So the box is CLIPPED
      // to the photograph and the framing is computed from the part that is in it.
      // What is refused is a target with (almost) nothing in shot: the ROI table's
      // Inflation column sits at x=1555 of a 1180px frame until a `set` step
      // scrolls it in, and clamping that back into view would frame the wrong
      // columns with no error.
      const overlap =
        Math.max(0, Math.min(box.x + box.width, W) - Math.max(box.x, 0)) *
        Math.max(0, Math.min(box.y + box.height, H) - Math.max(box.y, 0));
      const area = Math.max(1, box.width * box.height);
      if (overlap < area * 0.25) {
        fail(
          `scene "${scene.id}": zoom target "${selector}" is outside the ${W}×${H} frame ` +
            `(x ${Math.round(box.x)}..${Math.round(box.x + box.width)}, y ${Math.round(box.y)}..${Math.round(
              box.y + box.height,
            )}; ${Math.round((overlap / area) * 100)}% of it is in shot).\n` +
            `  The screenshot does not contain it, so the zoom would frame something else. Bring it ` +
            `into view with the scene's \`before()\` hook or a \`set\` step — a horizontally-scrolling ` +
            `table needs its own scrollLeft, not scrollIntoView on the page.`,
        );
      }
      // ⚠ IN THE VIEWPORT IS NOT THE SAME AS ON THE SCREEN, AND THIS ONE COST A
      // RUN. `boundingBox()` reports the LAYOUT box, which ignores every clipping
      // ancestor: the Addressed-check panel scrolled up behind the PR pane's own
      // sticky header reported a perfectly reasonable y=260 while being invisible,
      // and the zoom framed a body whose heading was nowhere in the picture.
      // `elementFromPoint` answers the question that actually matters — is this
      // thing painted where we think it is — and catches an overlay sitting on top
      // of it for free. It is asked at the centre of the VISIBLE part, so a panel
      // taller than the viewport still passes.
      const painted = await page
        .locator(selector)
        .first()
        .evaluate((el, frame) => {
          const r = el.getBoundingClientRect();
          const cx = (Math.max(r.left, 0) + Math.min(r.right, frame[0])) / 2;
          const cy = (Math.max(r.top, 0) + Math.min(r.bottom, frame[1])) / 2;
          const hit = document.elementFromPoint(cx, cy);
          return hit == null ? 'nothing' : el.contains(hit) || hit.contains(el) ? 'ok' : (hit.tagName || '?').toLowerCase();
        }, [W, H])
        .catch(() => 'ok');
      if (painted !== 'ok') {
        fail(
          `scene "${scene.id}": zoom target "${selector}" is in the layout but not on the screen — ` +
            `the point at its centre belongs to <${painted}>.\n` +
            `  It is clipped by a scrolling ancestor or covered by something on top. A pane's own ` +
            `sticky header does this: scrolling a row to viewport y=260 puts it BEHIND the header when ` +
            `the scroller starts at y=370. Position it inside the scroller's visible band.`,
        );
      }
      const visible = {
        x: Math.max(box.x, 0),
        y: Math.max(box.y, 0),
        width: Math.min(box.x + box.width, W) - Math.max(box.x, 0),
        height: Math.min(box.y + box.height, H) - Math.max(box.y, 0),
      };
      const to = fitRect(visible, step.zoom, W, H, scale, outW, scene.id);
      const n = Math.max(2, Math.round(ms / MOTION_STEP_MS));
      for (let i = 1; i <= n; i++) {
        frames.push({ file: lastFile, hold: MOTION_STEP_MS, src: lerpRect(src, to, easeInOut(i / n)) });
      }
      src = to;
      report.push(
        `    zoom → ${Math.round(to.w / scale)}×${Math.round(to.h / scale)} CSS px over ${ms}ms ` +
          `(${(W / (to.w / scale)).toFixed(2)}×, ${(to.w / outW).toFixed(2)} source px per output px)`,
      );
      continue;
    }

    // ---- zoom back out -----------------------------------------------------
    if (step.zoomOut) {
      if (!lastFile) fail(`scene "${scene.id}": a zoom-out needs a held frame before it`);
      const n = Math.max(2, Math.round(step.zoomOut.ms / MOTION_STEP_MS));
      const from = src;
      for (let i = 1; i <= n; i++) {
        frames.push({ file: lastFile, hold: MOTION_STEP_MS, src: lerpRect(from, FULL, easeInOut(i / n)) });
      }
      src = FULL;
      continue;
    }

    fail(`scene "${scene.id}": unrecognised step ${JSON.stringify(step)}`);
  }

  await c.close();
  return { errors, shots: shotIndex };
}

/**
 * Grow a CSS-pixel bounding box to the output aspect ratio, clamp it to the
 * viewport, and refuse to go tighter than 1:1 against the captured pixels.
 *
 * ⚠ THE FLOOR IS THE POINT, AND IT IS SET BY THE OUTPUT WIDTH, NOT THE LAYOUT
 * WIDTH. A source rect of `w` CSS px holds `w * scale` real pixels and is drawn
 * into `outW` of them; once `w * scale < outW` the canvas is upscaling a
 * photograph and the reader appears to move closer to detail the interpolator
 * invented. So the floor is `outW / scale` CSS px:
 *
 *     scale 1  →  1770 CSS px floor in a 1180 frame  →  NO ZOOM IS POSSIBLE
 *     scale 2  →   885 CSS px  →  at most a 1.33x push-in
 *     scale 3  →   590 CSS px  →  a 2x push-in, drawn 1:1
 */
function fitRect(box, spec, W, H, scale, outW, sceneId) {
  const { pad = 20, maxWidth, width, anchor = 'center', offset = [0, 0] } = spec;
  const aspect = W / H;
  // ⚠ `width` IS THE ONLY KNOB THAT CAN LOOSEN A ZOOM, AND THAT IS NOT OBVIOUS.
  // `maxWidth` only CAPS: a small anchor (a tab, a table header, a panel heading)
  // derives a tiny rect, which the no-upscale floor below then raises to exactly
  // `outW / scale` — so every zoom onto a small element lands at the SAME tightest
  // legal framing however large `maxWidth` is, and raising it changes nothing.
  // That matters because the tightest framing is wrong for prose: at 590 CSS px
  // of a 1180px screen the addressed-check panel's own sentences ran off both
  // sides mid-word, which reads as a broken capture rather than a close-up.
  // Say `width` when the shot has to fit a column of text; leave it off when the
  // shot is chips, tiles or bars and closer is better.
  //
  // It is also the file-size knob. Motion bytes track how FAR the picture travels,
  // so a 1.3x push costs roughly half a 2x one — see MOTION IS THE BUDGET.
  let w = width ?? Math.min(box.width + pad * 2, maxWidth ?? Infinity);
  let h = width != null ? width / aspect : box.height + pad * 2;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;

  const minW = outW / scale;
  if (minW > W * 0.92) {
    fail(
      `scene "${sceneId}": at deviceScaleFactor ${scale} the no-upscale floor is ${Math.round(minW)} CSS px ` +
        `in a ${W}px frame, which leaves no room to zoom. Raise the scene's \`scale\` (3 gives a 2x push-in).`,
    );
  }
  if (w < minW) {
    w = minW;
    h = w / aspect;
  }
  w = Math.min(w, W);
  h = Math.min(h, H);
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;

  const cx =
    anchor === 'left' ? box.x + w / 2 : anchor === 'right' ? box.x + box.width - w / 2 : box.x + box.width / 2;
  // `offset` nudges the FRAMING without moving the anchor. The element decides
  // which part of the screen the zoom is about (and fails loudly if it is gone);
  // the offset decides what else fits in the shot beside it — here, the row
  // labels down the left, which no element of their own describes.
  let x = cx - w / 2 + (offset[0] ?? 0);
  let y = box.y + box.height / 2 - h / 2 + (offset[1] ?? 0);
  x = Math.max(0, Math.min(x, W - w));
  y = Math.max(0, Math.min(y, H - h));

  // ⚠ A ZOOM THAT ENDS AT THE FULL FRAME IS NOT A ZOOM, and it fails SILENTLY:
  // the clip simply holds still for its whole duration and nobody reviewing it
  // knows a step was skipped. Every panel in this app is full-width at a 1180px
  // viewport, so a bare selector almost always lands here — cap it with `maxWidth`.
  if (w > W * 0.92) {
    fail(
      `scene "${sceneId}": the zoom target is ${Math.round(w)}px wide in a ${W}px frame, which is not a zoom. ` +
        `Give the step a \`maxWidth\` (and an \`anchor\`), or pick a narrower element.`,
    );
  }
  return { x: x * scale, y: y * scale, w: w * scale, h: h * scale };
}

const lerpRect = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

// ===========================================================================
// PHASE 2 — replay into a canvas and record
// ===========================================================================

const RECORDER_HTML = (cfg) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #000; }
  canvas { display: block; }
</style>
<canvas id="c" width="${cfg.W}" height="${cfg.H}"></canvas>
<script type="module">
window.__cfg = ${JSON.stringify(cfg)};
</script>
`;

/**
 * Runs INSIDE the recorder page. Preloads every distinct frame image, then draws
 * on a rAF clock and records the canvas.
 *
 * Returns the recording's OWN clock alongside the video: `stamps[k]` is
 * `performance.now()` at the moment frame `k` was handed to the encoder. That is
 * the only honest basis for a cue list — see the header.
 */
async function replayAndRecord(page, cfg) {
  return page.evaluate(async (cfg) => {
    const canvas = document.getElementById('c');
    const g = canvas.getContext('2d', { alpha: false });

    // ---- preload every distinct image ------------------------------------
    const names = [...new Set(cfg.frames.map((f) => f.file))];
    const images = new Map();
    await Promise.all(
      names.map(
        (n) =>
          new Promise((ok, no) => {
            const img = new Image();
            img.onload = () => {
              images.set(n, img);
              ok();
            };
            img.onerror = () => no(new Error(`frame ${n} failed to load`));
            img.src = `/frames/${n}`;
          }),
      ),
    );

    // ---- a flat timeline: cumulative start time per frame ------------------
    let t = 0;
    const timeline = cfg.frames.map((f) => {
      const entry = { ...f, start: t, end: t + f.hold };
      t += f.hold;
      return entry;
    });
    const totalMs = t;

    const drawAt = (ms) => {
      // Binary search would be tidier; a linear cursor is O(1) amortised and the
      // list is a few hundred entries.
      let f = timeline[timeline.length - 1];
      for (let i = 0; i < timeline.length; i++) {
        if (ms < timeline[i].end) {
          f = timeline[i];
          break;
        }
      }
      const img = images.get(f.file);
      g.drawImage(img, f.src.x, f.src.y, f.src.w, f.src.h, 0, 0, cfg.W, cfg.H);
    };

    // Paint frame 0 before the recorder starts so the first encoded frame is a
    // real screen rather than a blank canvas.
    drawAt(0);

    // ⚠ `captureStream(fps)` IS A TRAP HERE, AND IT FAILS SILENTLY.
    // Asked for a frame rate, Chromium only hands the encoder a frame when the
    // canvas content actually CHANGES — and this clip is mostly held frames, so
    // a 29.55-second timeline recorded as 8.37 seconds of video playing three and
    // a half times too fast, with no error anywhere and a poster that still
    // looked right. MEASURED: 117 distinct images out, ~100 frames in the file.
    //
    // `captureStream(0)` + an explicit `requestFrame()` per slot is the fix: the
    // frame count is then ours, the timestamps are wall-clock, and a held screen
    // is encoded as the repeated frames it is (which H.264 charges almost nothing
    // for — that is the whole size argument).
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const rec = new MediaRecorder(stream, {
      mimeType: cfg.mimeType,
      videoBitsPerSecond: cfg.videoBitsPerSecond,
    });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((ok) => (rec.onstop = ok));
    rec.start(250);

    const slotMs = 1000 / cfg.recordFps;
    const t0 = performance.now();
    /** Wall-clock ms at which each frame index actually reached the encoder. */
    const stamps = [];
    let framesPushed = 0;
    await new Promise((finish) => {
      const step = () => {
        const ms = performance.now() - t0;
        // Catch up rather than drift: if the rAF clock slips, push the frames the
        // wall clock says are owed so the clip's length stays honest. Each one is
        // stamped as it goes, so a catch-up burst is VISIBLE in the cue maths
        // rather than quietly shortening the clip under a cue list that still
        // believes the plan.
        while (framesPushed * slotMs <= ms && framesPushed * slotMs < totalMs) {
          drawAt(framesPushed * slotMs);
          track.requestFrame();
          stamps.push(performance.now() - t0);
          framesPushed++;
        }
        if (ms >= totalMs) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    rec.stop();
    await done;

    window.__drawAt = drawAt;
    const blob = new Blob(chunks, { type: cfg.mimeType });
    const base64 = await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
    return { base64, totalMs, distinctImages: names.length, framesPushed, stamps };
  }, cfg);
}

// ===========================================================================
// WHAT THE ENCODER ACTUALLY SPENT
//
// The configured bitrate is a request; this reads the answer out of the file.
// MediaRecorder emits a FRAGMENTED MP4, so the per-frame sizes live in each
// fragment's `trun` box rather than in one `stsz` at the front — walk
// moof > traf > trun and the sample sizes come out in presentation order, 1:1
// with the frames phase 2 pushed.
//
// ⚠ IT IS A REPORT, NOT A GATE. If the box walk ever fails to line up (a codec
// or container change), it says so and the byte ceiling above still holds.
// ===========================================================================
function mp4SampleSizes(buf) {
  const sizes = [];
  const sync = [];
  const walk = (start, end, inTraf) => {
    let p = start;
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let head = 8;
      if (size === 1) {
        // 64-bit size: the only other legal form, and it costs one line to honour.
        size = Number(buf.readBigUInt64BE(p + 8));
        head = 16;
      }
      if (size < head || p + size > end) return false;
      if (type === 'moof' || type === 'traf') {
        if (!walk(p + head, p + size, type === 'traf')) return false;
      } else if (type === 'trun' && inTraf) {
        const flags = buf.readUInt32BE(p + head) & 0xffffff;
        let q = p + head + 4;
        const count = buf.readUInt32BE(q);
        q += 4;
        if (flags & 0x1) q += 4; // data_offset
        let firstFlags = null;
        if (flags & 0x4) {
          firstFlags = buf.readUInt32BE(q);
          q += 4;
        }
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) q += 4; // sample_duration
          let sz = null;
          if (flags & 0x200) {
            sz = buf.readUInt32BE(q);
            q += 4;
          }
          let sf = i === 0 && firstFlags != null ? firstFlags : null;
          if (flags & 0x400) {
            sf = buf.readUInt32BE(q);
            q += 4;
          }
          if (flags & 0x800) q += 4; // composition offset
          if (sz == null) return false;
          sizes.push(sz);
          // bit 16 of the sample flags is `sample_is_non_sync_sample`.
          sync.push(sf == null ? sizes.length === 1 : (sf & 0x10000) === 0);
        }
      }
      p += size;
    }
    return true;
  };
  return walk(0, buf.length, false) && sizes.length > 0 ? { sizes, sync } : null;
}

function reportFrameSizes(buf, plannedFrames, pixels) {
  const parsed = mp4SampleSizes(buf);
  if (!parsed) {
    console.log('  (could not read per-frame sizes out of the fragmented MP4 — skipping the bpp breakdown)');
    return;
  }
  const { sizes, sync } = parsed;
  // Frame k of the recording drew timeline ms k*slotMs. Whether that instant was
  // MOVING is a property of the manifest, so the two lists line up by index.
  const slot = 1000 / RECORD_FPS;
  let t = 0;
  const spans = plannedFrames.map((f) => {
    const s = { start: t, end: t + f.hold, moving: f.hold === MOTION_STEP_MS };
    t += f.hold;
    return s;
  });
  const movingAt = (ms) => spans.find((s) => ms < s.end)?.moving ?? false;
  const bucket = { key: [], motion: [], held: [] };
  for (let i = 0; i < sizes.length; i++) {
    if (sync[i]) bucket.key.push(sizes[i]);
    else if (movingAt(i * slot)) bucket.motion.push(sizes[i]);
    else bucket.held.push(sizes[i]);
  }
  const line = (label, arr) => {
    if (arr.length === 0) return `  ${label.padEnd(16)} none`;
    const total = arr.reduce((a, b) => a + b, 0);
    const mean = total / arr.length;
    return (
      `  ${label.padEnd(16)} ${String(arr.length).padStart(4)} frames · ${(mean / 1024)
        .toFixed(1)
        .padStart(6)} kB each · ${((mean * 8) / pixels).toFixed(3)} bpp · ${(total / 1024)
        .toFixed(0)
        .padStart(5)} kB total (${Math.round((total / buf.length) * 100)}%)`
    );
  };
  console.log('  MEASURED, per frame class:');
  console.log(line('keyframes', bucket.key));
  console.log(line('motion', bucket.motion));
  console.log(line('held', bucket.held));
}

// ===========================================================================
// go
// ===========================================================================
const { scenario, path: scenarioPath } = await loadScenario(SCENARIO_ARG);
const W = scenario.width ?? 1180;
const H = scenario.height ?? 664;
const OUT_W = Math.round(W * OUT_SCALE);
const OUT_H = Math.round(H * OUT_SCALE);
// ⚠ H.264 REQUIRES EVEN DIMENSIONS. An odd one does not error — MediaRecorder
// quietly produces a file some decoders refuse.
if (OUT_W % 2 || OUT_H % 2) {
  fail(
    `H.264 needs even dimensions — ${W}×${H} at OUT_SCALE ${OUT_SCALE} gives ${OUT_W}×${OUT_H}. ` +
      `Adjust the scenario's width/height so both multiply to whole even numbers.`,
  );
}

// Every scene must carry the two strings the cue list is made of. A cue with no
// title is a chapter the landing page cannot render.
for (const s of scenario.scenes) {
  if (!s.title || !s.text) fail(`scene "${s.id}": a scene needs both a \`title\` and a \`text\` for its cue`);
}

console.log(`\n▸ scenario ${scenario.name}  (${scenarioPath.replace(ROOT + '/', '')})`);
console.log(
  `  ${scenario.scenes.length} scene(s) · layout ${W}×${H} CSS · capture ×${scenario.scale ?? CAPTURE_SCALE} ` +
    `(${W * (scenario.scale ?? CAPTURE_SCALE)}×${H * (scenario.scale ?? CAPTURE_SCALE)}) · encode ${OUT_W}×${OUT_H}`,
);

const frameDir = mkdtempSync(join(tmpdir(), 'limn-demo-frames-'));
const frames = [];
const report = [];
const allErrors = [];
/** Scene boundaries in PLANNED timeline ms — the seed for the cue list. */
const plan = [];

const browser = await launch();
const t0 = Date.now();
for (const scene of scenario.scenes) {
  const first = frames.length;
  const startMs = frames.reduce((a, f) => a + f.hold, 0);
  console.log(`\n  ▸ ${scene.id}  ${scene.url}`);
  const r = await captureScene(browser, scenario, scene, frameDir, frames, report);
  // ⚠ ASSERT THE SCENE PRODUCED SOMETHING. `pnpm shots <name>` silently no-ops on
  // an unmatched name and that has cost real time; a scenario that quietly films
  // nothing is the same defect one medium over.
  if (frames.length === first) fail(`scene "${scene.id}" produced no frames`);
  const ms = frames.slice(first).reduce((a, f) => a + f.hold, 0);
  plan.push({ id: scene.id, title: scene.title, text: scene.text, startMs, endMs: startMs + ms });
  console.log(`    ${frames.length - first} frames · ${r.shots} screenshots · ${(ms / 1000).toFixed(1)}s`);
  for (const line of report.splice(0)) console.log(line);
  if (r.errors.length) {
    allErrors.push(...r.errors.map((e) => `[${scene.id}] ${e}`));
  }
}
console.log(`\n  phase 1: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- the duration ceiling ---------------------------------------------------
const totalMs = frames.reduce((a, f) => a + f.hold, 0);
const budget = Math.min(scenario.budgetMs ?? MAX_MS, MAX_MS);
if (totalMs > budget) {
  fail(
    `scenario "${scenario.name}" runs ${(totalMs / 1000).toFixed(2)}s, over its ${(budget / 1000).toFixed(
      1,
    )}s ceiling by ${((totalMs - budget) / 1000).toFixed(2)}s — shorten a hold in ${scenarioPath.replace(
      ROOT + '/',
      '',
    )}`,
  );
}
const motionMs = frames.filter((f) => f.hold === MOTION_STEP_MS).length * MOTION_STEP_MS;
console.log(
  `  timeline: ${(totalMs / 1000).toFixed(2)}s of a ${(budget / 1000).toFixed(1)}s ceiling · ` +
    `${(motionMs / 1000).toFixed(2)}s of it moves (${((motionMs / totalMs) * 100).toFixed(0)}%)`,
);

const bpp = BPP ?? MOTION_BPP;
const videoBitsPerSecond = Math.round(OUT_W * OUT_H * bpp * RECORD_FPS);
console.log(
  `  encoder: ${(videoBitsPerSecond / 1e6).toFixed(2)} Mbps target = ${OUT_W}×${OUT_H} × ${bpp} bpp × ${RECORD_FPS} fps` +
    (BPP ? '  (--bpp override)' : ''),
);

const cfg = {
  W: OUT_W,
  H: OUT_H,
  recordFps: RECORD_FPS,
  mimeType: 'video/mp4;codecs=avc1.42E01E',
  videoBitsPerSecond,
  frames: frames.map((f) => ({ file: f.file, hold: f.hold, src: f.src })),
};
const html = RECORDER_HTML(cfg);

// ---- a tiny origin so the canvas is never tainted ---------------------------
// `drawImage` from file:// taints the canvas and `captureStream` on a tainted
// canvas throws. One same-origin static server is simpler and faster than
// base64-ing a few hundred PNGs through `evaluate`.
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.startsWith('/frames/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(readFileSync(join(frameDir, url.slice('/frames/'.length))));
    }
  } catch {
    /* fall through */
  }
  res.writeHead(404).end('no');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// A SECOND browser. It carries the same anti-throttling flags the app browser
// does (CAPTURE_LAUNCH_ARGS) plus the autoplay policy, because phase 2 is a
// realtime recording driven by rAF: a backgrounded renderer coalesces rAF to 1 Hz
// and the clip records as a handful of frames with no error anywhere.
const recBrowser = await launch();
const recPage = await recBrowser.newPage({ viewport: { width: OUT_W, height: OUT_H + 40 } });
const recErrors = watchPage(recPage);
await recPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

console.log(`\n▸ phase 2: recording ${(totalMs / 1000).toFixed(1)}s in real time…`);
const t1 = Date.now();
const { base64, distinctImages, framesPushed, stamps } = await replayAndRecord(recPage, cfg);
console.log(
  `  done in ${((Date.now() - t1) / 1000).toFixed(1)}s · ${distinctImages} distinct images · ${framesPushed} frames encoded`,
);
const expectedFrames = Math.round((totalMs / 1000) * RECORD_FPS);
if (framesPushed < expectedFrames * 0.95) {
  fail(
    `only ${framesPushed} of ~${expectedFrames} frames reached the encoder — the clip would play ` +
      `${(expectedFrames / Math.max(1, framesPushed)).toFixed(1)}x too fast. See the captureStream note above.`,
  );
}

// ---- the cue list, on the RECORDING'S clock ---------------------------------
//
// `stamps[k]` is when frame k reached the encoder. Chromium timestamps a
// `requestFrame()` capture at the moment it is called, and normalises the first
// one to t=0 in the output, so subtracting stamps[0] gives presentation time in
// the finished file. A cue boundary planned at timeline ms T lands on the first
// frame that DRAWS T or later — `ceil(T / slotMs)` — and takes that frame's real
// stamp. Built this way the cues are contiguous by construction: each one ends
// exactly where the next begins.
const slotMs = 1000 / RECORD_FPS;
const base = stamps[0] ?? 0;
const at = (frameIndex) => {
  const k = Math.min(Math.max(frameIndex, 0), stamps.length - 1);
  return Math.round(stamps[k] - base);
};
const realDurationMs = at(stamps.length - 1) + Math.round(slotMs);
const cues = plan.map((p, i) => ({
  id: p.id,
  startMs: i === 0 ? 0 : at(Math.ceil(p.startMs / slotMs)),
  endMs: i === plan.length - 1 ? realDurationMs : at(Math.ceil(plan[i + 1].startMs / slotMs)),
  title: p.title,
  text: p.text,
}));

// ⚠ THE CUE LIST MUST TILE THE WHOLE CLIP. A gap is a chapter list that goes
// blank mid-video; an overlap is two chapters highlighted at once. Both are
// silent on a page that only ever renders `the cue whose window contains t`.
if (cues[0].startMs !== 0) fail(`cue list does not start at 0 (got ${cues[0].startMs}ms)`);
for (let i = 0; i < cues.length; i++) {
  if (cues[i].endMs <= cues[i].startMs) {
    fail(`cue "${cues[i].id}" is empty or inverted (${cues[i].startMs}..${cues[i].endMs}ms)`);
  }
  if (i > 0 && cues[i].startMs !== cues[i - 1].endMs) {
    fail(
      `cue list is not contiguous between "${cues[i - 1].id}" (ends ${cues[i - 1].endMs}ms) and ` +
        `"${cues[i].id}" (starts ${cues[i].startMs}ms)`,
    );
  }
}
if (cues[cues.length - 1].endMs !== realDurationMs) {
  fail(`cue list ends at ${cues[cues.length - 1].endMs}ms but the clip runs ${realDurationMs}ms`);
}

// How far the recording slipped from the plan. Reported rather than hidden: the
// cue times above are the REAL ones either way, but a big number here means the
// machine could not keep up and the clip itself is short.
const drift = plan.map((p, i) => Math.abs(cues[i].startMs - p.startMs));
const worstDrift = Math.max(...drift);
console.log(
  `  clock: planned ${(totalMs / 1000).toFixed(2)}s, recorded ${(realDurationMs / 1000).toFixed(2)}s · ` +
    `worst cue drift ${worstDrift}ms (cues use the RECORDED times)`,
);
if (realDurationMs < totalMs * 0.95) {
  fail(
    `the recording is ${(realDurationMs / 1000).toFixed(2)}s against a ${(totalMs / 1000).toFixed(2)}s plan — ` +
      `the replay could not keep up, so the clip plays fast. Close other work and run it again.`,
  );
}

// ---- poster ------------------------------------------------------------------
// Frame 0 of the clip, so the still the reader sees before pressing play (and
// INSTEAD of the clip under reduced motion) is the clip's own first picture.
const posterBuf = await recPage.evaluate(async () => {
  // ⚠ REPAINT FRAME 0 FIRST. The replay leaves the canvas showing the LAST frame,
  // and a poster of the last frame is a still of the end of the clip — press play
  // and the picture jumps backwards.
  window.__drawAt(0);
  const canvas = document.getElementById('c');
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.86));
  const b64 = await new Promise((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
  return b64;
});

await recBrowser.close();
await browser.close();
server.close();
if (!KEEP_FRAMES) rmSync(frameDir, { recursive: true, force: true });
else console.log(`  frames kept → ${frameDir}`);

// ---- the byte ceiling --------------------------------------------------------
const video = Buffer.from(base64, 'base64');
console.log(
  `\n  file: ${(video.length / 1024).toFixed(1)} kB · ${((video.length * 8) / realDurationMs / 1000).toFixed(
    2,
  )} Mbps average · ${((video.length * 8) / (framesPushed * OUT_W * OUT_H)).toFixed(3)} bits/pixel over all frames`,
);
reportFrameSizes(video, frames, OUT_W * OUT_H);
if (video.length > MAX_BYTES) {
  fail(
    `the clip is ${(video.length / 1024).toFixed(1)} kB, over the ${(MAX_BYTES / 1024).toFixed(0)} kB ceiling.\n` +
      `  ${(motionMs / 1000).toFixed(2)}s of it moves, and MOTION IS THE BUDGET — a second of movement costs\n` +
      `  tens of times a second held. Shorten or drop a zoom in ${scenarioPath.replace(ROOT + '/', '')}, or\n` +
      `  lower MOTION_BPP (currently ${MOTION_BPP}) if the picture can afford it. Holds are nearly free.`,
  );
}

// ---- write -------------------------------------------------------------------
const poster = Buffer.from(posterBuf, 'base64');
const targets = [OUT_DIR, ...(PUBLISH ? [PUBLIC_DEMO] : [])];
const written = [];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, `${scenario.name}.mp4`);
  const jpg = join(dir, `${scenario.name}-poster.jpg`);
  const json = join(dir, `${scenario.name}.cues.json`);
  writeFileSync(mp4, video);
  writeFileSync(jpg, poster);
  writeFileSync(json, `${JSON.stringify(cues, null, 2)}\n`);
  written.push(mp4, jpg, json);
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`\n✅ ${scenario.name}  ${(realDurationMs / 1000).toFixed(2)}s  ${OUT_W}×${OUT_H}`);
for (const f of written) console.log(`   ${kb(statSync(f).size).padStart(10)}  ${f}`);
console.log('');
for (const c of cues) {
  console.log(
    `   ${String(c.startMs).padStart(6)}–${String(c.endMs).padEnd(6)} ms  ${c.title}`,
  );
}
if (allErrors.length) {
  console.log(`\n⚠ console errors seen while filming (the demo stack has no GitHub behind it,`);
  console.log(`  so the GitHub-touching routes legitimately fail — check these are only those):`);
  for (const e of [...new Set(allErrors)].slice(0, 12)) console.log(`   · ${e}`);
}
if (recErrors.length) {
  console.log(`\n⚠ recorder page errors: ${recErrors.join(' | ')}`);
}

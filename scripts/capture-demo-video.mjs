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
// overlay, no fade, no zoompan. So captions, the zoom and the frame timing all
// have to happen before the encoder sees a pixel — which is exactly what the
// canvas in phase 2 is for.
//
// ⚠ MEASURED ON THIS MACHINE, and the reason the codec is not negotiable:
//     H.264 / MediaRecorder     ~262 kB for 30s   (hold-dominant)
//     VP8 / bundled ffmpeg     1,280 kB for 30s   (a pan)
//     animated WebP              165 kB hold-only, 7,919 kB for the same pan
// Motion costs roughly 5.1x the bitrate of a held frame whatever the codec, so
// the size of this file is decided by how much of it moves — not by the encoder
// settings. That is why the scenarios hold more than they pan.
//
// ===========================================================================
// USAGE
//
//   node scripts/capture-demo-video.mjs                        # the walkthrough
//   node scripts/capture-demo-video.mjs --scenario hero
//   node scripts/capture-demo-video.mjs --scenario ./my.mjs --out /tmp
//   node scripts/capture-demo-video.mjs --keep-frames          # leave phase 1 on disk
//
// It needs the demo stack already running (`pnpm demo --no-seed`), or use the
// one-command wrapper which boots and tears it down: `pnpm demo:video`.
//
// `--out` DEFAULTS TO THE HOME DIRECTORY (the masters). The size-tuned copies
// under apps/landing/public/demo/ are written by `--publish`.
// ===========================================================================
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ctx, open, watchPage } from './lib/demo-browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PUBLIC_DEMO = join(ROOT, 'apps', 'landing', 'public', 'demo');
const MONO_FONT = join(ROOT, 'apps', 'landing', 'src', 'fonts', 'jetbrains-mono-latin-400.woff2');

// ---------------------------------------------------------------------------
// Frame rates. TWO of them, and the split is the whole size argument.
//
// A held screen is emitted as ONE captured image repeated by the replay clock —
// the encoder sees an identical frame and spends almost nothing on it. Only the
// moving parts are photographed repeatedly, at 12 fps: below that a scroll
// judders visibly, above it the file grows for detail nobody can follow at a
// two-second pan speed.
//
// ⚠ THE TWO RATES ARE DELIBERATELY EQUAL. Recording the canvas at 25 fps while
// the content only changes 12 times a second does not make the clip smoother —
// it hands the encoder a second identical frame to spend bits on. If you raise
// one of these, raise both, and re-measure.
//
// MEASURED, and stated as what was actually run rather than per-lever: the
// walkthrough at 25 fps / 1.1 Mbps / three 4-second scrolls came out at 1,640 kB;
// at 12 fps / 0.7 Mbps / three 3-second scrolls it is 954 kB, for a picture that
// looks the same held still. Those three moved TOGETHER, so none of them owns
// the 42% on its own.
// ---------------------------------------------------------------------------
const MOTION_FPS = 12;
const MOTION_STEP_MS = 1000 / MOTION_FPS;
/** The rate the canvas is captured at in phase 2. Must match MOTION_FPS — see above. */
const RECORD_FPS = MOTION_FPS;

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
 * free — a zoom is the same photograph drawn from a smaller source rect, not a
 * second photograph, so a 1.7-second push-in costs one screenshot.
 */
async function captureScene(browser, scenario, scene, dir, frames, report) {
  const scale = scene.scale ?? 1;
  const W = scenario.width;
  const H = scenario.height;
  const c = await ctx(browser, { width: W, height: H, scale, pane: scene.pane });
  const page = await c.newPage();
  const errors = watchPage(page);

  await open(page, scene.url, scene.ready, { settleMs: scene.settleMs ?? 2500 });
  if (scene.before) await scene.before(page);

  // The ground the caption strip is painted on, read off the app rather than
  // guessed, so the strip and the screen above it are the same colour.
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

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

    // ---- scroll: eased scrollTop, one photograph per motion frame ----------
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
      const to = fitRect(box, step.zoom, W, H, scale, scene.id);
      const n = Math.max(2, Math.round(ms / MOTION_STEP_MS));
      for (let i = 1; i <= n; i++) {
        frames.push({ file: lastFile, hold: MOTION_STEP_MS, src: lerpRect(src, to, easeInOut(i / n)) });
      }
      src = to;
      report.push(
        `    zoom → ${Math.round(to.w / scale)}×${Math.round(to.h / scale)} CSS px over ${ms}ms (0 extra screenshots)`,
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
  return { ground, errors, shots: shotIndex };
}

/**
 * Grow a CSS-pixel bounding box to the output aspect ratio, clamp it to the
 * viewport, and refuse to go tighter than 1:1 against the captured pixels.
 *
 * ⚠ THE FLOOR IS THE POINT. A source rect narrower than `width / scale` CSS px
 * is asking the canvas to upscale a photograph — the reader appears to move
 * closer to detail that the interpolator invented. Capture the scene at
 * `scale: 2` and the floor halves.
 */
function fitRect(box, spec, W, H, scale, sceneId) {
  const { pad = 20, maxWidth, anchor = 'center', offset = [0, 0] } = spec;
  const aspect = W / H;
  let w = Math.min(box.width + pad * 2, maxWidth ?? Infinity);
  let h = box.height + pad * 2;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;

  const minW = W / scale;
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
  // the clip simply holds still for 1.7 seconds and nobody reviewing it knows a
  // step was skipped. Every panel in this app is full-width at a 1180px viewport,
  // so a bare selector almost always lands here — cap it with `maxWidth`.
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
  @font-face {
    font-family: 'Demo Mono';
    src: url('/font.woff2') format('woff2');
    font-weight: 400;
    font-display: block;
  }
  html, body { margin: 0; background: #000; }
  canvas { display: block; }
</style>
<canvas id="c" width="${cfg.W}" height="${cfg.H + cfg.captionBarHeight}"></canvas>
<script type="module">
window.__cfg = ${JSON.stringify(cfg)};
</script>
`;

/**
 * Runs INSIDE the recorder page. Preloads every distinct frame image, then draws
 * on a rAF clock and records the canvas.
 *
 * ⚠ THE CAPTION IS DRAWN OUTSIDE THE APP'S PIXELS, in a strip below them. A
 * caption drawn over the screen covers the thing it is describing, and it makes
 * the clip unusable for anything else — the strip can be cropped off, an overlay
 * cannot.
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
    await document.fonts.load(`400 ${cfg.captionPx}px 'Demo Mono'`);
    await document.fonts.ready;

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

      if (cfg.captionBarHeight > 0) {
        g.fillStyle = cfg.ground;
        g.fillRect(0, cfg.H, cfg.W, cfg.captionBarHeight);
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(0, cfg.H, cfg.W, 1);
        if (f.caption) {
          g.fillStyle = `rgba(255,255,255,${(0.78 * (f.captionAlpha ?? 1)).toFixed(3)})`;
          g.font = `400 ${cfg.captionPx}px 'Demo Mono', ui-monospace, monospace`;
          g.textBaseline = 'middle';
          g.fillText(f.caption, 22, cfg.H + cfg.captionBarHeight / 2 + 1);
        }
      }
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
    let framesPushed = 0;
    await new Promise((finish) => {
      const step = () => {
        const ms = performance.now() - t0;
        // Catch up rather than drift: if the rAF clock slips, push the frames the
        // wall clock says are owed so the clip's length stays honest.
        while (framesPushed * slotMs <= ms && framesPushed * slotMs < totalMs) {
          drawAt(framesPushed * slotMs);
          track.requestFrame();
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
    return { base64, totalMs, distinctImages: names.length, framesPushed };
  }, cfg);
}

// ===========================================================================
// go
// ===========================================================================
const { scenario, path: scenarioPath } = await loadScenario(SCENARIO_ARG);
const W = scenario.width ?? 1180;
const H = scenario.height ?? 664;
const CAPTION_BAR = scenario.captionBarHeight ?? 46;
if ((W % 2) | ((H + CAPTION_BAR) % 2)) {
  fail(`H.264 needs even dimensions — got ${W}×${H + CAPTION_BAR}`);
}

console.log(`\n▸ scenario ${scenario.name}  (${scenarioPath.replace(ROOT + '/', '')})`);
console.log(`  ${scenario.scenes.length} scene(s), ${W}×${H} + ${CAPTION_BAR}px caption bar`);

const frameDir = mkdtempSync(join(tmpdir(), 'limn-demo-frames-'));
const frames = [];
const report = [];
let ground = '#111114';
const allErrors = [];

const browser = await chromium.launch({ headless: true });
const t0 = Date.now();
for (const scene of scenario.scenes) {
  const first = frames.length;
  console.log(`\n  ▸ ${scene.id}  ${scene.url}`);
  const r = await captureScene(browser, scenario, scene, frameDir, frames, report);
  ground = r.ground || ground;
  // ⚠ ASSERT THE SCENE PRODUCED SOMETHING. `pnpm shots <name>` silently no-ops on
  // an unmatched name and that has cost real time; a scenario that quietly films
  // nothing is the same defect one medium over.
  if (frames.length === first) fail(`scene "${scene.id}" produced no frames`);
  for (let i = first; i < frames.length; i++) frames[i].caption = scene.caption ?? null;
  const ms = frames.slice(first).reduce((a, f) => a + f.hold, 0);
  console.log(`    ${frames.length - first} frames · ${r.shots} screenshots · ${(ms / 1000).toFixed(1)}s`);
  for (const line of report.splice(0)) console.log(line);
  if (r.errors.length) {
    allErrors.push(...r.errors.map((e) => `[${scene.id}] ${e}`));
  }
}
console.log(`\n  phase 1: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- budget -----------------------------------------------------------------
const totalMs = frames.reduce((a, f) => a + f.hold, 0);
const budget = scenario.budgetMs ?? 30_000;
if (totalMs > budget) {
  fail(
    `scenario "${scenario.name}" runs ${(totalMs / 1000).toFixed(2)}s, over its ${(budget / 1000).toFixed(
      1,
    )}s budget by ${((totalMs - budget) / 1000).toFixed(2)}s — shorten a hold in ${scenarioPath.replace(
      ROOT + '/',
      '',
    )}`,
  );
}
console.log(`  timeline: ${(totalMs / 1000).toFixed(2)}s of a ${(budget / 1000).toFixed(1)}s budget`);

const cfg = {
  W,
  H,
  captionBarHeight: CAPTION_BAR,
  captionPx: scenario.captionPx ?? 15,
  ground,
  recordFps: RECORD_FPS,
  mimeType: 'video/mp4;codecs=avc1.42E01E',
  videoBitsPerSecond: scenario.videoBitsPerSecond ?? 1_100_000,
  frames: frames.map((f) => ({ file: f.file, hold: f.hold, src: f.src, caption: f.caption })),
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
    if (url === '/font.woff2') {
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return res.end(readFileSync(MONO_FONT));
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


// A SECOND browser, with the throttling off. A backgrounded renderer coalesces
// rAF to 1 Hz, and phase 2 is a realtime recording driven by rAF — under
// throttling the clip records as a handful of frames with no error anywhere.
const recBrowser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const recPage = await recBrowser.newPage({ viewport: { width: W, height: H + CAPTION_BAR + 40 } });
const recErrors = watchPage(recPage);
await recPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

console.log(`\n▸ phase 2: recording ${(totalMs / 1000).toFixed(1)}s in real time…`);
const t1 = Date.now();
const { base64, distinctImages, framesPushed } = await replayAndRecord(recPage, cfg);
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

// ---- poster ------------------------------------------------------------------
// Frame 0 of the clip, so the still the reader sees before pressing play (and
// INSTEAD of the clip under reduced motion) is the clip's own first picture.
const posterBuf = await recPage.evaluate(async () => {
  // ⚠ REPAINT FRAME 0 FIRST. The replay leaves the canvas showing the LAST frame,
  // and a poster of the last frame is a still of the end of the clip — press play
  // and the picture jumps backwards.
  window.__drawAt(0);
  const canvas = document.getElementById('c');
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
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

// ---- write -------------------------------------------------------------------
const video = Buffer.from(base64, 'base64');
const poster = Buffer.from(posterBuf, 'base64');
const targets = [OUT_DIR, ...(PUBLISH ? [PUBLIC_DEMO] : [])];
const written = [];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, `${scenario.name}.mp4`);
  const jpg = join(dir, `${scenario.name}-poster.jpg`);
  writeFileSync(mp4, video);
  writeFileSync(jpg, poster);
  written.push(mp4, jpg);
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`\n✅ ${scenario.name}  ${(totalMs / 1000).toFixed(2)}s`);
for (const f of written) console.log(`   ${kb(statSync(f).size).padStart(10)}  ${f}`);
if (allErrors.length) {
  console.log(`\n⚠ console errors seen while filming (the demo stack has no GitHub behind it,`);
  console.log(`  so the GitHub-touching routes legitimately fail — check these are only those):`);
  for (const e of [...new Set(allErrors)].slice(0, 12)) console.log(`   · ${e}`);
}
if (recErrors.length) {
  console.log(`\n⚠ recorder page errors: ${recErrors.join(' | ')}`);
}

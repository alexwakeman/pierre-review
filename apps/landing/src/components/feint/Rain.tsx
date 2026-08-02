import { useEffect, useRef } from 'react';
import { SPRITES } from '../../lib/sprites';
import type { AlienName } from '../../lib/sprites';

// ---------------------------------------------------------------------------
// The rain — notifications falling behind the hero copy.
//
// The site's standing rule is "the site does not move; motion is the game's
// job", and this is the one sanctioned exception. It earns it by being an
// ARGUMENT rather than a decoration: notifications arrive from off the top of
// the page, fall straight down past the headline, and fade to nothing on the
// way. The fading is the product — the storm keeps arriving, and it goes quiet
// before it reaches you. That is why the drops never land, never pile up, never
// interact, and never touch the two words that matter.
//
// It must read as a whisper. Start alpha is 0.16 and the fade is superlinear
// (^1.6), so a drop spends most of its fall under 5 % opacity; at a glance the
// hero is still a still page.
//
// CANVAS, NOT SVG/DOM, and not for the usual "canvas is faster" reason. The
// three that decide it here:
//   · eighteen sprites with per-instance alpha at 60 Hz is eighteen `opacity`
//     writes plus eighteen transform writes per frame in SVG, versus one paint;
//   · the reduced-motion mode is "paint the arrangement once and stop", which
//     is two lines on a canvas and an awkward frozen DOM tree otherwise;
//   · a canvas prerenders to nothing, which is exactly right for a decorative
//     layer — the prerenderer's per-route byte floors measure real prose, and
//     this must not pad them.
//
// PALETTE: flat `#2A2A2E` for BOTH the 'x' and the 'a' cells. Vermilion means
// "a human is needed" and nothing else on this site; it may not decorate. A
// vermilion drop would read as a signal in a field of noise, which is the
// opposite of what the figure below the fold already says.
//
// SPRITE SET: rank 1 and rank 2 only. Rank 3 (`repo`, `review`, `ci`) is the
// work that actually matters and is not noise; `bot` is the boss; and
// `notebook` does not descend — refusing to fall is its entire joke, and one
// falling notebook would spend it.
//
// SSR: nothing here touches `window` outside the effect, and the element itself
// is inert in Node. Do NOT wrap it in a `typeof window` guard — the guard would
// only move the same non-render into a place that is harder to reason about.
// ---------------------------------------------------------------------------

/** Rank 1 and 2, minus the notebook. See the header for why each exclusion. */
const RAIN_SPRITES: readonly AlienName[] = [
  'channel',
  'group',
  'bell',
  'email',
  'meeting',
  'at',
  'thread',
];

const DROP_COUNT = 18;
/** Cell size in CSS px — the UI register, so a drop is 16–22 px across. */
const CELL = 2;
const INK = '#2A2A2E';
const START_ALPHA = 0.16;
/** Superlinear so the drop is nearly gone by the time it is halfway down. */
const FADE_EXPONENT = 1.6;
/** CSS px per second. Faster than the rack's descent, slower than its shots. */
const SPEED = 34;
/** Below this the drop contributes nothing a display can show — skip the runs. */
const ALPHA_FLOOR = 0.002;
/**
 * Fixed seed. The page is prerendered and then re-rendered fresh in the browser,
 * and two visitors comparing screens should see the same page — so the
 * arrangement is a pure function of the seed and the hero's size. `Math.random`
 * would make the reduced-motion still frame different on every load, which is
 * precisely the flicker that mode exists to remove.
 */
const SEED = 0x5eed;

type Drop = {
  name: AlienName;
  /** Horizontal position as a fraction of the usable width — survives a resize. */
  xf: number;
  /** Top edge, in CSS px from the top of the hero. Negative = still off-page. */
  y: number;
};

/**
 * A 32-bit LCG (Numerical Recipes constants). Created inside the effect, never
 * at module scope: a module-scope generator would be advanced by whichever
 * component happened to mount first and stop being reproducible.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function Rain(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const random = makeRandom(SEED);
    const drops: Drop[] = [];

    let width = 0;
    let height = 0;
    let dpr = 1;

    let rafId = 0;
    let lastFrame = 0;
    let onScreen = true;
    let pageVisible = true;
    let reduced = false;

    const pick = (): AlienName => {
      const i = Math.floor(random() * RAIN_SPRITES.length);
      return RAIN_SPRITES[i] ?? 'bell';
    };

    /** Send a drop back above the top edge, at a fresh column and a fresh gap. */
    const respawn = (d: Drop): void => {
      d.name = pick();
      d.xf = random();
      // The gap is a fraction of the hero's height, so the column never fills
      // in on a short viewport and never thins out on a tall one.
      d.y = -(0.06 + random() * 0.5) * height - SPRITES[d.name].rows * CELL;
    };

    const seedDrops = (): void => {
      drops.length = 0;
      for (let i = 0; i < DROP_COUNT; i += 1) {
        const name = pick();
        // Spread the initial fall positions across the whole hero (and a little
        // above it) so the first painted frame is already mid-storm rather than
        // a row of drops queued at the ceiling.
        drops.push({ name, xf: random(), y: (random() * 1.28 - 0.28) * height });
      }
    };

    /** Sync the backing store to the CSS box. Returns true if anything changed. */
    const measure = (): boolean => {
      const w = Math.max(1, Math.round(canvas.clientWidth));
      const h = Math.max(1, Math.round(canvas.clientHeight));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (w === width && h === height && ratio === dpr) return false;

      const previousHeight = height;
      width = w;
      height = h;
      dpr = ratio;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      // Draw in CSS px; the transform absorbs the device ratio.
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      // `xf` is a fraction and needs nothing. `y` is in px, so a hero that grew
      // or shrank would otherwise jump the whole field's fade progress.
      if (previousHeight > 0) {
        const k = h / previousHeight;
        for (const d of drops) d.y *= k;
      }
      return true;
    };

    const paint = (): void => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = INK;

      for (const d of drops) {
        // The fade origin is the TOP EDGE OF THE HERO, not the spawn point above
        // it: a drop must cross into view at full strength and fade across the
        // part a reader can actually see, otherwise the staggering gap would
        // double as an invisible head start on the fade.
        const p = Math.min(1, Math.max(0, d.y / height));
        const alpha = START_ALPHA * Math.pow(1 - p, FADE_EXPONENT);
        if (alpha <= ALPHA_FLOOR) continue;

        const sprite = SPRITES[d.name];
        const x = Math.round(d.xf * Math.max(0, width - sprite.cols * CELL));
        // Snap to the device pixel grid so the runs never straddle a physical
        // pixel and get anti-aliased into a smudge. Never `Math.round` to a
        // whole CSS px — at 34 px/s that visibly steps on a 2× display.
        const y = Math.round(d.y * dpr) / dpr;

        ctx.globalAlpha = alpha;
        for (const run of sprite.runs) {
          ctx.fillRect(x + run.x * CELL, y + run.y * CELL, run.w * CELL, CELL);
        }
      }

      ctx.globalAlpha = 1;
    };

    const step = (now: number): void => {
      rafId = requestAnimationFrame(step);
      // A zero `lastFrame` means this is the first frame after a start or a
      // resume, so dt is 0 and the field carries on exactly where it stopped.
      // The clamp keeps a backgrounded tab's first frame from teleporting.
      const dt = lastFrame === 0 ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      for (const d of drops) {
        d.y += SPEED * dt;
        if (d.y >= height) respawn(d);
      }
      paint();
    };

    const stop = (): void => {
      if (rafId === 0) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const start = (): void => {
      if (rafId !== 0 || reduced || !onScreen || !pageVisible) return;
      lastFrame = 0;
      rafId = requestAnimationFrame(step);
    };

    // Reduced motion is checked HERE, in JS, and not left to the CSS blanket in
    // index.css: that rule kills `animation` and `transition`, and a rAF loop is
    // neither. The mode is a still frame of the same seeded arrangement — the
    // rain must not vanish, because its absence would silently change what the
    // hero says.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = motionQuery.matches;

    const onMotionChange = (event: MediaQueryListEvent): void => {
      reduced = event.matches;
      if (reduced) {
        stop();
        paint();
      } else {
        start();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        onScreen = entry ? entry.isIntersecting : true;
        if (onScreen) start();
        else stop();
      },
      { threshold: 0 },
    );

    const resizeObserver = new ResizeObserver(() => {
      // Only the backing store changes here, never the CSS box (the canvas is
      // `inset-0`), so this cannot feed itself.
      if (measure()) paint();
    });

    const onVisibilityChange = (): void => {
      pageVisible = !document.hidden;
      if (pageVisible) start();
      else stop();
    };

    measure();
    seedDrops();
    paint();

    pageVisible = !document.hidden;
    motionQuery.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    start();

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      motionQuery.removeEventListener('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      // Decorative in the strictest sense: it carries no information the copy
      // does not already carry, and it must never intercept a click on the CTA
      // sitting on top of it.
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none"
    />
  );
}

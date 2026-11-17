import cornerSvg from '../../assets/arcs/corner.svg?raw';

// ---------------------------------------------------------------------------
// THE CORNER RIPPLE on the voice tiles (lapis, verdigris, madder; gold has no
// quarter). The banded quarter in a tile's corner is the ::after's MASK
// (board.css § the voices: assets/arcs/corner.svg over the run's gradient and the
// grain). When a tile comes fully into view, once per page view, its mask is
// swapped for its OWN animated copy of corner.svg: every band's line swells and
// settles, the corner's band first and each band outward a little later, three
// times, each ripple gentler than the last. Then the static mask comes back. The
// colours, grain and resting picture are the same image the tile always shows.
//
// WHY A MASK IMAGE. The swell is SMIL inside the SVG (stroke-width), so nothing in
// the page restyles: only the small corner repaints, for about three seconds. Each
// tile's copy carries a unique comment, so it is its own image and its animation
// starts when that tile's copy loads, not when some other tile's did.
//
// WHEN. A tile ripples once its corner has stayed fully in view for DWELL_MS, and never in the
// page's first SETTLE_MS: a tile on screen as the page opens would otherwise ripple
// before anyone looks, and a `.rise` tile while it is still fading in. A tile that
// leaves the view before its ripple starts waits for the next time it is fully in view.
//
// Called by useReveal, which skips it under prefers-reduced-motion.
// ---------------------------------------------------------------------------

/** Each ripple's peak, as a multiple of a band's own width: 1.8×, then gentler. */
export const RIPPLE_PEAKS = [1.8, 1.45, 1.2] as const;
/** One band's swell (s), the gap from one ripple to the next (s), and the delay from a band to the next one out (s). */
export const SWELL_S = 0.5;
export const RIPPLE_EVERY_S = 0.6;
export const BAND_LAG_S = 0.06;

const STEP_S = 0.025;

/** How long a tile stays fully in view before its ripple starts (ms): long enough to be looked at, short enough for a skim. */
export const DWELL_MS = 300;
/** No ripple in the page's first second: a tile already on screen ripples once the page has settled. */
export const SETTLE_MS = 1000;

/** The wait before a tile that has just come fully into view ripples, `sinceOpenMs` after the page opened. */
export function playDelay(sinceOpenMs: number): number {
  return Math.max(DWELL_MS, SETTLE_MS - sinceOpenMs);
}

interface Band {
  d: string;
  w: number;
}

/** The bands of corner.svg, corner first (its paths are written innermost first). */
export function cornerBands(svg: string = cornerSvg): Band[] {
  return Array.from(svg.matchAll(/<path d="([^"]+)" stroke-width="([\d.]+)"\/>/g), (m) => ({
    d: m[1] as string,
    w: Number(m[2]),
  }));
}

/** A band's width over its own time line, as SMIL values and keyTimes (sin² swells: smooth in and out). */
export function swellTimeline(w: number): { values: string; keyTimes: string; dur: number } {
  const dur = (RIPPLE_PEAKS.length - 1) * RIPPLE_EVERY_S + SWELL_S;
  const steps = Math.round(dur / STEP_S);
  const values: string[] = [];
  const keys: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s * STEP_S;
    let k = 1;
    RIPPLE_PEAKS.forEach((peak, r) => {
      const u = (t - r * RIPPLE_EVERY_S) / SWELL_S;
      if (u > 0 && u < 1) k = Math.max(k, 1 + (peak - 1) * Math.sin(Math.PI * u) ** 2);
    });
    values.push((w * k).toFixed(3));
    keys.push((t / dur).toFixed(4));
  }
  keys[keys.length - 1] = '1';
  return { values: values.join(';'), keyTimes: keys.join(';'), dur };
}

/** The whole ripple, start to finish (s). */
export function rippleSeconds(bandCount: number): number {
  return (bandCount - 1) * BAND_LAG_S + (RIPPLE_PEAKS.length - 1) * RIPPLE_EVERY_S + SWELL_S;
}

/** An animated corner.svg; `id` makes it a separate image, so its time line starts when it loads. */
export function waveSvg(id: number, bands: Band[] = cornerBands()): string {
  const paths = bands
    .map((b, i) => {
      const tl = swellTimeline(b.w);
      return (
        `<path d="${b.d}" stroke-width="${b.w}">` +
        `<animate attributeName="stroke-width" begin="${(i * BAND_LAG_S).toFixed(2)}s" dur="${tl.dur.toFixed(2)}s" ` +
        `values="${tl.values}" keyTimes="${tl.keyTimes}" calcMode="linear" fill="freeze"/></path>`
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><!--${id}--><g fill="none" stroke="#000">${paths}</g></svg>`;
}

const TILES = '.tile.lapis, .tile.verdigris, .tile.madder';

/** Start watching the voice tiles under `root`; returns a stop that puts everything back. */
export function startCornerWaves(root: HTMLElement): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => undefined;
  const tiles = Array.from(root.querySelectorAll<HTMLElement>(TILES));
  if (tiles.length === 0) return () => undefined;

  const bands = cornerBands();
  const ms = Math.ceil(rippleSeconds(bands.length) * 1000) + 150;
  const timers = new Set<number>();
  const probes: HTMLElement[] = [];
  let next = 0;

  const play = (tile: HTMLElement): void => {
    const url = `url("data:image/svg+xml,${encodeURIComponent(waveSvg(++next, bands))}")`;
    tile.style.setProperty('--wave-mask', url);
    tile.classList.add('waving');
    const t = window.setTimeout(() => {
      timers.delete(t);
      tile.classList.remove('waving');
      tile.style.removeProperty('--wave-mask');
    }, ms);
    timers.add(t);
  };

  // "Fully in view" means the CORNER QUARTER, where the ripple is drawn: a probe placed
  // over it is what the observer watches. A tall tile is wholly on screen only for a
  // moment of a scroll (or never, taller than the screen); its corner is there for long.
  const owner = new Map<Element, HTMLElement>();
  const opened = performance.now();
  const pending = new Map<Element, number>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const due = pending.get(e.target);
        if (e.intersectionRatio < 0.99) {
          // Out of full view before the ripple started: wait for the next time.
          if (due != null) {
            window.clearTimeout(due);
            timers.delete(due);
            pending.delete(e.target);
          }
          continue;
        }
        if (due != null) continue;
        const target = e.target;
        const t = window.setTimeout(() => {
          timers.delete(t);
          pending.delete(target);
          io.unobserve(target);
          const tile = owner.get(target);
          if (tile) play(tile);
        }, playDelay(performance.now() - opened));
        timers.add(t);
        pending.set(target, t);
      }
    },
    { threshold: [0, 0.99] },
  );
  for (const tile of tiles) {
    const probe = document.createElement('span');
    probe.className = 'corner-probe';
    probe.setAttribute('aria-hidden', 'true');
    tile.appendChild(probe);
    probes.push(probe);
    owner.set(probe, tile);
    io.observe(probe);
  }

  return () => {
    io.disconnect();
    for (const t of timers) window.clearTimeout(t);
    for (const p of probes) p.remove();
    for (const tile of tiles) {
      tile.classList.remove('waving');
      tile.style.removeProperty('--wave-mask');
    }
  };
}

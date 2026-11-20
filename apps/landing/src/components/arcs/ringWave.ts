import { BAND_LAG_S, swellTimeline } from './cornerWave';

// ---------------------------------------------------------------------------
// THE RING'S RIPPLE: the voice tiles' corner ripple (cornerWave.ts), played on the home
// page's ring (Ring.tsx) each time its lines CLOSE into the ring. Every band swells and
// settles three times, each ripple gentler, the innermost band first and each band
// outward a little later (the same timing, swellTimeline and BAND_LAG_S, as the tiles).
//
// WHEN. A scene's ring is closed when every line has landed: in a forward scene once
// S ≥ gather × (the latest line's share), in a reverse scene while S ≤ 0 (S, Scene.tsx:
// vh scrolled since the scene's top reached the screen's top). The ripple plays on the
// change from apart to closed, never on the state the page opens in, and again on the
// next close. A ring that comes apart mid-ripple stops it at once.
//
// HOW, CHEAPLY. The lines are 64 composited layers; swelling their strokes would repaint
// all 64 every frame. Instead the ripple draws ONE overlay <svg> of the whole ring (the
// lines' own paths and gradients, in the ring's user units) over the box, hides the
// lines, and animates the overlay's stroke widths (Web Animations), then removes it.
// Only that one picture repaints, for about three seconds.
//
// Called by useReveal, which skips it under prefers-reduced-motion.
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Is a scene's ring closed (every line home) at S vh, for a gather of `gather` vh? */
export function ringClosed(S: number, gather: number, lastShare: number, reverse: boolean): boolean {
  return reverse ? S <= 0 : S >= gather * lastShare;
}

/** A band's swell as Web Animations keyframes (stroke widths in user units). */
export function swellKeyframes(w: number): { frames: Keyframe[]; ms: number } {
  const tl = swellTimeline(w);
  const values = tl.values.split(';');
  const keys = tl.keyTimes.split(';').map(Number);
  return {
    frames: values.map((v, i) => ({ strokeWidth: `${v}px`, offset: keys[i] })),
    ms: tl.dur * 1000,
  };
}

interface RingTrack {
  scene: HTMLElement;
  ring: HTMLElement;
  gather: number;
  lastShare: number;
  reverse: boolean;
  closed: boolean;
  stop: (() => void) | null;
}

/** Draw the overlay, hide the lines, ripple; returns a stop that puts everything back. */
function ripple(ring: HTMLElement, done: () => void): () => void {
  const box = ring.querySelector<HTMLElement>('.arcs-box');
  if (!box) return () => undefined;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ring-wave');
  svg.setAttribute('viewBox', `0 0 ${ring.dataset.w} ${ring.dataset.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const anims: Animation[] = [];
  let longest = 0;
  ring.querySelectorAll<SVGSVGElement>('.line').forEach((line) => {
    const grad = line.querySelector('linearGradient');
    const path = line.querySelector('path');
    if (!grad || !path) return;
    const g = grad.cloneNode(true) as SVGLinearGradientElement;
    g.id = `${grad.id}w`;
    const p = path.cloneNode(true) as SVGPathElement;
    p.setAttribute('stroke', `url(#${g.id})`);
    svg.append(g, p);
    const w = Number(path.getAttribute('stroke-width')) || 1;
    const { frames, ms } = swellKeyframes(w);
    const delay = (Number(line.dataset.b) || 0) * BAND_LAG_S * 1000;
    longest = Math.max(longest, delay + ms);
    if (typeof p.animate === 'function') anims.push(p.animate(frames, { duration: ms, delay, fill: 'both' }));
  });
  box.append(svg);
  ring.classList.add('waving');
  let over = false;
  const stop = (): void => {
    if (over) return;
    over = true;
    window.clearTimeout(t);
    for (const a of anims) a.cancel();
    svg.remove();
    ring.classList.remove('waving');
  };
  const t = window.setTimeout(() => {
    stop();
    done();
  }, longest + 50);
  return stop;
}

/** Watch every ring in a scene under `root`; returns a stop that puts everything back. */
export function startRingWaves(root: HTMLElement): () => void {
  const tracks: RingTrack[] = [];
  root.querySelectorAll<HTMLElement>('.scene').forEach((scene) => {
    const ring = scene.querySelector<HTMLElement>('.ring3d');
    if (!ring) return;
    const shares = Array.from(ring.querySelectorAll<SVGSVGElement>('.line'), (l) =>
      Number(getComputedStyle(l).getPropertyValue('--e')) || 1,
    );
    tracks.push({
      scene,
      ring,
      gather: Number(scene.dataset.gather) || 100,
      lastShare: Math.max(1e-3, ...shares),
      reverse: scene.classList.contains('scene-reverse'),
      closed: false,
      stop: null,
    });
  });
  if (tracks.length === 0) return () => undefined;

  let first = true;
  let raf = 0;
  const check = (): void => {
    raf = 0;
    const vh = window.innerHeight;
    for (const t of tracks) {
      const S = (-t.scene.getBoundingClientRect().top / vh) * 100;
      const closed = ringClosed(S, t.gather, t.lastShare, t.reverse);
      if (closed && !t.closed && !first) {
        t.stop?.();
        t.stop = ripple(t.ring, () => {
          t.stop = null;
        });
      } else if (!closed && t.stop) {
        t.stop();
        t.stop = null;
      }
      t.closed = closed;
    }
    first = false;
  };
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(check);
  };
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', kick);
  check();

  return () => {
    window.removeEventListener('scroll', kick);
    window.removeEventListener('resize', kick);
    if (raf) cancelAnimationFrame(raf);
    for (const t of tracks) t.stop?.();
  };
}

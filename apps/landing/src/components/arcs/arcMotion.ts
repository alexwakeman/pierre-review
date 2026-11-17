import { FADED_END, FADED_START } from './Scene';

// ---------------------------------------------------------------------------
// The JavaScript FALLBACK for the arcs' motion (called by useReveal, which skips
// it under prefers-reduced-motion). On a browser with CSS scroll-driven
// animations it does nothing at all: board.css runs every picture on the
// compositor. Elsewhere it reproduces the same two mappings, writing only a
// transform per layer per frame (rAF, passive listener):
//   lead     apart = 1 − scrollY / (0.6 × viewport height)
//   others   apart = 1 − progress from "entry 0%" to "contain 30%" of its own view
//            timeline: from its top edge reaching the viewport's bottom, through
//            its own height, and 30% of (viewport height − its height) more.
//   scenes   (Scene.tsx) S = vh scrolled since the scene's top reached the screen's
//            top; apart = 1 − S / gather (S / gather for a reverse scene), and the
//            two fades from its data-* timing.
// CSS already paints every layer apart, so nothing flashes before this runs.
// ---------------------------------------------------------------------------

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

interface SceneTrack {
  el: HTMLElement;
  layers: SVGSVGElement[];
  fadeIn: HTMLElement | null;
  fadeOut: HTMLElement | null;
  t: { gather: number; fadeIn: number; outStart: number; outEnd: number };
  /** A reverse scene comes apart: apart = S / gather. */
  reverse: boolean;
  last: number;
}

interface Track {
  el: HTMLElement;
  layers: SVGSVGElement[];
  lead: boolean;
  last: number;
}

export function startArcMotion(root: HTMLElement): () => void {
  if (typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()')) return () => undefined;

  // A scene's picture follows its scene's timing, below; every other picture is tracked here.
  const tracks: Track[] = Array.from(root.querySelectorAll<HTMLElement>('.arcs'))
    .filter((el) => el.closest('.scene') == null)
    .map((el) => ({
    el,
    layers: Array.from(el.querySelectorAll<SVGSVGElement>('.layer')),
    lead: el.classList.contains('lead'),
    last: -1,
  }));
  const scenes: SceneTrack[] = Array.from(root.querySelectorAll<HTMLElement>('.scene')).map((el) => ({
    el,
    layers: Array.from(el.querySelectorAll<SVGSVGElement>('.arcs .layer')),
    fadeIn: el.querySelector<HTMLElement>('.scene-in'),
    fadeOut: el.querySelector<HTMLElement>('.scene-out'),
    t: {
      gather: Number(el.dataset.gather) || 100,
      fadeIn: Number(el.dataset.in) || 60,
      outStart: Number(el.dataset.outStart) || 100,
      outEnd: Number(el.dataset.outEnd) || 160,
    },
    reverse: el.classList.contains('scene-reverse'),
    last: -1,
  }));
  if (tracks.length === 0 && scenes.length === 0) return () => undefined;

  let raf = 0;
  const paint = (): void => {
    raf = 0;
    const vh = window.innerHeight;
    // read everything first, then write: no layout thrash
    const aparts = tracks.map((t) => {
      if (t.lead) return clamp(1 - window.scrollY / (vh * 0.6));
      const r = t.el.getBoundingClientRect();
      // entry 0% = top at the viewport's bottom; contain 30% = its height + 30% of (vh − height) later
      return clamp(1 - (vh - r.top) / (r.height + Math.max(vh - r.height, 0) * 0.3 || 1));
    });
    const sceneS = scenes.map((sc) => (-sc.el.getBoundingClientRect().top / vh) * 100);
    tracks.forEach((t, i) => {
      const a = aparts[i] ?? 0;
      if (Math.abs(a - t.last) < 0.0005) return;
      t.last = a;
      const tf = a === 0 ? 'none' : `translate3d(calc(var(--ax) * ${a.toFixed(4)}), calc(var(--ay) * ${a.toFixed(4)}), 0)`;
      for (const l of t.layers) l.style.transform = tf;
    });
    scenes.forEach((sc, i) => {
      const S = sceneS[i] ?? 0;
      if (Math.abs(S - sc.last) < 0.05) return;
      sc.last = S;
      const a = sc.reverse ? clamp(S / sc.t.gather) : clamp(1 - S / sc.t.gather);
      const tf = a === 0 ? 'none' : `translate3d(calc(var(--ax) * ${a.toFixed(4)}), calc(var(--ay) * ${a.toFixed(4)}), 0)`;
      for (const l of sc.layers) l.style.transform = tf;
      if (sc.fadeIn) sc.fadeIn.style.opacity = (FADED_START + (1 - FADED_START) * clamp(S / sc.t.fadeIn)).toFixed(3);
      if (sc.fadeOut) {
        const k = clamp((S - sc.t.outStart) / (sc.t.outEnd - sc.t.outStart || 1));
        sc.fadeOut.style.opacity = (1 - (1 - FADED_END) * k).toFixed(3);
      }
    });
  };
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(paint);
  };
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', kick);
  paint();

  return () => {
    window.removeEventListener('scroll', kick);
    window.removeEventListener('resize', kick);
    if (raf) cancelAnimationFrame(raf);
    for (const t of tracks) for (const l of t.layers) l.style.transform = '';
    for (const sc of scenes) {
      for (const l of sc.layers) l.style.transform = '';
      if (sc.fadeIn) sc.fadeIn.style.opacity = '';
      if (sc.fadeOut) sc.fadeOut.style.opacity = '';
    }
  };
}

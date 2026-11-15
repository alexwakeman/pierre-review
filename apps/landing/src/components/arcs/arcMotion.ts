// ---------------------------------------------------------------------------
// The JavaScript FALLBACK for the arcs' motion (called by useReveal, which skips
// it under prefers-reduced-motion). On a browser with CSS scroll-driven
// animations it does nothing at all: board.css runs every picture on the
// compositor. Elsewhere it reproduces the same two mappings, writing only a
// transform per layer per frame (rAF, passive listener):
//   lead     apart = 1 − scrollY / (0.6 × viewport height)
//   others   apart = 1 − progress from "entry 0%" to "cover 60%" of its own view
//            timeline: the top meeting the viewport's bottom, to 60% of the way
//            through the viewport.
// CSS already paints every layer apart, so nothing flashes before this runs.
// ---------------------------------------------------------------------------

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

interface Track {
  el: HTMLElement;
  layers: SVGSVGElement[];
  lead: boolean;
  last: number;
}

export function startArcMotion(root: HTMLElement): () => void {
  if (typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()')) return () => undefined;

  const tracks: Track[] = Array.from(root.querySelectorAll<HTMLElement>('.arcs')).map((el) => ({
    el,
    layers: Array.from(el.querySelectorAll<SVGSVGElement>('.layer')),
    lead: el.classList.contains('lead'),
    last: -1,
  }));
  if (tracks.length === 0) return () => undefined;

  let raf = 0;
  const paint = (): void => {
    raf = 0;
    const vh = window.innerHeight;
    // read everything first, then write: no layout thrash
    const aparts = tracks.map((t) => {
      if (t.lead) return clamp(1 - window.scrollY / (vh * 0.6));
      const r = t.el.getBoundingClientRect();
      // entry 0% = top at the viewport's bottom; cover 60% = 60% of (vh + height) later
      return clamp(1 - (vh - r.top) / ((vh + r.height) * 0.6));
    });
    tracks.forEach((t, i) => {
      const a = aparts[i] ?? 0;
      if (Math.abs(a - t.last) < 0.0005) return;
      t.last = a;
      const tf = a === 0 ? 'none' : `translate3d(calc(var(--ax) * ${a.toFixed(4)}), calc(var(--ay) * ${a.toFixed(4)}), 0)`;
      for (const l of t.layers) l.style.transform = tf;
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
  };
}

// ---------------------------------------------------------------------------
// The JavaScript half of the arcs' motion (called by useReveal, which skips it
// under prefers-reduced-motion). It never runs per frame on a browser that has
// CSS scroll-driven animations, and it only ever writes a transform.
//
// 1. REVEAL (every non-lead picture). A picture below the fold at load gets
//    `pre` (layers offset, bands undrawn); when a fifth of it scrolls into view
//    it swaps to `in` and CSS transitions draw it, once. A picture already on
//    screen at load is left alone, so nothing flashes.
// 2. LEAD FALLBACK (the hero's pictures, only where `animation-timeline:
//    scroll()` is unsupported). CSS already paints each lead layer apart; this
//    maps scrollY → apart = 1 − scrollY / (0.6 × viewport height), the same as
//    the CSS animation's range, and writes it as one transform per layer per
//    frame (rAF, passive listener, no layout reads).
// ---------------------------------------------------------------------------

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function startArcMotion(root: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];

  // ---- 1. reveal ----
  const vh = window.innerHeight;
  const pending = Array.from(root.querySelectorAll<HTMLElement>('.arcs:not(.lead)')).filter(
    (el) => el.getBoundingClientRect().top >= vh,
  );
  if (pending.length > 0 && typeof IntersectionObserver !== 'undefined') {
    pending.forEach((el) => el.classList.add('pre'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.remove('pre');
          el.classList.add('in');
          io.unobserve(el);
        }
      },
      { threshold: 0.2 },
    );
    pending.forEach((el) => io.observe(el));
    cleanups.push(() => {
      io.disconnect();
      pending.forEach((el) => el.classList.remove('pre', 'in'));
    });
  }

  // ---- 2. lead fallback ----
  const scrollDriven = typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()');
  const layers = scrollDriven ? [] : Array.from(root.querySelectorAll<SVGSVGElement>('.arcs.lead .layer'));
  if (layers.length > 0) {
    let raf = 0;
    let last = -1;
    const paint = (): void => {
      raf = 0;
      const a = clamp(1 - window.scrollY / (window.innerHeight * 0.6));
      if (Math.abs(a - last) < 0.0005) return;
      last = a;
      const t = a === 0 ? 'none' : `translate3d(calc(var(--ax) * ${a.toFixed(4)}), calc(var(--ay) * ${a.toFixed(4)}), 0)`;
      for (const l of layers) l.style.transform = t;
    };
    const kick = (): void => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    paint();
    cleanups.push(() => {
      window.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
      if (raf) cancelAnimationFrame(raf);
      layers.forEach((l) => (l.style.transform = ''));
    });
  }

  return () => cleanups.forEach((c) => c());
}

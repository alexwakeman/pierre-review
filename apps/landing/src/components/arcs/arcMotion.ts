// ---------------------------------------------------------------------------
// Scroll-linked motion for every <Arcs> under a page root (called by useReveal).
//
// For each svg.arcs, `v` is how far it has travelled through the viewport:
// 0 as its top meets the viewport's bottom, 1 as its bottom leaves the top.
//   --draw   = v / 0.45, clamped: the bands draw out as it comes into view
//   --spread = (v - 0.55) / 0.45, clamped: it opens out as it scrolls away
// A LEAD piece (data-lead: the hero's) is always drawn and only opens out, so the
// top of the page never flickers from the prerendered drawing. Values ease toward their targets each
// frame. The caller skips all of this under prefers-reduced-motion.
// ---------------------------------------------------------------------------

interface Track {
  el: SVGSVGElement;
  draw: number;
  spread: number;
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function targets(el: Element, vh: number): [number, number] {
  const r = el.getBoundingClientRect();
  const v = clamp((vh - r.top) / (vh + r.height));
  // a lead piece (the hero's) is drawn from the start and only opens out
  const lead = el.hasAttribute('data-lead');
  return [lead ? 1 : clamp(v / 0.45), clamp((v - (lead ? 0.3 : 0.55)) / 0.45)];
}

export function startArcMotion(root: HTMLElement): () => void {
  const vh0 = window.innerHeight;
  const tracks: Track[] = Array.from(root.querySelectorAll<SVGSVGElement>('svg.arcs')).map((el) => {
    const [draw, spread] = targets(el, vh0);
    const t: Track = { el, draw, spread };
    el.style.setProperty('--draw', t.draw.toFixed(3));
    el.style.setProperty('--spread', t.spread.toFixed(3));
    return t;
  });
  if (tracks.length === 0) return () => undefined;

  let raf = 0;
  const tick = (): void => {
    raf = 0;
    const vh = window.innerHeight;
    let moving = false;
    for (const t of tracks) {
      const [d, s] = targets(t.el, vh);
      const nd = t.draw + (d - t.draw) * 0.16;
      const ns = t.spread + (s - t.spread) * 0.16;
      if (Math.abs(nd - t.draw) > 0.001 || Math.abs(ns - t.spread) > 0.001) moving = true;
      t.draw = Math.abs(nd - d) < 0.001 ? d : nd;
      t.spread = Math.abs(ns - s) < 0.001 ? s : ns;
      t.el.style.setProperty('--draw', t.draw.toFixed(3));
      t.el.style.setProperty('--spread', t.spread.toFixed(3));
    }
    if (moving) raf = requestAnimationFrame(tick);
  };
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', kick);
  kick();

  return () => {
    window.removeEventListener('scroll', kick);
    window.removeEventListener('resize', kick);
    if (raf) cancelAnimationFrame(raf);
    for (const t of tracks) {
      t.el.style.removeProperty('--draw');
      t.el.style.removeProperty('--spread');
    }
  };
}

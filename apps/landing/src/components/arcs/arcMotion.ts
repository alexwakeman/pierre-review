// ---------------------------------------------------------------------------
// Scroll-linked motion for every <Arcs> under a page root (called by useReveal).
//
// EVERY PICTURE COMES TOGETHER AS THE READER SCROLLS DOWN, and stays together.
//
// For each svg.arcs, `v` is how far it has travelled through the viewport:
// 0 as its top meets the viewport's bottom, 1 as its bottom leaves the top.
//   --draw  = v / 0.45, clamped: the bands draw out and the quarters slide home
//             as it comes into view
//   --apart = 0: once home, a picture never comes apart again
// A LEAD piece (data-lead: the hero's) is on screen from the start, so it is
// always drawn, and it begins APART at the top of the page instead:
//   --apart = 1 - scrollY / (0.6 × viewport height), clamped: its links close up
//             over the first 60% of a screen of scrolling
// Values ease toward their targets each frame. The caller skips all of this under
// prefers-reduced-motion, which (like no JS and the prerendered HTML) shows every
// picture drawn and together.
// ---------------------------------------------------------------------------

interface Track {
  el: SVGSVGElement;
  draw: number;
  apart: number;
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function targets(el: Element, vh: number): [number, number] {
  const r = el.getBoundingClientRect();
  if (el.hasAttribute('data-lead')) return [1, clamp(1 - window.scrollY / (vh * 0.6))];
  const v = clamp((vh - r.top) / (vh + r.height));
  return [clamp(v / 0.45), 0];
}

export function startArcMotion(root: HTMLElement): () => void {
  const vh0 = window.innerHeight;
  const tracks: Track[] = Array.from(root.querySelectorAll<SVGSVGElement>('svg.arcs')).map((el) => {
    const [draw, apart] = targets(el, vh0);
    const t: Track = { el, draw, apart };
    el.style.setProperty('--draw', t.draw.toFixed(3));
    el.style.setProperty('--apart', t.apart.toFixed(3));
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
      const na = t.apart + (s - t.apart) * 0.16;
      if (Math.abs(nd - t.draw) > 0.001 || Math.abs(na - t.apart) > 0.001) moving = true;
      t.draw = Math.abs(nd - d) < 0.001 ? d : nd;
      t.apart = Math.abs(na - s) < 0.001 ? s : na;
      t.el.style.setProperty('--draw', t.draw.toFixed(3));
      t.el.style.setProperty('--apart', t.apart.toFixed(3));
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
      t.el.style.removeProperty('--apart');
    }
  };
}

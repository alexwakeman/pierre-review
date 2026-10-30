import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

// THE EDGE FADE (docs/redesign/DESIGN.md § 6): a scroll box that hides more content past an edge
// says so — the hidden side fades out. Pure presentation: a CSS mask over the box, recomputed on
// scroll and resize. Nothing fades when everything fits, or once that edge is reached.

const FADE = 28;

export function useEdgeFade(ref: RefObject<HTMLElement>, axis: 'x' | 'y'): CSSProperties | undefined {
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const pos = axis === 'x' ? el.scrollLeft : el.scrollTop;
      const size = axis === 'x' ? el.clientWidth : el.clientHeight;
      const full = axis === 'x' ? el.scrollWidth : el.scrollHeight;
      const start = pos > 1;
      const end = pos + size < full - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
    // Re-subscribed when the element itself changes (a row that mounts later, behind a condition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, axis]);
  if (!edges.start && !edges.end) return undefined;
  const dir = axis === 'x' ? 'to right' : 'to bottom';
  const g = `linear-gradient(${dir}, ${edges.start ? `transparent, black ${FADE}px` : 'black'}, ${
    edges.end ? `black calc(100% - ${FADE}px), transparent` : 'black'
  })`;
  return { maskImage: g, WebkitMaskImage: g };
}

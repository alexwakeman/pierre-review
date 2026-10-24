import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// ---------------------------------------------------------------------------
// The board's entrance: tiles marked `.rise` lift into place as they scroll in.
//
// THE HIDDEN STATE IS ADDED HERE, NEVER IN MARKUP. The prerendered HTML has every
// tile visible; only once this effect runs does the root get `js-rise`, which is
// what board.css keys the hidden state on (and only under
// prefers-reduced-motion: no-preference). So with no JS, or reduced motion, or no
// IntersectionObserver, nothing is ever hidden.
//
// Usage: const ref = useReveal<HTMLDivElement>(); <div className="lb" ref={ref}>…
// ---------------------------------------------------------------------------

export function useReveal<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const els = Array.from(root.querySelectorAll<HTMLElement>('.rise'));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('in'));
      return;
    }

    root.classList.add('js-rise');

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    els.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 4) * 70}ms`;
      io.observe(el);
    });

    return () => {
      io.disconnect();
      // Back to the markup's state (everything visible), so a remount — StrictMode
      // runs every effect twice in dev — starts the reveal cleanly.
      root.classList.remove('js-rise');
      els.forEach((el) => {
        el.classList.remove('in');
        el.style.transitionDelay = '';
      });
    };
  }, []);

  return ref;
}

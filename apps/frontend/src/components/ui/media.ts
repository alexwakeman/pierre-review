// Breakpoints and motion preference, read ONCE here (docs/redesign/DESIGN.md § Layout and mobile).
//
// The CSS side is Tailwind's own screens (sm 640 · md 768 · lg 1024 · xl 1280, plus `touch:` for a
// coarse pointer); this is the JS side for the few primitives whose STRUCTURE changes by width
// (the side panel docks or becomes a sheet; a menu becomes a bottom sheet). Never branch on width
// for looks in JS — that is CSS's job.

import { useEffect, useState } from 'react';

export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;

/** The persistent sidebar and the docked side panel need this much width. Below it: drawer + sheet. */
export const DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.lg}px)`;
/** Phone: sheets go full-screen, menus open from the bottom. */
export const PHONE_QUERY = `(max-width: ${BREAKPOINTS.md - 1}px)`;
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** Live `matchMedia` answer. SSR / test-safe (false without a window). */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = (): void => setOn(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return on;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** True when the reader asked for less motion. Animations become instant state changes. */
export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

/** Non-hook read for timers (how long to wait for a leave animation). */
export function prefersReducedMotion(): boolean {
  return matches(REDUCED_MOTION_QUERY);
}

/** The motion durations of DESIGN.md, in ms. Keep in step with tailwind.config.ts. */
export const MOTION = { fast: 80, base: 160, leave: 170 } as const;

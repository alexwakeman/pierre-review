import { useEffect, useState } from 'react';

/** Whether a CSS media query matches, live. False where `matchMedia` is missing or throws. */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => {
    try {
      return typeof window !== 'undefined' && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const on = (): void => setMatches(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

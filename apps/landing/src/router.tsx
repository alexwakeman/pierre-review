import { useCallback, useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';

// A tiny dependency-free client router for the marketing site. Real (clean) URLs
// — the Fastify server serves the landing index.html for any non-/api, non-/app
// path, so deep-links and reloads of /features, /insights, … all work. Crawlers
// follow the real <a href> links; per-route <title>/meta are set by useSeo().

const ROUTE_EVENT = 'pierre:route';

// The route being prerendered, set by entry-server.tsx before each
// renderToStaticMarkup() pass. There is no `window` in Node, so without this
// every prerendered page would render the HOME route's component — silently
// emitting eight identical files. Untouched (and unreachable) in the browser.
let staticPath: string | null = null;

/** Build-time only: pin the path currentPath() reports. See prerender.mjs. */
export function setStaticPath(path: string): void {
  staticPath = path;
}

/** Normalised current path: no trailing slash, '' → '/'. */
export function currentPath(): string {
  if (typeof window === 'undefined') return staticPath ?? '/';
  const p = window.location.pathname.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

function scrollToHash(hash: string): void {
  const el = document.getElementById(hash);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Programmatic navigation. Same-page #hash → smooth scroll; else pushState. */
export function navigate(to: string): void {
  const hashIndex = to.indexOf('#');
  const path = hashIndex === -1 ? to : to.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : to.slice(hashIndex + 1);
  const normalisedPath = path === '' ? currentPath() : path.replace(/\/+$/, '') || '/';
  const samePage = normalisedPath === currentPath();

  if (hash && samePage) {
    scrollToHash(hash);
    return;
  }

  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(ROUTE_EVENT));
  if (hash) {
    // Let the new page render, then scroll to the anchor.
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToHash(hash)));
  } else {
    window.scrollTo(0, 0);
  }
}

/** Subscribe to route changes (popstate + programmatic navigate). */
export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = (): void => setPath(currentPath());
    window.addEventListener('popstate', onChange);
    window.addEventListener(ROUTE_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(ROUTE_EVENT, onChange);
    };
  }, []);
  return path;
}

/** True for links that must do a full browser navigation (app, API, external). */
function isExternal(to: string): boolean {
  return (
    /^https?:\/\//.test(to) ||
    to.startsWith('/api') ||
    to.startsWith('/app') ||
    to.startsWith('mailto:')
  );
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  children: ReactNode;
};

/** Anchor that client-routes internal landing links and full-navigates the rest. */
export function Link({ to, children, onClick, ...rest }: LinkProps): JSX.Element {
  const external = isExternal(to);
  const handle = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (external) return; // let the browser handle app/api/external links
      // Respect new-tab / modified clicks.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(to);
    },
    [external, onClick, to],
  );
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

import { useEffect } from 'react';
import { OG_IMAGE, SITE_URL } from './routes';

// Per-route document head management for the CLIENT-rendered pass.
//
// The static HTML already carries the correct head for the requested route —
// prerender.mjs bakes it in at build time from the same ROUTE_SEO table these
// pages read (lib/routes.ts) — so this hook is no longer what a crawler depends
// on. It exists for the SPA navigations that follow: a client-side route change
// never reloads the document, so the title/canonical/og tags have to be rewritten
// in place. Prerender covers the first paint, this covers every hop after it.

export { SITE_URL };

type Seo = {
  title: string;
  description: string;
  /** Path only, e.g. "/features". Defaults to the current path. */
  path?: string;
  image?: string;
  /** Robots directive; the 404 page passes "noindex, follow" to avoid soft-404 indexing. */
  robots?: string;
};

function setMeta(selector: string, attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export function useSeo({
  title,
  description,
  path,
  image = OG_IMAGE,
  robots = 'index, follow',
}: Seo): void {
  useEffect(() => {
    const url = `${SITE_URL}${path ?? window.location.pathname}`;
    document.title = title;

    setMeta('meta[name="description"]', 'name', 'description', description);
    setMeta('meta[name="robots"]', 'name', 'robots', robots);
    // Canonical + og:url are owned here (per-route), not hard-coded in index.html —
    // so a non-JS crawler of /features never sees a canonical pointing at home.
    setLink('canonical', url);
    setMeta('meta[property="og:url"]', 'property', 'og:url', url);

    setMeta('meta[property="og:title"]', 'property', 'og:title', title);
    setMeta('meta[property="og:description"]', 'property', 'og:description', description);
    setMeta('meta[property="og:url"]', 'property', 'og:url', url);
    setMeta('meta[property="og:image"]', 'property', 'og:image', image);

    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title);
    setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description);
    setMeta('meta[name="twitter:image"]', 'name', 'twitter:image', image);
  }, [title, description, path, image]);
}

import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { setStaticPath } from './router';
import { ROUTE_SEO, NOT_FOUND_SEO, PRERENDER_PATHS, SITE_URL, OG_IMAGE } from './lib/routes';
import { SITE_NAME } from './lib/site';

// Build-time render entry. Vite bundles this for Node (`vite build --ssr`), and
// prerender.mjs calls render() once per route to bake real HTML into dist/.
// It is NEVER part of the browser bundle — main.tsx remains the only client entry.
//
// renderToStaticMarkup, not renderToString: nothing here is hydrated (the client
// does a fresh createRoot() render), so the data-reactroot / comment markers that
// renderToString emits for hydration would be dead weight in every page.

// SITE_NAME travels with the SEO table so prerender.mjs can bake og:site_name and
// the OG image alt text without keeping its own copy of the product name — the
// identity stays a single value in lib/site.ts.
export { ROUTE_SEO, NOT_FOUND_SEO, PRERENDER_PATHS, SITE_URL, OG_IMAGE, SITE_NAME };

/** Render one route to static HTML for injection into the index.html shell. */
export function render(path: string): string {
  // App reads the route through router.currentPath(), which falls back to this
  // in Node. Set it before rendering or every page comes out as the home page.
  setStaticPath(path);
  return renderToStaticMarkup(<App />);
}

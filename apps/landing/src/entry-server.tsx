import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { setStaticPath } from './router';
import { ROUTE_SEO, NOT_FOUND_SEO, PRERENDER_PATHS, SITE_URL, OG_IMAGE } from './lib/routes';

// Build-time render entry. Vite bundles this for Node (`vite build --ssr`), and
// prerender.mjs calls render() once per route to bake real HTML into dist/.
// It is NEVER part of the browser bundle — main.tsx remains the only client entry.
//
// renderToStaticMarkup, not renderToString: nothing here is hydrated (the client
// does a fresh createRoot() render), so the data-reactroot / comment markers that
// renderToString emits for hydration would be dead weight in every page.

export { ROUTE_SEO, NOT_FOUND_SEO, PRERENDER_PATHS, SITE_URL, OG_IMAGE };

/** Render one route to static HTML for injection into the index.html shell. */
export function render(path: string): string {
  // App reads the route through router.currentPath(), which falls back to this
  // in Node. Set it before rendering or every page comes out as the home page.
  setStaticPath(path);
  return renderToStaticMarkup(<App />);
}

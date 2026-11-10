import type { RouteSeo } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import { PAGES, sectionFor } from './manifest';
import { DOCS_ROOT } from './routes';

// The docs' per-route <title> and description, read by the layout (useSeo, for client
// navigation) and by the prerenderer (baked into each page's HTML). One source, so they agree.

const HOME: RouteSeo = {
  title: `Documentation · ${SITE_NAME}`,
  description: `How to use ${SITE_NAME}, screen by screen: Open pull requests, Pending, This Sprint, the timeline, the feed, Reports, Bots Monitoring, AI review, AI Fix, merging, every Settings tab, each integration, and how it runs on your own computer.`,
};

const NOT_FOUND: RouteSeo = {
  title: `Page not found · ${SITE_NAME} docs`,
  description: `That page is not in the ${SITE_NAME} documentation.`,
  robots: 'noindex, follow',
};

/** Every docs route with its SEO, in reading order (the docs home first). */
export function docsRouteSeo(): Record<string, RouteSeo> {
  const out: Record<string, RouteSeo> = { [DOCS_ROOT]: HOME };
  for (const p of PAGES) {
    const section = sectionFor(p.section);
    const where = section && section.title !== p.meta.title ? ` · ${section.title}` : '';
    out[p.route] = { title: `${p.meta.title}${where} · ${SITE_NAME} docs`, description: p.meta.summary };
  }
  return out;
}

let cache: Record<string, RouteSeo> | null = null;

export function docsSeoFor(path: string): RouteSeo {
  cache ??= docsRouteSeo();
  return cache[path] ?? NOT_FOUND;
}

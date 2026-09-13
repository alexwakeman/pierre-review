import { SITE_NAME } from './site';

// The landing site's route table and its per-route SEO copy — ONE source of truth,
// read by two consumers that must never disagree:
//
//   • the client (App.tsx maps path → page component; each page calls
//     useSeo(seoFor(path)) to set the live document head), and
//   • the build-time prerenderer (prerender.mjs), which bakes the same title /
//     description / canonical into the static HTML it writes for each route.
//
// Before this existed the copy lived inline in each page's useSeo() call and the
// only HTML a non-JS client ever received was the empty #root shell — so the
// title and description a crawler saw were the HOME page's, on every URL. Keeping
// the copy here means the prerendered head and the hydrated head cannot drift.
//
// The product name comes from lib/site.ts, never a literal, so a rename does not
// have to be re-applied across nine strings here.
//
// THE DOMAIN IS DELIBERATELY UNCHANGED. The rename is staged: the brand is Limn,
// but pierre-review.com stays until the identifier tranche ships, because Safe
// Browsing and Search Console verification are per-domain and non-transferable and
// both GitHub OAuth callback URLs are registered against it.

export const SITE_URL = 'https://pierre-review.com';
export const OG_IMAGE = `${SITE_URL}/og-image.png`;

export type RouteSeo = {
  title: string;
  description: string;
  /** Robots directive. Defaults to "index, follow"; the 404 page opts out. */
  robots?: string;
};

/**
 * Canonical, indexable routes. Order is the order they appear in the sitemap.
 *
 * THE SITE IS THREE CONTENT PAGES plus the three legal ones. /features, /bots,
 * /pro, /pricing, /how-it-works and /arcade were removed together: the product
 * pages were organised by FEATURE AREA, which meant a developer and a manager
 * read the same five pages and neither found the half addressed to them. The
 * content now sits on one page per reader, each of which carries the free tier
 * in full first, then Pro, then the comparison table and the sign-up.
 *
 * Legacy aliases for the removed routes are handled in App.tsx and by the
 * prerenderer, which copies the nearest surviving page's HTML so an old inbound
 * link lands on something readable with a canonical pointing at the new page.
 * They are deliberately ABSENT here — they would be duplicate content in the
 * sitemap.
 */
export const ROUTE_SEO: Record<string, RouteSeo> = {
  '/': {
    title: `${SITE_NAME} — shine a light on your software projects`,
    description: `Your work spans repositories, people and a growing stack of review automation. ${SITE_NAME} lights all of it on one board — whose turn it is, what is stalled, what is ready to land — and measures what the AI review bots on top are actually worth. Free and open core.`,
  },
  '/for-developers': {
    title: 'For developers — what to do next, across every repository',
    description: `A red build on one branch, two reviews waiting on another, six bot comments on the one you thought was done, and a conflict that appeared overnight. All of it is yours and none of it is ordered. ${SITE_NAME} ranks the lot into one list and lets you finish the top of it in place — reply, approve, merge, resolve the conflict. Free, with no repository limit.`,
  },
  '/for-managers': {
    title: 'For engineering managers — see the whole review loop, people and bots',
    description: `Throughput, lead time and where the waiting happens across every repository you own, with people counted apart from automation — free. Then a forwardable report per sprint, an hour-by-hour account of who was holding each pull request, and a keep / tune / noisy verdict on every review bot you pay for.`,
  },
  '/how-we-measure': {
    title: 'How we measure — the two models, in plain English',
    description: `Almost everything ${SITE_NAME} shows you is counted, not predicted. Two questions resist counting and have a model each: how serious a review-bot comment is, and whether your bots are doing well compared with the same bots in comparable repositories. What each one is for, how it was built, and how we know it works.`,
  },
  '/privacy': {
    title: `Privacy policy — ${SITE_NAME}`,
    description: `What ${SITE_NAME} collects, why, who processes it, how long it is kept, and how to get it deleted or exported. Run locally, ${SITE_NAME} collects nothing at all.`,
  },
  '/cookies': {
    title: `Cookie policy — ${SITE_NAME}`,
    description: `Every cookie ${SITE_NAME} sets, what it does, how long it lasts, and a one-click control to change your analytics choice.`,
  },
  '/terms': {
    title: `Terms of service — ${SITE_NAME}`,
    description: `The terms for using the hosted ${SITE_NAME} service: what you get, what you are responsible for, billing and cancellation, and the limits of liability.`,
  },
};

/** Every route the prerenderer emits static HTML for. */
export const PRERENDER_PATHS = Object.keys(ROUTE_SEO);

export const NOT_FOUND_SEO: RouteSeo = {
  title: `Page not found — ${SITE_NAME}`,
  description: `That page does not exist. Head back to the ${SITE_NAME} home page.`,
  robots: 'noindex, follow',
};

/** The SEO record for a path, with the path folded in for canonical/og:url. */
export function seoFor(path: string): RouteSeo & { path: string } {
  return { ...(ROUTE_SEO[path] ?? NOT_FOUND_SEO), path };
}

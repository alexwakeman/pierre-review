import { FREE_TEAM_SIZE, NPM_PACKAGE, SITE_NAME } from './site';

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
// Browsing and Search Console verification are per-domain and non-transferable.

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
 * THE SITE IS FOUR CONTENT PAGES plus the three legal ones. /features, /bots,
 * /pro, /pricing, /how-it-works and /arcade were removed together: the product
 * pages were organised by FEATURE AREA, which meant a developer and a manager
 * read the same five pages and neither found the half addressed to them. The
 * content now sits on one page per reader.
 *
 * /contact is the fourth, and it is load-bearing rather than courtesy: an
 * organisation with more than FREE_TEAM_SIZE people needs a licence, and this
 * is where it asks. See src/pages/Contact.tsx.
 *
 * /demo/ is NOT a landing route. It is a separate static build of the app with
 * sample data, served by apps/site — so it is absent here and from the sitemap.
 *
 * Legacy aliases for the removed routes are handled in App.tsx and by the
 * prerenderer, which copies the nearest surviving page's HTML so an old inbound
 * link lands on something readable with a canonical pointing at the new page.
 * They are deliberately ABSENT here — they would be duplicate content in the
 * sitemap.
 */
export const ROUTE_SEO: Record<string, RouteSeo> = {
  '/': {
    title: `${SITE_NAME} — plan your day across every repository`,
    description: `${SITE_NAME} opens on one board that answers what to work on today: review requests, replies, red builds, conflicts and pull requests ready to land, from every repository, ranked. You decide what counts as your turn and in what order. Claude reviews and fixes pull requests on your own Claude login. 100% free, runs on your machine: npx ${NPM_PACKAGE}.`,
  },
  '/for-developers': {
    title: 'For developers — plan your day, by your own rules',
    description: `A red build, two reviews waiting, a reply on a thread you had moved on from, a conflict that appeared overnight. ${SITE_NAME} puts all of it on one board across every repository, ranked, with what to do next at the top. You decide what counts as your turn and how it is ordered, then finish the work in place — reply, approve, merge, resolve the conflict. Claude reviews and fixes pull requests on your own Claude Code login or Anthropic API key, on your machine; Codex support is coming soon. Free, with no repository limit.`,
  },
  '/for-managers': {
    title: 'For engineering managers — see the whole review loop, people and bots',
    description: `Throughput, lead time and where the waiting happens across every repository you own, with people counted apart from automation. A forwardable report per sprint, an hour-by-hour account of who was holding each pull request, and a keep / tune / rarely used verdict on every review bot you pay for. Free, on your own machine.`,
  },
  '/contact': {
    title: `Contact — licences for bigger teams, questions and bug reports`,
    description: `${SITE_NAME} is free for individuals and for teams of up to ${FREE_TEAM_SIZE} people in one organisation. If more than ${FREE_TEAM_SIZE} people in your organisation use it, ask for a licence here. Questions and bug reports are welcome too.`,
  },
  '/how-we-measure': {
    title: 'How we measure — the two models, in plain English',
    description: `Almost everything ${SITE_NAME} shows you is counted, not predicted. Two questions resist counting and have a model each: how serious a review-bot comment is, and whether your bots are doing well compared with the same bots in comparable repositories. What each one is for, how it was built, and how we know it works.`,
  },
  '/privacy': {
    title: `Privacy policy — ${SITE_NAME}`,
    description: `What this website collects — the contact form and, if you accept them, analytics — why, who processes it, and how long it is kept. The ${SITE_NAME} app runs on your machine and sends nothing to us.`,
  },
  '/cookies': {
    title: `Cookie policy — ${SITE_NAME}`,
    description: `The two analytics cookies this site sets if you agree to them, what they do, how long they last, and a one-click control to change your choice.`,
  },
  '/terms': {
    title: `Terms of use — ${SITE_NAME}`,
    description: `The terms for this website and the ${SITE_NAME} software, a summary of the Limn License — free for individuals and teams of up to ${FREE_TEAM_SIZE} people — and the limits of liability.`,
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

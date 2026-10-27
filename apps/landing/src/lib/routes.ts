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
// The site lives at limn-review.com (moved from the old pierre-review.com on 2026-10-23).

export const SITE_URL = 'https://limn-review.com';
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
 * THE SITE IS FIVE CONTENT PAGES plus the three legal ones: home, Getting
 * started, Reporting and metrics, How we measure and Contact. The earlier
 * feature-area pages (/features, /bots, /pro, /pricing, /how-it-works, /arcade)
 * and then the two role pages (/for-developers, /for-managers) were retired;
 * their URLs survive as aliases.
 *
 * /contact is the fifth, and it is load-bearing rather than courtesy: an
 * organisation where more than FREE_TEAM_SIZE people use Limn needs a licence,
 * and this is where it asks. See src/pages/Contact.tsx.
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
    title: `${SITE_NAME} — automated code review, story and docs alignment, on your machine`,
    description: `${SITE_NAME} reviews each pull request against its story and your docs on your own AI agent (Claude Code or Codex), posts the review to GitHub automatically, and AI Fix fixes the findings and failing CI. Free for up to ${FREE_TEAM_SIZE} people, it runs on your machine: npx ${NPM_PACKAGE}.`,
  },
  '/getting-started': {
    title: `Getting started — install, run and connect · ${SITE_NAME}`,
    description: `Run ${SITE_NAME} with one command: npx ${NPM_PACKAGE}. Then connect Claude Code or Codex, give Limn a share of your weekly AI usage, add the scoring model for review-bot comments, add your repositories, and connect Jira or Linear and Slack. It runs on your machine and uses your logged-in gh.`,
  },
  '/reporting': {
    title: `Reporting and metrics — where the work is and where it waits · ${SITE_NAME}`,
    description: `${SITE_NAME} Reports' headline figures cover one stated window, and anything else says so in its heading. A report per sprint or month, Chronology for where every hour of review goes, 26 weeks of history, where the work is happening across your repositories, and what your review bots are worth. It runs on your own machine.`,
  },
  '/contact': {
    title: `Contact — licences, questions and bug reports · ${SITE_NAME}`,
    description: `${SITE_NAME} is free for individuals, and for organisations where no more than ${FREE_TEAM_SIZE} people use it. More users than that need a licence: ask for one here. Questions and bug reports are welcome too.`,
  },
  '/how-we-measure': {
    title: `How we measure — the two models, in plain English · ${SITE_NAME}`,
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
    description: `The terms for this website and the ${SITE_NAME} software, a summary of the Limn License — free for individuals, and for organisations where no more than ${FREE_TEAM_SIZE} people use it — and the limits of liability.`,
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

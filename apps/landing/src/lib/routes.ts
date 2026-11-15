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
// The site lives at ensemble.ac (moved from limn-review.com on 2026-11-15, which had moved from
// pierre-review.com on 2026-10-23; both old domains 301 here through REDIRECT_HOSTS).

export const SITE_URL = 'https://ensemble.ac';
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
 * THE SITE IS SIX CONTENT PAGES plus the three legal ones (and the docs, whose
 * routes come from the docs manifest): home, Build, Ensemble review, Automation,
 * Everything else and Contact. (2026-11: /teams 301s to /ensemble-review, and
 * /reporting and /how-we-measure 301 to their sections of /everything-else.) The earlier feature-area pages (/features, /bots, /pro, /pricing,
 * /how-it-works, /arcade) and then the two role pages (/for-developers,
 * /for-managers) were retired; their URLs survive as aliases. The Getting started
 * page was folded into the docs (/docs/getting-started/…): /getting-started,
 * /for-developers and /features now 301 there (apps/site src/app.ts).
 *
 * /contact is load-bearing, and it is load-bearing rather than courtesy: an
 * organisation where more than FREE_TEAM_SIZE people use Ensemble needs a licence,
 * and this is where it asks. See src/pages/Contact.tsx.
 *
 * Legacy aliases for the removed routes are handled in App.tsx and by the
 * prerenderer, which copies the nearest surviving page's HTML so an old inbound
 * link lands on something readable with a canonical pointing at the new page.
 * They are deliberately ABSENT here — they would be duplicate content in the
 * sitemap.
 */
export const ROUTE_SEO: Record<string, RouteSeo> = {
  '/': {
    title: `${SITE_NAME} — refine, build and review as an ensemble`,
    description: `${SITE_NAME} takes a ticket from your tracker, checks it against your docs and code, implements it, reviews it in rounds and opens the pull request. Each teammate reviews with their own Claude or Codex, and GitHub is the source of truth. It runs fully on your machine, with no added service. Free for up to ${FREE_TEAM_SIZE} people: npx ${NPM_PACKAGE}.`,
  },
  '/build': {
    title: `Build — one click from ticket to pull request · ${SITE_NAME}`,
    description: `One click turns a ticket into a reviewed pull request on your own machine: ${SITE_NAME} checks the story against your docs and code, fills the gaps, implements in a sandbox, reviews its own work in rounds and opens the PR. By hand or automatically, and how you verify the result.`,
  },
  '/ensemble-review': {
    title: `Ensemble review — no review bot seat, one review per commit · ${SITE_NAME}`,
    description: `No review bot seat: each teammate reviews with their own Claude or Codex, on their own machine, and each change is checked against its ticket. There is no server between you: GitHub is the source of truth. A status line on each commit stops two people reviewing it twice, and every posted review joins one list. Free for up to ${FREE_TEAM_SIZE} people.`,
  },
  '/automation': {
    title: `Automation — dependency updates, merged without you · ${SITE_NAME}`,
    description: `${SITE_NAME} handles Dependabot and Renovate pull requests end to end on your machine: it approves, fixes, resolves conflicts and merges when checks pass, and claims each one on GitHub so only one teammate acts.`,
  },
  '/everything-else': {
    title: `Everything else — review, fix, ship, reports and how we measure · ${SITE_NAME}`,
    description: `The rest of ${SITE_NAME}: reviewing, fixing and shipping across every repository, reports per sprint or month, Chronology, what your review bots are worth, and the two models behind the numbers. It runs on your own machine.`,
  },
  '/contact': {
    title: `Contact — licences, questions and bug reports · ${SITE_NAME}`,
    description: `${SITE_NAME} is free for individuals, and for organisations where no more than ${FREE_TEAM_SIZE} people use it. More users than that need a licence: ask for one here. Questions and bug reports are welcome too.`,
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
    title: `Terms and conditions — ${SITE_NAME}`,
    description: `The terms for this website and the ${SITE_NAME} software: a summary of the Ensemble License (free for individuals, and for organisations where no more than ${FREE_TEAM_SIZE} people use it), the frontier models the AI tools support, what we do against leaks and prompt injection, and why the software is provided as is.`,
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

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
 * Legacy aliases (/insights, /reviews → Pro) are deliberately ABSENT: they still
 * resolve client-side for old inbound links, but they are duplicates of /pro and
 * should neither be prerendered nor advertised in the sitemap.
 */
export const ROUTE_SEO: Record<string, RouteSeo> = {
  '/': {
    title: `${SITE_NAME} — the calm layer above your review bot`,
    description: `Bring your own reviewer. ${SITE_NAME} is the cross-repo layer above CodeRabbit, Greptile and Copilot — what’s stalled, whose turn it is, and what every bot comment is actually worth: graded independently, on your own repos.`,
  },
  '/features': {
    title: 'Open Core — the free multi-repo GitHub dashboard',
    description:
      'The free, open-core tier in full: the cross-repo Activity feed, derived thread states, the repo→contributor timeline, per-repo consoles, PR detail with real write actions, per-comment bot grading with the per-PR triage grade, and cross-repo search. Free, forever.',
  },
  '/bots': {
    title: 'The receipt — independent grading of your AI review bots',
    description: `Every bot comment on your repos, graded by ${SITE_NAME}’s own ML model — severity, category and a keep/tune/noisy verdict per bot. On adjudicated ground truth the model agrees 0.700 exactly; the vendor’s own badge manages 0.474. Per-comment grading and the per-PR triage grade are free in the hosted service; the per-bot verdict table, depth, overlap and history are Pro.`,
  },
  '/pro': {
    title: `${SITE_NAME} Pro & Pro+ — the measurement depth, and the full loop`,
    description:
      'Pro is the scoreboard over the free grades: the per-bot keep/tune/noisy ROI table, behaviour and inflation history, per-seat ROI, synthesised verdicts on every drill-down, Chronology, period reports with 1:1 prep, narrated daily briefs, thread validity and CI diagnosis. Pro+ closes the loop — Claude reviews that learn, and fixes you approve, pushed to GitHub.',
  },
  '/pricing': {
    title: `Pricing — ${SITE_NAME} is open-core and free. Pro from $15 a seat`,
    description: `The ${SITE_NAME} dashboard — including independent grading on every bot comment and the per-PR triage grade — is free forever. Pro is $15 a seat for the per-bot verdict table, the history, depth and reports; Pro+ is $29 a seat for Claude reviews and fixes on your own key.`,
  },
  '/how-it-works': {
    title: 'How it works — sync, architecture & roadmap',
    description: `The engineering behind ${SITE_NAME}: an idempotent five-minute sync pipeline with two-phase backfill and lean storage, a dual-dialect SQLite/Postgres data layer, the local-vs-cloud split, the security model — and what’s next (metered advanced AI, BYO endpoints, deeper Jira/Linear, email digests).`,
  },
  '/arcade': {
    title: 'Inbox Invaders — the notification firehose as an arcade game',
    description:
      `A free browser game about the thing ${SITE_NAME} takes off your desk: ` +
      'twelve kinds of notification descend, you clear what you can, and the ' +
      'inbox wins. No sign-up.',
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

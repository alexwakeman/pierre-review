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
    title: 'Pierre — the calm layer above your review bot',
    description:
      'Bring your own reviewer. Pierre is the cross-repo layer above CodeRabbit, Greptile and Copilot — what’s stalled, whose turn it is, and which of the bot’s comments a human still needs to read.',
  },
  '/features': {
    title: 'Open Core — the free multi-repo GitHub dashboard',
    description:
      'The free, open-core tier in full: the cross-repo Activity feed, the repo→contributor timeline, per-repo consoles, derived thread states, PR detail with real write actions, and the open-PR strip. Free, forever.',
  },
  '/pro': {
    title: 'Pierre Pro — AI summaries, team insights & agentic review',
    description:
      'The intelligence layer: per-repo AI digests, sprint reports, team Insights, DORA-style flow metrics, My-Turn triage, Slack digests, Jira/Linear links — plus Claude Review and AI Fix with a human hand on the wheel.',
  },
  '/pricing': {
    title: 'Pricing — Pierre is open-core and free. Pro is $5/month',
    description:
      'The Pierre dashboard is free, local-first, and yours forever. Pro adds AI summaries, team Insights, flow metrics, Slack digests and My Turn — for $5 a month.',
  },
  '/how-it-works': {
    title: 'How it works — sync, architecture & roadmap',
    description:
      'The engineering behind Pierre: an idempotent five-minute sync pipeline with two-phase backfill and lean storage, a dual-dialect SQLite/Postgres data layer, the local-vs-cloud split, the security model — and what’s next (metered advanced AI, BYO endpoints, deeper Jira/Linear, email digests).',
  },
  '/privacy': {
    title: 'Privacy policy — Pierre',
    description:
      'What Pierre collects, why, who processes it, how long it is kept, and how to get it deleted or exported. Run locally, Pierre collects nothing at all.',
  },
  '/cookies': {
    title: 'Cookie policy — Pierre',
    description:
      'Every cookie Pierre sets, what it does, how long it lasts, and a one-click control to change your analytics choice.',
  },
  '/terms': {
    title: 'Terms of service — Pierre',
    description:
      'The terms for using the hosted Pierre service: what you get, what you are responsible for, billing and cancellation, and the limits of liability.',
  },
};

/** Every route the prerenderer emits static HTML for. */
export const PRERENDER_PATHS = Object.keys(ROUTE_SEO);

export const NOT_FOUND_SEO: RouteSeo = {
  title: 'Page not found — Pierre',
  description: 'That page does not exist. Head back to the Pierre home page.',
  robots: 'noindex, follow',
};

/** The SEO record for a path, with the path folded in for canonical/og:url. */
export function seoFor(path: string): RouteSeo & { path: string } {
  return { ...(ROUTE_SEO[path] ?? NOT_FOUND_SEO), path };
}

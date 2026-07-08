// Google Analytics 4 for the timeline SPA — the SAME instance as the landing page.
//
// To enable: supply your GA4 Measurement ID (looks like "G-XXXXXXXXXX") via the
// VITE_GA_ID build env (the same var the landing uses, so one id covers both):
//   apps/frontend/.env  →  VITE_GA_ID=G-XXXXXXXXXX
// or paste it into GA_MEASUREMENT_ID below. While empty, gtag.js is never loaded
// and nothing is tracked.
//
// PRIVACY — this is CLOUD-ONLY by caller contract: App.tsx only calls
// initAnalytics() when me.deploymentMode === 'cloud'. Local installs
// (`npx pierre-review` on a user's machine) never load gtag or send a hit, so the
// local-first "no phone-home" promise holds even if an id is baked into the build.

export const GA_MEASUREMENT_ID: string =
  (import.meta.env.VITE_GA_ID as string | undefined)?.trim() || '';

// A real GA4 id is "G-" followed by ~10 alphanumerics. Guard against the literal
// placeholder so a half-finished setup never loads gtag with a bogus id.
function isValidId(id: string): boolean {
  return /^G-[A-Z0-9]{6,}$/i.test(id) && id !== 'G-XXXXXXXXXX';
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let initialised = false;

/** Inject gtag.js once and configure GA4. SPA page_view is sent manually below. */
export function initAnalytics(): void {
  if (initialised || typeof window === 'undefined') return;
  if (!isValidId(GA_MEASUREMENT_ID)) return;
  initialised = true;

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  // MUST push the genuine `arguments` object, exactly like Google's snippet
  // (`function gtag(){dataLayer.push(arguments)}`): gtag.js silently ignores commands
  // pushed as plain arrays, so a rest-param version loads the script but never executes
  // `config` and never sends a single hit. (Mirrors the landing's analytics.ts fix.)
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('js', new Date());
  // Suppress the automatic page_view; we send one ourselves (the SPA's "page" is
  // /app — query-string filter changes are not separate page views).
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });
}

/** Record a page view (the path only — query state is intentionally excluded). */
export function trackPageView(path = window.location.pathname): void {
  if (!initialised || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: `${window.location.origin}${path}`,
    page_title: document.title,
  });
}

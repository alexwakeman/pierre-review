// Google Analytics 4 for the timeline SPA — the SAME instance as the landing page.
//
// To enable: supply your GA4 Measurement ID (looks like "G-XXXXXXXXXX") via the
// VITE_GA_ID build env (the same var the landing uses, so one id covers both):
//   apps/frontend/.env  →  VITE_GA_ID=G-XXXXXXXXXX
// or paste it into GA_MEASUREMENT_ID below. While empty, gtag.js is never loaded
// and nothing is tracked.
//
// PRIVACY — TWO independent gates, both required:
//   1. CLOUD-ONLY by caller contract: App.tsx only calls initAnalytics() when
//      me.deploymentMode === 'cloud'. Local installs (`npx pierre-review` on a user's
//      machine) never load gtag or send a hit, so the local-first "no phone-home" promise
//      holds even if an id is baked into the build.
//   2. CONSENT: gtag.js is not fetched until the user has explicitly agreed
//      (lib/consent.ts). Configuring-but-denying would still have contacted Google, so the
//      script is never requested at all — and Consent Mode v2 defaults are pushed as a second
//      layer. Google Signals + ad personalisation are off. See the landing's /privacy + /cookies.

import { hasAnalyticsConsent } from './consent.js';

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

/** True when an operator configured analytics at all (drives whether to show the banner). */
export function analyticsConfigured(): boolean {
  return isValidId(GA_MEASUREMENT_ID);
}

let initialised = false;
/** Cleared by revokeAnalytics() so a same-session withdrawal stops sending hits. */
let sending = false;

/**
 * Inject gtag.js once and configure GA4. A NO-OP without a valid id AND explicit consent, so
 * callers may invoke it freely.
 */
export function initAnalytics(): void {
  if (typeof window === 'undefined') return;
  if (!isValidId(GA_MEASUREMENT_ID)) return;
  if (!hasAnalyticsConsent()) return;
  if (initialised) {
    // Re-granted in the same page life: gtag is loaded, just resume.
    sending = true;
    window.gtag?.('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  initialised = true;
  sending = true;

  window.dataLayer = window.dataLayer || [];
  // MUST push the genuine `arguments` object, exactly like Google's snippet
  // (`function gtag(){dataLayer.push(arguments)}`): gtag.js silently ignores commands
  // pushed as plain arrays, so a rest-param version loads the script but never executes
  // `config` and never sends a single hit. (Mirrors the landing's analytics.ts fix.)
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };

  // Consent Mode v2: defaults denied FIRST, then the grant we actually hold.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.gtag('js', new Date());
  // Suppress the automatic page_view; we send one ourselves (the SPA's "page" is
  // /app — query-string filter changes are not separate page views).
  // Measurement only: no Google Signals, no ad personalisation.
  window.gtag('config', GA_MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

/** Stop sending after a withdrawal. gtag cannot be unloaded, so suppress + deny instead; the
 *  next full page load will not fetch it at all. */
export function revokeAnalytics(): void {
  sending = false;
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
  }
}

/** Record a page view (the path only — query state is intentionally excluded). */
export function trackPageView(path = window.location.pathname): void {
  if (!initialised || !sending || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: `${window.location.origin}${path}`,
    page_title: document.title,
  });
}

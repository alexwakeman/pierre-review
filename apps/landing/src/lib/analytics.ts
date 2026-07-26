// Google Analytics 4 — opt-in twice over: opt-in by the OPERATOR (a measurement id
// must be supplied at build time) and opt-in by the VISITOR (explicit consent).
//
// To enable: set your GA4 Measurement ID (looks like "G-XXXXXXXXXX"), either by
//   • setting VITE_GA_ID in the build env (apps/landing/.env → VITE_GA_ID=G-XXXX), or
//   • pasting it into GA_MEASUREMENT_ID below.
// While it's empty the gtag script is never loaded and nothing is tracked, so the
// site ships analytics-ready but silent until you drop your ID in.
//
// PRIVACY / GDPR — the load-bearing part. GA4 writes a first-party `_ga` cookie and
// transmits the visitor's IP and client id to Google (a US processor). Under
// GDPR + ePrivacy that requires PRIOR consent, so:
//   • gtag.js is not fetched at all until `hasAnalyticsConsent()` is true — a
//     "configured but denied" load would still have contacted Google;
//   • Consent Mode v2 defaults are pushed BEFORE config anyway, as a second layer,
//     so ad/analytics storage is denied unless explicitly updated to granted;
//   • Google Signals and ad personalisation are switched OFF, so the data is not
//     joined to advertising identities;
//   • withdrawing consent deletes the cookies (lib/consent.ts) and stops all hits
//     for the rest of the session.
// See pages/Privacy.tsx + pages/Cookies.tsx for the user-facing disclosure.

import { hasAnalyticsConsent } from './consent';

export const GA_MEASUREMENT_ID: string =
  (import.meta.env.VITE_GA_ID as string | undefined)?.trim() || '';

// A real GA4 id is "G-" followed by ~10 alphanumerics. Guard against the literal
// placeholder so a half-finished setup never loads gtag with a bogus id.
function isValidId(id: string): boolean {
  return /^G-[A-Z0-9]{6,}$/i.test(id) && id !== 'G-XXXXXXXXXX';
}

/** True when an operator has configured analytics at all (drives the banner). */
export function analyticsConfigured(): boolean {
  return isValidId(GA_MEASUREMENT_ID);
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let initialised = false;
/** Set false by revokeAnalytics() so a same-session withdrawal stops sending hits. */
let sending = false;

function ensureGtagStub(): void {
  window.dataLayer = window.dataLayer || [];
  if (window.gtag) return;
  // MUST push the genuine `arguments` object, exactly like Google's snippet
  // (`function gtag(){dataLayer.push(arguments)}`): gtag.js silently ignores
  // commands pushed as plain arrays, so a rest-param version loads the script
  // but never executes `config` and never sends a single hit.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
}

/**
 * Inject gtag.js and configure GA4. A NO-OP unless the visitor has granted consent
 * and a valid measurement id is configured — call it freely; it guards itself.
 */
export function initAnalytics(): void {
  if (typeof window === 'undefined') return;
  if (!analyticsConfigured()) return;
  if (!hasAnalyticsConsent()) return;
  if (initialised) {
    // Re-granted within the same page life: gtag is already loaded, just resume.
    sending = true;
    window.gtag?.('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  initialised = true;
  sending = true;

  ensureGtagStub();

  // Consent Mode v2 defaults — pushed BEFORE anything else, so even if the tag were
  // somehow loaded without our gate it would start in the denied state.
  window.gtag!('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  // …then the grant we actually have.
  window.gtag!('consent', 'update', { analytics_storage: 'granted' });

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.gtag!('js', new Date());
  // We send page_view ourselves on each client-side route change (below), so the
  // initial config suppresses the automatic one to avoid a double count.
  // Google Signals / ad personalisation off: measurement only, never advertising.
  window.gtag!('config', GA_MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

/**
 * Stop sending on withdrawal. gtag.js cannot be un-loaded from the page, so the
 * flag below suppresses further hits and the caller (the banner) clears the cookies;
 * the next full page load will not fetch gtag at all.
 */
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

/** Record a virtual page view for the current location (call on every route change). */
export function trackPageView(path: string): void {
  if (!initialised || !sending || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    page_title: document.title,
  });
}

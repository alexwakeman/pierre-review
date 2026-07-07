// Google Analytics 4 — opt-in, fill-in-later.
//
// To enable: set your GA4 Measurement ID (looks like "G-XXXXXXXXXX"), either by
//   • setting VITE_GA_ID in the build env (apps/landing/.env → VITE_GA_ID=G-XXXX), or
//   • pasting it into GA_MEASUREMENT_ID below.
// While it's empty the gtag script is never loaded and nothing is tracked, so the
// site ships analytics-ready but silent until you drop your ID in.

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

/** Inject gtag.js once and configure GA4 with SPA page_view handled manually. */
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
  // (`function gtag(){dataLayer.push(arguments)}`): gtag.js silently ignores
  // commands pushed as plain arrays, so a rest-param version loads the script
  // but never executes `config` and never sends a single hit.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('js', new Date());
  // We send page_view ourselves on each client-side route change (below), so the
  // initial config suppresses the automatic one to avoid a double count.
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });
}

/** Record a virtual page view for the current location (call on every route change). */
export function trackPageView(path: string): void {
  if (!initialised || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    page_title: document.title,
  });
}

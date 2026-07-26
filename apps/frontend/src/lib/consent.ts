// Cookie / analytics consent (GDPR + ePrivacy) — the SPA's copy.
//
// Deliberately duplicated from apps/landing/src/lib/consent.ts rather than shared: the landing
// and the app share NO runtime code by design (only `@pierre-review/shared` types, and this is
// browser-storage logic, not a type). Keep the two in step — the storage KEY is identical, so a
// visitor who answers on the marketing site is not asked again inside the app.
//
//
// The legal shape of this is not "show a banner" — it is:
//   1. NOTHING non-essential runs before an affirmative choice. Google Analytics
//      sets a first-party cookie (_ga) and transmits the visitor's IP + client id
//      to Google, a US processor. Both need prior informed consent in the EU/UK,
//      so gtag.js is not merely configured-but-denied — it is never even fetched
//      until consent is granted (see analytics.ts).
//   2. Refusal must be as easy as acceptance. The banner has two equally-weighted
//      buttons; there is no "manage 47 partners" maze and no legitimate-interest
//      pre-tick, because there are no third-party ad partners to hide.
//   3. Consent is withdrawable at any time, from the same place it was given. The
//      footer carries a permanent "Cookie settings" link that reopens the banner.
//   4. The choice is versioned. Bumping CONSENT_VERSION re-asks everyone, which is
//      what must happen if the set of processors ever changes.
//
// The choice itself lives in localStorage, NOT a cookie: storing "the user declined
// cookies" in a cookie is the joke everyone makes, and localStorage for a strictly
// necessary preference needs no consent of its own.

const STORAGE_KEY = 'pierre:cookie-consent';

/** Bump when the processors or purposes change — this re-prompts every visitor. */
export const CONSENT_VERSION = 1;

export type ConsentChoice = 'granted' | 'denied';

interface StoredConsent {
  choice: ConsentChoice;
  version: number;
  /** ISO timestamp — the record of WHEN consent was given, which GDPR expects. */
  at: string;
}

const CONSENT_EVENT = 'pierre:consent';

function read(): StoredConsent | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    if (parsed.choice !== 'granted' && parsed.choice !== 'denied') return null;
    // A stale version is treated as "never asked", so the banner returns.
    if (parsed.version !== CONSENT_VERSION) return null;
    return { choice: parsed.choice, version: CONSENT_VERSION, at: parsed.at ?? '' };
  } catch {
    // Private mode / disabled storage / corrupt JSON — fail CLOSED (no consent).
    return null;
  }
}

/** The stored choice, or null when the visitor has not been asked yet. */
export function consentChoice(): ConsentChoice | null {
  if (typeof window === 'undefined') return null;
  return read()?.choice ?? null;
}

/** True only on an explicit, current-version grant. Absence is never consent. */
export function hasAnalyticsConsent(): boolean {
  return consentChoice() === 'granted';
}

/** Record a choice and notify listeners (the banner + the analytics bootstrapper). */
export function setConsent(choice: ConsentChoice): void {
  try {
    const record: StoredConsent = {
      choice,
      version: CONSENT_VERSION,
      at: new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — the in-page event below still applies for this visit */
  }
  if (choice === 'denied') clearAnalyticsCookies();
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }));
}

/** Re-open the question (the footer's "Cookie settings"). */
export function resetConsent(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to remove */
  }
  clearAnalyticsCookies();
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: null }));
}

/**
 * Best-effort removal of the cookies GA already set, so withdrawing consent
 * actually deletes data on the device rather than just stopping new hits.
 * GA4 uses `_ga` plus a per-property `_ga_<CONTAINER>`; older/UA leftovers use
 * `_gid`/`_gat`. Expiring them requires matching the path (and, for `_ga`, the
 * registrable domain it was set on), so try both host and dot-host.
 */
export function clearAnalyticsCookies(): void {
  if (typeof document === 'undefined') return;
  const host = window.location.hostname;
  // e.g. "www.pierre-review.com" → also try ".pierre-review.com"
  const parts = host.split('.');
  const domains = new Set<string>([host, `.${host}`]);
  if (parts.length > 2) {
    const apex = parts.slice(-2).join('.');
    domains.add(apex);
    domains.add(`.${apex}`);
  }
  for (const raw of document.cookie.split(';')) {
    const name = raw.split('=')[0]?.trim();
    if (!name) continue;
    if (!/^_ga(_|$)|^_gid$|^_gat/.test(name)) continue;
    for (const domain of domains) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain}`;
    }
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** Subscribe to consent changes. Returns an unsubscribe function. */
export function onConsentChange(fn: (choice: ConsentChoice | null) => void): () => void {
  const handler = (e: Event): void => {
    fn((e as CustomEvent<ConsentChoice | null>).detail ?? null);
  };
  window.addEventListener(CONSENT_EVENT, handler);
  return () => window.removeEventListener(CONSENT_EVENT, handler);
}

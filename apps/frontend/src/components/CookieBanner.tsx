import { useCallback, useEffect, useState } from 'react';
import { analyticsConfigured, initAnalytics, revokeAnalytics } from '../lib/analytics.js';
import { consentChoice, onConsentChange, setConsent } from '../lib/consent.js';

// The consent prompt inside the app. Mirrors the landing's banner, and shares its storage key —
// so someone who already answered on the marketing site is not asked a second time here.
//
// Renders NOTHING unless all three are true:
//   • the deployment is cloud (the caller passes `enabled`; local installs never load gtag at
//     all, so there is nothing to consent to and a banner would be pure noise),
//   • a GA4 measurement id was configured at build time,
//   • the visitor has not already chosen.
//
// Accept and Decline carry equal weight and cost one click each. Not a modal: refusing must not
// be more effort than accepting, and this must never sit between a user and their dashboard.

export function CookieBanner({ enabled }: { enabled: boolean }): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled || !analyticsConfigured()) return;
    setVisible(consentChoice() === null);
    // The Settings → Privacy control clears the stored choice and fires this event, which brings
    // the banner back so the user can change their mind.
    return onConsentChange((choice) => setVisible(choice === null));
  }, [enabled]);

  const accept = useCallback(() => {
    setConsent('granted');
    initAnalytics();
    setVisible(false);
  }, []);

  const decline = useCallback(() => {
    setConsent('denied');
    revokeAnalytics();
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie choices"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-gray-200 bg-white/95 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          We&apos;d like to use Google Analytics to count page views. It sets a cookie and shares
          your IP address with Google. Nothing loads unless you say yes, and Pierre works exactly
          the same either way.{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 underline hover:text-blue-500 dark:text-blue-400"
          >
            Privacy policy
          </a>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={decline}
            className="flex-1 rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 sm:flex-none"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="flex-1 rounded-md border border-gray-300 bg-gray-100 px-3.5 py-1.5 text-sm font-semibold text-gray-900 transition hover:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 sm:flex-none"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

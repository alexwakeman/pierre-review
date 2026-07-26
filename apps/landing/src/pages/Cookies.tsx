import { useCallback } from 'react';
import { useSeo } from '../lib/seo';
import { Link } from '../router';
import { resetConsent, consentChoice } from '../lib/consent';
import { revokeAnalytics } from '../lib/analytics';
import {
  LegalNote,
  LegalPage,
  LegalSection,
  LegalTable,
  Mail,
  P,
  T,
  UL,
} from '../components/legal';

// The cookie policy. Short, specific, and — importantly — it carries a working
// control rather than telling you to go and edit your browser settings. The whole
// list is four cookies, two of which only exist during a sign-in.

export default function Cookies(): JSX.Element {
  useSeo({
    title: 'Cookie policy — Pierre',
    description:
      'Every cookie Pierre sets, what it does, how long it lasts, and a one-click control to change your analytics choice.',
    path: '/cookies',
  });

  const current = typeof window === 'undefined' ? null : consentChoice();

  // Clearing the stored choice fires the consent event, which makes the banner
  // reappear so the visitor can answer again. Also stop any already-loaded tag.
  const change = useCallback(() => {
    revokeAnalytics();
    resetConsent();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <LegalPage
      title="Cookie policy"
      intro={
        <>
          <p>
            Pierre sets four cookies in total. Two are needed to keep you signed in, one
            exists for ten minutes during a GitHub sign-in, and one is analytics — which
            only ever appears if you agreed to it.
          </p>
          <div className="mt-5">
            <LegalNote title="Your current choice">
              <p>
                {current === 'granted'
                  ? 'You have accepted analytics cookies.'
                  : current === 'denied'
                    ? 'You have declined analytics cookies. None are set.'
                    : 'You have not made a choice yet, so no analytics cookies are set.'}
              </p>
              <button
                type="button"
                onClick={change}
                className="mt-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-1.5 text-sm font-semibold text-gray-200 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
              >
                Change my choice
              </button>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="list" heading="Every cookie, in full">
        <LegalTable
          columns={['Name', 'Type', 'Purpose', 'Lifetime']}
          rows={[
            [
              <span className="font-mono text-xs">pierre_session</span>,
              'Strictly necessary',
              'Keeps you signed in to the hosted app. Cryptographically sealed and HTTP-only, so page scripts cannot read it. Contains only your internal account id.',
              '30 days',
            ],
            [
              <span className="font-mono text-xs">pierre_oauth_state</span>,
              'Strictly necessary',
              'A one-time random value that proves a GitHub sign-in was started by you and not by another site. Set when you click Sign in, deleted the moment you come back.',
              '10 minutes',
            ],
            [
              <span className="font-mono text-xs">_ga</span>,
              'Analytics — consent required',
              'Google Analytics: distinguishes one visitor from another so page views can be counted.',
              '2 years',
            ],
            [
              <span className="font-mono text-xs">_ga_&lt;ID&gt;</span>,
              'Analytics — consent required',
              'Google Analytics: keeps session state for this specific property.',
              '2 years',
            ],
          ]}
        />
        <P>
          Pierre also uses your browser&apos;s <T>local storage</T> — not cookies — to
          remember interface preferences (which rows you collapsed, how tall the detail
          pane is, your cookie choice itself) and to cache pull-request detail so the app
          feels fast. None of it is transmitted anywhere and it never leaves your device.
        </P>
      </LegalSection>

      <LegalSection id="necessary" heading="Why two of them can't be declined">
        <P>
          The two <span className="font-mono text-xs">pierre_*</span> cookies are what the
          law calls strictly necessary: they exist solely to deliver something you
          explicitly asked for (being signed in, and being signed in <em>safely</em>).
          There is no version of the hosted app that works without them, and they carry no
          tracking value — one holds an account number, the other a random string that is
          thrown away seconds later. That is why they are set without asking.
        </P>
        <P>
          If you would rather not have them at all, run Pierre locally instead. There is no
          session, no sign-in and no server.
        </P>
      </LegalSection>

      <LegalSection id="analytics" heading="The analytics cookies, and how they behave">
        <UL>
          <li>
            <T>Nothing loads before you agree.</T> Decline, and the Google Analytics script
            is never downloaded — so Google is not contacted at all, not even to be told
            you refused.
          </li>
          <li>
            <T>Declining costs you nothing.</T> Every feature works identically. There is no
            nag, no reduced functionality, and the banner does not come back.
          </li>
          <li>
            <T>Advertising signals are off.</T> Google Signals and ad personalisation are
            explicitly disabled, so the data cannot be joined to an advertising profile or
            used for remarketing.
          </li>
          <li>
            <T>Changing your mind deletes the cookies.</T> Withdrawing consent expires{' '}
            <span className="font-mono text-xs">_ga</span> and{' '}
            <span className="font-mono text-xs">_ga_&lt;ID&gt;</span> on your device
            immediately and stops all further measurement.
          </li>
        </UL>
        <P>
          Google is the recipient of this data and acts as our processor; the transfer is to
          the United States. See §§2 and 5 of the{' '}
          <Link to="/privacy" className="text-brand-sky underline hover:text-sky-300">
            privacy policy
          </Link>{' '}
          for the legal detail.
        </P>
      </LegalSection>

      <LegalSection id="self-hosted" heading="Self-hosted and local installs">
        <P>
          If you run Pierre yourself, analytics is not configured at all unless you supply
          your own measurement id at build time — so the banner never appears and no
          analytics cookie is ever set. The local desktop mode has no sign-in, so it sets
          neither session cookie either. A local install sets <T>no cookies whatsoever</T>.
        </P>
      </LegalSection>

      <LegalSection id="browser" heading="Browser-level controls">
        <P>
          You can also block or delete cookies in your browser&apos;s settings, or use
          Google&apos;s own{' '}
          <a
            href="https://tools.google.com/dlpage/gaoptout"
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-sky underline hover:text-sky-300"
          >
            Analytics opt-out extension
          </a>
          . Blocking the two necessary cookies will sign you out of the hosted app.
        </P>
        <P>
          Questions about any of this: <Mail />.
        </P>
      </LegalSection>
    </LegalPage>
  );
}

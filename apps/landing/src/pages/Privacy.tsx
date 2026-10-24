import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { SITE_NAME } from '../lib/site';
import {
  LEGAL_CONTROLLER,
  LEGAL_LINK,
  LegalNote,
  LegalPage,
  LegalSection,
  LegalTable,
  Mail,
  P,
  T,
  UL,
} from '../components/legal';

// The privacy notice.
//
// Limn is local-only: there is no hosted app, no account and no server of ours in
// the path of anything the app does. So this notice is mostly about THIS WEBSITE,
// where exactly two things are collected — what someone types into the contact form,
// and consented analytics — plus the request logs any web server keeps.
//
// §3 still says plainly what the app does on the reader's own machine (it copies
// other people's GitHub activity into a local file, and the AI features send content
// to Anthropic on the reader's own credentials), because that is true and a reader
// deploying it for a team needs to know.

const LINK = LEGAL_LINK;

export default function Privacy(): JSX.Element {
  useSeo(seoFor('/privacy'));

  return (
    <LegalPage
      pigment="lapis"
      title="Privacy policy"
      intro={
        <>
          <p>
            This notice explains what personal data this website collects, why, and what you
            can do about it. It also says what the {SITE_NAME} app does on your own machine.
          </p>
          <div>
            <LegalNote title="The short version">
              <p>
                There are no accounts. On this site we collect only what you type into the
                contact form, and analytics if you accept them. The app runs on your computer
                and sends nothing to us — no telemetry, no crash reports, no analytics.
              </p>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="controller" heading="1. Who is responsible">
        <P>
          The data controller is <T>{LEGAL_CONTROLLER}</T>, a sole trader based in the United
          Kingdom, contactable at <Mail />. The same person who wrote the code answers the
          email.
        </P>
        <P>
          The UK GDPR and the Data Protection Act 2018 apply, and the EU GDPR applies to
          visitors in the EEA. If you are in California, see §8.
        </P>
      </LegalSection>

      <LegalSection id="website" heading="2. This website">
        <P>
          The pages are static. They set no cookies and run no third-party scripts{' '}
          <em>until you agree to them</em>. What the site does collect:
        </P>
        <UL>
          <li>
            <T>The contact form</T> — the name, email address, subject and message you type.
            They are delivered to a private Slack channel that one person reads. Nothing else
            is collected with them: no fingerprint, no tracking identifier, and no third-party
            anti-spam service (the form is protected by a hidden field, a signed minimum fill
            time and a rate limit, all on our own server). Your email address is used to reply
            to you and for nothing else.
          </li>
          <li>
            <T>Google Analytics 4</T>, only if you press Accept on the cookie banner. It counts
            page views and sends your IP address, approximate location, device and browser
            details and the pages you view to Google. Decline and the script is never
            downloaded. Google Signals and ad personalisation are off. Details, and how to
            change your mind, are in the{' '}
            <Link to="/cookies" className={LINK}>
              cookie policy
            </Link>
            .
          </li>
          <li>
            <T>Server logs</T> — the hosting provider records request details, including your
            IP address, for security and debugging.
          </li>
        </UL>
        <P>
          Fonts and images are served from this domain: no Google Fonts, no CDN, no tracking
          pixel.
        </P>
        <P>
          <T>The demo</T> runs in your browser on invented sample data. Nothing you type or
          click in it is sent to us, beyond the consented analytics above.
        </P>
        <P>
          <T>Legal basis:</T> consent (UK/EU GDPR Art. 6(1)(a)) for analytics; legitimate
          interests (Art. 6(1)(f)) for keeping the site secure and for answering a message you
          chose to send.
        </P>
      </LegalSection>

      <LegalSection id="app" heading="3. The app, on your machine">
        <P>
          {SITE_NAME} runs on your computer and keeps everything in a file under your home
          directory. We have no server in that path and receive none of it. What the app does,
          so you can decide where to run it:
        </P>
        <UL>
          <li>
            <T>It copies GitHub activity into that file</T> — pull requests, review comments,
            commits, and the usernames and avatars of everyone involved. That includes people
            who never chose to use {SITE_NAME}: your colleagues and any outside contributor. It
            only reads what your own GitHub login can already read.
          </li>
          <li>
            <T>AI features send content to Anthropic</T> — diffs, comments and ticket text for
            the pull request being reviewed or fixed. They use your own Claude Code login or
            Anthropic API key, so the content goes from your machine to Anthropic under your
            agreement with them. We never see it.
          </li>
          <li>
            <T>Optional integrations</T> you set up yourself — a Slack webhook, an issue
            tracker, SonarCloud — receive or send only what those features need, directly
            from your machine.
          </li>
          <li>
            <T>First-use downloads</T> — the AI runtime and the comment-grading model are
            downloaded the first time you ask for them, from npm and the model host. Those
            services see the request, as with any download.
          </li>
        </UL>
        <P>
          If you run {SITE_NAME} for a team, you are the controller for the data it holds, under
          your own privacy notice.
        </P>
      </LegalSection>

      <LegalSection id="processors" heading="4. Who else the website data reaches">
        <P>No data is sold, and there are no advertising or data-broker relationships.</P>
        <LegalTable
          label="Who else the website data reaches"
          columns={['Recipient', 'What they receive', 'Where', 'When']}
          rows={[
            [
              'Railway',
              'Hosting for this website, and its request logs',
              'USA / EU region',
              'Always',
            ],
            [
              'Slack',
              'The name, email address, subject and message you typed into the contact form, delivered to a private channel of ours',
              'USA',
              'Only when you submit the contact form',
            ],
            [
              'Google (Analytics)',
              'Page views, IP address, device and browser data',
              'USA',
              'Only with your consent (§2)',
            ],
          ]}
        />
        <P>
          Transfers outside the UK/EEA rely on the UK International Data Transfer Addendum and
          the EU Standard Contractual Clauses, as incorporated in each provider&apos;s data
          processing terms. We may also disclose data where the law requires it.
        </P>
      </LegalSection>

      <LegalSection id="retention" heading="5. How long it is kept">
        <UL>
          <li>
            <T>Contact-form messages</T> — kept in the Slack channel for as long as the
            conversation is useful, and deleted on request. The site keeps no copy of its own.
            The one exception is a failed delivery, which is written to the server log so the
            message is not lost.
          </li>
          <li>
            <T>Server logs</T> — kept by the hosting provider for a short window (days, not
            months).
          </li>
          <li>
            <T>Analytics</T> — kept by Google under the property&apos;s data-retention
            setting.
          </li>
        </UL>
      </LegalSection>

      <LegalSection id="rights" heading="6. Your rights">
        <P>
          Under UK/EU GDPR you can ask us to give you a copy of your data, correct it, delete
          it, restrict or object to how we use it, and withdraw any consent you have given.
          Email <Mail /> and we will respond within one month. It never costs anything.
        </P>
        <P>
          If your GitHub activity appears in someone else&apos;s {SITE_NAME}, that copy is on
          their machine, not ours — ask them.
        </P>
        <P>
          If you are unhappy with how we handle your data, you can complain to the UK{' '}
          <a
            href="https://ico.org.uk/make-a-complaint/"
            target="_blank"
            rel="noreferrer noopener"
            className={LINK}
          >
            Information Commissioner&apos;s Office
          </a>
          , or to your own EU supervisory authority.
        </P>
      </LegalSection>

      <LegalSection id="security" heading="7. Security">
        <P>
          The site is served over HTTPS with HSTS and a strict content security policy. If you
          find a vulnerability, report it privately to <Mail /> rather than opening a public
          issue.
        </P>
      </LegalSection>

      <LegalSection id="california" heading="8. California residents">
        <P>
          We do not sell personal information and do not share it for cross-context
          behavioural advertising, as the CCPA/CPRA define those terms. You have the right to
          know what we collect (§2), to delete it, to correct it, and not to be discriminated
          against for asking. Email <Mail />. We do not knowingly collect data from anyone
          under 16.
        </P>
      </LegalSection>

      <LegalSection id="changes" heading="9. Changes">
        <P>
          If this notice changes materially we will update the date at the top and, where the
          change affects consent, ask again. The full history is in the public git repository.
        </P>
      </LegalSection>
    </LegalPage>
  );
}

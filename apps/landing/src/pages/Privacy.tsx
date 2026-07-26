import { useSeo } from '../lib/seo';
import { Link } from '../router';
import {
  LEGAL_CONTROLLER,
  LegalNote,
  LegalPage,
  LegalSection,
  LegalTable,
  Mail,
  P,
  T,
  UL,
} from '../components/legal';

// The privacy notice. Two things make Pierre's version unusual and both are stated
// up front rather than buried:
//   1. There are TWO products here. Run locally, nothing is collected by anyone —
//      there is no server to collect it. The notice below is almost entirely about
//      the hosted cloud version.
//   2. The data Pierre syncs includes personal data about people who are NOT its
//      users — the other GitHub accounts whose pull requests and comments appear on
//      your team's board. Pretending otherwise would be the dishonest thing to do,
//      so §4 says so explicitly and explains the legal basis.

export default function Privacy(): JSX.Element {
  useSeo({
    title: 'Privacy policy — Pierre',
    description:
      'What Pierre collects, why, who processes it, how long it is kept, and how to get it deleted or exported. Run locally, Pierre collects nothing at all.',
    path: '/privacy',
  });

  return (
    <LegalPage
      title="Privacy policy"
      intro={
        <>
          <p>
            This notice explains what personal data Pierre processes, why, and what you
            can do about it. It covers the hosted service at{' '}
            <span className="font-mono text-gray-200">pierre-review.com</span>.
          </p>
          <div className="mt-5">
            <LegalNote title="If you run Pierre on your own machine, this notice barely applies to you">
              <p>
                Pierre&apos;s default mode is local: it runs on your computer, stores
                everything in a SQLite file under your home directory, authenticates with
                your own <span className="font-mono">gh</span> CLI token, and sends
                nothing to us. We have no server in that path and receive no data — not
                telemetry, not crash reports, not analytics. The rest of this notice is
                about the hosted cloud version, where there is a server and we do process
                data. Sections 2 (analytics) and 7 (AI features) are the only ones with
                anything to say about local installs, and both are opt-in.
              </p>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="controller" heading="1. Who is responsible">
        <P>
          The data controller for the hosted service is <T>{LEGAL_CONTROLLER}</T>, an
          individual sole trader based in the United Kingdom, contactable at <Mail />.
          Pierre is a small independent project, not a company with a privacy department:
          the same person who wrote the code answers the email.
        </P>
        <P>
          Because the controller is UK-based, the UK GDPR and the Data Protection Act 2018
          apply, and the EU GDPR applies to visitors and users in the EEA. If you are in
          California, see §11.
        </P>
      </LegalSection>

      <LegalSection id="website" heading="2. The website and analytics">
        <P>
          The marketing pages you are reading now are static. They set no cookies and run
          no third-party scripts <em>until you agree to them</em>. Specifically:
        </P>
        <UL>
          <li>
            <T>Google Analytics 4</T> — used to count page views and see which pages are
            useful. It writes a first-party <span className="font-mono">_ga</span> cookie
            and sends your IP address, approximate location, device/browser details and the
            pages you view to Google. It runs <em>only</em> if you press Accept on the
            cookie banner. Decline and the script is never even downloaded. Google Signals
            and ad personalisation are switched off, so the data is never joined to an
            advertising profile. Full detail, including how to change your mind, is in the{' '}
            <Link to="/cookies" className="text-brand-sky underline hover:text-sky-300">
              cookie policy
            </Link>
            .
          </li>
          <li>
            <T>Fonts and assets</T> — the brand typeface and every image are served from
            this domain. There is no Google Fonts request, no CDN and no tracking pixel, so
            loading a page discloses nothing to a third party.
          </li>
          <li>
            <T>Server logs</T> — the hosting provider records request metadata including
            your IP address, for security and debugging. See §6.
          </li>
        </UL>
        <P>
          <T>Legal basis:</T> consent (UK/EU GDPR Art. 6(1)(a)) for analytics; legitimate
          interests (Art. 6(1)(f)) for keeping the service secure and available.
        </P>
      </LegalSection>

      <LegalSection id="account" heading="3. If you sign in to the hosted app">
        <P>
          Signing in uses GitHub OAuth. We never see or store a password. What we do store:
        </P>
        <LegalTable
          columns={['Data', 'Why', 'Notes']}
          rows={[
            [
              'Your GitHub id, username, display name and avatar URL',
              'To identify your account and show who you are in the UI',
              'Read from GitHub at sign-in and refreshed periodically',
            ],
            [
              'A GitHub access token',
              'To read the repositories you ask Pierre to watch, and to perform actions you initiate (posting a review, resolving a thread)',
              'Encrypted at rest with AES-256-GCM. Never sent to your browser, never logged.',
            ],
            [
              'A session cookie',
              'To keep you signed in',
              'Named pierre_session, cryptographically sealed, HTTP-only, 30 days. Strictly necessary — no consent needed, and it cannot be declined without signing out.',
            ],
            [
              'Timestamp of your last activity',
              'So we only sync repositories for accounts that are actually being used',
              'A single timestamp; no history is kept',
            ],
            [
              'Your plan, and a Stripe customer id if you buy Pro',
              'To know what you are entitled to',
              'See §5 — card details never reach our server',
            ],
          ]}
        />
        <P>
          <T>Legal basis:</T> performance of a contract (Art. 6(1)(b)) — this is the data
          required to provide the service you asked for.
        </P>
      </LegalSection>

      <LegalSection id="repo-data" heading="4. Repository data — including other people's">
        <P>
          Pierre&apos;s purpose is to show a team&apos;s pull-request activity. When you add
          a repository, Pierre copies recent activity from GitHub into its database so it
          can be searched, filtered and charted. That includes:
        </P>
        <UL>
          <li>
            pull request titles, descriptions, state, timestamps, labels and CI results;
          </li>
          <li>
            review comments, review bodies and issue comments — the actual text people
            wrote;
          </li>
          <li>commit SHAs, messages and the file paths each commit touched;</li>
          <li>
            the GitHub username, display name and avatar of everyone who authored, reviewed
            or commented on any of it;
          </li>
          <li>metrics derived from the above (review turnaround, bot activity, and so on).</li>
        </UL>
        <P>
          <T>
            This means Pierre processes personal data about people who never signed up for
            it
          </T>{' '}
          — your colleagues, and any outside contributor to a repository you watch. We are
          stating that plainly because it is true of every tool in this category and is
          rarely admitted.
        </P>
        <P>
          Two things limit it. First, Pierre only ever reads what the connected GitHub
          token can already read, so it can never surface anything the account holder was
          not already entitled to see. Second, by default Pierre stores <em>less</em> than
          it could: pull-request descriptions, diff hunks and commit messages are not
          persisted at all unless the operator turns that on — they are fetched from GitHub
          on demand when you open a pull request, and cached in your browser rather than on
          the server.
        </P>
        <P>
          <T>Legal basis:</T> legitimate interests (Art. 6(1)(f)) — the interest being a
          development team&apos;s ability to see and manage its own review workload. The data
          is professional activity that the individuals concerned published in a
          collaborative workspace, the processing is limited to what the team&apos;s existing
          access already permits, and it is not used for profiling, advertising or any
          decision about the individual. If you are deploying Pierre for a team, you are
          likely a joint or independent controller for this data under your own privacy
          notice; contact us at <Mail /> if you need a data processing agreement.
        </P>
      </LegalSection>

      <LegalSection id="processors" heading="5. Who else the data reaches">
        <P>
          We use a small number of processors. No data is sold, and there are no
          advertising or data-broker relationships.
        </P>
        <LegalTable
          columns={['Recipient', 'What they receive', 'Where', 'When']}
          rows={[
            [
              'GitHub (Microsoft)',
              'Your token is used to read repository activity; actions you take (a review, a comment, a resolved thread) are written back',
              'USA / global',
              'Always — it is the data source',
            ],
            [
              'Railway',
              'Hosting: the application, its database and its request logs',
              'USA / EU region',
              'Always',
            ],
            [
              'Google (Analytics)',
              'Page views, IP address, device and browser data',
              'USA',
              'Only with your consent (§2)',
            ],
            [
              'Anthropic',
              'The content sent to the model: diffs, comment text and metrics for the pull requests being summarised or reviewed',
              'USA',
              'Only when you use a Pro AI feature (§7)',
            ],
            [
              'Stripe',
              'Your payment details, name and billing address',
              'USA / EU',
              'Only if you buy Pro. Collected by Stripe directly — card data never touches our server.',
            ],
            [
              'Slack',
              'The digest content you configured',
              'USA',
              'Only if you set up a Slack digest webhook yourself',
            ],
          ]}
        />
        <P>
          Transfers outside the UK/EEA rely on the UK International Data Transfer Addendum
          and the EU Standard Contractual Clauses, as incorporated in each provider&apos;s
          data processing terms. We may also disclose data where legally required, or to
          protect the service against abuse.
        </P>
      </LegalSection>

      <LegalSection id="retention" heading="6. How long data is kept">
        <UL>
          <li>
            <T>Repository activity</T> — pull requests and everything attached to them are
            deleted automatically once they have been inactive for 180 days. This runs
            nightly; nothing accumulates indefinitely.
          </li>
          <li>
            <T>Your account</T> — kept until you delete it. Deleting removes the account
            row, your encrypted token, every repository you added and all the activity
            synced for them.
          </li>
          <li>
            <T>Server logs</T> — retained by the hosting provider for a short operational
            window (days, not months). Credentials are redacted before anything is written.
          </li>
          <li>
            <T>AI usage records</T> — a running count of tokens and credits used per month,
            for billing and quota. The prompts themselves are not stored by us.
          </li>
          <li>
            <T>Billing records</T> — held by Stripe for as long as UK tax law requires
            (currently six years).
          </li>
        </UL>
      </LegalSection>

      <LegalSection id="ai" heading="7. AI features">
        <P>
          Pierre&apos;s AI features are opt-in and clearly labelled. When you use one — a
          repository digest, a pull-request summary, team insights, an AI review — the
          relevant content is sent to <T>Anthropic</T> to generate the result. That content
          can include source-code diffs, review comments and the names of the people
          involved.
        </P>
        <P>
          Anthropic acts as our processor and, under its commercial terms, does not use
          this content to train its models. Even so: treat an AI feature as a decision to
          share that code and those comments with a third party, and do not enable it on a
          repository where that would be inappropriate. Nothing is sent unless you press
          the button.
        </P>
        <P>
          On a local install, AI features use <em>your own</em> Anthropic credentials and
          the content goes from your machine to Anthropic directly — we are not in the path
          and never see it.
        </P>
      </LegalSection>

      <LegalSection id="benchmark" heading="8. The cross-organisation benchmark (off by default)">
        <P>
          The hosted app offers an optional benchmark that compares your review-bot metrics
          against an aggregate of other organisations. It is <T>off unless you switch it
          on</T>. When enabled, aggregate, non-identifying counts are contributed to that
          pool — never repository names, pull-request contents or usernames. You can turn it
          off at any time in settings, which stops further contribution.
        </P>
        <P>
          <T>Legal basis:</T> consent (Art. 6(1)(a)), withdrawable at any time.
        </P>
      </LegalSection>

      <LegalSection id="rights" heading="9. Your rights">
        <P>
          Under UK/EU GDPR you can ask us to: give you a copy of your data (access and
          portability), correct it, delete it, restrict or object to how we use it, and
          withdraw any consent you have given. Exercising a right never costs you anything
          and never degrades the service.
        </P>
        <P>Two of these are self-service in the hosted app, under Settings → Your data:</P>
        <UL>
          <li>
            <T>Export</T> — downloads everything associated with your account as a single
            JSON file.
          </li>
          <li>
            <T>Delete account</T> — irreversibly removes your account, your encrypted
            GitHub token, your repositories and all synced activity. It also revokes
            Pierre&apos;s access to your GitHub account.
          </li>
        </UL>
        <P>
          For anything else, or if you are not a user but your GitHub activity appears in
          someone&apos;s Pierre instance, email <Mail /> and we will respond within one
          month. To help with the second case: we hold that data on behalf of whichever
          account added the repository, so we may need to put you in touch with them —
          include the repository name if you can.
        </P>
        <P>
          If you are unhappy with how we handle it, you can complain to the UK{' '}
          <a
            href="https://ico.org.uk/make-a-complaint/"
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-sky underline hover:text-sky-300"
          >
            Information Commissioner&apos;s Office
          </a>
          , or to your own EU supervisory authority.
        </P>
      </LegalSection>

      <LegalSection id="security" heading="10. Security">
        <P>
          GitHub tokens are encrypted at rest with AES-256-GCM under a key held only in the
          server environment. Session cookies are sealed, HTTP-only and same-site. All
          traffic is HTTPS with HSTS. Every database query is scoped to the owning account,
          and that isolation is enforced by an automated check in the build. Credentials are
          redacted from logs. The application is open source, so you can verify all of this
          rather than take our word for it.
        </P>
        <P>
          No system is perfect. If you find a vulnerability, please report it privately to{' '}
          <Mail /> rather than opening a public issue.
        </P>
      </LegalSection>

      <LegalSection id="california" heading="11. California residents">
        <P>
          We do not sell personal information and do not share it for cross-context
          behavioural advertising, as those terms are defined by the CCPA/CPRA. You have
          the right to know what we collect (§§2–4), to delete it, to correct it, and not to
          be discriminated against for asking. Use the self-service controls in §9 or email{' '}
          <Mail />. We do not knowingly collect data from anyone under 16.
        </P>
      </LegalSection>

      <LegalSection id="changes" heading="12. Changes">
        <P>
          If this notice changes materially we will update the date at the top and, where
          the change affects consent, re-ask for it. The full history is in the public git
          repository, so you can diff any version against any other.
        </P>
      </LegalSection>
    </LegalPage>
  );
}

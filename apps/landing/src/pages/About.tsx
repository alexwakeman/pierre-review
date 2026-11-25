import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { FREE_TEAM_SIZE, SITE_NAME } from '../lib/site';
import { LEGAL_LINK, LegalPage, LegalSection, P, UL } from '../components/legal';

// About. The plain reading layout of the legal pages (components/legal.tsx), because
// this page is read for facts, not sold to.
//
// "Using your own Claude login" lives HERE, not in the docs: it is a statement about
// the product and Anthropic's terms, and the docs' providers page points here
// (docs/pages/settings/how-providers-treat-your-work.tsx #your-claude-login). Keep the
// quotations word for word and dated; say nothing Anthropic has not said. Ensemble does
// not claim the login route is allowed, nor that it is forbidden (CLAUDE.md, the
// credential ladder).

const LINK = LEGAL_LINK;
const A_LEGAL = 'https://code.claude.com/docs/en/legal-and-compliance';
const A_LEGAL_SOURCE = 'Legal and compliance, Claude Code Docs (retrieved 19 November 2026)';
const A_SALES = 'https://www.anthropic.com/contact-sales';

function Quote({ children }: { children: string }): JSX.Element {
  return (
    <figure className="lg-quote">
      <blockquote cite={A_LEGAL}>{children}</blockquote>
      <figcaption>
        <a className={LINK} href={A_LEGAL} target="_blank" rel="noreferrer noopener">
          {A_LEGAL_SOURCE}
        </a>
      </figcaption>
    </figure>
  );
}

export default function About(): JSX.Element {
  useSeo(seoFor('/about'));

  return (
    <LegalPage
      pigment="verdigris"
      title={`About ${SITE_NAME}`}
      dateLine="Updated 19 November 2026"
      intro={
        <p>
          {SITE_NAME} is a dashboard and a set of AI tools for a team&rsquo;s pull requests. It runs only on your
          computer, with your own GitHub sign-in and your own AI account. There is no {SITE_NAME} server and no{' '}
          {SITE_NAME} account. It is free for individuals, and for organisations where no more than {FREE_TEAM_SIZE}{' '}
          people use it.
        </p>
      }
    >
      <LegalSection id="your-claude-login" heading="Using your own Claude login">
        <P>
          {SITE_NAME} uses your Anthropic API key by default. It can also run on a Claude Code login (Pro, Max or
          Ultra). This section says what Anthropic&rsquo;s terms say about that, how {SITE_NAME} uses a login, and what
          is not settled, so you can decide.
        </P>

        <h3 className="lg-h3">What Anthropic says</h3>
        <Quote>
          {`Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users.`}
        </Quote>
        <Quote>
          Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the
          Agent SDK.
        </Quote>
        <Quote>
          Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior
          notice.
        </Quote>

        <h3 className="lg-h3">How {SITE_NAME} uses a login</h3>
        <UL>
          <li>
            {SITE_NAME} has no Claude sign-in of its own. You sign in through Anthropic&rsquo;s own flow, with{' '}
            <code>claude</code>.
          </li>
          <li>
            {SITE_NAME} runs on your computer. Claude Code reads your login there. {SITE_NAME} never stores it or sends
            it anywhere, and there is no {SITE_NAME} server.
          </li>
          <li>
            Each person runs their own copy on their own plan. No one&rsquo;s requests go through anyone else&rsquo;s
            account.
          </li>
          <li>
            Automatic runs stop at 10% of your week a day and 50% a week unless you change it, and Settings → AI shows how much of your plan{' '}
            {SITE_NAME} has used.
          </li>
        </UL>

        <h3 className="lg-h3">What is not settled</h3>
        <P>
          {SITE_NAME} is built on the Agent SDK, so it is the kind of product the first quotation is about. Anthropic
          has not said whether a tool that each person installs and runs on their own computer, on their own login,
          counts as routing requests &ldquo;on behalf of their users&rdquo;. We asked Anthropic&rsquo;s support team,
          and they did not give a ruling. So we do not say this use is allowed, and we do not say it is forbidden. If
          Anthropic gives a ruling, we will update this page.
        </P>

        <h3 className="lg-h3">If you choose a login</h3>
        <UL>
          <li>With no API key set, {SITE_NAME} uses your login.</li>
          <li>
            With a key set, untick <strong className="lg-t">Use my API keys first</strong> in Settings → AI to use the
            login first.
          </li>
          <li>
            Keep the spend budget on, so {SITE_NAME}&rsquo;s automatic runs stay within ordinary use of your plan. See{' '}
            <Link className={LINK} to="/docs/settings/ai-usage-and-spend">
              AI usage and spend
            </Link>
            .
          </li>
        </UL>
        <P>
          To ask Anthropic about your own use, use its{' '}
          <a className={LINK} href={A_SALES} target="_blank" rel="noreferrer noopener">
            contact sales
          </a>{' '}
          form, which its terms name for questions about authentication. To set up an API key, see{' '}
          <Link className={LINK} to="/docs/integrations/claude">
            Set up Claude
          </Link>
          .
        </P>
      </LegalSection>
    </LegalPage>
  );
}

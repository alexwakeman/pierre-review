import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { REPO_URL, SITE_NAME } from '../lib/site';
import { VENDOR_LEGAL_LINE, VENDOR_NAME } from '../lib/licence';
import { LEGAL_CONTACT_EMAIL } from '../components/legal';
import { useReveal } from '../components/board/useReveal';
import './pricing.css';

// ---------------------------------------------------------------------------
// Security and trust — the one page a security or procurement reviewer reads.
//
// FACTS ONLY, each one checkable in the code or the docs it links to. No promise that is
// not already true (no continuity commitment, no certification) — those go here only once
// they exist. The detail lives in /docs/security/*; this page summarises and links.
//
// Reuses the pricing page's layout (./pricing.css, `.lb.pricing`): same tiles, same grid.
// ---------------------------------------------------------------------------

const OUT: { to: string; what: string }[] = [
  { to: 'GitHub', what: 'Reads of your repositories, and the writes you press or switch on, through your own GitHub CLI sign-in.' },
  { to: 'Anthropic or OpenAI', what: 'Code, diffs and ticket text for each AI run, under your own account and its terms.' },
  { to: 'Your tracker, wiki, SonarCloud or Slack', what: 'Only once you connect one.' },
  { to: 'npm and GitHub', what: 'Downloads of the AI programs, the scoring model and the sandbox image.' },
];

export default function Trust(): JSX.Element {
  useSeo(seoFor('/trust'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb pricing" ref={ref}>
      <section className="board p-head" aria-labelledby="t-h1">
        <div className="tile p-name">
          <h1 id="t-h1">Security and trust</h1>
          <p className="p-lead">
            {SITE_NAME} is software that runs on your own computers. We run no server for it, and it sends nothing to us:
            no analytics, no usage reports, no crash reports.
          </p>
        </div>
      </section>

      <section className="section board p-facts" aria-label="Where your data goes">
        <div className="tile rise">
          <h2>Where your data goes</h2>
          <ul className="p-list">
            {OUT.map((o) => (
              <li key={o.to}>
                <b>{o.to}.</b> {o.what}
              </li>
            ))}
          </ul>
          <p>
            <Link to="/docs/security/browser-and-network">The full list</Link>
          </p>
        </div>
        <div className="tile verdigris rise">
          <h2>No new supplier in your data path</h2>
          <p>
            {VENDOR_NAME} never receives your code or your team&rsquo;s data, so it is not a data processor for you. Each
            copy of {SITE_NAME} keeps its data in a file on that computer; your organisation is the controller of it.
          </p>
          <p>
            Nothing is installed on your GitHub organisation, and {SITE_NAME} stores no GitHub token.
          </p>
        </div>
        <div className="tile rise">
          <h2>What the AI agents can do</h2>
          <ul className="p-list">
            <li>Reviews and chats only read. They cannot edit files or run commands.</li>
            <li>
              AI Fix and Implement story run commands only in a container or virtual machine on your computer, with no
              GitHub credentials and no write access to your files.
            </li>
            <li>Anything an agent reads from a pull request is treated as untrusted.</li>
          </ul>
          <p>
            <Link to="/docs/security/ai-and-the-sandbox">How the sandbox works</Link>
          </p>
        </div>
      </section>

      <section className="section board p-facts" aria-label="Defaults and assurance">
        <div className="tile rise">
          <h2>What happens without a click</h2>
          <p>
            Nothing is posted to GitHub or pushed until a person presses the button. Automatic review, fixing, pushing and
            dependency handling are off until someone switches them on, per workspace. One thing is on by default: on your own
            pull requests, once a thread {SITE_NAME} opened is addressed, it replies and resolves it. Settings → AI review
            switches that off.
          </p>
        </div>
        <div className="tile lapis rise">
          <h2>Certifications</h2>
          <p>
            We hold no SOC 2 or ISO 27001 report and have had no independent penetration test. Those cover a supplier that
            holds your data; {SITE_NAME} holds none. The source is public, so you can read what it does:{' '}
            <a href={REPO_URL}>the repository</a>.
          </p>
        </div>
        <div className="tile madder rise">
          <h2>Report a security problem</h2>
          <p>
            Email <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> with &ldquo;Security&rdquo; in the
            subject. Please do not open a public issue for it. You get a reply within two working days.
          </p>
        </div>
      </section>

      <section className="section board p-vendor" aria-label="Who makes it">
        <div className="tile rise">
          <h2>Who makes it</h2>
          <p>
            {VENDOR_LEGAL_LINE} Read the <Link to="/terms">terms</Link>, the <Link to="/privacy">privacy policy</Link> and the{' '}
            <Link to="/pricing">licence prices</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}

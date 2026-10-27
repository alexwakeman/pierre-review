import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { DEMO_PATH, FREE_TEAM_SIZE, INSTALL_COMMAND, LICENSE_URL, SITE_NAME } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import { ContactForm } from '../components/ContactForm';
import initialH from '../assets/board/img/initial-h.jpg';
import './contact.css';

// ---------------------------------------------------------------------------
// Contact — and the way an organisation gets a licence.
//
// Limn is free for individuals, and for organisations where no more than FREE_TEAM_SIZE
// people use it (the Limn License at the repository root). More users than that need a
// commercial licence, and there is no checkout: it starts
// with a message here. So the first sentence says who this page is for, and the
// form opens on the licence topic when the visitor arrives from a licence link
// (`?topic=licence`).
//
// NO PHONE NUMBER, NO ADDRESS, NO "our team". It is one person answering, the
// page says so, and that is the most useful true thing on it.
//
// /pricing RESOLVES TO THIS PAGE (App.tsx and prerender.mjs): somebody asking what it
// costs finds the answer in the first two lines — nothing, unless more than
// FREE_TEAM_SIZE people in the organisation use it.
//
// Drawn in the home page's board style (src/board.css); page-only layout and the
// form's styles live in ./contact.css, scoped under `.lb.contact`.
// ---------------------------------------------------------------------------

export default function Contact(): JSX.Element {
  useSeo(seoFor('/contact'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb contact" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board c-head" aria-labelledby="c-h1">
        <div className="tile c-name">
          <h1 id="c-h1">More than {FREE_TEAM_SIZE} users? Ask for a licence here.</h1>
          <p className="c-lead">
            {SITE_NAME} is free for individuals, and for organisations where no more than{' '}
            {FREE_TEAM_SIZE} people use it. More users than that need a licence. Send a message and we will sort one out. Questions and bug
            reports are welcome here too.
          </p>
          <p className="btns">
            <a className="btn" href={DEMO_PATH}>
              Try the demo first →
            </a>
            <a className="btn alt" href={LICENSE_URL}>
              Read the licence →
            </a>
          </p>
        </div>
        <div className="tile ph c-pic">
          <img src={initialH} width={700} height={722} alt="Illuminated initial H from a choirbook" />
        </div>
        <div className="tile verdigris c-say">
          <p>
            Using it on your own, or no more than {FREE_TEAM_SIZE} people in your organisation use
            it? You need none of this —
            run <code>{INSTALL_COMMAND}</code> and it works today.
          </p>
        </div>
      </section>

      {/* ---- the form, and what happens next ------------------------- */}
      <section className="section board c-main" aria-label="Message">
        <div className="tile c-formtile rise">
          <ContactForm />
        </div>

        <div className="tile lapis c-next rise">
          <h2>What happens next</h2>
          <ul className="c-list">
            <li>
              It reaches one person, who replies — usually the same day, and always
              within two working days.
            </li>
            <li>
              If you asked about a licence, the reply says what it covers and what it
              costs for the size of your organisation.
            </li>
            <li>
              If you found something broken, the reply comes from the person who will
              fix it.
            </li>
            <li>
              Your email is used to answer you. It is not added to a mailing list and it
              is not passed to anyone.
            </li>
          </ul>
        </div>

        <div className="tile madder c-who rise">
          <h2>Who needs a licence</h2>
          <p>
            Count the people in your organisation who use {SITE_NAME}. Up to{' '}
            {FREE_TEAM_SIZE}, it is free. More than {FREE_TEAM_SIZE}, the organisation needs
            a licence.
          </p>
          <p>The full terms are in the Limn License, published with the source.</p>
        </div>
      </section>

      {/* ---- the other ways ------------------------------------------- */}
      <section className="section board c-else" aria-labelledby="c-else-h">
        <div className="tile c-txt rise">
          <h2 id="c-else-h">Or skip the form entirely.</h2>
          <p>
            Nothing on this page is a gate in front of the app.{' '}
            <code>{INSTALL_COMMAND}</code>{' '}
            runs it against your own repositories using your existing{' '}
            <code>gh</code> login, stores no
            credentials, and sends nothing to us.
          </p>
          <p>
            Bugs and feature requests are better as issues than as messages: they are
            public, they are searchable, and somebody else hitting the same thing can add
            to them.
          </p>
        </div>
      </section>

      {/* ---- start: the closing block, in board form ------------------ */}
      <section className="section board c-start" id="start" aria-labelledby="c-start-h">
        <div className="tile gold c-mid rise">
          <h2 id="c-start-h">Free. One command.</h2>
          <p>
            {SITE_NAME} runs only on your machine. It reads GitHub through your{' '}
            <code>gh</code> login and keeps its data in a file on your
            disk. There is no account and nothing to pay.
          </p>
          <p>
            Nothing is sent to us. We run no server for the app, and it has no tracking. Your
            code and pull requests go only between your machine and GitHub — and to your AI
            provider, on your own account, when a review or fix runs.
          </p>
          <p>
            <code>{INSTALL_COMMAND}</code>
          </p>
          <p className="btns">
            <a className="btn" href={DEMO_PATH}>
              Try the demo
            </a>
            <a className="btn alt" href="/contact?topic=licence">
              More than {FREE_TEAM_SIZE} users in your organisation? →
            </a>
          </p>
        </div>
        <div className="tile c-facts rise">
          <ul className="c-list">
            <li>100% free. No sign-in, no card, no repository limit.</li>
            <li>Runs only on your machine. No data is sent to our servers.</li>
            <li>
              Available only from npm: <code>{INSTALL_COMMAND}</code>.
              Needs Node 20 or later.
            </li>
            <li>
              Runs on your own AI agent tooling. Reviews and fixes use your Claude Code login,
              an Anthropic API key or Codex on your ChatGPT plan.
            </li>
            <li>
              Free for individuals, and for organisations where no more than {FREE_TEAM_SIZE}{' '}
              people use it. More users than that need a licence —{' '}
              <a href="/contact?topic=licence">ask through the contact form</a>.
            </li>
            <li>The demo runs in your browser on sample data. No install, no sign-in.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

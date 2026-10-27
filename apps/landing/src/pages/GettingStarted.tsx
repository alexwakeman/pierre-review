import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { DEMO_PATH, INSTALL_COMMAND, NPM_PACKAGE } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import { copyText } from '../components/board/copyText';
import { useLightbox } from '../components/Lightbox';
import aiSetup from '../assets/pages/gs-ai-setup.jpg';
import aiReady from '../assets/pages/gs-ai-ready.jpg';
import mlSetup from '../assets/pages/gs-ml-setup.jpg';
import mlBadges from '../assets/pages/gs-ml-badges.jpg';
import addRepos from '../assets/pages/gs-add-repos.jpg';
import workspaces from '../assets/pages/gs-workspaces.jpg';
import trackerJira from '../assets/pages/gs-tracker-jira.jpg';
import trackerLinear from '../assets/pages/gs-tracker-linear.jpg';
import slack from '../assets/pages/gs-slack.jpg';
import './getting-started.css';

// ---------------------------------------------------------------------------
// Getting started: install and run, then the six things worth switching on.
//
// The board style (src/board.css) under `.lb`, plus this page's own rules under
// `.lb.gs` (getting-started.css). The steps are a real <ol>: order matters.
//
// Every claim here is true of the code today (cli.ts, ai/credentials.ts,
// docs/ML-SEVERITY.md, docs/SYNC.md, docs/TRACKERS.md, docs/PLATFORM.md § Slack).
// Button and field names are quoted exactly as the app spells them.
// ---------------------------------------------------------------------------

const AI_INSTALL = `${INSTALL_COMMAND} ai install`;
const CODEX_INSTALL = `${INSTALL_COMMAND} ai install codex`;
const CODEX_LOGIN = `${INSTALL_COMMAND} ai login codex`;
const ML_INSTALL = `${INSTALL_COMMAND} ml install`;

/** A command with a copy button beside it. The command stays readable if copying fails. */
function Command({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="gs-cmd">
      <pre>
        <code>{text}</code>
      </pre>
      <button className="gs-copy" type="button" onClick={copy}>
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        <span className="vh"> {text}</span>
      </button>
    </div>
  );
}

type Shot = {
  src: string;
  width: number;
  height: number;
  alt: string;
  label?: string;
  /** Left out on phones, where a second strip of the same panel adds nothing. */
  phoneHide?: boolean;
};

function Shots({ shots }: { shots: Shot[] }): JSX.Element {
  const lightbox = useLightbox();
  return (
    <>
      {shots.map((s) => (
        <figure key={s.src} className={s.phoneHide ? 'gs-fig gs-phone-hide' : 'gs-fig'}>
          {s.label ? <figcaption>{s.label}</figcaption> : null}
          {/* A tap opens the screenshot full size: on a phone it is too small to read. */}
          <a
            href={s.src}
            onClick={(e) => {
              // The href still works without JS (and for a new-tab click); otherwise
              // the shot opens in place.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              lightbox.open({ src: s.src, alt: s.alt, title: s.label });
            }}
          >
            <img src={s.src} width={s.width} height={s.height} alt={s.alt} loading="lazy" />
          </a>
        </figure>
      ))}
    </>
  );
}

type StepProps = {
  n: number;
  id: string;
  title: string;
  pigment: 'lapis' | 'verdigris' | 'madder';
  /** `wide`: the pictures are long strips, so they sit full width under the text. */
  wide?: boolean;
  children: ReactNode;
  aside: ReactNode;
};

function Step({ n, id, title, pigment, wide, children, aside }: StepProps): JSX.Element {
  return (
    <li className="gs-step">
      <section className={wide ? 'board gs-row wide' : 'board gs-row'} aria-labelledby={`${id}-h`}>
        <div className={`tile gs-txt ${pigment} rise`}>
          <div className="gs-in">
            <span className="gs-n" aria-hidden="true">
              {n}
            </span>
            <h2 id={`${id}-h`}>
              <span className="vh">Step {n}: </span>
              {title}
            </h2>
            {children}
          </div>
        </div>
        <div className="tile gs-shot rise">{aside}</div>
      </section>
    </li>
  );
}

function CloseCopy(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    void copyText(INSTALL_COMMAND).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="btn alt" type="button" onClick={copy}>
      <span aria-live="polite">{copied ? 'Copied' : `Copy ${INSTALL_COMMAND}`}</span>
    </button>
  );
}

export default function GettingStarted(): JSX.Element {
  useSeo(seoFor('/getting-started'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb gs" ref={ref}>
      <section className="board gs-head" aria-labelledby="gs-h">
        <div className="tile gs-title">
          <h1 id="gs-h">Getting started</h1>
          <p className="gs-lead">
            One command starts Limn on your machine. Then add your repositories, and switch on the parts you want.
          </p>
        </div>
        <div className="tile verdigris gs-need">
          <h2>You need</h2>
          <ul>
            <li>Node 20 or later</li>
            <li>
              The GitHub CLI, signed in with <code>gh auth login</code>
            </li>
          </ul>
          <p>Nothing else. No account, no sign-up.</p>
        </div>
      </section>

      <ol className="gs-steps">
        <Step
          n={1}
          id="install"
          title="Install and run"
          pigment="lapis"
          aside={
            <div className="gs-term" aria-label="What the terminal shows">
              <pre>
                <code>
                  <span className="gs-dim">$</span> {INSTALL_COMMAND}
                  {'\n\n'}
                  {'  '}
                  <span className="gs-acc">▸</span> http://localhost:4000/app
                  {'\n\n'}
                  <span className="gs-dim"># other options</span>
                  {'\n'}
                  <span className="gs-dim">$</span> {INSTALL_COMMAND} --port 4100
                  {'\n'}
                  <span className="gs-dim">$</span> {INSTALL_COMMAND} --no-open
                  {'\n'}
                  <span className="gs-dim">$</span> {INSTALL_COMMAND} status
                </code>
              </pre>
            </div>
          }
        >
          <p>
            Run this in a terminal. Limn starts a local server and opens <code>http://localhost:4000/app</code> in your
            browser.
          </p>
          <Command text={INSTALL_COMMAND} />
          <p>
            Limn reads GitHub with your <code>gh</code> token and stores no GitHub credentials. Your data stays in{' '}
            <code>~/.limn</code> on this machine.
          </p>
          <p className="gs-note">
            Installed globally (<code>npm i -g {NPM_PACKAGE}</code>), the command is <code>limn</code>. For organisation
            repos behind SSO you may need <code>gh auth refresh -h github.com -s read:org</code>.
          </p>
        </Step>

        <Step
          n={2}
          id="ai"
          title="Connect your AI agent"
          pigment="verdigris"
          wide
          aside={
            <Shots
              shots={[
                {
                  src: aiSetup,
                  width: 1424,
                  height: 226,
                  label: 'Before',
                  phoneHide: true,
                  alt: "A pull request's AI Review tab with the button 'Set up AI (one-time ~110 MB download)'",
                },
                {
                  src: aiReady,
                  width: 1424,
                  height: 227,
                  label: 'After',
                  alt: "The same tab once AI is set up: a model picker, a Re-review button and the review",
                },
              ]}
            />
          }
        >
          <p>
            AI Review, AI Fix and the chats run on your own AI agent tooling: Claude Code or Codex. Limn stores no key
            and charges nothing.
          </p>
          <p>
            The first time, press <b>Set up AI (one-time ~110 MB download)</b>, shown where the Run button will be, or run:
          </p>
          <Command text={AI_INSTALL} />
          <p>
            <b>Claude Code.</b> Sign in once with <code>claude</code>, or set <code>ANTHROPIC_API_KEY</code>.
          </p>
          <p>
            <b>Codex.</b> Add Codex and sign in with your ChatGPT account, or do both from <b>Settings → AI</b>:
          </p>
          <Command text={CODEX_INSTALL} />
          <Command text={CODEX_LOGIN} />
          <p className="gs-note">
            On a machine without a browser, add <code>--device-auth</code> to the sign-in. Limn keeps its own Codex
            sign-in in <code>~/.limn/codex</code> and never touches <code>~/.codex</code>. An OpenAI API key is not
            supported yet.
          </p>
          <p className="gs-note">
            With both signed in, choose one in <b>Settings → AI</b> (Claude Code by default), or set{' '}
            <code>LIMN_AI_PROVIDER</code> to <code>claude</code> or <code>codex</code>. By default, nothing is posted or
            pushed until you press the button.
          </p>
        </Step>

        <Step
          n={3}
          id="budget"
          title="Set a budget"
          pigment="madder"
          aside={
            <div className="gs-modes" aria-label="The two kinds of budget">
              <div className="gs-mode">
                <b>On a subscription</b>
                <dl>
                  <div>
                    <dt>Limn's share of your week</dt>
                    <dd>5%, you choose</dd>
                  </div>
                  <div>
                    <dt>Each 5-hour session</dt>
                    <dd>same as your week, unless you change it</dd>
                  </div>
                </dl>
              </div>
              <div className="gs-mode">
                <b>On an API key</b>
                <dl>
                  <div>
                    <dt>Each week</dt>
                    <dd>US$ you choose</dd>
                  </div>
                </dl>
              </div>
            </div>
          }
        >
          <p>
            In <b>Settings</b>, under <b>AI spend</b>.
          </p>
          <ul className="gs-list">
            <li>
              On a Claude or ChatGPT subscription, you choose what share of your weekly allowance Limn may use: 5%
              unless you change it, up to 50%. Limn adds up what its own runs use and compares that with the
              allowance. Allowances aren't published exactly, so this is an estimate. On Claude Max, Limn asks whether
              it's Max 5x or Max 20x.
            </li>
            <li>
              Each 5-hour session gets the same share as your week, unless you set it separately.
            </li>
            <li>
              When Limn has used its share, it stops starting automatic runs until your week or session resets. Your
              own use of your AI agent is never limited, and runs you start yourself still run after you confirm.
            </li>
            <li>
              The header shows Limn's AI quota: how much of its budget is used, or with no budget, how much of your week. Click it to see when your week and session reset. On a
              subscription, each run's cost shows as a share of your week, not in dollars.
            </li>
            <li>On an API key, set a weekly budget in US dollars.</li>
          </ul>
          <p className="gs-note">
            Want reviews to use less? The design diagram drawn after each review is on by default and can be turned off
            for each workspace.
          </p>
        </Step>

        <Step
          n={4}
          id="ml"
          title="Add the scoring model"
          pigment="lapis"
          wide
          aside={
            <Shots
              shots={[
                {
                  src: mlSetup,
                  width: 622,
                  height: 107,
                  label: 'Settings → Bot comment scoring',
                  alt: "The Bot comment scoring section of Settings, with the button 'Set up (one-time ~240 MB download)'",
                },
                {
                  src: mlBadges,
                  width: 1140,
                  height: 170,
                  label: 'What it gives you',
                  alt: 'What the bots are flagging: 502 findings, 49% high severity, 30% nits, with categories and a severity legend',
                },
              ]}
            />
          }
        >
          <p>
            Limn's own small model scores each review-bot comment from nit to critical, and tags it with a category. It
            does not take the bot's own label on trust.
          </p>
          <p>
            It runs at background priority and pauses on battery. Nothing leaves your machine to score a comment. In{' '}
            <b>Settings</b>, under <b>Bot comment scoring</b>, press <b>Set up (one-time ~240 MB download)</b>, or run:
          </p>
          <Command text={ML_INSTALL} />
          <p className="gs-note">
            On 300 bot comments graded independently, with every existing label hidden, it agreed 70% of the time.
            CodeRabbit's own badge agreed 47% of the time, on the 228 it had labelled.
          </p>
        </Step>

        <Step
          n={5}
          id="repos"
          title="Add your repositories"
          pigment="verdigris"
          aside={
            <Shots
              shots={[
                {
                  src: addRepos,
                  width: 672,
                  height: 475,
                  alt: "The Repos & workspaces dialog: searching 'acme/' lists four repositories, each with an Add button",
                },
                {
                  src: workspaces,
                  width: 672,
                  height: 475,
                  alt: 'The Repos & workspaces dialog: two workspaces, Platform and Web, and each repository with its workspace picker',
                },
              ]}
            />
          }
        >
          <p>
            On first run, Limn lists the repositories you have been active in, with up to five ticked. Press{' '}
            the <b>Add … selected</b> button, or search for any repository by name.
          </p>
          <p>
            Later, open the workspace menu at the top left and choose <b>Manage repos &amp; workspaces</b>. Each
            repository sits in exactly one workspace, and the workspace you pick sets what the whole app shows.
          </p>
          <p className="gs-note">
            A new repository fills in its last 14 days first, in seconds, then goes back 90 days in the background.
          </p>
        </Step>

        <Step
          n={6}
          id="tracker"
          title="Connect Jira or Linear"
          pigment="madder"
          aside={
            <Shots
              shots={[
                {
                  src: trackerJira,
                  width: 622,
                  height: 663,
                  alt: 'Settings → Issue tracker set to Jira, with base URL, project keys, where to look, and optional Jira API access',
                },
                {
                  src: trackerLinear,
                  width: 622,
                  height: 387,
                  alt: 'Settings → Issue tracker set to Linear, with workspace URL, team keys and where to look',
                },
              ]}
            />
          }
        >
          <p>
            In <b>Settings</b>, under <b>Issue tracker</b>, choose the provider for this workspace. GitHub Issues needs
            nothing: Limn picks it up when a repository uses it.
          </p>
          <p>
            For Jira, enter your base URL and, if you like, project keys. For Linear, enter your workspace URL. Press{' '}
            <b>Save</b>.
          </p>
          <p className="gs-note">
            An optional token lets Limn read each ticket's title, status, description and acceptance criteria. It is
            never shown again and stays on your machine. Tickets are read when a pull request arrives.
          </p>
        </Step>

        <Step
          n={7}
          id="slack"
          title="Connect Slack"
          pigment="lapis"
          aside={
            <Shots
              shots={[
                {
                  src: slack,
                  width: 622,
                  height: 476,
                  alt: 'Settings → Slack: a stored webhook, Daily at 9:00 AM, three checkboxes and a Send test button',
                },
              ]}
            />
          }
        >
          <p>
            In <b>Settings</b>, under <b>Slack</b>, paste an incoming webhook URL (create one at api.slack.com/apps →
            Incoming Webhooks). Pick <b>Daily</b> or <b>Twice daily</b>, save, and press <b>Send test</b>.
          </p>
          <p>
            The digest lists the team's Pending tabs, the top 5 of each. The digest never names the person who set it
            up. Posts when an automatic review runs or a pull request merges stay off until you tick them.
          </p>
          <p className="gs-note">Each workspace has its own channel, or none (up to 12 workspaces).</p>
        </Step>
      </ol>

      <section className="section board gs-close" aria-labelledby="gs-close-h">
        <div className="tile gold gs-close-mid rise">
          <h2 id="gs-close-h">See it first</h2>
          <p>The quick demo runs in your browser on sample data. Nothing to install.</p>
          <p className="btns">
            <a className="btn" href={DEMO_PATH}>
              Quick demo
            </a>
            <CloseCopy />
          </p>
        </div>
        <div className="tile lapis gs-close-side rise" aria-hidden="true"></div>
      </section>
    </div>
  );
}

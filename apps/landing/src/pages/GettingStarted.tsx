import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, NPM_PACKAGE } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import { copyText } from '../components/board/copyText';
import { BotsSeverityMock } from '../components/mock/reports';
import {
  AddReposMock,
  AiSettingsMock,
  BotScoringMock,
  SlackMock,
  TrackerMock,
  WorkspacesMock,
} from '../components/mock/setup';
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
//
// The pictures are HTML mocks of the real Settings sections and dialogs
// (components/mock/setup.tsx, words in src/mock/acme.ts SETUP_*): their selects,
// checkboxes and buttons work, so a reader can try the step before running it.
// ---------------------------------------------------------------------------

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

/** A mock with a small caption over it. */
function Pic({ label, children }: { label?: string; children: ReactNode }): JSX.Element {
  return (
    <figure className="gs-fig">
      {label ? <figcaption>{label}</figcaption> : null}
      {children}
    </figure>
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
    <button className="btn" type="button" onClick={copy}>
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
            <Pic>
              <AiSettingsMock />
            </Pic>
          }
        >
          <p>
            AI Review, AI Fix and the chats run on your own AI agent tooling: Claude Code or Codex. Both work out of the
            box. The first time Limn starts, it downloads them in the background, so signing in is the only step. Limn
            stores no key and charges nothing.
          </p>
          <p>
            <b>Claude Code.</b> Sign in once with <code>claude</code>, or set <code>ANTHROPIC_API_KEY</code>.
          </p>
          <p>
            <b>Codex.</b> Sign in with your ChatGPT account from <b>Settings → AI</b>, or run:
          </p>
          <Command text={CODEX_LOGIN} />
          <p className="gs-note">
            While the download runs, its progress shows where the Run button will be. If it fails, press{' '}
            <b>Retry</b>, or run <code>{CODEX_INSTALL}</code>.
          </p>
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
                    <dd>50%, you choose</dd>
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
              On a Claude or ChatGPT subscription, you choose what share of your weekly allowance Limn may use: 50%
              unless you change it, from 1% to 100%. Limn adds up what its own runs use and compares that with the
              allowance. Allowances aren't published exactly, so this is an estimate. On Claude Max, Limn asks whether
              it's Max 5x or Ultra.
            </li>
            <li>
              If your plan limits each 5-hour session, the session gets the same share as your week, unless you set
              it separately.
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
            <>
              <Pic>
                <BotScoringMock />
              </Pic>
              <Pic label="What it gives you">
                <BotsSeverityMock />
              </Pic>
            </>
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
            <>
              <Pic>
                <AddReposMock />
              </Pic>
              <Pic label="Manage repos & workspaces">
                <WorkspacesMock />
              </Pic>
            </>
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
            <Pic>
              <TrackerMock />
            </Pic>
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
            <Pic>
              <SlackMock />
            </Pic>
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
          <h2 id="gs-close-h">Run it now</h2>
          <p>One command. No account.</p>
          <p className="btns">
            <CloseCopy />
          </p>
        </div>
        <div className="tile lapis gs-close-side rise" aria-hidden="true"></div>
      </section>
    </div>
  );
}

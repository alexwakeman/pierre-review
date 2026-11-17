import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import { CopyCommand } from '../components/board/CopyCommand';
import { useReveal } from '../components/board/useReveal';
import './build.css';

// ---------------------------------------------------------------------------
// Automation — everything the dependency automation does, in detail. It shares the Build
// page's layout vocabulary (pages/build.css, `.lb.build` + the `bd-*` classes), so the two
// "how it works" pages read as one set.
//
// ⚠ EVERY CLAIM IS A PRODUCT FACT (docs/MERGE-CI-TRUNK.md § Dependency automation,
// docs/TEAM-REVIEW.md, merge/dependency-automation.ts, merge/deps-claim.ts). The traps:
//   · ON BY DEFAULT since 2026-11 (all four switches); "off" is stored explicitly;
//   · approve / fix / conflicts act only for a TRUSTED bot — Dependabot and Renovate are trusted by
//     default, any other bot by hand; MERGING needs no trust (it waits for every check);
//   · it never resolves review threads; it acts only in repositories the reader can push to;
//   · conflicts: it asks the bot to rebase first and waits 30 minutes, then the AI session;
//   · AI runs: at most 2 per pull request a day, each asks the spend budget first and is SKIPPED
//     (never queued) when over; no container runtime ⇒ one skipped line, never a claim;
//   · a person's cancel wins.
// Change this page in the same commit as the behaviour.
// ---------------------------------------------------------------------------

interface FlowStep {
  who: string;
  h: string;
  p: ReactNode;
  tone: string;
}

const STEPS: FlowStep[] = [
  { who: 'Bot', tone: 'gold', h: 'An update arrives', p: 'Dependabot or Renovate opens a pull request in one of your repositories.' },
  {
    who: SITE_NAME,
    tone: 'verdigris',
    h: 'It claims the pull request',
    p: 'A status line on the commit says you are handling it. Your teammates’ copies read it and step aside.',
  },
  {
    who: SITE_NAME,
    tone: 'verdigris',
    h: 'Approve',
    p: 'When the checks pass, it approves under your account. Only for a bot you trust.',
  },
  {
    who: 'Agent',
    tone: 'lapis',
    h: 'Fix',
    p: 'Red CI or merge conflicts: your Claude or Codex fixes them in a sandbox, and the fix is pushed.',
  },
  {
    who: SITE_NAME,
    tone: 'verdigris',
    h: 'Merge when ready',
    p: 'It lands when every check passes. If anyone pushes in the meantime, it stops.',
  },
];

function Marks({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="bd-list">
      {items.map((u, i) => (
        <li key={i}>{u}</li>
      ))}
    </ul>
  );
}

export default function Automation(): JSX.Element {
  useSeo(seoFor('/automation'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb build" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board bd-head" aria-labelledby="au-h1">
        <div className="tile bd-name">
          <h1 id="au-h1">Dependency updates, merged without you.</h1>
          <p className="bd-lead">
            {SITE_NAME} takes Dependabot and Renovate pull requests from opened to merged: it approves them, fixes
            red CI and merge conflicts, and merges when the checks pass. It runs on your machine, under your GitHub
            account.
          </p>
        </div>
        <div className="tile lapis bd-facts">
          <Marks
            items={[
              <>On by default, in every workspace. Switch any part off in Settings → Dependencies.</>,
              'Dependabot and Renovate are trusted by default. Any other bot you trust by hand.',
              'It acts only in repositories you can push to.',
            ]}
          />
        </div>
        <div className="tile verdigris bd-say">
          <p>Each update is handled once. Nobody has to open it.</p>
        </div>
        <div className="tile gold bd-go">
          <p className="btns">
            <Link className="btn" to="/docs/settings/dependencies">
              Read the docs →
            </Link>
          </p>
        </div>
      </section>

      {/* ---- the flow -------------------------------------------------- */}
      <section className="section board bd-how" aria-labelledby="au-how-h">
        <div className="tile bd-txt bd-full rise">
          <h2 id="au-how-h">What happens to an update</h2>
          <p>Each step is its own switch. Each one claims the pull request on GitHub before it writes anything.</p>
        </div>
      </section>
      <div className="board bd-flowrow">
        <ol className="bd-flowsteps five" aria-labelledby="au-how-h">
          {STEPS.map((s, i) => (
            <li key={s.h} className={`tile ${s.tone} rise`}>
              <span className="bd-fn" aria-hidden="true">
                {i + 1}
              </span>
              <span className="bd-who">{s.who}</span>
              <h4>{s.h}</h4>
              <p>{s.p}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* ---- each part in detail ----------------------------------------- */}
      <section className="board bd-notes">
        <div className="tile bd-txt bd-half rise">
          <h3>Approve them automatically</h3>
          <p>
            Once the pull request&rsquo;s checks pass, {SITE_NAME} approves it under your account. It does this only
            when the update comes from a bot you trust, so a look-alike account never gets an approval.
          </p>
        </div>
        <div className="tile bd-txt bd-half rise">
          <h3>Merge them automatically</h3>
          <p>
            It arms <b>Merge when ready</b>, which lands the pull request when every check passes, through GitHub&rsquo;s
            merge queue where a repository uses one. Arming pins the commit: if anyone pushes, it stops. Merging needs
            no trust, because it waits for every check.
          </p>
        </div>
        <div className="tile bd-txt bd-half rise">
          <h3>Fix them with AI</h3>
          <p>
            When CI is red, your Claude or Codex reads the failure and fixes it in a sandbox on your machine, and the
            fix is pushed to the update&rsquo;s branch. That commit is merged only once its own CI is green. At most
            two AI runs per pull request a day.
          </p>
        </div>
        <div className="tile bd-txt bd-half rise">
          <h3>Resolve their conflicts</h3>
          <p>
            It first asks the bot to rebase, and waits 30 minutes. If the conflicts are still there, your agent merges
            in a sandbox and resolves them. Only a merge that checks out is pushed.
          </p>
        </div>
      </section>

      {/* ---- once, however many of you ------------------------------------ */}
      <section className="section board bd-verify" aria-labelledby="au-team-h">
        <div className="tile gold bd-vhead rise">
          <h2 id="au-team-h">Once, however many of you.</h2>
          <p>
            Alone, it just runs. With teammates, each runs {SITE_NAME} on their own machine, with no server between
            you, and GitHub keeps the score the same way it does for reviews.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>Claim, then act</h3>
          <p>
            Before any write, {SITE_NAME} posts a status line on the commit: you are handling it. It reads the lines
            again, and the earliest claim wins. A teammate&rsquo;s copy that sees your line steps aside.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>A claim never sticks</h3>
          <p>
            A claim lasts while its machine is working on it. If a laptop closes mid-fix, the claim runs out and a
            teammate&rsquo;s copy takes over. When the work ends, the line says what was done, or that it is free.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>Not CI</h3>
          <p>
            These lines sit beside your checks on GitHub, but {SITE_NAME} never counts them as CI, and they never
            block a merge.
          </p>
        </div>
      </section>

      {/* ---- limits ---------------------------------------------------------- */}
      <section className="section board bd-notes" aria-labelledby="au-lim-h">
        <div className="tile bd-txt bd-full rise">
          <h2 id="au-lim-h">What keeps it in bounds</h2>
        </div>
        <div className="tile bd-txt bd-third rise">
          <h3>Which updates</h3>
          <p>
            Choose the largest update it handles (patch, minor or major), security fixes only, and which ecosystems.
            Every switch follows these.
          </p>
        </div>
        <div className="tile bd-txt bd-third rise">
          <h3>Your AI budget</h3>
          <p>
            Every AI run asks your spend budget first. Over it, the run is skipped, not queued. With no container
            runtime, the AI steps are skipped and the log says so.
          </p>
        </div>
        <div className="tile bd-txt bd-third rise">
          <h3>You win</h3>
          <p>
            Cancel it on a pull request and it stays cancelled for that update. Pending → Dependencies lists what it
            did in the last two weeks, one entry per pull request.
          </p>
        </div>
      </section>

      {/* ---- start ----------------------------------------------------- */}
      <section className="section board bd-start" aria-labelledby="au-s-h">
        <div className="tile gold bd-start-main rise">
          <h2 id="au-s-h">Let the bots finish their own work.</h2>
          <p>Run it on your machine, sign in to GitHub with gh and to Claude Code or Codex.</p>
          <code className="bd-cmd">{INSTALL_COMMAND}</code>
          <p className="btns">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
          </p>
        </div>
        <div className="tile bd-txt bd-start-list rise">
          <Marks
            items={[
              <Link key="d" to="/docs/settings/dependencies">Settings → Dependencies</Link>,
              <Link key="s" to="/docs/security/ai-and-the-sandbox">AI and the sandbox</Link>,
              <Link key="e" to="/ensemble-review">Running it with teammates</Link>,
            ]}
          />
        </div>
      </section>
    </div>
  );
}

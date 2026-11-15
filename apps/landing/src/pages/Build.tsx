import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import { CopyCommand } from '../components/board/CopyCommand';
import { useReveal } from '../components/board/useReveal';
import { LoopBodyMock, TicketCheckMock, TicketDesignMock } from '../components/mock/build';
import './build.css';

// ---------------------------------------------------------------------------
// Build — how a ticket becomes a pull request (Implement story, Fill gaps, the review loop, Build end
// to end), the story check, the Ticket design, and how to verify the result. Board style
// (src/board.css); page layout in ./build.css, scoped under `.lb.build`.
//
// ⚠ EVERY CLAIM HERE IS A PRODUCT FACT, from docs/STORY-BUILD.md, docs/SANDBOX.md,
// docs/CLAUDE-REVIEW.md (the ticket review, Check against docs, design diagrams) and the user docs
// under src/docs/pages/implement-story/, story-checks/ and ai-review/design-diagrams.tsx. The traps:
//   · the build report is a SELF-REPORT ("The agent says"), never a gate on Push;
//   · Push opens a DRAFT by default; the review loop opens the PR READY for review;
//   · the review loop posts nothing on GitHub but the branch commits and the pull request;
//   · Build end to end writes the tracker on Jira only, and never changes the ticket's status;
//   · the Ticket design is worked out by the model, and is drawn for a ticket with 2+ pull requests.
// Button and status words are the app's own. When the product changes one, change this page too.
// ---------------------------------------------------------------------------

type Who = 'You' | 'Agent' | typeof SITE_NAME;
interface FlowStep {
  who: Who;
  h: string;
  p: ReactNode;
  tone: string;
}

const BY_HAND: FlowStep[] = [
  { who: 'You', tone: 'gold', h: 'Press Implement', p: <>On the ticket&rsquo;s story view, from This Sprint. Then <b>Start</b>.</> },
  { who: 'Agent', tone: 'lapis', h: 'It plans first', p: 'It reads the ticket, the code, the data and your reference docs, and writes a plan. It changes no files.' },
  { who: 'You', tone: 'gold', h: 'Settle the plan', p: <>Each point: <b>Agree</b>, <b>Keep the story</b> or <b>Reply</b>. Then <b>Approve and start</b>.</> },
  { who: 'Agent', tone: 'lapis', h: 'It builds in the sandbox', p: 'It writes the code, runs the repositories’ own tests and reports on each criterion.' },
  { who: 'You', tone: 'gold', h: 'Read the diffs', p: 'One diff per pull request, in plan order. Ask for changes in the conversation.' },
  { who: 'You', tone: 'gold', h: 'Push', p: 'A new branch and a new pull request, under your GitHub account. A draft by default.' },
];

const AUTO: FlowStep[] = [
  { who: 'You', tone: 'gold', h: 'Build end to end', p: <>One press, from the caret on <b>Implement</b> or <b>Fill gaps</b>.</> },
  { who: SITE_NAME, tone: 'verdigris', h: 'The plan is approved', p: <>Every point to settle is taken as <b>Agree</b>.</> },
  { who: 'Agent', tone: 'lapis', h: 'It builds', p: 'As by hand. Then the branch is pushed to GitHub, with no pull request yet.' },
  { who: SITE_NAME, tone: 'verdigris', h: 'Review and check', p: 'The branch is reviewed like a pull request, and checked against the ticket’s criteria.' },
  { who: 'Agent', tone: 'lapis', h: 'Fix, answer or push back', p: 'Every point gets a fix, an answer, or a push back with a reason. Each fix is a new commit.' },
  { who: SITE_NAME, tone: 'verdigris', h: 'Open the pull request', p: <>Ready for review. The description ends with &ldquo;Review in {SITE_NAME}&rdquo;.</> },
];

function Flow({ id, title, steps, children }: { id: string; title: string; steps: FlowStep[]; children?: ReactNode }): JSX.Element {
  return (
    <div className="board bd-flowrow">
      <h3 id={id} className="bd-wayh rise">
        {title}
      </h3>
      <ol className="bd-flowsteps" aria-labelledby={id}>
        {steps.map((s, i) => (
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
      {children}
    </div>
  );
}

function Marks({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="bd-list">
      {items.map((u, i) => (
        <li key={i}>{u}</li>
      ))}
    </ul>
  );
}

const STATUSES: { w: string; p: string; tone: string }[] = [
  { w: 'Met', p: 'A pull request does it. The check names which one, and the evidence.', tone: 'c-green' },
  { w: 'Met outside code changes', p: 'A person’s comment on the ticket says it was done another way.', tone: 'c-green' },
  { w: 'Partly met', p: 'Some of it is there. The check says which part is not.', tone: 'c-amber' },
  { w: 'Not met', p: 'It is in none of the pull requests. The check says where it belongs.', tone: 'c-red' },
  { w: 'Can’t tell from the code', p: 'The code cannot show it, or a pull request could not be read.', tone: 'c-grey' },
];

export default function Build(): JSX.Element {
  useSeo(seoFor('/build'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb build" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board bd-head" aria-labelledby="bd-h1">
        <div className="tile bd-name">
          <h1 id="bd-h1">A ticket in. A pull request out.</h1>
          <p className="bd-lead">
            {SITE_NAME} hands a ticket to an agent, your own Claude Code or Codex, in a sandbox on your
            machine. It plans, builds and tests. You check the work, and it becomes a pull request.
          </p>
        </div>
        <div className="tile lapis bd-facts">
          <Marks
            items={[
              'The sandbox holds every repository in the workspace, the ticket in full, your Claude notes and your reference documents.',
              'The agent has a shell in the sandbox, but no GitHub credentials, no Docker socket and no way to change your own files.',
              <>Its changes leave as a patch. {SITE_NAME} pushes them from your machine, when you say so.</>,
            ]}
          />
        </div>
        <div className="tile verdigris bd-say">
          <p>Your machine. Your Claude or Codex. A sandbox.</p>
        </div>
        <div className="tile gold bd-go">
          <p className="btns">
            <Link className="btn" to="/docs/implement-story/overview">
              Read the docs →
            </Link>
          </p>
        </div>
      </section>

      {/* ---- how the build works --------------------------------------- */}
      <section className="section board bd-how" aria-labelledby="bd-how-h">
        <div className="tile bd-txt bd-full rise">
          <h2 id="bd-how-h">How the build works</h2>
          <p>
            Two ways, the same agent and the same sandbox. By hand, nothing happens until you press. Automatically,
            one press runs it to an open pull request.
          </p>
        </div>
      </section>

      <Flow id="bd-hand-h" title="By hand" steps={BY_HAND} />
      <section className="board bd-notes">
        <div className="tile bd-txt bd-half rise">
          <h3>Fill gaps</h3>
          <p>
            A ticket already under way can still miss criteria. When its story check found gaps, the story view
            offers <b>Fill gaps</b> in place of <b>Implement</b>. It is the same session, but the plan and the
            build cover only those gaps.
          </p>
        </div>
        <div className="tile bd-txt bd-half rise">
          <h3>What you need</h3>
          <p>
            A container runtime on this computer: Docker, Podman, Colima, OrbStack or microsandbox. Claude Code
            or Codex, signed in. An issue tracker connected to the workspace, so the ticket can be read.
          </p>
        </div>
      </section>

      <Flow id="bd-auto-h" title="Automatically" steps={AUTO}>
        <p className="bd-loop rise">
          <span aria-hidden="true">↺</span> Steps 4 and 5 repeat, 4 rounds by default (1 to 6). They stop early when
          a round finds nothing open.
        </p>
      </Flow>
      <section className="board bd-notes">
        <div className="tile bd-txt bd-third rise">
          <h3>The review rounds are on by default</h3>
          <p>
            At Start, <b>After the build: review and fix, then open the pull request</b> is ticked, so you settle the
            plan and the rest runs by itself. Tick <b>Approve the plan automatically</b> too, and <b>Start</b> is the
            only press.
          </p>
        </div>
        <div className="tile bd-txt bd-third rise">
          <h3>What the rounds do</h3>
          <p>
            The review uses your workspace&rsquo;s AI review setting. With Claude and Codex, both review at once,
            without seeing each other&rsquo;s findings. The agent may say a criterion does not apply; the next check
            judges that. GitHub gets only the commits, one status per round and the pull request; a teammate&rsquo;s{' '}
            {SITE_NAME} shows that you are building the ticket.
          </p>
        </div>
        <div className="tile bd-txt bd-third rise">
          <h3>When a round leaves something open</h3>
          <p>
            After the last round the pull request opens anyway, and its description lists what is still open. Over
            your spend budget, the rounds pause until you press <b>Continue</b>.
          </p>
        </div>
        <div className="tile bd-shot bd-half rise">
          <LoopBodyMock />
        </div>
        <div className="tile bd-txt bd-half rise">
          <h3>The ticket, on Jira</h3>
          <p>
            After <b>Build end to end</b> opens the pull requests, {SITE_NAME} writes the description and criteria
            the plan changed, and comments on the ticket as you, in plain English. It never changes the
            ticket&rsquo;s status. On other trackers it writes nothing.
          </p>
        </div>
      </section>

      {/* ---- the story check ------------------------------------------- */}
      <section className="section board bd-pair" aria-labelledby="bd-sc-h">
        <div className="tile madder bd-id rise">
          <p className="bd-word">The story check</p>
          <p className="bd-story">
            <b>Not “is the code right?”</b>
            <span>“Does this work do what the ticket asked for?”</span>
          </p>
        </div>
        <div className="tile bd-txt bd-wide rise">
          <h2 id="bd-sc-h">Criterion by criterion, against the code.</h2>
          <p>
            The story check reads the ticket from your tracker, and every open and merged pull request that names it,
            in any of your repositories. It is one check per ticket, so a ticket split across three pull requests
            gets one answer.
          </p>
          <div className="bd-stat">
            {STATUSES.map((s) => (
              <p key={s.w}>
                <span className={`mk-chip ${s.tone}`}>{s.w}</span> {s.p}
              </p>
            ))}
          </div>
          <p>
            Two more lists: <b>Asked for outside the criteria</b>, what the title or description asks for that no
            criterion names; and <b>Not asked for</b>, work in the pull requests the ticket does not ask for.
          </p>
        </div>
        <div className="tile lapis bd-txt bd-full rise">
          <h3>Check against docs</h3>
          <p>
            In the story view, <b>Check against docs</b> reads the ticket&rsquo;s story and criteria against your
            reference library: specifications, design notes, policies. It says <b>Matches the docs</b>,{' '}
            <b>Partly matches the docs</b> or <b>Goes against the docs</b>, and what to do. Every point must quote a
            section of your library, and {SITE_NAME} checks the quote is really there. A point without one is
            dropped, never shown.
          </p>
        </div>
      </section>

      {/* ---- the example ----------------------------------------------- */}
      <section className="section board bd-ex" aria-labelledby="bd-ex-h">
        <div className="tile bd-txt bd-full rise">
          <h2 id="bd-ex-h">One ticket, drawn.</h2>
          <p>
            For a ticket with two or more pull requests, the story view draws a <b>Ticket design</b>: who touches the
            data across the top, each step down the page in the order it happens. Each box and each step names the
            pull request that does it. The model works the flow out from the code.
          </p>
        </div>
        <div className="tile bd-shot bd-full rise">
          <TicketDesignMock />
        </div>
        <div className="tile bd-shot bd-left rise">
          <TicketCheckMock />
        </div>
        <div className="tile bd-txt bd-right rise">
          <h3>Read them together</h3>
          <p>
            The story check says criterion 3, &ldquo;No refunds after 30 days&rdquo;, is not met. The design agrees:
            no step checks the 30 days.
          </p>
          <p>
            Step 7 sends one email. The story check still says the retry path sends two. The design shows the main
            path, not every branch.
          </p>
          <p>Click a step in the app to open its file in the pull request&rsquo;s Changes tab.</p>
        </div>
      </section>

      {/* ---- verify ---------------------------------------------------- */}
      <section className="section board bd-verify" aria-labelledby="bd-v-h">
        <div className="tile gold bd-vhead rise">
          <h2 id="bd-v-h">Verify the results.</h2>
          <p>
            An agent wrote this code. {SITE_NAME} checks some of what it says, and labels the rest as the agent’s or the model’s.
            The rest is yours to check, as for any pull request.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>The agent says</h3>
          <p>
            The build report: per pull request <b>Done</b>, <b>Partly done</b> or <b>Not done</b>, the checks it ran
            (<b>Passed</b>, <b>Failed</b> or <b>Not run</b>), and each criterion. It is the agent&rsquo;s own account.
            It never holds back <b>Push</b>.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>{SITE_NAME} checked</h3>
          <p>
            Every piece of evidence in the plan, on your machine; a point it cannot check is left out, and one line
            says how many. Every docs quote. Before a push, that the commit is the change you reviewed.
          </p>
        </div>
        <div className="tile bd-tier rise">
          <h3>The model worked out</h3>
          <p>
            Each criterion verdict, and the design. &ldquo;Can&rsquo;t tell from the code&rdquo; means the code cannot
            show it, or could not be read; it is never turned into &ldquo;Not met&rdquo;. A design marked <b>Drawn for an earlier commit.</b>{' '}
            is out of date.
          </p>
        </div>
        <div className="tile bd-txt bd-checklist rise">
          <h3>Before you merge</h3>
          <ol className="bd-ol">
            <li>Read every diff. The report is not a review.</li>
            <li>
              Look under <b>What {SITE_NAME} left out</b>: edits in a repository the plan did not name.
            </li>
            <li>Check each “Met” against the code it names. Read every “Partly met” and “Can’t tell from the code”.</li>
            <li>Find the main path in the design, then check each step in its file.</li>
            <li>Run the tests yourself, and try the change the way a user would.</li>
            <li>
              After review rounds, read <b>Still open</b> in the description, and each point the agent pushed
              back on in the build tab.
            </li>
            <li>
              Then review it like any other pull request. Your auto review skips the commit the rounds already
              reviewed, so ask a teammate. Merging is yours.
            </li>
          </ol>
        </div>
      </section>

      {/* ---- start ----------------------------------------------------- */}
      <section className="section board bd-start" aria-labelledby="bd-s-h">
        <div className="tile gold bd-start-main rise">
          <h2 id="bd-s-h">Build your next ticket.</h2>
          <p>Run it on your machine, sign in to GitHub with gh and to Claude Code or Codex.</p>
          <code className="bd-cmd">{INSTALL_COMMAND}</code>
          <p className="btns">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
          </p>
        </div>
        <div className="tile bd-txt bd-start-list rise">
          <Marks
            items={[
              <Link key="o" to="/docs/implement-story/overview">Implement a story</Link>,
              <Link key="p" to="/docs/implement-story/plan">Plan the work</Link>,
              <Link key="f" to="/docs/implement-story/fill-gaps">Fill gaps</Link>,
              <Link key="u" to="/docs/implement-story/push">Push the result</Link>,
              <Link key="s" to="/docs/story-checks/overview">Story checks</Link>,
              <Link key="d" to="/docs/ai-review/design-diagrams">Design diagrams</Link>,
            ]}
          />
        </div>
      </section>
    </div>
  );
}

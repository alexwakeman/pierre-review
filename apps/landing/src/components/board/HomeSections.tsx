import { Link } from '../../router';
import { SITE_NAME } from '../../lib/site';

// ---------------------------------------------------------------------------
// The home page's three sections after the hero: how it works (the build flow), review
// as an ensemble (the team circle) and dependency updates (bot automation). Each one
// ends on a link to the page that tells it in full (/build, /ensemble-review,
// /automation).
//
// Both diagrams are real markup, not pictures: the flow is an ordered list, the circle
// an SVG with a role="img" summary AND a visually hidden list carrying the same facts,
// so a crawler or screen reader gets every word.
//
// ⚠ EVERY CLAIM IS A PRODUCT FACT (docs/STORY-BUILD.md, docs/TEAM-REVIEW.md,
// docs/CLAUDE-REVIEW.md § Team claims, docs/MERGE-CI-TRUNK.md § Dependency automation).
// Change the copy here in the same commit as the behaviour.
// ---------------------------------------------------------------------------

const STEPS: { n: string; h: string; p: string; tone: string }[] = [
  { n: '1', h: 'Connect your tracker', p: 'Jira, Linear, GitHub Issues or Notion. It reads the tickets you pick.', tone: 'lapis' },
  {
    n: '2',
    h: 'Assess the ticket',
    p: 'Your agent reads the story with your docs and your code, and plans. Nothing is built until you approve the plan.',
    tone: 'verdigris',
  },
  { n: '3', h: 'Implement', p: 'Your Claude or Codex writes the change in a sandbox on your machine.', tone: 'madder' },
  {
    n: '4',
    h: 'Review in rounds',
    p: 'Claude and Codex review the branch and check it against the ticket. The agent fixes what they find, and they review again.',
    tone: 'lapis',
  },
  { n: '5', h: 'Create the PR', p: 'In one click, with what the review found and fixed in its description.', tone: 'gold' },
];

/** The build flow: five steps, with the review loop drawn under Implement and Review. */
export function HowItWorks(): JSX.Element {
  return (
    <section id="how" className="section chapter" aria-labelledby="how-h">
      <div className="chap rise">
        <h2 id="how-h">From ticket to pull request</h2>
        <p>Define the work, build it and review it, on your own machine.</p>
      </div>
      <div className="board flow">
        <ol className="flow-steps">
          {STEPS.map((s) => (
            <li key={s.n} className={`tile ${s.tone} rise`}>
              <span className="flow-n" aria-hidden="true">
                {s.n}
              </span>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </li>
          ))}
        </ol>
        <p className="flow-loop rise">
          <span aria-hidden="true">↺</span> Steps 3 and 4 repeat until the review is clean.
        </p>
        <p className="flow-more rise">
          <Link to="/build">How the build works →</Link>
        </p>
      </div>
    </section>
  );
}

/** The teammates around one pull request: who they are and which agent they review with. */
const MATES: { name: string; agent: string }[] = [
  { name: 'You', agent: 'Claude + Codex' },
  { name: 'Sam', agent: 'Claude' },
  { name: 'Dana', agent: 'Codex' },
  { name: 'Priya', agent: 'Claude' },
  { name: 'Leo', agent: 'Codex' },
];

/** The circle: each teammate's own machine around the pull request, which lives on GitHub. */
function Circle(): JSX.Element {
  const cx = 300;
  const cy = 300;
  const r = 215;
  const nodes = MATES.map((m, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / MATES.length;
    return { ...m, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  return (
    <svg
      className="circle-svg"
      viewBox="0 0 600 600"
      role="img"
      aria-label="Five teammates, each on their own machine with their own Claude or Codex, around one pull request on GitHub. Each one claims a commit there before reviewing it."
    >
      <circle cx={cx} cy={cy} r={r} className="c-orbit" />
      {nodes.map((n) => (
        <line key={`l-${n.name}`} x1={cx} y1={cy} x2={n.x} y2={n.y} className="c-spoke" />
      ))}
      <circle cx={cx} cy={cy} r={92} className="c-hub" />
      <text x={cx} y={cy - 18} className="c-hub-k">
        GITHUB
      </text>
      <text x={cx} y={cy + 8} className="c-hub-t">
        #612 acme/payments
      </text>
      <text x={cx} y={cy + 32} className="c-hub-s">
        claims · reviews · threads
      </text>
      {nodes.map((n, i) => (
        <g key={n.name}>
          <circle cx={n.x} cy={n.y} r={58} className={`c-node c-node-${i % 4}`} />
          <text x={n.x} y={n.y - 4} className="c-name">
            {n.name}
          </text>
          <text x={n.x} y={n.y + 18} className="c-agent">
            {n.agent}
          </text>
        </g>
      ))}
    </svg>
  );
}

const ENSEMBLE_POINTS: { h: string; p: string }[] = [
  {
    h: 'Local agents',
    p: 'Each teammate reviews with their own Claude or Codex, on their own machine and their own plan.',
  },
  {
    h: 'Claude and Codex together',
    p: 'Both review at once, without seeing each other. Their findings are merged into one review, and every comment thread is checked against the code.',
  },
  {
    h: 'GitHub is the source of truth',
    p: 'A status line on the commit says who is reviewing it, so nobody reviews it twice. There is no server between you.',
  },
  {
    h: 'In place of a review bot',
    p: `${SITE_NAME} can replace a hosted code-review tool, and fix what it finds on your own pull requests.`,
  },
];

/** Review as an ensemble: the circle and the four facts beside it. */
export function EnsembleSection(): JSX.Element {
  return (
    <section id="ensemble" className="section chapter" aria-labelledby="ens-h">
      <div className="chap rise">
        <h2 id="ens-h">Review as an ensemble</h2>
        <p>The team takes on the reviews together, each with their own agent. Nothing to host.</p>
      </div>
      <div className="board ensemble">
        <div className="tile circle rise">
          <Circle />
          <ul className="vh">
            {MATES.map((m) => (
              <li key={m.name}>
                {m.name}: reviews on their own machine with {m.agent}.
              </li>
            ))}
          </ul>
        </div>
        <div className="ens-points">
          {ENSEMBLE_POINTS.map((pt) => (
            <div key={pt.h} className="tile rise">
              <h3>{pt.h}</h3>
              <p>{pt.p}</p>
            </div>
          ))}
          <p className="ens-more rise">
            <Link to="/ensemble-review">How ensemble review works →</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

/** Dependency updates: the bot automation, in one board. */
export function BotsSection(): JSX.Element {
  return (
    <section id="bots" className="section chapter" aria-labelledby="bots-h">
      <div className="chap rise">
        <h2 id="bots-h">Dependency updates, handled</h2>
        <p>Dependabot and Renovate pull requests, from opened to merged, without anyone opening them.</p>
      </div>
      <div className="board bots">
        <div className="tile verdigris rise">
          <h3>Approved</h3>
          <p>When the update comes from a bot you trust and CI is green.</p>
        </div>
        <div className="tile madder rise">
          <h3>Fixed</h3>
          <p>Red CI and merge conflicts are fixed by your agent in a sandbox, then pushed.</p>
        </div>
        <div className="tile lapis rise">
          <h3>Merged</h3>
          <p>When every check passes. If anyone pushes in the meantime, it stops.</p>
        </div>
        <div className="tile gold rise">
          <h3>Once per team</h3>
          <p>One teammate&rsquo;s {SITE_NAME} claims each pull request on GitHub, so it is done once.</p>
          <p className="more">
            <Link to="/automation">Everything it automates →</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

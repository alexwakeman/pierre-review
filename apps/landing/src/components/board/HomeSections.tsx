import { Link } from '../../router';
import { SITE_NAME } from '../../lib/site';
import { EnsembleStory } from './EnsembleStory';
import { BuildStory } from './BuildStory';

// ---------------------------------------------------------------------------
// The home page's three sections after the hero: review as an ensemble (the team
// circle), how it works (the build flow) and dependency updates (bot automation). Each one
// ends on a link to the page that tells it in full (/build, /ensemble-review,
// /automation).
//
// Both diagrams are stories (./story/): an SVG with a role="img" summary AND a visually
// hidden list carrying the same steps, so a crawler or screen reader gets every word.
//
// ⚠ EVERY CLAIM IS A PRODUCT FACT (docs/STORY-BUILD.md, docs/TEAM-REVIEW.md,
// docs/CLAUDE-REVIEW.md § Team claims, docs/MERGE-CI-TRUNK.md § Dependency automation).
// Change the copy here in the same commit as the behaviour.
// ---------------------------------------------------------------------------

/** The build flow, as a story: from the press to the updated ticket, then How to test. */
export function HowItWorks(): JSX.Element {
  return (
    <section id="how" className="section chapter" aria-labelledby="how-h">
      <div className="chap rise">
        <h2 id="how-h">One click from ticket to pull request</h2>
        <p>
          Press Build end to end. {SITE_NAME} refines the ticket, builds it, reviews it until it is clean, opens the
          pull request and updates the ticket.
        </p>
      </div>
      <div className="board flow">
        <div className="tile flow-stage rise">
          <BuildStory />
        </div>
        <p className="flow-more rise">
          <Link to="/build">How the build works →</Link>
        </p>
      </div>
    </section>
  );
}

/** The teammates around one pull request: who they are and which agent they review with. */
const ENSEMBLE_POINTS: { h: string; p: string }[] = [
  {
    h: 'No review bot seat',
    p: 'Each teammate reviews with their own Claude or Codex, on the plan they already have. Nothing to buy, nothing to host.',
  },
  {
    h: 'Checked against the ticket',
    p: "Each change is checked against its ticket's acceptance criteria and description, and your docs. It says what is met and what is still open.",
  },
  {
    h: 'The same review, every time',
    p: 'Auto review runs on every push, the same way, with Claude and Codex together when you have both. A status line on the commit says who is reviewing it, so nobody reviews it twice.',
  },
  {
    h: 'It fixes, then goes back',
    p: 'When a review finds problems on your pull request, your Ensemble fixes them with your agent and pushes the fix. Red CI and SonarCloud issues too. Then it goes back for review.',
  },
];

/** Review as an ensemble: the story of one pull request (EnsembleStory) and the four facts beside it. */
export function EnsembleSection(): JSX.Element {
  return (
    <section id="ensemble" className="section chapter" aria-labelledby="ens-h">
      <div className="chap rise">
        <h2 id="ens-h">Review as an ensemble</h2>
        <p>
          The process of a review bot, on the Claude and Codex plans your team already has. Every pull request gets the
          same review, checked against its ticket.
        </p>
      </div>
      <div className="board ensemble">
        <div className="tile circle rise">
          <EnsembleStory />
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

import { Link } from '../../router';

// "Why Ensemble": four tiles. The AI tile carries the link to setting a budget.

export function WhyEnsemble(): JSX.Element {
  return (
    <section className="section chapter why" aria-labelledby="why-h">
      <div className="chap minor rise">
        <h2 id="why-h">Why Ensemble</h2>
        <p>Built to fit how your team already works.</p>
      </div>
      <div className="board why4">
        <div className="tile rise">
          <h3>On your machine</h3>
          <p>Your code and data stay on your disk. No hosted service, no sign-in.</p>
        </div>
        <div className="tile rise">
          <h3>Nothing to migrate</h3>
          <p>
            Uses your <code>gh</code> login, your CI and your tracker as they are.
          </p>
        </div>
        <div className="tile rise">
          <h3>Your AI plan</h3>
          <p>Runs on Claude Code or Codex. Set a weekly share and it stops there.</p>
          <p className="more">
            <Link to="/docs/settings/ai-usage-and-spend#spend-budget">Set a budget →</Link>
          </p>
        </div>
        <div className="tile rise">
          <h3>You stay in charge</h3>
          <p>Nothing is posted or pushed until you press the button, or switch it on.</p>
        </div>
      </div>
    </section>
  );
}

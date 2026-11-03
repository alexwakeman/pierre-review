import { Link } from '../../router';
import { FREE_TEAM_SIZE, INSTALL_COMMAND } from '../../lib/site';
import { CopyCommand } from './CopyCommand';

// "Every feature, free": the two tiers. The team size comes from FREE_TEAM_SIZE
// (it mirrors the Limn License); never type the number here.

export function Tiers(): JSX.Element {
  return (
    <section id="licence" className="section chapter" aria-labelledby="tiers-h">
      <div className="chap minor rise">
        <h2 id="tiers-h">Every feature, free</h2>
        <p>Start on your own today. Bring the team when it works for you.</p>
      </div>
      <div className="board tiers">
        <div className="tile gold rise">
          <p className="k">Individuals and teams up to {FREE_TEAM_SIZE}</p>
          <h3>Free</h3>
          <ul>
            <li>Every feature: review, fix, ship, reports</li>
            <li>Runs on your own AI plan</li>
            <li>No account, no card</li>
          </ul>
          <p className="cmd">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
          </p>
        </div>
        <div className="tile lapis rise">
          <p className="k">More than {FREE_TEAM_SIZE} people</p>
          <h3>A licence</h3>
          <ul>
            <li>The same app, the same features</li>
            <li>One licence for the organisation</li>
            <li>We answer every message</li>
          </ul>
          <p className="cmd">
            <Link className="btn alt" to="/contact?topic=licence">
              Ask for a licence
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

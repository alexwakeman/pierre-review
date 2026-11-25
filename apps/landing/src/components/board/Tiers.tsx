import { Link } from '../../router';
import { FREE_TEAM_SIZE, INSTALL_COMMAND } from '../../lib/site';
import { LOWEST_PRICE_GBP, formatGbp } from '../../lib/licence';
import { CopyCommand } from './CopyCommand';

// "Free for small teams": the two tiers. The team size comes from FREE_TEAM_SIZE
// (it mirrors the Ensemble License); never type the number here. Team policy, the first organisation
// feature, needs a licence key (docs/TEAM-POLICY.md); a small team gets one free on request.

export function Tiers(): JSX.Element {
  return (
    <section id="licence" className="section chapter" aria-labelledby="tiers-h">
      <div className="chap minor rise">
        <h2 id="tiers-h">Free for small teams</h2>
        <p>Start on your own today. Bring the team when it works for you.</p>
      </div>
      <div className="board tiers">
        <div className="tile gold rise">
          <p className="k">Individuals and teams up to {FREE_TEAM_SIZE}</p>
          <h3>Free</h3>
          <ul>
            <li>Review, fix, ship and reports</li>
            <li>Runs on your own AI plan</li>
            <li>No account, no card</li>
          </ul>
          <p className="cmd">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
          </p>
        </div>
        <div className="tile lapis rise">
          <p className="k">More than {FREE_TEAM_SIZE} people</p>
          <h3>From {formatGbp(LOWEST_PRICE_GBP)} a year</h3>
          <ul>
            <li>Team policy: rules your repositories set for every copy</li>
            <li>One licence for the organisation, priced by team size</li>
            <li>Your AI usage stays on your own provider&rsquo;s bill</li>
          </ul>
          <p className="cmd">
            <Link className="btn alt" to="/pricing">
              See the prices
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

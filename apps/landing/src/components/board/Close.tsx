import { Link } from '../../router';
import { INSTALL_COMMAND } from '../../lib/site';
import { CopyCommand } from './CopyCommand';
import { Quartet } from '../arcs/pieces';

/** The close (#run, where the header's "Run it now" lands). The Quartet sits between the
 *  call to action and the install link and assembles as it scrolls into view. */
export function Close(): JSX.Element {
  return (
    <section id="run" className="section board close" aria-labelledby="run-h">
      <div className="tile gold mid rise">
        <h2 id="run-h">From ticket to merged, on your machine.</h2>
        <div className="cmd">
          <CopyCommand />
          <code>{INSTALL_COMMAND}</code>
        </div>
      </div>
      <div className="tile art quartet rise">
        <Quartet label="Four banded quarter-circles in four colours, facing one centre" />
      </div>
      <div className="tile lapis side rise">
        <p>One minute to run. Your first review a few minutes later.</p>
        <p>
          <Link to="/docs/getting-started/install-and-run">Install and run →</Link>
        </p>
      </div>
    </section>
  );
}

import { Quartet, Spiral } from '../arcs/pieces';
import { INSTALL_COMMAND, SITE_NAME } from '../../lib/site';
import { CopyCommand } from './CopyCommand';

// ---------------------------------------------------------------------------
// The hero: the claim, the command, and the site's signature picture, the SPIRAL
// (components/arcs): quarters in five colours that only read as one shape together.
// Under the claim, the QUARTET (four quarters facing one centre) beside Goethe's line
// on the string quartet: an ensemble as a conversation, which is what a review is.
//
// ⚠ "Fully local, no added service" is the claim, and it is exact: the app runs on each
// person's machine and talks only to GitHub, their tracker and their own AI provider.
// "Decentralised" describes the REVIEW only (no orchestrator; GitHub is where teammates
// meet) — never the whole product.
// ---------------------------------------------------------------------------

export function Hero(): JSX.Element {
  return (
    <section className="board hero" aria-label={SITE_NAME}>
      <div className="tile say">
        <p className="kick">{SITE_NAME} · an agentic SDLC on your machine</p>
        <h1>Define, build, and review as an ensemble.</h1>
        <p className="lead">
          From ticket to merged pull request with your own Claude or Codex. It runs fully on your team&rsquo;s own
          machines, with no added service.
        </p>
        <div className="cmd">
          <CopyCommand />
          <code>{INSTALL_COMMAND}</code>
        </div>
      </div>
      <div className="tile art p1">
        <Quartet label="Four banded quarter-circles in four colours, facing one centre" />
      </div>
      <figure className="tile motto">
        <blockquote>
          <p>“One hears four sensible people conversing among themselves.”</p>
        </blockquote>
        <figcaption>Goethe, on the string quartet, in a letter to Zelter, 1829</figcaption>
      </figure>
      <div className="tile art hand">
        <Spiral lead label="A golden spiral of banded quarter-circles, each in its own run of colour" />
      </div>
    </section>
  );
}

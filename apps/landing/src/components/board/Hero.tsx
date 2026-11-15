import { Chain } from '../arcs/pieces';
import { INSTALL_COMMAND, SITE_NAME } from '../../lib/site';
import { CopyCommand } from './CopyCommand';

// ---------------------------------------------------------------------------
// The hero: the claim, the command, and the site's big picture, the CHAIN
// (components/arcs): quarters linked end to end whose links start mirrored across
// the tile and cross through each other into place as the reader scrolls. Under the
// claim, Poincaré's line on the ensemble and the details. ONE moving picture per
// screen: the Quartet lives in the close (Close.tsx), not here.
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
        <h1>Refine, build and review as an ensemble.</h1>
        <p className="lead">
          From ticket to merged pull request with your own Claude or Codex. It runs fully on your team&rsquo;s own
          machines, with no added service.
        </p>
        <div className="cmd">
          <CopyCommand />
          <code>{INSTALL_COMMAND}</code>
        </div>
      </div>
      <figure className="tile motto">
        <blockquote>
          {/* ⚠ Poincaré's own words (the English translation), cut with an ellipsis and
              never reworded: a reworded line would need "after Poincaré". */}
          <p>
            “It is the harmony of the diverse parts … that permits us to see clearly and to comprehend at once
            both the ensemble and the details.”
          </p>
        </blockquote>
        <figcaption>
          <a href="https://en.wikipedia.org/wiki/Henri_Poincar%C3%A9" target="_blank" rel="noreferrer noopener">
            Henri Poincaré
          </a>
          , <cite>Science and Method</cite>, 1908
        </figcaption>
      </figure>
      <div className="tile art hand">
        <Chain lead label="A chain of banded quarter-circles linked end to end, each in its own run of colour" />
      </div>
    </section>
  );
}

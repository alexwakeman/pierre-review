import adagio from '../../assets/board/img/bach-bwv1001.jpg';
import hand from '../../assets/board/img/bach-hand.jpg';
import { INSTALL_COMMAND, SITE_NAME } from '../../lib/site';
import { CopyCommand } from './CopyCommand';

// ---------------------------------------------------------------------------
// The hero: the claim, the command, and Bach's hand holding his six-part canon
// (Haussmann, 1746) as the picture. Under the claim, Bach's own hand again (the solo
// violin Adagio, 1720) and Goethe's line on the string quartet: an ensemble as a
// conversation, which is what a review is.
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
      <div className="tile ph p1">
        <img
          src={adagio}
          width={960}
          height={962}
          alt="Bach's handwritten score of the Adagio from his first sonata for solo violin, 1720"
        />
      </div>
      <figure className="tile motto">
        <blockquote>
          <p>“One hears four sensible people conversing among themselves.”</p>
        </blockquote>
        <figcaption>Goethe, on the string quartet, in a letter to Zelter, 1829</figcaption>
      </figure>
      <div className="tile ph hand">
        <img
          src={hand}
          width={930}
          height={843}
          alt="Bach's hand holding his canon for six voices, from Haussmann's portrait, 1746"
        />
      </div>
    </section>
  );
}

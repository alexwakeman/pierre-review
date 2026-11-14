import adagio from '../../assets/board/img/bach-bwv1001.jpg';
import { INSTALL_COMMAND } from '../../lib/site';
import { CopyCommand } from './CopyCommand';
import { PendingBoardMock } from '../mock/home';

// ---------------------------------------------------------------------------
// The hero: the claim, the command, and the Pending board as the picture. Under
// the claim, Hilliard's miniature and his line on limning, which named the app.
// ---------------------------------------------------------------------------

export function Hero(): JSX.Element {
  return (
    <section className="board hero" aria-label="Ensemble">
      <div className="tile say">
        <p className="kick">Ensemble · code review on your machine</p>
        <h1>Your team writes more code than it can review.</h1>
        <p className="lead">
          Ensemble reviews every pull request against its story and your docs on your own Claude or Codex, shows each
          person what needs them next, and fixes what it finds. Free, on your machine.
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
        <figcaption>
          Goethe, on the string quartet, in a letter to Zelter, 1829
        </figcaption>
      </figure>
      <div className="tile pic rise">
        <PendingBoardMock />
      </div>
    </section>
  );
}

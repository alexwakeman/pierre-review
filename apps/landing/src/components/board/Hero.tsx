import hilliard from '../../assets/board/img/hilliard.jpg';
import { INSTALL_COMMAND } from '../../lib/site';
import { CopyCommand } from './CopyCommand';
import { PendingBoardMock } from '../mock/home';

// ---------------------------------------------------------------------------
// The hero: the claim, the command, and the Pending board as the picture. Under
// the claim, Hilliard's miniature and his line on limning, which named the app.
// ---------------------------------------------------------------------------

export function Hero(): JSX.Element {
  return (
    <section className="board hero" aria-label="Limn">
      <div className="tile say">
        <p className="kick">Limn · code review on your machine</p>
        <h1>Your team writes more code than it can review.</h1>
        <p className="lead">
          Limn reviews every pull request against its story and your docs on your own Claude or Codex, shows each
          person what needs them next, and fixes what it finds. Free, on your machine.
        </p>
        <div className="cmd">
          <CopyCommand />
          <code>{INSTALL_COMMAND}</code>
        </div>
      </div>
      <div className="tile ph p1">
        <img src={hilliard} width={1280} height={1283} alt="Nicholas Hilliard's self-portrait miniature, 1577" />
      </div>
      <figure className="tile motto">
        <blockquote>
          <p>“The line without shadow showeth all to good judgment.”</p>
        </blockquote>
        <figcaption>
          Nicholas Hilliard, <cite>The Arte of Limning</cite>, c.1600
        </figcaption>
      </figure>
      <div className="tile pic rise">
        <PendingBoardMock />
      </div>
    </section>
  );
}

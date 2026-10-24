import { useEffect, useRef, useState } from 'react';
import hilliard from '../../assets/board/img/hilliard.jpg';
import { HeroDots } from './HeroDots';
import { copyText } from './copyText';
import { DEMO_PATH } from '../../lib/site';

// ---------------------------------------------------------------------------
// The hero board: the name, Hilliard's miniature, the statement, the dots and
// the gold "Free. Local. No extra seat." tile with its copy button.
// ---------------------------------------------------------------------------

const COMMAND = 'npx limn-review';

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void copyText(COMMAND).then((ok) => {
      if (!ok) return; // The command stays readable beside the button.
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <button className="btn" type="button" onClick={copy}>
      <span aria-live="polite">{copied ? 'Copied' : 'Copy the command'}</span>
    </button>
  );
}

export function Hero() {
  return (
    <section className="board hero" aria-label="Limn">
      <div className="tile name">
        <h1>
          Limn<span className="vh"> — automated, local code review</span>
        </h1>
      </div>
      <div className="tile ph p1">
        <img src={hilliard} width={1280} height={1283} alt="Nicholas Hilliard's self-portrait miniature, 1577" />
      </div>
      <div className="tile lapis say">
        <p>Code review, story alignment, docs alignment. Automated, on your machine.</p>
      </div>
      <div className="tile anim" aria-hidden="true">
        <HeroDots />
      </div>
      <div className="tile gold free">
        <p>Free. Local. No extra seat.</p>
        <p>
          <span className="btns">
            <CopyCommand />
            <a className="btn alt" href={DEMO_PATH}>Quick demo</a>
          </span>
          <code>{COMMAND}</code>
        </p>
      </div>
    </section>
  );
}

import { DEMO_PATH } from '../../lib/site';
import { useEffect, useRef, useState } from 'react';
import initialH from '../../assets/board/img/initial-h.jpg';
import { copyText } from './copyText';

const COMMAND = 'npx limn-review';

/** The close (#run): initial H, the gold "Review your next PR tonight" tile, a lapis flank. */
export function Close(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    const done = (): void => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    };
    void copyText(COMMAND).then((ok) => {
      if (ok) done();
    });
  };

  return (
    <section id="run" className="section board cta" aria-labelledby="cta-h">
      <div className="tile ph l1 rise">
        <img
          src={initialH}
          width={1200}
          height={1239}
          alt="Illuminated initial H from a choirbook"
          loading="lazy"
        />
      </div>
      <div className="tile mid gold rise">
        <h2 id="cta-h">Review your next PR tonight</h2>
        <p>One command. No account.</p>
        <p className="btns">
          <button className="btn" type="button" onClick={copy} aria-live="polite">
            {copied ? 'Copied' : `Copy ${COMMAND}`}
          </button>
          <a className="btn alt" href={DEMO_PATH}>Quick demo</a>
        </p>
      </div>
      <div className="tile r1 lapis rise"></div>
    </section>
  );
}

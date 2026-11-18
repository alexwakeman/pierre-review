import { useEffect, useRef } from 'react';
import { Link } from '../../router';
import { SITE_NAME } from '../../lib/site';
import { EnsembleStory } from './EnsembleStory';
import { BuildStory } from './BuildStory';
import { snakeMask } from './snake';

// ---------------------------------------------------------------------------
// The home page's three sections after the hero: review as an ensemble (the team
// circle), how it works (the build flow) and dependency updates (bot automation). Each one
// ends on a link to the page that tells it in full (/build, /ensemble-review,
// /automation).
//
// Both diagrams are stories (./story/): an SVG with a role="img" summary AND a visually
// hidden list carrying the same steps, so a crawler or screen reader gets every word.
//
// ⚠ EVERY CLAIM IS A PRODUCT FACT (docs/STORY-BUILD.md, docs/TEAM-REVIEW.md,
// docs/CLAUDE-REVIEW.md § Team claims, docs/MERGE-CI-TRUNK.md § Dependency automation).
// Change the copy here in the same commit as the behaviour.
// ---------------------------------------------------------------------------

/** The build flow, as a story: from the press to the updated ticket, then How to test. */
export function HowItWorks(): JSX.Element {
  return (
    <section id="how" className="section chapter" aria-labelledby="how-h">
      <div className="chap rise">
        <h2 id="how-h">One click from ticket to pull request</h2>
        <p>
          Spend more time on the spec and the design and less time prompting and checking. Press Build end to
          end:{' '}
          {SITE_NAME} refines the ticket, builds it, reviews it until it is clean, opens the pull requests and updates
          the ticket.
        </p>
      </div>
      <div className="board flow">
        <div className="tile flow-stage rise">
          <BuildStory />
        </div>
        <p className="flow-note rise">No prompt to write, no context to paste, no review rounds to sit through.</p>
        <p className="flow-more rise">
          <Link to="/build">How the build works →</Link>
        </p>
      </div>
    </section>
  );
}

/** The four facts beside the review story, in one person's voice, each saying what you no longer do. */
const ENSEMBLE_POINTS: { h: string; p: string }[] = [
  {
    h: 'Your plan, no bot seat',
    p: 'Reviews run on your own Claude or Codex. Nothing to buy, nothing to host.',
  },
  {
    h: 'Checked against the ticket',
    p: "Every change is checked against its acceptance criteria and your docs, so you don't have to tick them off yourself.",
  },
  {
    h: 'Every push, the same review',
    p: 'Auto review runs on each push, Claude and Codex together when you have both. With teammates, each commit is reviewed once.',
  },
  {
    h: 'It fixes, then goes back',
    p: 'Findings, red CI and SonarCloud issues are fixed by your agent and pushed, then reviewed again. You read the result, not every round.',
  },
];

const SNAKE_RADIUS = 14;
const SNAKE_STROKE = 2;

/**
 * THE SNAKE (./snake.ts, pages/home.css § the snake): one line down through the four boxes,
 * shown as a mask over one band of colour. Measured on mount and on every resize:
 * the boxes' tops and bottoms in the column, and the band's size (well past the column's
 * corners). Until then the line is not drawn at all.
 */
function useSnake(ref: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const box = ref.current;
    const line = box?.querySelector<HTMLElement>(':scope > .ens-snake');
    if (!box || !line || typeof ResizeObserver === 'undefined') return;
    const tiles = Array.from(box.querySelectorAll<HTMLElement>(':scope > .tile'));
    const measure = (): void => {
      // offsets, not getBoundingClientRect: the column may be mid-reveal (translated)
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const boxes = tiles.map((t) => ({ top: t.offsetTop, bottom: t.offsetTop + t.offsetHeight }));
      line.style.setProperty('--snake', snakeMask(boxes, w, h, SNAKE_RADIUS, SNAKE_STROKE));
      line.style.setProperty('--wheel-d', `${Math.hypot(w, h) * 1.2}px`);
      line.classList.add('on');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => {
      ro.disconnect();
      line.classList.remove('on');
      line.style.removeProperty('--snake');
      line.style.removeProperty('--wheel-d');
    };
  }, [ref]);
}

/** Review as an ensemble: the story of one pull request (EnsembleStory) and the four facts beside it. */
export function EnsembleSection(): JSX.Element {
  const points = useRef<HTMLDivElement>(null);
  useSnake(points);
  return (
    <section id="ensemble" className="section chapter" aria-labelledby="ens-h">
      <div className="chap rise">
        <h2 id="ens-h">Review as an ensemble</h2>
        <p>
          Your team&rsquo;s pull requests: all reviewed automatically on your behalf. You stay in control, with no
          seat or extra account needed.
        </p>
      </div>
      <div className="board ensemble">
        <div className="tile circle rise">
          <EnsembleStory />
        </div>
        <div className="ens-points rise" ref={points}>
          {ENSEMBLE_POINTS.map((pt) => (
            <div key={pt.h} className="tile">
              <h3>{pt.h}</h3>
              <p>{pt.p}</p>
            </div>
          ))}
          <p className="ens-more">
            <Link to="/ensemble-review">How ensemble review works →</Link>
          </p>
          {/* the snake: one band of colour, seen only through one line down the boxes */}
          <div className="ens-snake" aria-hidden="true">
            <div className="ens-wheel" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Dependency updates: the bot automation, in one board. */
export function BotsSection(): JSX.Element {
  return (
    <section id="bots" className="section chapter" aria-labelledby="bots-h">
      <div className="chap rise">
        <h2 id="bots-h">Dependency updates, handled</h2>
        <p>Dependabot and Renovate pull requests, from opened to merged, without anyone opening them.</p>
      </div>
      <div className="board bots">
        <div className="tile verdigris rise">
          <h3>Approved</h3>
          <p>When the update comes from a bot you trust and CI is green.</p>
        </div>
        <div className="tile madder rise">
          <h3>Fixed</h3>
          <p>Red CI and merge conflicts are fixed by your agent in a sandbox, then pushed.</p>
        </div>
        <div className="tile lapis rise">
          <h3>Merged</h3>
          <p>When every check passes. If anyone pushes in the meantime, it stops.</p>
        </div>
        <div className="tile gold rise">
          <h3>Once, not twice</h3>
          <p>Each update is handled once, even when several people run {SITE_NAME}.</p>
          <p className="more">
            <Link to="/automation">Everything it automates →</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { Link } from '../../router';
import { SITE_NAME } from '../../lib/site';
import { EnsembleStory } from './EnsembleStory';
import { BuildStory } from './BuildStory';

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
          Spend your time on what the ticket should say, not on prompting and checking. Press Build end to end:{' '}
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

/**
 * ONE GRADIENT ACROSS THE FOUR BOXES' EDGES (pages/home.css § the spectral edge): every
 * box's ring is a slice of the same colour wheel, centred on the middle of the four. Each
 * box is told where that middle is, from its own top-left (--ring-x, --ring-y) and how big
 * the wheel must be to cover all four (--ring-d). Measured on mount and on every resize;
 * the turning on scroll is CSS. Before this runs (the prerendered page) each box shows its
 * own still slice.
 */
function useSharedRing(ref: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const tiles = Array.from(box.querySelectorAll<HTMLElement>(':scope > .tile'));
    const measure = (): void => {
      // offsets, not getBoundingClientRect: a tile mid-reveal is translated
      const cx = box.offsetWidth / 2;
      const cy = box.offsetHeight / 2;
      // well past the farthest corner, so no box's edge is ever left uncovered
      const d = Math.hypot(box.offsetWidth, box.offsetHeight) * 1.6;
      for (const t of tiles) {
        t.style.setProperty('--ring-x', `${cx - t.offsetLeft}px`);
        t.style.setProperty('--ring-y', `${cy - t.offsetTop}px`);
        t.style.setProperty('--ring-d', `${d}px`);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => {
      ro.disconnect();
      for (const t of tiles) ['--ring-x', '--ring-y', '--ring-d'].forEach((v) => t.style.removeProperty(v));
    };
  }, [ref]);
}

/** Review as an ensemble: the story of one pull request (EnsembleStory) and the four facts beside it. */
export function EnsembleSection(): JSX.Element {
  const points = useRef<HTMLDivElement>(null);
  useSharedRing(points);
  return (
    <section id="ensemble" className="section chapter" aria-labelledby="ens-h">
      <div className="chap rise">
        <h2 id="ens-h">Review as an ensemble</h2>
        <p>
          Your Claude and Codex review every pull request, against its ticket, on the plan you already have. Add
          teammates and their Ensembles join in.
        </p>
      </div>
      <div className="board ensemble">
        <div className="tile circle rise">
          <EnsembleStory />
        </div>
        <div className="ens-points" ref={points}>
          {ENSEMBLE_POINTS.map((pt) => (
            <div key={pt.h} className="tile rise">
              <h3>{pt.h}</h3>
              <p>{pt.p}</p>
            </div>
          ))}
          <p className="ens-more rise">
            <Link to="/ensemble-review">How ensemble review works →</Link>
          </p>
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

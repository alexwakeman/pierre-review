import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// REVIEW AS AN ENSEMBLE, AS A STORY (the home page's "Review as an ensemble"). The team
// circle tells one pull request's life in five steps, played once when it comes into
// view (Replay plays it again):
//   1  You open #612. Only You is drawn, marked as its author.
//   2  Sam and Dana review it at the same time, each from their own machine (two edges
//      in their colours). Leo and Priya are on the team, drawn faint.
//   3  Your Ensemble fixes the findings by itself: the findings come back to You, your
//      agent fixes them, and the fix is pushed. Nobody types anything.
//   4  Back for review: You look over the fix, then Dana approves it.
//   5  Merged: the pull request turns green.
// A caption card under the circle says what is happening, with the step number.
//
// The steps are PHASES; the svg carries one class per phase reached (p-open, p-review …),
// and board CSS (pages/home.css § the story) shows each mark from its phase on, with
// opacity, transforms and line draws only. The prerendered page, no JS and reduced motion
// show the finished picture (every phase) with all five steps listed.
//
// ⚠ EVERY STEP IS A PRODUCT FACT (docs/TEAM-REVIEW.md, docs/CLAUDE-REVIEW.md § Auto fix):
// each teammate's Ensemble claims the commit and reviews it on their own machine; on your
// own pull request a finished review starts an auto fix that pushes to the branch.
// ---------------------------------------------------------------------------

const PHASES = ['open', 'review', 'findings', 'fix', 'push', 'back', 'approve', 'merged'] as const;
type Phase = (typeof PHASES)[number];

/** When each phase starts (ms from Play). */
const AT: Record<Phase, number> = {
  open: 300,
  review: 3000,
  findings: 6200,
  fix: 7600,
  push: 9600,
  back: 11400,
  approve: 12900,
  merged: 14600,
};

/** The caption step each phase belongs to. */
const STEP_OF: Record<Phase, number> = { open: 1, review: 2, findings: 3, fix: 3, push: 3, back: 4, approve: 4, merged: 5 };

export const STORY_STEPS: { h: string; p: string }[] = [
  { h: 'You open a pull request', p: '#612 Partial refunds goes up on GitHub. You are its author.' },
  {
    h: 'Sam and Dana review it, at the same time',
    p: 'Each one’s Ensemble claims the commit and reviews it on their own machine, with their own Claude or Codex. Together they find three issues.',
  },
  {
    h: 'Your Ensemble fixes them',
    p: 'Nobody types a thing. Ensemble fixes the findings on your machine with your Claude, in a sandbox, and pushes the fix to the branch.',
  },
  { h: 'Back for review', p: 'The fixed pull request goes back for review. You look over the fix, then Dana approves it.' },
  { h: 'Merged', p: 'Green, and merged.' },
];

const MATES = [
  { name: 'You', agent: 'Claude + Codex', cls: 'you' },
  { name: 'Sam', agent: 'Claude', cls: 'sam' },
  { name: 'Dana', agent: 'Codex', cls: 'dana' },
  { name: 'Priya', agent: 'Claude', cls: 'faint' },
  { name: 'Leo', agent: 'Codex', cls: 'faint' },
] as const;

const CX = 300;
const CY = 300;
const R = 215;
const NODE = 58;
const HUB = 92;

const nodes = MATES.map((m, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / MATES.length;
  return { ...m, x: CX + R * Math.cos(a), y: CY + R * Math.sin(a), a };
});
const byName = (n: string): (typeof nodes)[number] => nodes.find((x) => x.name === n) as (typeof nodes)[number];

/** A straight edge between a node and the hub, `side` px off the centre line, from `from` to the other end. */
function edge(name: string, side: number, toHub: boolean): { d: string; mx: number; my: number } {
  const n = byName(name);
  const ux = (CX - n.x) / R;
  const uy = (CY - n.y) / R;
  const px = -uy * side;
  const py = ux * side;
  const a = { x: n.x + ux * (NODE + 6) + px, y: n.y + uy * (NODE + 6) + py };
  const b = { x: CX - ux * (HUB + 6) + px, y: CY - uy * (HUB + 6) + py };
  const [s, e] = toHub ? [a, b] : [b, a];
  return { d: `M${s.x.toFixed(1)} ${s.y.toFixed(1)}L${e.x.toFixed(1)} ${e.y.toFixed(1)}`, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

const E = {
  open: edge('You', 0, true),
  sam: edge('Sam', 0, true),
  dana: edge('Dana', 0, true),
  findings: edge('You', -12, false),
  push: edge('You', 12, true),
};

const ALL = new Set<Phase>(PHASES);

export function EnsembleStory(): JSX.Element {
  // The prerendered page shows the finished picture; the effect resets it to the start
  // (before it can be seen: the section is below the fold) and plays it once in view.
  const [reached, setReached] = useState<Set<Phase>>(ALL);
  const [still, setStill] = useState(true);
  const [played, setPlayed] = useState(false);
  const timers = useRef<number[]>([]);
  const root = useRef<HTMLDivElement>(null);

  const clear = (): void => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  const play = (): void => {
    clear();
    setReached(new Set());
    setPlayed(true);
    for (const ph of PHASES) {
      timers.current.push(window.setTimeout(() => setReached((r) => new Set(r).add(ph)), AT[ph]));
    }
  };

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof IntersectionObserver === 'undefined') return;
    setStill(false);
    setReached(new Set());
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          play();
        }
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
    // play/clear only touch refs and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = PHASES.filter((p) => reached.has(p)).pop();
  const step = last != null ? STEP_OF[last] : 0;
  const cls = ['circle-svg', 'story-svg', still ? 'still' : '', ...PHASES.filter((p) => reached.has(p)).map((p) => `p-${p}`)].filter(Boolean).join(' ');
  const you = byName('You');
  const dana = byName('Dana');
  const sam = byName('Sam');

  return (
    <div className="story" ref={root}>
      <svg
        className={cls}
        viewBox="0 0 600 600"
        role="img"
        aria-label="One pull request's review: you open it; Sam and Dana review it at the same time from their own machines; your Ensemble fixes what they found with your agent and pushes the fix; you look over it, Dana approves it, and it is merged."
      >
        <circle cx={CX} cy={CY} r={R} className="c-orbit s-team" />

        {/* the edges: drawn along their length when their phase comes */}
        <path d={E.open.d} pathLength={1} className="s-edge e-open" />
        <path d={E.sam.d} pathLength={1} className="s-edge e-sam" />
        <path d={E.dana.d} pathLength={1} className="s-edge e-dana" />
        <path d={E.findings.d} pathLength={1} className="s-edge e-findings" />
        <path d={E.push.d} pathLength={1} className="s-edge e-push" />

        {/* the pull request on GitHub */}
        <g className="s-hub">
          <circle cx={CX} cy={CY} r={HUB} className="c-hub s-hub-fill" />
          <text x={CX} y={CY - 26} className="c-hub-k">
            GITHUB
          </text>
          <text x={CX} y={CY + 2} className="c-hub-t">
            #612 acme/payments
          </text>
          <g className="s-hub-words">
            <text x={CX} y={CY + 28} className="c-hub-s w-open">
              Open
            </text>
            <text x={CX} y={CY + 28} className="c-hub-s w-review">
              In review
            </text>
            <text x={CX} y={CY + 28} className="c-hub-s w-findings">
              3 findings
            </text>
            <text x={CX} y={CY + 28} className="c-hub-s w-push">
              Fixed · back for review
            </text>
            <text x={CX} y={CY + 28} className="c-hub-s w-approve">
              Approved
            </text>
            <text x={CX} y={CY + 28} className="c-hub-s w-merged">
              Merged
            </text>
          </g>
        </g>

        {/* the team */}
        {nodes.map((n) => (
          <g key={n.name} className={`s-mate m-${n.cls}`}>
            <circle cx={n.x} cy={n.y} r={NODE} className="c-node s-node" />
            <text x={n.x} y={n.y - 4} className="c-name">
              {n.name}
            </text>
            <text x={n.x} y={n.y + 18} className="c-agent">
              {n.agent}
            </text>
          </g>
        ))}

        {/* You: the author */}
        <g className="s-author">
          <rect x={you.x - 34} y={you.y + NODE - 11} width={68} height={22} rx={11} />
          <text x={you.x} y={you.y + NODE + 4}>
            AUTHOR
          </text>
        </g>

        {/* edge labels */}
        <g className="s-tag t-reviewing-sam">
          <text x={sam.x - 2} y={sam.y + NODE + 22}>
            Reviewing
          </text>
        </g>
        <g className="s-tag t-reviewing-dana">
          <text x={dana.x - 2} y={dana.y + NODE + 22}>
            Reviewing
          </text>
        </g>
        <g className="s-tag t-findings">
          <text x={E.findings.mx - 64} y={E.findings.my + 4}>
            3 findings
          </text>
        </g>
        <g className="s-tag t-push">
          <text x={E.push.mx + 60} y={E.push.my + 4}>
            Pushed fix
          </text>
        </g>
        <g className="s-tag t-approved">
          <text x={dana.x - 2} y={dana.y + NODE + 22}>
            Approved
          </text>
        </g>

        {/* your Ensemble, working with your agent */}
        <g className="s-agent">
          <rect x={you.x + 66} y={you.y - 30} width={198} height={44} rx={8} />
          <path
            className="s-spark"
            d={`M${you.x + 86} ${you.y - 18}l3 6 6 3-6 3-3 6-3-6-6-3 6-3z`}
          />
          <text x={you.x + 104} y={you.y - 12} className="a-k">
            ENSEMBLE · AUTOMATIC
          </text>
          <text x={you.x + 104} y={you.y + 6} className="a-t">
            Fixing with your Claude
          </text>
        </g>
      </svg>

      {still ? (
        <ol className="story-all">
          {STORY_STEPS.map((s, i) => (
            <li key={s.h}>
              <span className="cap-n">{i + 1}</span>
              <span>
                <b>{s.h}.</b> {s.p}
              </span>
            </li>
          ))}
        </ol>
      ) : (
      <div className="story-cap" aria-live="polite">
        {step === 0 ? (
          <p className="cap-wait">The life of one pull request.</p>
        ) : (
          <>
            <span className="cap-n">
              {step} / {STORY_STEPS.length}
            </span>
            <h3>{STORY_STEPS[step - 1]!.h}</h3>
            <p>{STORY_STEPS[step - 1]!.p}</p>
          </>
        )}
        {played && step === STORY_STEPS.length && (
          <button type="button" className="cap-replay" onClick={play}>
            Replay
          </button>
        )}
      </div>
      )}

      <ol className="vh">
        {STORY_STEPS.map((s) => (
          <li key={s.h}>
            {s.h}: {s.p}
          </li>
        ))}
      </ol>
    </div>
  );
}

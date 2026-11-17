import { useStory } from './story/useStory';
import { StoryCaption, type StoryStep } from './story/StoryCaption';
import { SITE_NAME } from '../../lib/site';
import './story/build-story.css';

// ---------------------------------------------------------------------------
// BUILD END TO END, AS A STORY (the home page's "One click from ticket to pull request" and
// the top of /build's "How the build works"). One fixed picture, three columns, so the eye
// never has to find its place again:
//   left    the ticket (PAY-139). It starts the story and ends it.
//   middle  Ensemble: what it read, the plan, then where the build is.
//   right   your repositories (payments, api, web) and your docs, as lanes.
// Nine steps: press · read the ticket · check it against code and docs (a criterion added)
// · plan four pull requests · build in every repository at once, in the sandbox · review
// rounds (Claude and Codex; a fix; clean) · the pull requests open in plan order, #632
// stacked on #631, the api and web ones after the one they need · the ticket gets the new
// criterion and a comment · in Ensemble's ticket view, How to test.
// Engine and caption card: ./story/ (shared with EnsembleStory). CSS: ./story/build-story.css.
//
// ⚠ EVERY STEP IS A PRODUCT FACT (docs/STORY-BUILD.md § Build end to end, § The review loop,
// § Pushing a stack; docs/STORY-CHAT.md):
//   · the branches are reviewed BEFORE any pull request opens; the PRs open READY, in plan order;
//   · a STACK is within one repository (PR k targets PR k−1's branch); across repositories
//     the plan's order and "depends on" hold, never a git stack;
//   · the ticket gets the plan's changes and ONE plain-English comment, as the reader; its
//     STATUS NEVER CHANGES (and only Jira is written today; the copy stays tracker-general);
//   · How to test is the story chat's preset (shared STORY_CHAT_PRESETS): it is READ-ONLY,
//     it says how to check the work and runs nothing.
// ---------------------------------------------------------------------------

const PHASES = [
  'press',
  'fetch',
  'assess',
  'refine',
  'plan',
  'build',
  'review',
  'fix',
  'clean',
  'prs',
  'ticket',
  'comment',
  'verify',
  'ask',
  'answer',
] as const;
type Phase = (typeof PHASES)[number];

/** When each phase starts (ms from Play). */
const AT: Record<Phase, number> = {
  press: 300,
  fetch: 2400,
  assess: 4600,
  refine: 6400,
  plan: 8800,
  build: 11200,
  review: 14400,
  fix: 16200,
  clean: 18000,
  prs: 20000,
  ticket: 24000,
  comment: 25200,
  verify: 28200,
  ask: 29600,
  answer: 31000,
};

const STEP_OF: Record<Phase, number> = {
  press: 1,
  fetch: 2,
  assess: 3,
  refine: 3,
  plan: 4,
  build: 5,
  review: 6,
  fix: 6,
  clean: 6,
  prs: 7,
  ticket: 8,
  comment: 8,
  verify: 9,
  ask: 9,
  answer: 9,
};

export const BUILD_STEPS: StoryStep[] = [
  { h: 'You press Build end to end', p: `On the ticket, in ${SITE_NAME}. It is the only thing you press.` },
  { h: 'It reads the ticket', p: 'The description and every acceptance criterion, in full.' },
  {
    h: 'It checks the ticket against your code and docs',
    p: 'Where the criteria fall short, it fixes them. Here, older refunds have no reason, so it adds a criterion.',
  },
  { h: 'It plans the change', p: 'Four pull requests in three repositories, in the order they must merge.' },
  {
    h: 'It builds in every repository',
    p: 'Your Claude or Codex writes the code in payments, api and web at once, in a sandbox on your machine.',
  },
  {
    h: 'It reviews its own work, in rounds',
    p: 'Claude and Codex review the branches against the criteria. The agent fixes what they find, and they review again.',
  },
  {
    h: 'It opens the pull requests, in order',
    p: '#632 is stacked on #631 in payments. The api and web pull requests come after the ones they need.',
  },
  {
    h: 'It updates the ticket',
    p: 'The new criterion, and a plain-English comment: the pull requests, what changed and why. The status is left to you.',
  },
  {
    h: 'You ask how to test it',
    p: `In ${SITE_NAME}’s ticket view, press How to test. It reads the pull requests and tells you how to check the work yourself.`,
  },
];

// ---- the picture -------------------------------------------------------------------------
// ONE drawing, TWO geometries: WIDE (three columns, 760 × 520) and TALL for phones (the ticket
// and Ensemble side by side on top, the docs and repositories below, 400 wide), so the words
// stay readable on a phone. Both are in the page; CSS shows one by width (no JS, no jump).

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Geo {
  name: 'wide' | 'tall';
  W: number;
  H: number;
  /** The ticket, Ensemble, and the lanes' column. */
  T: Box;
  M: Box;
  L: { x: number; w: number };
  docsY: number;
  docsH: number;
  laneYs: readonly [number, number, number];
  laneH: number;
  /** In a lane: the name's baseline, the progress bar, the pull requests' top. */
  laneLabel: number;
  laneBar: number;
  lanePr: number;
  /** Each planned pull request's left edge, from the lane's left. */
  prX: readonly [number, number, number, number];
  /** The ticket's criteria as written on it (shorter when tall). */
  ac: readonly [string, string, string];
  /** Where the pills and the status line sit in Ensemble's column, from its top. */
  pillsY: number;
  sayY: number;
  pillW: number;
  /** The How to test panel, and its answer lines' first baseline and spacing. */
  chat: Box;
  ansY: number;
  ansGap: number;
  /** The pointer: off the board, on the button, on How to test. */
  ptr: { start: [number, number]; press: [number, number]; chip: [number, number] };
}

const LANES = [
  { name: 'acme/payments', cls: 'l-pay' },
  { name: 'acme/api', cls: 'l-api' },
  { name: 'acme/web', cls: 'l-web' },
] as const;

/** The planned pull requests: lane, and what each one needs first. */
const PRS = [
  { n: 1, num: '#631', lane: 0, plan: 'Store the reason', short: 'Store reason', after: '' },
  { n: 2, num: '#632', lane: 0, plan: 'Fill older refunds', short: 'Old refunds', after: 'on ①' },
  { n: 3, num: '#219', lane: 1, plan: 'Reason in the API', short: 'Reason in API', after: 'after ①' },
  { n: 4, num: '#1204', lane: 2, plan: 'Picker and export', short: 'Picker, export', after: 'after ③' },
] as const;
const PR_W = 100;
const PR_H = 36;
const CIRCLED = ['①', '②', '③', '④'];

const WIDE: Geo = {
  name: 'wide',
  W: 760,
  H: 520,
  T: { x: 16, y: 20, w: 224, h: 480 },
  M: { x: 262, y: 20, w: 212, h: 480 },
  L: { x: 496, w: 248 },
  docsY: 20,
  docsH: 42,
  laneYs: [76, 216, 356],
  laneH: 120,
  laneLabel: 26,
  laneBar: 42,
  lanePr: 70,
  prX: [16, 136, 136, 16],
  ac: ['AC1  Staff pick a reason', 'AC2  Reason in the export', 'AC3  Older refunds'],
  pillsY: 290,
  sayY: 366,
  pillW: 90,
  chat: { x: 252, y: 20, w: 500, h: 480 },
  ansY: 224,
  ansGap: 38,
  ptr: { start: [330, 540], press: [150, 462], chip: [340, 118] },
};

const TALL: Geo = {
  name: 'tall',
  W: 400,
  H: 870,
  T: { x: 8, y: 8, w: 188, h: 480 },
  M: { x: 212, y: 8, w: 180, h: 480 },
  L: { x: 20, w: 360 },
  docsY: 500,
  docsH: 36,
  laneYs: [548, 646, 744],
  laneH: 86,
  laneLabel: 22,
  laneBar: 33,
  lanePr: 45,
  prX: [16, 140, 140, 140],
  ac: ['AC1  Pick a reason', 'AC2  In the export', 'AC3  Old refunds'],
  pillsY: 286,
  sayY: 356,
  pillW: 74,
  chat: { x: 8, y: 494, w: 384, h: 368 },
  ansY: 214,
  ansGap: 33,
  ptr: { start: [240, 900], press: [120, 446], chip: [90, 586] },
};

const laneY = (g: Geo, lane: number): number => g.laneYs[lane]!;
const prLeft = (g: Geo, i: number): number => g.L.x + g.prX[i]!;
const prTop = (g: Geo, i: number): number => laneY(g, PRS[i]!.lane) + g.lanePr;

/** The cross-repository order: from the bottom of one block to the top of the one after it. */
function needs(g: Geo, from: number, to: number): string {
  const x1 = prLeft(g, from) + PR_W / 2;
  const y1 = prTop(g, from) + PR_H + 4;
  const x2 = prLeft(g, to) + PR_W / 2;
  const y2 = prTop(g, to) - 6;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

/** The mouse pointer (its tip at 0,0). */
const POINTER = 'M0 0L0 22L6 16.5L10.5 26L14 24.5L9.5 15L17 15Z';

const ANSWER = [
  'Merge #631, #632, then #219, #1204.',
  'Refund part of an order; pick a reason.',
  'Export the CSV: the reason is in it.',
  'Older refunds say “No reason given”.',
];

const LABEL =
  "Build end to end: you press it on the ticket; Ensemble reads the ticket, checks it against your code and docs and adds a missing criterion, plans four pull requests in three repositories, builds them in a sandbox, reviews and fixes them in rounds, opens them in order with one stacked on another, updates the ticket with a comment, and in Ensemble's ticket view How to test gives you the steps to check it.";

const px = ([x, y]: [number, number]): string => `translate(${x}px, ${y}px)`;

function Board({ g, phases }: { g: Geo; phases: string }): JSX.Element {
  const { T, M, L } = g;
  const lanesTop = g.laneYs[0] - 8;
  const lanesBottom = g.laneYs[2] + g.laneH + 8;
  const button = T.y + T.h - 56;
  const comment = { y: T.y + 252, h: button - 8 - (T.y + 252) };
  const C = g.chat;
  const chips = [
    { t: 'How to test', x: 16, w: 116 },
    { t: 'Integration', x: 140, w: 112 },
    { t: 'Risks', x: 260, w: 72 },
  ];
  const vars = {
    '--ptr-start': px(g.ptr.start),
    '--ptr-press': px(g.ptr.press),
    '--ptr-chip': px(g.ptr.chip),
  } as React.CSSProperties;

  return (
    <svg
      className={`bstory-svg bstory-${g.name} ${phases}`}
      viewBox={`0 0 ${g.W} ${g.H}`}
      role="img"
      aria-label={LABEL}
      style={vars}
    >
      {/* ---- the ticket ------------------------------------------------------ */}
      <g className="b-ticket">
        <rect x={T.x} y={T.y} width={T.w} height={T.h} rx={10} className="b-card" />
        <text x={T.x + 16} y={T.y + 28} className="b-k">
          TICKET · PAY-139
        </text>
        <text x={T.x + 16} y={T.y + 56} className="b-title">
          Refund reasons
        </text>
        <text x={T.x + 16} y={T.y + 78} className="b-title">
          in the export
        </text>
        <text x={T.x + 16} y={T.y + 112} className="b-k">
          {g.name === 'tall' ? 'CRITERIA' : 'ACCEPTANCE CRITERIA'}
        </text>
        {g.ac.slice(0, 2).map((t, i) => (
          <g key={t} className="b-ac">
            <rect x={T.x + 12} y={T.y + 124 + i * 42} width={T.w - 24} height={34} rx={5} />
            <text x={T.x + 22} y={T.y + 146 + i * 42}>
              {t}
            </text>
          </g>
        ))}
        <g className="b-ac b-ac-new">
          <rect x={T.x + 12} y={T.y + 208} width={T.w - 24} height={34} rx={5} />
          <text x={T.x + 22} y={T.y + 230}>
            {g.ac[2]}
          </text>
          <text x={T.x + T.w - 22} y={T.y + 230} className="b-new">
            NEW
          </text>
        </g>

        <g className="b-comment">
          <rect x={T.x + 12} y={comment.y} width={T.w - 24} height={comment.h} rx={6} />
          <text x={T.x + 24} y={comment.y + 24} className="b-k">
            COMMENT · YOU
          </text>
          {g.name === 'tall' ? (
            <>
              <text x={T.x + 24} y={comment.y + 50} className="b-links">
                #631 #632
              </text>
              <text x={T.x + 24} y={comment.y + 72} className="b-links">
                #219 #1204
              </text>
            </>
          ) : (
            <>
              <text x={T.x + 24} y={comment.y + 50}>
                4 pull requests:
              </text>
              <text x={T.x + 24} y={comment.y + 72} className="b-links">
                #631 #632 #219 #1204
              </text>
            </>
          )}
          <text x={T.x + 24} y={comment.y + 98}>
            Every refund has a
          </text>
          <text x={T.x + 24} y={comment.y + 120}>
            reason, and so does
          </text>
          <text x={T.x + 24} y={comment.y + 142}>
            the export.
          </text>
        </g>

        <g className="b-button">
          <rect x={T.x + 12} y={button} width={T.w - 24} height={42} rx={7} />
          <text x={T.x + T.w / 2} y={button + 27}>
            Build end to end
          </text>
        </g>
      </g>

      {/* the hand-offs between the ticket and Ensemble */}
      <path d={`M${T.x + T.w + 2} ${T.y + 140}l${M.x - T.x - T.w - 6} 10-${M.x - T.x - T.w - 6} 10`} className="b-hop h-fetch" />
      <path d={`M${M.x - 2} ${T.y + 310}l-${M.x - T.x - T.w - 6} 10 ${M.x - T.x - T.w - 6} 10`} className="b-hop h-ticket" />

      {/* ---- Ensemble -------------------------------------------------------- */}
      <g className="b-ens">
        <rect x={M.x} y={M.y} width={M.w} height={M.h} rx={10} className="b-card b-ens-card" />
        <path className="b-spark" d={`M${M.x + 22} ${M.y + 14}l3 6 6 3-6 3-3 6-3-6-6-3 6-3z`} />
        <text x={M.x + 38} y={M.y + 28} className="b-k b-ens-k">
          {SITE_NAME.toUpperCase()}
        </text>

        {/* what it read, and what it found */}
        <g className="b-read">
          <text x={M.x + 16} y={M.y + 58} className="b-h">
            The ticket
          </text>
          {[
            { t: 'AC1', s: 'code' },
            { t: 'AC2', s: 'docs' },
          ].map((r, i) => (
            <g key={r.t} className="b-row">
              <rect x={M.x + 12} y={M.y + 72 + i * 42} width={M.w - 24} height={34} rx={5} />
              <text x={M.x + 22} y={M.y + 94 + i * 42}>
                {r.t}
              </text>
              <text x={M.x + M.w - 22} y={M.y + 94 + i * 42} className="b-ok">
                ✓ {r.s}
              </text>
            </g>
          ))}
          <g className="b-row b-added">
            <rect x={M.x + 12} y={M.y + 156} width={M.w - 24} height={58} rx={5} />
            <text x={M.x + 22} y={M.y + 178}>
              + AC3
            </text>
            <text x={M.x + M.w - 22} y={M.y + 178} className="b-new">
              ADDED
            </text>
            <text x={M.x + 22} y={M.y + 202} className="b-small">
              {g.name === 'tall' ? 'Older refunds: none' : 'Older refunds have none'}
            </text>
          </g>
        </g>

        {/* the plan, then where the build is */}
        <g className="b-plan">
          <text x={M.x + 16} y={M.y + 58} className="b-h">
            The plan
          </text>
          {PRS.map((p, i) => (
            <g key={p.n} className={`b-step b-step-${p.n}`}>
              <rect x={M.x + 12} y={M.y + 70 + i * 50} width={M.w - 24} height={44} rx={5} />
              <text x={M.x + 30} y={M.y + 99 + i * 50} className={`b-num b-mid ${LANES[p.lane]!.cls}`}>
                {CIRCLED[i]}
              </text>
              <text x={M.x + 50} y={M.y + 88 + i * 50} className="b-small">
                {LANES[p.lane]!.name.replace('acme/', '')}
                {p.after ? ` · ${p.after}` : ''}
              </text>
              <text x={M.x + 50} y={M.y + 106 + i * 50} className="b-line">
                {g.name === 'tall' ? p.short : p.plan}
              </text>
            </g>
          ))}
        </g>

        <g className="b-status">
          <g className="b-pills">
            <rect x={M.x + 12} y={M.y + g.pillsY} width={g.pillW} height={30} rx={15} />
            <text x={M.x + 12 + g.pillW / 2} y={M.y + g.pillsY + 20}>
              Claude
            </text>
            <rect x={M.x + M.w - 12 - g.pillW} y={M.y + g.pillsY} width={g.pillW} height={30} rx={15} />
            <text x={M.x + M.w - 12 - g.pillW / 2} y={M.y + g.pillsY + 20}>
              Codex
            </text>
          </g>
          {[
            ['s-build', 'Building'],
            ['s-review', 'Round 1 · 3 open'],
            ['s-fix', 'Fixing them'],
            ['s-clean', 'Round 2 · all clear'],
            ['s-prs', 'Opening pull requests'],
            ['s-ticket', 'Updating the ticket'],
          ].map(([c, t]) => (
            <text key={c} x={M.x + M.w / 2} y={M.y + g.sayY} className={`b-say ${c}`}>
              {t}
            </text>
          ))}
          <g className="b-dots">
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={M.x + M.w / 2 - 16 + i * 16} cy={M.y + g.sayY + 26} r={4} />
            ))}
          </g>
        </g>
      </g>

      {/* ---- your docs and repositories ------------------------------------- */}
      <g className="b-docs">
        <rect x={L.x} y={g.docsY} width={L.w} height={g.docsH} rx={8} className="b-card" />
        <text x={L.x + 16} y={g.docsY + g.docsH / 2 + 6} className="b-lane-name">
          Your docs
        </text>
        <text x={L.x + L.w - 16} y={g.docsY + g.docsH / 2 + 6} className="b-small b-end">
          reference library
        </text>
      </g>

      <rect x={L.x - 8} y={lanesTop} width={L.w + 16} height={lanesBottom - lanesTop} rx={12} className="b-sandbox" />
      <text x={L.x + L.w / 2} y={lanesBottom + 22} className="b-sandbox-k">
        SANDBOX · YOUR MACHINE
      </text>

      {LANES.map((l, i) => (
        <g key={l.name} className={`b-lane ${l.cls}`}>
          <rect x={L.x} y={laneY(g, i)} width={L.w} height={g.laneH} rx={8} className="b-card b-lane-card" />
          <text x={L.x + 16} y={laneY(g, i) + g.laneLabel} className="b-lane-name">
            {l.name}
          </text>
          <rect x={L.x + 16} y={laneY(g, i) + g.laneBar} width={L.w - 32} height={8} rx={4} className="b-track" />
          <rect x={L.x + 16} y={laneY(g, i) + g.laneBar} width={L.w - 32} height={8} rx={4} className={`b-fill b-fill-${i}`} />
        </g>
      ))}

      {/* the order across repositories, then the pull requests themselves */}
      <path d={needs(g, 0, 2)} pathLength={1} className="b-need n-1" />
      <path d={needs(g, 2, 3)} pathLength={1} className="b-need n-2" />
      <path d={`M${prLeft(g, 0) + PR_W + 2} ${prTop(g, 0) + PR_H / 2}H${prLeft(g, 1) - 2}`} className="b-stackline" />
      {PRS.map((p, i) => (
        <g key={p.n} className={`b-pr b-pr-${p.n} ${LANES[p.lane]!.cls}`}>
          <rect x={prLeft(g, i)} y={prTop(g, i)} width={PR_W} height={PR_H} rx={6} />
          <text x={prLeft(g, i) + 22} y={prTop(g, i) + 24} className="b-num b-mid">
            {CIRCLED[i]}
          </text>
          <text x={prLeft(g, i) + 40} y={prTop(g, i) + 24} className="b-prnum">
            {p.num}
          </text>
        </g>
      ))}

      {/* ---- step 9: the ticket in Ensemble, How to test ---------------------- */}
      <g className="b-chat">
        <rect x={C.x} y={C.y} width={C.w} height={C.h} rx={10} className="b-chat-card" />
        <path className="b-spark" d={`M${C.x + 20} ${C.y + 14}l3 6 6 3-6 3-3 6-3-6-6-3 6-3z`} />
        <text x={C.x + 36} y={C.y + 28} className="b-k b-ens-k">
          {SITE_NAME.toUpperCase()} · PAY-139
        </text>
        <text x={C.x + 16} y={C.y + 60} className="b-h">
          Ask about this story
        </text>
        {chips.map((c, i) => (
          <g key={c.t} className={`b-chip${i === 0 ? ' b-chip-go' : ''}`}>
            <rect x={C.x + c.x} y={C.y + 76} width={c.w} height={32} rx={16} />
            <text x={C.x + c.x + c.w / 2} y={C.y + 97}>
              {c.t}
            </text>
          </g>
        ))}
        <g className="b-q">
          <rect x={C.x + C.w - 16 - Math.min(436, C.w - 48)} y={C.y + 126} width={Math.min(436, C.w - 48)} height={58} rx={8} />
          <text x={C.x + C.w - Math.min(436, C.w - 48)} y={C.y + 150}>
            Once these are merged, what must I do
          </text>
          <text x={C.x + C.w - Math.min(436, C.w - 48)} y={C.y + 172}>
            to prove this ticket is done?
          </text>
        </g>
        {ANSWER.map((a, i) => (
          <g key={a} className={`b-a b-a-${i}`}>
            <text x={C.x + 24} y={C.y + g.ansY + i * g.ansGap} className="b-a-n">
              {i + 1}
            </text>
            <text x={C.x + 46} y={C.y + g.ansY + i * g.ansGap}>
              {a}
            </text>
          </g>
        ))}
        <text x={C.x + 16} y={C.y + C.h - 18} className="b-small b-note">
          {g.name === 'tall' ? 'It reads, and changes nothing.' : 'It reads the code and the pull requests. It changes nothing.'}
        </text>
      </g>

      {/* the reader's pointer */}
      <g className="b-pointer">
        <path d={POINTER} />
      </g>
    </svg>
  );
}

export function BuildStory(): JSX.Element {
  const player = useStory(PHASES, AT, STEP_OF, BUILD_STEPS.length);
  return (
    <div className="story bstory" ref={player.root}>
      <Board g={WIDE} phases={player.phaseClasses} />
      <Board g={TALL} phases={player.phaseClasses} />
      <StoryCaption steps={BUILD_STEPS} player={player} intro="From one press to an updated ticket." />
    </div>
  );
}

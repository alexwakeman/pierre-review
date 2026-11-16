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

// ---- the picture: a 760 × 520 board --------------------------------------------------------

/** The three columns. */
const T = { x: 16, y: 20, w: 224, h: 480 };
const M = { x: 262, y: 20, w: 212, h: 480 };
const L = { x: 496, w: 248 };

const LANES = [
  { name: 'acme/payments', cls: 'l-pay', y: 76 },
  { name: 'acme/api', cls: 'l-api', y: 216 },
  { name: 'acme/web', cls: 'l-web', y: 356 },
] as const;
const LANE_H = 120;

/** The planned pull requests: lane, column, and what each one needs first. */
const PRS = [
  { n: 1, num: '#631', lane: 0, x: 512, plan: 'Store the reason', after: '' },
  { n: 2, num: '#632', lane: 0, x: 632, plan: 'Fill older refunds', after: 'on ①' },
  { n: 3, num: '#219', lane: 1, x: 632, plan: 'Reason in the API', after: 'after ①' },
  { n: 4, num: '#1204', lane: 2, x: 512, plan: 'Picker and export', after: 'after ③' },
] as const;
const PR_W = 100;
const PR_H = 36;
const prY = (lane: number): number => LANES[lane]!.y + 70;
const CIRCLED = ['①', '②', '③', '④'];

/** The cross-repository order: from the bottom of one block to the top of the one after it. */
function needs(from: number, to: number): string {
  const a = PRS[from]!;
  const b = PRS[to]!;
  const x1 = a.x + PR_W / 2;
  const y1 = prY(a.lane) + PR_H + 4;
  const x2 = b.x + PR_W / 2;
  const y2 = prY(b.lane) - 6;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

/** The mouse pointer (its tip at 0,0). */
const POINTER = 'M0 0L0 22L6 16.5L10.5 26L14 24.5L9.5 15L17 15Z';

const ANSWER = [
  'Merge #631 and #632, then #219, then #1204.',
  'Refund part of an order and pick a reason.',
  'Export the CSV: the reason has its own column.',
  'An older refund says “No reason given”.',
];

export function BuildStory(): JSX.Element {
  const player = useStory(PHASES, AT, STEP_OF, BUILD_STEPS.length);
  const cls = `bstory-svg ${player.phaseClasses}`;

  return (
    <div className="story bstory" ref={player.root}>
      <svg
        className={cls}
        viewBox="0 0 760 520"
        role="img"
        aria-label="Build end to end: you press it on the ticket; Ensemble reads the ticket, checks it against your code and docs and adds a missing criterion, plans four pull requests in three repositories, builds them in a sandbox, reviews and fixes them in rounds, opens them in order with one stacked on another, updates the ticket with a comment, and in Ensemble's ticket view How to test gives you the steps to check it."
      >
        {/* ---- left: the ticket ---------------------------------------------- */}
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
            ACCEPTANCE CRITERIA
          </text>
          {['AC1  Staff pick a reason', 'AC2  Reason in the export'].map((t, i) => (
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
              AC3  Older refunds
            </text>
            <text x={T.x + T.w - 22} y={T.y + 230} className="b-new">
              NEW
            </text>
          </g>

          <g className="b-comment">
            <rect x={T.x + 12} y={T.y + 262} width={T.w - 24} height={156} rx={6} />
            <text x={T.x + 24} y={T.y + 286} className="b-k">
              COMMENT · YOU
            </text>
            <text x={T.x + 24} y={T.y + 312}>
              4 pull requests:
            </text>
            <text x={T.x + 24} y={T.y + 334} className="b-links">
              #631 #632 #219 #1204
            </text>
            <text x={T.x + 24} y={T.y + 360}>
              Every refund has a
            </text>
            <text x={T.x + 24} y={T.y + 382}>
              reason, and so does
            </text>
            <text x={T.x + 24} y={T.y + 404}>
              the export.
            </text>
          </g>

          <g className="b-button">
            <rect x={T.x + 12} y={T.y + 424} width={T.w - 24} height={42} rx={7} />
            <text x={T.x + T.w / 2} y={T.y + 451}>
              Build end to end
            </text>
          </g>
        </g>

        {/* the hand-offs between the columns */}
        <path d={`M${T.x + T.w + 4} 160l12 10-12 10`} className="b-hop h-fetch" />
        <path d={`M${M.x - 4} 330l-12 10 12 10`} className="b-hop h-ticket" />

        {/* ---- middle: Ensemble ---------------------------------------------- */}
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
                Older refunds have none
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
                <text x={M.x + 52} y={M.y + 88 + i * 50} className="b-small">
                  {LANES[p.lane]!.name.replace('acme/', '')}
                  {p.after ? ` · ${p.after}` : ''}
                </text>
                <text x={M.x + 52} y={M.y + 106 + i * 50} className="b-line">
                  {p.plan}
                </text>
              </g>
            ))}
          </g>

          <g className="b-status">
            <g className="b-pills">
              <rect x={M.x + 12} y={M.y + 290} width={90} height={30} rx={15} className="pill-claude" />
              <text x={M.x + 57} y={M.y + 310}>
                Claude
              </text>
              <rect x={M.x + 110} y={M.y + 290} width={90} height={30} rx={15} className="pill-codex" />
              <text x={M.x + 155} y={M.y + 310}>
                Codex
              </text>
            </g>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-build">
              Building
            </text>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-review">
              Round 1 · 3 open
            </text>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-fix">
              Fixing them
            </text>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-clean">
              Round 2 · all clear
            </text>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-prs">
              Opening 4 pull requests
            </text>
            <text x={M.x + M.w / 2} y={M.y + 366} className="b-say s-ticket">
              Updating the ticket
            </text>
            <g className="b-dots">
              {[0, 1, 2].map((i) => (
                <circle key={i} cx={M.x + M.w / 2 - 16 + i * 16} cy={M.y + 392} r={4} />
              ))}
            </g>
          </g>
        </g>

        {/* ---- right: your docs and repositories ------------------------------- */}
        <g className="b-docs">
          <rect x={L.x} y={20} width={L.w} height={42} rx={8} className="b-card" />
          <text x={L.x + 16} y={47} className="b-lane-name">
            Your docs
          </text>
          <text x={L.x + L.w - 16} y={47} className="b-small b-end">
            reference library
          </text>
        </g>

        <rect x={L.x - 8} y={68} width={L.w + 16} height={416} rx={12} className="b-sandbox" />
        <text x={L.x + L.w / 2} y={506} className="b-sandbox-k">
          SANDBOX · YOUR MACHINE
        </text>

        {LANES.map((l, i) => (
          <g key={l.name} className={`b-lane ${l.cls}`}>
            <rect x={L.x} y={l.y} width={L.w} height={LANE_H} rx={8} className="b-card b-lane-card" />
            <text x={L.x + 16} y={l.y + 26} className="b-lane-name">
              {l.name}
            </text>
            <rect x={L.x + 16} y={l.y + 42} width={L.w - 32} height={8} rx={4} className="b-track" />
            <rect
              x={L.x + 16}
              y={l.y + 42}
              width={L.w - 32}
              height={8}
              rx={4}
              className={`b-fill b-fill-${i}`}
            />
          </g>
        ))}

        {/* the order across repositories, then the pull requests themselves */}
        <path d={needs(0, 2)} pathLength={1} className="b-need n-1" />
        <path d={needs(2, 3)} pathLength={1} className="b-need n-2" />
        <path
          d={`M${PRS[0].x + PR_W + 2} ${prY(0) + PR_H / 2}H${PRS[1].x - 2}`}
          className="b-stackline"
        />
        {PRS.map((p, i) => (
          <g key={p.n} className={`b-pr b-pr-${p.n} ${LANES[p.lane]!.cls}`}>
            <rect x={p.x} y={prY(p.lane)} width={PR_W} height={PR_H} rx={6} />
            <text x={p.x + 22} y={prY(p.lane) + 24} className="b-num b-mid">
              {CIRCLED[i]}
            </text>
            <text x={p.x + 40} y={prY(p.lane) + 24} className="b-prnum">
              {p.num}
            </text>
          </g>
        ))}

        {/* ---- step 9: the ticket in Ensemble, How to test ---------------------- */}
        <g className="b-chat">
          <rect x={252} y={20} width={500} height={480} rx={10} className="b-chat-card" />
          <path className="b-spark" d="M272 34l3 6 6 3-6 3-3 6-3-6-6-3 6-3z" />
          <text x={288} y={48} className="b-k b-ens-k">
            {SITE_NAME.toUpperCase()} · PAY-139
          </text>
          <text x={268} y={80} className="b-h">
            Ask about this story
          </text>
          {[
            { t: 'How to test', x: 268, w: 116 },
            { t: 'Integration', x: 392, w: 112 },
            { t: 'Risks', x: 512, w: 72 },
          ].map((c, i) => (
            <g key={c.t} className={`b-chip${i === 0 ? ' b-chip-go' : ''}`}>
              <rect x={c.x} y={96} width={c.w} height={32} rx={16} />
              <text x={c.x + c.w / 2} y={117}>
                {c.t}
              </text>
            </g>
          ))}
          <g className="b-q">
            <rect x={300} y={146} width={436} height={58} rx={8} />
            <text x={316} y={170}>
              Once these are merged, what must I do
            </text>
            <text x={316} y={192}>
              to prove this ticket is done?
            </text>
          </g>
          {ANSWER.map((a, i) => (
            <g key={a} className={`b-a b-a-${i}`}>
              <text x={276} y={244 + i * 40} className="b-a-n">
                {i + 1}
              </text>
              <text x={298} y={244 + i * 40}>
                {a}
              </text>
            </g>
          ))}
          <text x={268} y={480} className="b-small b-note">
            It reads the code and the pull requests. It changes nothing.
          </text>
        </g>

        {/* the reader's pointer */}
        <g className="b-pointer">
          <path d={POINTER} />
        </g>
      </svg>

      <StoryCaption steps={BUILD_STEPS} player={player} intro="From one press to an updated ticket." />
    </div>
  );
}

import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { FREE_TEAM_SIZE, INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import { CopyCommand } from '../components/board/CopyCommand';
import { useReveal } from '../components/board/useReveal';
import { FixMock, PendingListMock, ReviewMock } from '../components/mock/home';
import { ClaimLinesMock, TeamStandingMock } from '../components/mock/teams';
import { TEAM } from '../mock/acme';
import './teams.css';

// ---------------------------------------------------------------------------
// Ensemble review (/ensemble-review; /teams 301s here) — how a team reviews when each teammate runs
// Ensemble with their own agent, in the board style (src/board.css). Page-only layout lives in
// ./teams.css, scoped under `.lb.teams`.
//
// THE MESSAGE: each teammate adds to the review with their own local agent; there is no central
// orchestration — GitHub is the source of truth. "Decentralised" describes the REVIEW only; the
// product is "runs fully locally, with no added service".
//
// ⚠ EVERY CLAIM HERE IS A PRODUCT FACT, from docs/TEAM-REVIEW.md, docs/CLAUDE-REVIEW.md (§ Team
// claims, § Teammates' reviews, § Claude + Codex, § Check threads, § The replies pass,
// § Auto-posting, § AI Fix → Push when done / The auto fix queue) and
// review/claude-review/team-claim.ts. The traps:
//   · only AUTO reviews claim; a review the reader starts never waits or posts an "is reviewing"
//     line — but when they POST it, it writes the same "reviewed" line;
//   · one line per PROVIDER (ensemble/review-claude, ensemble/review-codex), not per model;
//   · a review "kept in Ensemble" posts nothing, so it holds nothing and nobody sees it;
//   · claims are ALWAYS ON (no setting); auto review itself is OFF until switched on;
//   · the lease is 25 minutes, renewed every 8; the earliest LIVE claimant wins;
//   · the PR author's own lines never hold the commit;
//   · pushback only on automatic runs with posting on; auto fix and Push automatically are OFF.
// When the product changes one of these, change this page in the same commit.
//
// ⚠ The team size comes from `FREE_TEAM_SIZE`; never type the number here.
// The pictures are HTML mocks on the fictional Acme data (src/mock/acme.ts TEAM); the circle's
// state is the ClaimLinesMock's (sam has Claude on #1190, dana is reviewing with Codex).
// ---------------------------------------------------------------------------

/** A product mock on a quiet tile. */
function Shot({ className = '', children }: { className?: string; children: ReactNode }): JSX.Element {
  return <div className={`tile tm-shot rise ${className}`.trim()}>{children}</div>;
}

/** A square-marked list on a tile. */
function Marks({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="tm-list">
      {items.map((u, i) => (
        <li key={i}>{u}</li>
      ))}
    </ul>
  );
}

/** One of the three status lines: its name, the words GitHub shows, what it means. */
function Line({ name, words, className, children }: { name: string; words: string; className: string; children: ReactNode }): JSX.Element {
  return (
    <div className={`tile tm-line rise ${className}`}>
      <h3>{name}</h3>
      <p className="tm-words">“{words}”</p>
      <p>{children}</p>
    </div>
  );
}

// ---- the circle -------------------------------------------------------------

type Mate = { name: string; agent: string; state: string; writes: boolean };

/** The ClaimLinesMock's moment: sam has reviewed #1190 with Claude, dana is reviewing it with Codex. */
const MATES: Mate[] = [
  { name: 'You', agent: 'Claude + Codex', state: 'steps aside', writes: false },
  { name: 'Sam', agent: 'Claude Code', state: 'reviewed · 2 comments', writes: true },
  { name: 'Dana', agent: 'Codex', state: 'is reviewing with Codex', writes: true },
  { name: 'Priya', agent: 'Claude Code', state: 'steps aside', writes: false },
  { name: 'Leo', agent: 'Codex', state: 'steps aside', writes: false },
];

/** Teammates' machines around one pull request on GitHub. Solid spokes write, dashed ones read. */
function Circle(): JSX.Element {
  const cx = 320;
  const cy = 310;
  const r = 222;
  const nodes = MATES.map((m, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / MATES.length;
    return { ...m, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  const pr = TEAM.claims.pr;
  return (
    <svg className="circle-svg" viewBox="0 0 640 640" aria-hidden="true" focusable="false">
      <circle cx={cx} cy={cy} r={r} className="c-orbit" />
      {nodes.map((n) => (
        <line
          key={`l-${n.name}`}
          x1={cx}
          y1={cy}
          x2={n.x}
          y2={n.y}
          className={n.writes ? 'c-spoke c-write' : 'c-spoke c-read'}
        />
      ))}
      <circle cx={cx} cy={cy} r={100} className="c-hub" />
      <text x={cx} y={cy - 34} className="c-hub-k">
        GITHUB
      </text>
      <text x={cx} y={cy - 8} className="c-hub-t">
        #{pr.num} {pr.title}
      </text>
      <text x={cx} y={cy + 16} className="c-hub-s">
        commit {TEAM.claims.sha}
      </text>
      <text x={cx} y={cy + 38} className="c-hub-s">
        status lines · reviews
      </text>
      <text x={cx} y={cy + 56} className="c-hub-s">
        threads
      </text>
      {nodes.map((n, i) => {
        const w = Math.max(96, n.state.length * 7.6 + 22);
        return (
          <g key={n.name}>
            <circle cx={n.x} cy={n.y} r={56} className={`c-node c-node-${i % 4}`} />
            <text x={n.x} y={n.y - 4} className="c-name">
              {n.name}
            </text>
            <text x={n.x} y={n.y + 18} className="c-agent">
              {n.agent}
            </text>
            <rect
              x={n.x - w / 2}
              y={n.y + 62}
              width={w}
              height={26}
              rx={13}
              className={n.writes ? 'c-tag c-tag-on' : 'c-tag'}
            />
            <text x={n.x} y={n.y + 80} className={n.writes ? 'c-tag-t c-tag-t-on' : 'c-tag-t'}>
              {n.state}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The five steps one teammate's Ensemble takes on a commit, as the lines GitHub shows. */
const STEPS: { k: string; where: 'gh' | 'me'; h: string; p: ReactNode }[] = [
  {
    k: 'Read',
    where: 'gh',
    h: 'Read the status lines',
    p: (
      <>
        Sam’s {SITE_NAME} reads the lines on the commit. Nobody holds <code>ensemble/review-claude</code>,
        so the commit is free for Claude.
      </>
    ),
  },
  {
    k: 'Claim',
    where: 'gh',
    h: '“sam is reviewing with Claude”',
    p: 'Posted, then read again. If two teammates claim at once, the earlier line wins and the other stands down.',
  },
  {
    k: 'Review',
    where: 'me',
    h: 'Claude Code reviews, on Sam’s machine',
    p: 'With Sam’s own sign-in. The line is posted again every 8 minutes while it runs.',
  },
  {
    k: 'Post',
    where: 'gh',
    h: 'The review goes to GitHub',
    p: 'As Sam’s review, marked as written by Ensemble.',
  },
  {
    k: 'Done',
    where: 'gh',
    h: '“sam reviewed · 2 comments”',
    p: 'Every other Ensemble on the team skips this commit for Claude. Dana’s Codex review carries on.',
  },
];

export default function EnsembleReview(): JSX.Element {
  useSeo(seoFor('/ensemble-review'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb teams" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board tm-head" aria-labelledby="tm-h1">
        <div className="tile tm-name">
          <h1 id="tm-h1">Review as an ensemble.</h1>
          <p className="tm-lead">
            No review bot seat. Each teammate reviews with their own Claude Code or Codex, on their own
            machine. Every pull request gets the same review on every push, checked against its ticket.
            GitHub is the source of truth.
          </p>
        </div>
        <Shot className="tm-hero-shot">
          <ClaimLinesMock />
        </Shot>
        <div className="tile verdigris tm-say">
          <p>Runs fully locally, with no added service.</p>
        </div>
        <div className="tile gold tm-go">
          <p className="btns">
            <Link className="btn" to="/docs/getting-started/install-and-run">
              Set it up →
            </Link>
          </p>
        </div>
      </section>

      {/* ---- the middle ground ------------------------------------------- */}
      <section className="section board tm-threads" aria-labelledby="tm-m-h">
        <div className="tile tm-txt tm-t-head rise">
          <h2 id="tm-m-h">Between a review bot and a prompt.</h2>
          <p>
            The process of a review bot, on the plans your team already has, with the ticket and your
            docs in hand.
          </p>
        </div>
        <div className="tile madder tm-t tm-t3 rise">
          <h3>A review bot</h3>
          <p>A seat for each person, paid for on top of the AI plans you already have.</p>
        </div>
        <div className="tile lapis tm-t tm-t3 rise">
          <h3>Your agent alone</h3>
          <p>
            No extra cost, but a different review each time, from a prompt someone wrote. It stays on
            one machine, and two people can do the same one.
          </p>
        </div>
        <div className="tile verdigris tm-t tm-t3 rise">
          <h3>{SITE_NAME}</h3>
          <p>
            The same review on every push, checked against the ticket&rsquo;s acceptance criteria and
            description, your docs and the earlier threads. Posted to GitHub once, for the whole team.
          </p>
        </div>
      </section>

      {/* ---- how it works: the circle and the sequence ------------------ */}
      <section className="section board tm-how" aria-labelledby="tm-how-h">
        <div className="tile tm-txt tm-how-head rise">
          <h2 id="tm-how-h">No one in charge. GitHub keeps the score.</h2>
          <p>
            The review is decentralised. Each {SITE_NAME} reads what the others left on the pull
            request, decides for itself, and writes back as its own person. If a teammate’s laptop is
            closed, yours carries on.
          </p>
        </div>

        <figure className="tile tm-circle rise" aria-labelledby="tm-circle-cap">
          <Circle />
          <figcaption id="tm-circle-cap">
            <span className="vh">
              Five teammates, each on their own machine, around pull request #{TEAM.claims.pr.num} on
              GitHub.{' '}
            </span>
            Sam has reviewed the commit with Claude. Dana is reviewing it with Codex. Both models are
            taken, so everyone else’s automatic review steps aside.
          </figcaption>
          <ul className="vh">
            {MATES.map((m) => (
              <li key={m.name}>
                {m.name}, with {m.agent}: {m.state}.
              </li>
            ))}
          </ul>
        </figure>

        <div className="tile tm-seq rise">
          <div className="tm-lanes" aria-hidden="true">
            <span>Sam’s machine</span>
            <span>GitHub</span>
          </div>
          <ol className="tm-steps" aria-label="One automatic review, step by step">
            {STEPS.map((s, i) => (
              <li key={s.k} className={s.where === 'me' ? 'on-me' : 'on-gh'}>
                <span className="tm-n" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <p className="tm-k">{s.k}</p>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- claims ---------------------------------------------------- */}
      <section className="section board tm-claims" aria-labelledby="tm-c-h">
        <div className="tile lapis tm-id rise">
          <p className="tm-word">Claims</p>
          <p className="tm-story">
            <b>On the commit</b>
            <span>a status line any teammate’s {SITE_NAME} can read.</span>
          </p>
        </div>
        <div className="tile tm-q tm-wide rise">
          <h2 id="tm-c-h">One review per model, per commit.</h2>
          <div className="tm-cols">
            <p>
              Before an automatic review starts, your {SITE_NAME} claims the pull request’s latest
              commit with a status line. A teammate’s {SITE_NAME} reads it and skips that commit.
            </p>
            <p>
              There is one line for each model: <code>ensemble/review-claude</code> and{' '}
              <code>ensemble/review-codex</code>. A teammate on Claude does not stop yours reviewing
              the same commit with Codex.
            </p>
          </div>
        </div>

        <Line name="Reviewing" words="sam is reviewing with Claude" className="tm-l1">
          Posted again every 8 minutes while the review runs. Not renewed for 25 minutes, it no longer
          holds the commit.
        </Line>
        <Line name="Reviewed" words="sam reviewed · 2 comments" className="tm-l2">
          The commit is done for Claude. A review kept in {SITE_NAME} puts nothing on GitHub, so it
          holds nothing.
        </Line>
        <Line name="Cleared" words="Cleared by sam: review didn’t finish · free to claim" className="tm-l3">
          The review stopped or was skipped. Any {SITE_NAME} can review the commit now.
        </Line>

        <div className="tile tm-txt tm-fine rise">
          <Marks
            items={[
              'Claims are per commit. A new push starts again.',
              'Only automatic reviews claim. A review you start yourself never waits. When you post it, it writes the same “reviewed” line.',
              'Always on, with no setting. Automatic review is off until you switch it on.',
              'No write access to the repository? The review runs without a line.',
            ]}
          />
        </div>
      </section>

      {/* ---- Claude and Codex ------------------------------------------- */}
      <section className="section board tm-pair2" aria-labelledby="tm-p-h">
        <div className="tile gold tm-id rise">
          <p className="tm-word">Claude + Codex</p>
          <p className="tm-story">
            <b>The default</b>
            <span>when both are signed in.</span>
          </p>
        </div>
        <div className="tile tm-txt tm-wide rise">
          <h2 id="tm-p-h">Two reviews, blind. One result.</h2>
          <p>
            Claude and Codex review at the same time, and neither sees the other. At the end their
            findings are merged into one review: a point both raised shows once, at the higher
            severity.
          </p>
          <p>
            If one fails, the other’s findings are still the review. If a teammate already has
            Claude on the commit, your automatic review runs Codex alone.
          </p>
          <p className="tm-more">
            <Link to="/docs/ai-review/claude-and-codex">Claude and Codex together →</Link>
          </p>
        </div>
      </section>

      {/* ---- threads ---------------------------------------------------- */}
      <section className="section board tm-threads" aria-labelledby="tm-t-h">
        <div className="tile tm-txt tm-t-head rise">
          <h2 id="tm-t-h">Every comment thread gets a judgement.</h2>
          <p>
            A later review reads the threads already on the pull request. The newest judgement wins,
            whoever’s {SITE_NAME} made it, and the thread says whose it is.
          </p>
        </div>
        <div className="tile lapis tm-t rise">
          <h3>Its own findings</h3>
          <p>
            Each one is followed up: addressed, partly addressed, not addressed or no longer applies.
            It never assumes “addressed”. A point still open is raised again, linked to the first.
          </p>
        </div>
        <div className="tile verdigris tm-t rise">
          <h3>Everyone else’s</h3>
          <p>
            A teammate’s, a person’s or another review bot’s comment gets two answers: does the point
            hold up, and is it addressed. Resolved threads too.
          </p>
        </div>
        <div className="tile madder tm-t rise">
          <h3>Check threads</h3>
          <p>
            With automatic review on, new comments on the same commit start a light pass that judges
            only the threads that changed, not a full review.
          </p>
        </div>
        <div className="tile tm-t tm-t-q rise">
          <h3>Replies</h3>
          <p>
            When the author answers one of your {SITE_NAME}’s findings, the replies pass judges the
            answer by itself. Accepted: the finding is settled for good. Disputed: one pushback per
            thread, ever, on automatic runs that post.
          </p>
        </div>
      </section>

      {/* ---- replace a review bot, and fix ------------------------------ */}
      <section className="section board tm-split" aria-labelledby="tm-b-h">
        <div className="tile tm-txt tm-left-n rise">
          <h2 id="tm-b-h">In place of a review bot. And it fixes.</h2>
          <p>
            Switch on automatic review for a workspace and each new pull request is reviewed. The
            review is posted to GitHub: by default on your pull requests and the ones you review, or
            on every one. It approves or asks for changes when your rules allow, or only comments.
            Each of these is a setting.
          </p>
          <p>
            AI Fix fixes the findings, threads and CI failures you pick, in a sandbox on your machine,
            and runs your tests. Push when done pushes it to your own pull request when every item is
            fixed.
          </p>
          <p>
            Auto fix, off until you switch it on, fixes what an automatic review or CI review found
            on your own pull requests. Push automatically is a second switch, also off.
          </p>
          <p className="tm-more">
            <Link to="/docs/ai-fix/push-and-auto-fix">Push and auto fix →</Link>
          </p>
        </div>
        <Shot className="tm-right-w">
          <FixMock />
        </Shot>
      </section>

      {/* ---- the author -------------------------------------------------- */}
      <section className="section board tm-split" aria-labelledby="tm-a-h">
        <div className="tile tm-txt tm-left rise">
          <h2 id="tm-a-h">You can’t approve your own pull request.</h2>
          <p>
            GitHub doesn’t allow it, and {SITE_NAME} follows GitHub. On your own pull request, your
            review is a comment, and it never holds the commit.
          </p>
          <p>
            A teammate’s {SITE_NAME} picks it up first, follows up on the points yours raised, and can
            approve. “Where this PR stands” shows the verdict GitHub holds for each reviewer.
          </p>
        </div>
        <Shot className="tm-right">
          <TeamStandingMock />
        </Shot>
      </section>

      {/* ---- one review ------------------------------------------------- */}
      <section className="section board tm-split" aria-labelledby="tm-r-h">
        <Shot className="tm-left">
          <ReviewMock />
        </Shot>
        <div className="tile tm-txt tm-right rise">
          <h2 id="tm-r-h">One review, however many reviewers.</h2>
          <p>
            A review a teammate’s {SITE_NAME} posted joins yours on the AI Review tab. Each finding
            says who raised it. A closed one says why.
          </p>
          <p>
            A teammate’s point still open? Post reminder raises it again under your name, with a link
            to theirs. Their comment is never edited.
          </p>
        </div>
      </section>

      {/* ---- who has it ------------------------------------------------- */}
      <section className="section board tm-split" aria-labelledby="tm-w-h">
        <div className="tile tm-txt tm-left-n rise">
          <h2 id="tm-w-h">Who has it now.</h2>
          <p>
            Waiting on others lists your pull requests that are with someone else, and for how many
            working hours. Past your review target, it says so. Nudge asks them again, on GitHub.
          </p>
        </div>
        <Shot className="tm-right-w">
          <PendingListMock initialTab="waiting" />
        </Shot>
      </section>

      {/* ---- never ------------------------------------------------------ */}
      <section className="section board tm-pair" aria-labelledby="tm-x-h">
        <div className="tile madder tm-id rise">
          <h2 id="tm-x-h" className="tm-word">
            What it never does
          </h2>
        </div>
        <div className="tile tm-txt tm-wide rise">
          <Marks
            items={[
              <>
                <b>Count as CI.</b> {SITE_NAME}’s lines are left out of every check count and merge
                verdict. Don’t make them required checks.
              </>,
              <>
                <b>Hold a commit for good.</b> {SITE_NAME} clears a line its own review left behind,
                and a teammate’s that went stale. The AI Review tab has a Clear button too.
              </>,
              <>
                <b>Post without asking.</b> A review goes to GitHub when you press Post or Review and
                post, or from automatic review, once you switch it on.
              </>,
              <>
                <b>Touch a teammate’s thread.</b> It never edits their comment or resolves their
                thread. A reminder is a new comment of yours.
              </>,
              <>
                <b>Show what was kept.</b> A review kept in {SITE_NAME} never reaches GitHub, so no
                teammate sees it.
              </>,
            ]}
          />
        </div>
      </section>

      {/* ---- start ------------------------------------------------------ */}
      <section className="section board tm-start" id="start" aria-labelledby="tm-s-h">
        <div className="tile gold tm-start-main rise">
          <h2 id="tm-s-h">Free for up to {FREE_TEAM_SIZE} people. A licence above that.</h2>
          <p>
            {SITE_NAME} is free for individuals, and for organisations where no more than{' '}
            {FREE_TEAM_SIZE} people use it. A bigger team needs a licence.
          </p>
          <code className="tm-cmd">{INSTALL_COMMAND}</code>
          <p className="btns">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
            <Link className="btn alt" to="/contact?topic=licence">
              Ask for a licence →
            </Link>
          </p>
        </div>
        <div className="tile tm-txt tm-start-list rise">
          <Marks
            items={[
              <>
                Each person runs <code>{INSTALL_COMMAND}</code> on their own machine.
              </>,
              'Each person signs in to GitHub with gh, and to Claude Code, Codex or both.',
              'Nothing is sent to us. We run no server for the app.',
              <>
                More than {FREE_TEAM_SIZE} people?{' '}
                <Link to="/contact?topic=licence">Ask through the contact form</Link>.
              </>,
            ]}
          />
        </div>
      </section>
    </div>
  );
}

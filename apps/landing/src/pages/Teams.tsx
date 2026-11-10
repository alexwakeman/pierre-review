import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { FREE_TEAM_SIZE, INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import { CopyCommand } from '../components/board/CopyCommand';
import { useReveal } from '../components/board/useReveal';
import { PendingListMock, ReviewMock } from '../components/mock/home';
import { ClaimLinesMock, TeamStandingMock } from '../components/mock/teams';
import './teams.css';

// ---------------------------------------------------------------------------
// For teams — how reviews work when several teammates each run Limn, in the board
// style (src/board.css). Page-only layout lives in ./teams.css, scoped under `.lb.teams`.
//
// ⚠ EVERY CLAIM HERE IS A PRODUCT FACT, from docs/CLAUDE-REVIEW.md § Team claims and
// § Teammates' reviews, and docs/BACKEND.md § Waiting on others. The traps:
//   · only AUTO reviews claim; a review the reader starts never claims or checks;
//   · one line per PROVIDER (limn/review-claude, limn/review-codex), not per model;
//   · a review "kept in Limn" posts nothing, so it holds nothing and nobody sees it;
//   · "Mark auto reviews on GitHub" is ON by default, auto review itself is OFF;
//   · the PR author's own lines never hold the commit.
// When the product changes one of these, change this page in the same commit.
//
// ⚠ The team size comes from `FREE_TEAM_SIZE`; never type the number here.
// The pictures are HTML mocks on the fictional Acme data (src/mock/acme.ts TEAM).
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

export default function Teams(): JSX.Element {
  useSeo(seoFor('/teams'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb teams" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board tm-head" aria-labelledby="tm-h1">
        <div className="tile tm-name">
          <h1 id="tm-h1">GitHub keeps the score.</h1>
          <p className="tm-lead">
            Everyone on the team runs their own {SITE_NAME}, on their own machine. There is no
            server between you. Each {SITE_NAME} reads and writes GitHub as its own person, and
            reads what the others left there.
          </p>
        </div>
        <Shot className="tm-hero-shot">
          <ClaimLinesMock />
        </Shot>
        <div className="tile verdigris tm-say">
          <p>No shared account. No sign-in. Nothing to host.</p>
        </div>
        <div className="tile gold tm-go">
          <p className="btns">
            <Link className="btn" to="/docs/getting-started/install-and-run">
              Set it up →
            </Link>
          </p>
        </div>
      </section>

      {/* ---- nobody in charge ------------------------------------------ */}
      <section className="section board tm-pair" aria-labelledby="tm-n-h">
        <div className="tile gold tm-id rise">
          <p className="tm-word">No one in charge</p>
        </div>
        <div className="tile tm-txt tm-wide rise">
          <h2 id="tm-n-h">Each {SITE_NAME} decides for itself, from what is on GitHub.</h2>
          <p>
            Who is reviewing this commit, which reviews were posted, whose turn it is: your{' '}
            {SITE_NAME} reads all of it from GitHub, and writes its own moves back the same way, as
            status lines, reviews and comments.
          </p>
          <p>
            So there is nothing to connect and nothing in the middle to fail. If a teammate’s laptop
            is closed, yours carries on. A line their review left behind stops holding the commit
            after 25 minutes.
          </p>
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
          <h2 id="tm-c-h">Two people, one commit, one review.</h2>
          <div className="tm-cols">
            <p>
              Before an auto review starts, your {SITE_NAME} posts a status line on the pull
              request’s latest commit. A teammate’s {SITE_NAME} reads that line and skips the commit.
            </p>
            <p>
              There is one line for each provider: <code>limn/review-claude</code> and{' '}
              <code>limn/review-codex</code>. A teammate reviewing with Claude does not stop yours
              reviewing the same commit with Codex.
            </p>
          </div>
        </div>

        <Line name="Reviewing" words="sam is reviewing with Claude" className="tm-l1">
          Posted again every 8 minutes while the review runs. Not renewed for 25 minutes, it no
          longer holds the commit.
        </Line>
        <Line name="Reviewed" words="sam reviewed · 2 comments" className="tm-l2">
          This commit is done for Claude. A review kept in {SITE_NAME} posts nothing to GitHub, so it
          holds nothing.
        </Line>
        <Line name="Cleared" words="Cleared by sam: review didn’t finish · free to claim" className="tm-l3">
          The review stopped or was skipped. Any {SITE_NAME} can review the commit now.
        </Line>

        <div className="tile tm-txt tm-fine rise">
          <Marks
            items={[
              'Two claims at the same moment? GitHub’s record of who posted first decides. The other stands down.',
              'Claims are per commit. A new push frees the pull request.',
              'Only auto reviews claim. A review you start yourself never checks or posts a line.',
              <>
                On by default, as “Mark auto reviews on GitHub” in Settings → Auto review. Auto
                review itself is off until you switch it on.
              </>,
            ]}
          />
        </div>
      </section>

      {/* ---- the author -------------------------------------------------- */}
      <section className="section board tm-split" aria-labelledby="tm-a-h">
        <div className="tile tm-txt tm-left rise">
          <h2 id="tm-a-h">You can’t approve your own pull request.</h2>
          <p>
            GitHub doesn’t allow it, and {SITE_NAME} follows GitHub. On your own pull request, your
            review is a comment.
          </p>
          <p>
            It never holds the commit either. A teammate’s {SITE_NAME} still reviews it, follows up
            on the points yours raised, and can approve.
          </p>
          <p>“Where this PR stands” shows each reviewer’s latest verdict, and what still holds on GitHub.</p>
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
            A review a teammate’s {SITE_NAME} posted to GitHub joins yours on the AI Review tab.
            Each finding says who raised it. A closed one says why.
          </p>
          <p>
            A teammate’s point still open? Post reminder raises it again under your name, with a
            link to theirs. Their comment is never edited.
          </p>
          <p>A review a teammate kept in their own {SITE_NAME} never reaches GitHub, so you never see it.</p>
        </div>
      </section>

      {/* ---- who has it ------------------------------------------------- */}
      <section className="section board tm-split" aria-labelledby="tm-w-h">
        <div className="tile tm-txt tm-left-n rise">
          <h2 id="tm-w-h">Who has it now.</h2>
          <p>
            Waiting on others lists your pull requests that are with someone else, and for how many
            working hours. Past your review target, it says so.
          </p>
          <p>Nudge asks them for their review again, on GitHub.</p>
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
                <b>Block a review.</b> Without write access to the repository, {SITE_NAME} reviews
                without a line.
              </>,
              <>
                <b>Hold a commit for good.</b> {SITE_NAME} clears a line its own review left behind,
                and a teammate’s that went stale. The AI Review tab has a Clear button too.
              </>,
              <>
                <b>Post without asking.</b> A review goes to GitHub when you press Post, or when you
                switch on auto review.
              </>,
              <>
                <b>Edit a teammate’s comment.</b> A reminder is a new comment of yours.
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
              'Each person signs in to GitHub with gh, and to Claude Code or Codex.',
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

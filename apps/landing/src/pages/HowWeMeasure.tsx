import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { DEMO_PATH, FREE_TEAM_SIZE, INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import hoursLeaf from '../assets/board/img/hours-leaf.jpg';
import botsSeverity from '../assets/pages/rep-bots-severity.jpg';
import botsCost from '../assets/pages/rep-bots-cost.jpg';
import './how-we-measure.css';

// ---------------------------------------------------------------------------
// How we measure — the two machine-learning models, for a general reader, in the
// home page's board style (src/board.css). Page-only layout lives in
// ./how-we-measure.css, scoped under `.lb.hwm`.
//
// ⚠ THIS IS MARKETING, NOT A PAPER. The rule this page is written to: if a
// concept cannot be explained in ONE plain sentence, it is left out entirely
// rather than half-explained. So there is no macro-F1 here, no quantiles, no
// confidence intervals, no Snorkel, no SetFit, no stratified sampling, no
// hierarchical Bayes — all of which are real and all of which would lose the
// reader in exchange for nothing they can act on.
//
// What survives is: what each model is FOR, how it was BUILT (in outline), and
// how we know it WORKS. A named architecture is allowed exactly once per model,
// unexplained, as a credibility signal — a reader who knows what ModernBERT is
// gets something from it, and a reader who does not loses nothing.
//
// ⚠ NUMBERS ARE WRITTEN AS PROPORTIONS A PERSON CAN PICTURE ("seven times in
// ten"), never as decimals or percentages that read as statistics. The sample
// COUNTS are deliberately absent: a true, carefully-chosen sample of a few
// hundred sounds small to a casual reader and arguing the point costs more than
// it wins. The underlying measurements are in docs/ML-SEVERITY.md § Accuracy
// and packages/ml — keep this page and those documents in agreement.
//
// ⚠ THE "WHAT THEY DON'T DO" SECTION IS NOT A DISCLAIMER — it is the strongest
// thing on the page. Every competitor puts a model on everything; saying out
// loud that counting beats a model at counting is what makes the two places we
// DO use one believable. Do not cut it for being negative.
//
// The closing block carries the words of the old paper theme's closing block
// (since deleted) in board markup. ⚠ The team size comes from
// `FREE_TEAM_SIZE`; never type the number here.
//
// Screenshots are the demo's Acme sample data (the same captures as Reporting).
// ---------------------------------------------------------------------------

const GRADER_USES = [
  'The severity badge on every bot comment, wherever you read it.',
  'The “needs a look” counts on a pull request, so a wall of forty threads has a top.',
  'The keep / tune / rarely used verdict on each vendor, and the over-calling line beside it.',
];

const BENCHMARK_USES = [
  'Where each of your bots sits against the same bot running in comparable repositories.',
  'What a typical team gets out of that vendor, so your own rate has something to mean.',
  'A written refusal wherever the comparison would not be honest.',
];

type ShotProps = { src: string; w: number; h: number; alt: string; className?: string };

/** A product screenshot on a quiet tile, at its own ratio. A tap opens it full size. */
function Shot({ src, w, h, alt, className = '' }: ShotProps): JSX.Element {
  return (
    <figure className={`tile hwm-shot rise ${className}`.trim()}>
      <a href={src}>
        <img src={src} width={w} height={h} alt={alt} loading="lazy" />
      </a>
    </figure>
  );
}

/** A square-marked list on a tile. */
function Marks({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="hwm-list">
      {items.map((u, i) => (
        <li key={i}>{u}</li>
      ))}
    </ul>
  );
}

/** The model's name on its pigment tile, with the one fact that travels with it. */
function Ident({
  word,
  moment,
  children,
  className,
}: {
  word: string;
  moment: string;
  children: ReactNode;
  className: string;
}): JSX.Element {
  return (
    <div className={`tile hwm-id rise ${className}`}>
      <p className="hwm-word">{word}</p>
      <p className="hwm-story">
        <b>{moment}</b>
        <span>{children}</span>
      </p>
    </div>
  );
}

export default function HowWeMeasure(): JSX.Element {
  useSeo(seoFor('/how-we-measure'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb hwm" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board hwm-head" aria-labelledby="hwm-h1">
        <div className="tile hwm-name">
          <h1 id="hwm-h1">Two models. One job each.</h1>
          <p className="hwm-lead">
            Almost everything {SITE_NAME} shows you is arithmetic — counted, not predicted. Two
            questions resist counting, and each has a model of its own built for it: how serious
            is this comment, and is that good compared to everybody else?
          </p>
        </div>
        <div className="tile ph hwm-pic">
          <img src={hoursLeaf} width={800} height={1018} alt="A page from a Book of Hours, around 1500" />
        </div>
        <div className="tile verdigris hwm-say">
          <p>Both are built and run by us. Neither sends your code or your comments anywhere.</p>
        </div>
        <div className="tile gold hwm-go">
          <p className="btns">
            <a className="btn" href={DEMO_PATH}>
              Try the demo
            </a>
            <Link className="btn alt" to="/reporting">
              See what it produces →
            </Link>
          </p>
        </div>
      </section>

      {/* ---- 01 · the grader ------------------------------------------- */}
      <section className="section hwm-model" aria-labelledby="hwm-g-h">
        <div className="board">
          <Ident className="lapis hwm-id-l" word="The grader" moment="On your machine">
            the grade runs on your own CPU. No comment leaves it to be graded.
          </Ident>
          <div className="tile hwm-q hwm-q-r rise">
            <h2 id="hwm-g-h">How serious is this comment?</h2>
            <div className="hwm-cols">
              <p>
                A review bot leaves forty comments on a pull request. Two of them will change
                whether the code works. The rest are preferences, tidy-ups and things somebody
                already knew. Nothing in the comments themselves tells you which is which — and
                the vendor&rsquo;s own labels are marking their own homework.
              </p>
              <p>
                So the first model reads each comment and says how serious it is: a nit,
                something minor, something major, or something critical. It is the same judgement
                a senior engineer makes in a second and cannot make four hundred times a week.
              </p>
            </div>
          </div>

          <Shot
            className="hwm-wide"
            src={botsSeverity}
            w={1140}
            h={587}
            alt="Bots Monitoring: what the bots are flagging, and a table with a row per bot: threads, share used, not addressed and severity mix"
          />
          <div className="tile hwm-txt hwm-side rise">
            <h3>How it was built</h3>
            <p>
              We collected millions of real review-bot comments from public repositories on
              GitHub — every major vendor, across projects of every size — and taught the model on
              those rather than on anything invented. Under the hood it is a fine-tuned ModernBERT,
              which is a language model small enough to run on the ordinary processor in a laptop
              or a server: no graphics card, no cloud, nothing sent out, and nothing metered.
            </p>
            <p>
              It does one thing, and that is the point. It is not a general assistant being asked
              nicely to have an opinion; it was trained for this single question and does nothing
              else.
            </p>
          </div>

          <div className="tile hwm-txt hwm-proof rise">
            <h3>How we know it works</h3>
            <p>
              We took 300 real bot comments, hid every label they already carried, and had them
              graded from scratch by an independent grader. Then we compared.
            </p>
            <p className="hwm-big">
              The model chose the same severity as the grader <strong>seven times in ten</strong>.
            </p>
            <p>
              To know whether that is good, we needed something to compare it against — so we
              checked how often a human reviewer agreed with that same grader on the same
              comments. Also seven times in ten. The model is reading these comments about as well
              as the question can be answered.
            </p>
            <p>
              On the ones CodeRabbit had labelled, its own severity labels matched the grader
              fewer than five times in ten. That gap is the whole reason we grade independently
              instead of passing the vendor&rsquo;s label through.
            </p>
          </div>
          <div className="tile hwm-txt hwm-feeds rise">
            <h3>What it feeds</h3>
            <Marks items={GRADER_USES} />
          </div>
        </div>
      </section>

      {/* ---- 02 · the benchmark ---------------------------------------- */}
      <section className="section hwm-model hwm-flip" aria-labelledby="hwm-b-h">
        <div className="board">
          <div className="tile hwm-q hwm-q-l rise">
            <h2 id="hwm-b-h">And is that good, or normal?</h2>
            <div className="hwm-cols">
              <p>
                Say your team acts on half of what CodeRabbit tells it. Is that good? There is no
                way to know from inside your own repositories. Half might be excellent. Half might
                mean the bot is badly configured and everyone has quietly started ignoring it.
              </p>
              <p>
                The second model answers that by building the missing half of the comparison: what
                the same bot does in <em>other people&rsquo;s</em> repositories.
              </p>
            </div>
          </div>
          <Ident className="verdigris hwm-id-r" word="The benchmark" moment="Bundled">
            the cohort ships with the app, so placing your bots sends nothing anywhere.
          </Ident>

          <div className="tile hwm-txt hwm-side-l rise">
            <h3>How it was built</h3>
            <p>
              Every public action on GitHub is published as a public event stream. We read it to
              find repositories running each review vendor, drew a sample of{' '}
              <strong>2,204 of them</strong> across seven vendors, and then visited each one to
              collect what actually happened: how much the bot said, how much of it people replied
              to, resolved, or left sitting.
            </p>
            <p>
              Repositories are then grouped with others of a similar size and pace, because a quiet
              internal service and a busy monorepo are not the same test. Your repository is placed
              against its own group, never against the average of all of them.
            </p>
            <p>
              Which repositories to sample was decided in code, with a fixed seed and a written
              record of every choice, so the cohort is reproducible rather than hand-picked. It is
              rebuilt as the corpus grows, and the page tells you how old the current one is.
            </p>
          </div>
          <Shot
            className="hwm-wide-r"
            src={botsCost}
            w={1140}
            h={574}
            alt="CodeRabbit's benchmark card: monthly cost, cost per merged pull request and per comment used, and how it compares with teams with similar repositories"
          />

          <div className="tile madder hwm-txt hwm-refuse rise">
            <h3>How we know it works</h3>
            <p className="hwm-big">By refusing.</p>
            <p>
              Some groups have plenty of comparable repositories behind them and some have a
              handful, and a comparison drawn from a handful is a number that will move on its own
              next month. Where a group is too thin, the panel says so in words instead of printing
              a figure.
            </p>
            <p>
              There are fourteen different ways it can decline to answer, and each one names which
              comparison it is declining and why. Every figure it <em>does</em> print carries how
              many repositories are behind it and which group they were.
            </p>
          </div>
          <div className="tile hwm-txt hwm-feeds rise">
            <h3>What it feeds</h3>
            <Marks items={BENCHMARK_USES} />
          </div>
        </div>
      </section>

      {/* ---- 03 · and nowhere else ------------------------------------- */}
      <section className="section board hwm-else" aria-labelledby="hwm-e-h">
        <div className="tile gold hwm-else-id rise">
          <p className="hwm-word">And nowhere else</p>
        </div>
        <div className="tile hwm-else-h rise">
          <h2 id="hwm-e-h">Everything else here is counting, and counting is better at it.</h2>
        </div>
        <div className="tile hwm-txt hwm-else-a rise">
          <p>
            Two models, on two questions, and that is the end of the list. How many pull requests
            merged, how long they waited, whose turn it is, what is stalled, what a change touches,
            who was holding it — all of that is arithmetic over your own data. It is exact, it is
            reproducible, and you can check it.
          </p>
          <p>
            A model would make every one of those <em>worse</em>. It would turn a number you can
            verify into an estimate you have to trust, and estimates are how dashboards stop being
            believed.
          </p>
        </div>
        <div className="tile lapis hwm-txt hwm-else-b rise">
          <p>
            There is a third place {SITE_NAME} uses AI, and it is separate from both models on this
            page: writing. Short notes — what a change could break, the reason beside an item in
            your queue — and, on your own machine, Claude&rsquo;s review of a pull request and its
            fix for the comments you pick. Those are language, not measurement, and they are clearly
            marked wherever they appear.
          </p>
          <p>
            No number on any screen comes from them, and nothing in the product acts on a
            model&rsquo;s output on its own. A grade changes what a list is sorted by. It never
            resolves a thread, merges a pull request or closes anything. By default, a review is
            posted, and a fix pushed, only when you press the button.
          </p>
        </div>
      </section>

      {/* ---- start ------------------------------------------------------ */}
      <section className="section board hwm-start" id="start" aria-labelledby="hwm-s-h">
        <div className="tile gold hwm-start-main rise">
          <h2 id="hwm-s-h">Free. One command.</h2>
          <p>
            {SITE_NAME} runs only on your machine. It reads GitHub through your <code>gh</code>{' '}
            login and keeps its data in a file on your disk. There is no account and nothing to
            pay.
          </p>
          <p>
            Nothing is sent to us. We run no server for the app, and it has no tracking. Your code
            and pull requests go only between your machine and GitHub — and to Anthropic, on your
            own account, when you ask Claude to review or fix something.
          </p>
          <code className="hwm-cmd">{INSTALL_COMMAND}</code>
          <p className="btns">
            <a className="btn" href={DEMO_PATH}>
              Try the demo
            </a>
            <Link className="btn alt" to="/contact?topic=licence">
              More than {FREE_TEAM_SIZE} users in your organisation? →
            </Link>
          </p>
        </div>
        <div className="tile hwm-txt hwm-start-list rise">
          <Marks
            items={[
              '100% free. No sign-in, no card, no repository limit.',
              'Runs only on your machine. No data is sent to our servers.',
              <>
                Available only from npm: <code>{INSTALL_COMMAND}</code>. Needs Node 20 or later.
              </>,
              'Built for Claude users. Reviews and fixes run on your Claude Code login or an Anthropic API key. Codex support is coming soon.',
              <>
                Free for individuals, and for organisations where no more than {FREE_TEAM_SIZE}{' '}
                people use it. More users than that need a licence —{' '}
                <Link to="/contact?topic=licence">ask through the contact form</Link>.
              </>,
              'The demo runs in your browser on sample data. No install, no sign-in.',
            ]}
          />
        </div>
      </section>
    </div>
  );
}

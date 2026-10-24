import { useEffect, useRef, useState } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { DEMO_PATH } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import { copyText } from '../components/board/copyText';
import { useLightbox } from '../components/Lightbox';
import scholar from '../assets/board/img/scholar.jpg';
import flowMetrics from '../assets/pages/rep-flow-metrics.jpg';
import periodReport from '../assets/pages/rep-period-report.jpg';
import periodSummary from '../assets/pages/rep-period-summary.jpg';
import chronology from '../assets/pages/rep-chronology.jpg';
import overTime from '../assets/pages/rep-chronology-over-time.jpg';
import whereWork from '../assets/pages/rep-where-work.jpg';
import botsSeverity from '../assets/pages/rep-bots-severity.jpg';
import botsCost from '../assets/pages/rep-bots-cost.jpg';
import sprintLanes from '../assets/pages/rep-sprint-lanes.jpg';
import './reporting.css';

// ---------------------------------------------------------------------------
// "Reporting and metrics": the reporting highlights in the home page's board
// style (src/board.css). Page-only layout lives in ./reporting.css, scoped under
// `.lb.rep`.
//
// Every sentence here was checked against the code (the reporting window, period
// reports, Chronology, flow metrics, Bots Monitoring, This Sprint). Screenshots
// are the demo's Acme sample data.
//
// Running order: header · one window · period reports · Chronology (+ the
// measured proof figures) · over time · where the work is · bots · This Sprint ·
// run it.
// ---------------------------------------------------------------------------

const COMMAND = 'npx limn-review';

type ShotProps = { src: string; w: number; h: number; alt: string; className?: string };

/**
 * A product screenshot on a quiet tile, drawn at its own aspect ratio (no crop).
 * A tap opens it full size: on a phone the wide report shots are too small to read.
 */
function Shot({ src, w, h, alt, className = '' }: ShotProps): JSX.Element {
  const lightbox = useLightbox();
  return (
    <figure className={`tile shot rise ${className}`.trim()}>
      <a
        href={src}
        onClick={(e) => {
          // The href still works without JS (and for a new-tab click); otherwise
          // the shot opens in place.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          lightbox.open({ src, alt });
        }}
      >
        <img src={src} width={w} height={h} alt={alt} loading="lazy" />
      </a>
    </figure>
  );
}

function RunIt(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    void copyText(COMMAND).then((ok) => {
      if (!ok) return; // The command stays readable beside the button.
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <section className="section board r-close" aria-labelledby="r-run-h">
      <div className="tile lapis r-flank rise"></div>
      <div className="tile gold r-mid rise">
        <h2 id="r-run-h">See your own numbers</h2>
        <p>One command. No account. Or look around the demo first.</p>
        <p className="btns">
          <a className="btn" href={DEMO_PATH}>
            Quick demo
          </a>
          <button className="btn alt" type="button" onClick={copy}>
            <span aria-live="polite">{copied ? 'Copied' : `Copy ${COMMAND}`}</span>
          </button>
        </p>
        <code>{COMMAND}</code>
      </div>
      <div className="tile verdigris r-flank rise"></div>
    </section>
  );
}

export default function Reporting(): JSX.Element {
  useSeo(seoFor('/reporting'));
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb rep" ref={ref}>
      {/* ---- header ---------------------------------------------------- */}
      <section className="board r-head" aria-labelledby="r-h1">
        <div className="tile r-name">
          <h1 id="r-h1">Reporting and metrics</h1>
          <p className="r-lead">Where the work is, where it waits, and what your review bots are worth.</p>
        </div>
        <div className="tile ph r-pic">
          <img
            src={scholar}
            width={800}
            height={919}
            alt="Jacques de Guyse reading at his desk among his books, around 1500"
          />
        </div>
        <div className="tile verdigris r-say">
          <p>Bots and people are counted apart.</p>
        </div>
        <div className="tile lapis r-say2">
          <p>No leaderboards, no developer scorecards.</p>
        </div>
      </section>

      {/* ---- 1. one window: split text / screenshot --------------------- */}
      <section className="section board r-split" aria-labelledby="r-win-h">
        <div className="tile r-txt rise">
          <h2 id="r-win-h">One stated window</h2>
          <p>
            Reports' headline figures cover one window: this sprint so far if you work in sprints, otherwise the last 7 or
            14 days. Anything else, such as right now or the last 12 weeks, says so in its heading.
          </p>
          <p className="muted">Each tile opens the pull requests behind its figure.</p>
        </div>
        <Shot
          className="r-wide"
          src={flowMetrics}
          w={1140}
          h={498}
          alt="Reports flow metrics for this sprint so far: merged, time to merge, time to first review, checks green at merge and time to fix red checks, with right-now tiles and 12-week charts"
        />
      </section>

      {/* ---- 2. period reports: full-width shot + a row of three -------- */}
      <section className="section r-period" aria-labelledby="r-per-h">
        <div className="r-chap">
          <h2 id="r-per-h">A report per sprint or month</h2>
          <p>
            Fifteen measures for each completed sprint or calendar month, against the period before. Month to date is
            live and costs nothing.
          </p>
        </div>
        <div className="board">
          <Shot
            className="r-full"
            src={periodReport}
            w={1148}
            h={833}
            alt="A period report for 1 to 15 October: sprint or month, people against automation, biggest movers, and metric rows with the prior period, the change and a forecast"
          />
          <div className="tile r-fact rise">
            <b>Stays the same</b>
            <p>Every figure counts only what happened inside its window, so a report reads the same after you send it.</p>
          </div>
          <div className="tile r-fact rise">
            <b>Same repositories</b>
            <p>Changes are compared over the repositories you tracked in both periods, so adding a repo isn't growth.</p>
          </div>
          <div className="tile r-fact rise">
            <b>No guessing</b>
            <p>No forecast for calendar months: they aren't the same length. Where the data can't support a number, it says so.</p>
          </div>
          <div className="tile r-sumtxt rise">
            <p>A short written summary, on your own Claude Code login or Anthropic API key.</p>
          </div>
          <Shot
            className="r-sum"
            src={periodSummary}
            w={1114}
            h={216}
            alt="A period report's written summary: what happened, and what to watch"
          />
        </div>
      </section>

      {/* ---- 3. Chronology: screenshot + courts, then the proof figure --- */}
      <section className="section board r-chron" aria-labelledby="r-chr-h">
        <div className="tile r-txt rise">
          <h2 id="r-chr-h">Where every hour goes</h2>
          <p>
            Every hour a pull request is open belongs to someone: a reviewer, the author, or the merge, once it's
            approved.
          </p>
          <ul className="r-courts">
            <li>
              {/* The swatches match the screenshot beside them, not the page's pigments. */}
              <span className="sw" style={{ background: '#d97706' }}></span>Waiting for a reviewer
            </li>
            <li>
              <span className="sw" style={{ background: '#0d9488' }}></span>Waiting for the author
            </li>
            <li>
              <span className="sw" style={{ background: '#6366f1' }}></span>Approved, waiting to merge
            </li>
          </ul>
          <p className="muted">
            Counted in your team's working hours, against time budgets you can change. Bots never move the ball. Pull
            requests opened by automation, or that no person touched, are left out, and the page says how many.
          </p>
        </div>
        <Shot
          className="r-wide"
          src={chronology}
          w={1148}
          h={722}
          alt="Chronology: where the working hours went between reviewer, author and landing, and each wait against its time budget"
        />
        <div className="tile lapis r-big rise">
          <p className="r-fig">
            42 min<span> to merge half of pull requests in the week of 19 Oct, from about 7 h in September</span>
          </p>
        </div>
        <div className="tile r-proof rise">
          <h3>Faster reviews, fewer bottlenecks</h3>
          <p>
            On a nine-repository delivery team, Limn took over the reviews in October. Half of their pull requests now merge
            within an hour of working time, and twice as many land each week. It cost them nothing extra.
          </p>
          <p className="src">
            Measured by Limn's Chronology report: merged pull requests by people, working hours, September vs the week of 19
            October 2026.
          </p>
        </div>
      </section>

      {/* ---- 4. over time: screenshot left, text right ------------------ */}
      <section className="section board r-split r-flip" aria-labelledby="r-ot-h">
        <Shot
          className="r-wide"
          src={overTime}
          w={1140}
          h={867}
          alt="Chronology over the last 26 weeks: markers for a repository joining, a new bot, a contributor and a setting change, with where the hours went, each wait against its budget, and working hours saved"
        />
        <div className="tile r-txt rise">
          <h2 id="r-ot-h">Over 26 weeks</h2>
          <p>
            Where the hours went each week, each wait against its budget, and the working hours saved. Markers show when a
            repo joined, a setting changed or a bot arrived.
          </p>
          <p className="muted">Open a marker to compare before and after.</p>
        </div>
      </section>

      {/* ---- 5. where the work is happening: one wide row -------------- */}
      <section className="section r-where" aria-labelledby="r-wh-h">
        <div className="r-chap">
          <h2 id="r-wh-h">Where the work is happening</h2>
          <p>
            Which repositories carry the work, and how far each merged change could reach. Unknown is never shown as zero.
          </p>
        </div>
        <div className="board">
          <Shot
            className="r-full"
            src={whereWork}
            w={1144}
            h={313}
            alt="Activity by repository, with people apart from automation and lines changed, and reach by repository at low, medium and high"
          />
        </div>
      </section>

      {/* ---- 6. bots: big claim tile + two screenshots ------------------ */}
      <section className="section board r-bots" aria-labelledby="r-bot-h">
        <div className="tile verdigris r-bclaim rise">
          <h2 id="r-bot-h">What your bots are worth</h2>
          <p>Bot comments graded nit, minor, major or critical by Limn's own model, on your own machine.</p>
          <p>What each bot costs per comment your team acted on.</p>
        </div>
        <Shot
          className="r-bshot"
          src={botsSeverity}
          w={1140}
          h={587}
          alt="Bots Monitoring: what the bots are flagging, and a table with a row per bot: threads, share used, not addressed and severity mix"
        />
        <div className="tile r-btxt rise">
          <p>
            How each bot compares with the same bot in similar-sized public repositories, or a plain sentence saying why it
            can't. Cost is per workspace and never added up across workspaces.
          </p>
        </div>
        <Shot
          className="r-bshot2"
          src={botsCost}
          w={1140}
          h={574}
          alt="CodeRabbit's benchmark card: monthly cost, cost per merged pull request and per comment used, and how it compares with teams with similar repositories"
        />
      </section>

      {/* ---- 7. This Sprint: full-width shot under a chapter ------------ */}
      <section className="section r-sprint" aria-labelledby="r-sp-h">
        <div className="r-chap">
          <h2 id="r-sp-h">This Sprint</h2>
          <p>
            The sprint by theme, critical path or person, on your tracker's own status columns. Jira, Linear or GitHub
            Issues. Limn writes nothing back.
          </p>
          <p className="muted">Themes and critical paths are written by Claude, on your own Claude Code login or Anthropic API key.</p>
        </div>
        <div className="board">
          <Shot
            className="r-full"
            src={sprintLanes}
            w={1440}
            h={960}
            alt="This Sprint by theme: themes as rows, status columns from not started to complete, ticket cards and numbered critical-path links"
          />
        </div>
      </section>

      <RunIt />
    </div>
  );
}

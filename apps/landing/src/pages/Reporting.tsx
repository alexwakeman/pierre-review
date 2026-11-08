import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import type { ReactNode } from 'react';
import { INSTALL_COMMAND } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import { CopyCommand } from '../components/board/CopyCommand';
import scholar from '../assets/board/img/scholar.jpg';
import {
  BenchmarkMock,
  BotsSeverityMock,
  ChronologyMock,
  FlowMetricsMock,
  OverTimeMock,
  PeriodReportMock,
  SprintLanesMock,
  WhereWorkMock,
} from '../components/mock/reports';
import './reporting.css';

// ---------------------------------------------------------------------------
// "Reporting and metrics": the reporting highlights in the home page's board
// style (src/board.css). Page-only layout lives in ./reporting.css, scoped under
// `.lb.rep`.
//
// Every sentence here was checked against the code (the reporting window, period
// reports, Chronology, flow metrics, Bots Monitoring, This Sprint). The pictures
// are HTML mocks of those screens (components/mock/reports.tsx) on the fictional
// Acme data (src/mock/acme.ts): real text, readable on a phone.
//
// Running order: header · one window · period reports · Chronology (+ the
// measured proof figures, then hours saved in dollars) · over time · where the work is · bots · This Sprint ·
// run it.
// ---------------------------------------------------------------------------

/** A product mock on a quiet tile. */
function Shot({ className = '', children }: { className?: string; children: ReactNode }): JSX.Element {
  return <div className={`tile shot rise ${className}`.trim()}>{children}</div>;
}

function RunIt(): JSX.Element {
  return (
    <section className="section board r-close" aria-labelledby="r-run-h">
      <div className="tile lapis r-flank rise"></div>
      <div className="tile gold r-mid rise">
        <h2 id="r-run-h">See your own numbers</h2>
        <p>One command. No account.</p>
        <p className="btns">
          <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
        </p>
        <code>{INSTALL_COMMAND}</code>
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

      {/* ---- 1. one window: split text / mock --------------------------- */}
      <section className="section board r-split" aria-labelledby="r-win-h">
        <div className="tile r-txt rise">
          <h2 id="r-win-h">One stated window</h2>
          <p>
            Reports' headline figures cover one window: this sprint so far if you work in sprints, otherwise the last 7 or
            14 days. Anything else, such as right now or the last 12 weeks, says so in its heading.
          </p>
          <p className="muted">Each tile opens the pull requests behind its figure.</p>
        </div>
        <Shot className="r-wide">
          <FlowMetricsMock />
        </Shot>
      </section>

      {/* ---- 2. period reports: full-width mock + a row of three -------- */}
      <section className="section r-period" aria-labelledby="r-per-h">
        <div className="r-chap">
          <h2 id="r-per-h">Every sprint or month on one chart</h2>
          <p>
            Fifteen measures for each sprint of the last 12 weeks, or each month of the last 6. Compare any of them on one
            chart, as the change from their first period.
          </p>
        </div>
        <div className="board">
          <Shot className="r-full">
            <PeriodReportMock />
          </Shot>
          <div className="tile r-fact rise">
            <b>Stays the same</b>
            <p>Every figure counts only what happened inside its window, so a period reads the same next month.</p>
          </div>
          <div className="tile r-fact rise">
            <b>Same repositories</b>
            <p>Every period is measured over the repositories tracked since the first one shown, so adding a repo isn't growth.</p>
          </div>
          <div className="tile r-fact rise">
            <b>No guessing</b>
            <p>No projection for calendar months: they aren't the same length. Where the data can't support a number, it says so.</p>
          </div>
        </div>
      </section>

      {/* ---- 3. Chronology: the mock, then the proof figure ------------- */}
      <section className="section board r-chron" aria-labelledby="r-chr-h">
        <div className="tile r-txt rise">
          <h2 id="r-chr-h">Where every hour goes</h2>
          <p>
            Every hour a pull request is open belongs to someone: a reviewer, the author, or the merge, once it's
            approved.
          </p>
          <p className="muted">
            Counted in your team's working hours, against time budgets you can change. Bots never move the ball. Pull
            requests opened by automation, or that no person touched, are left out, and the page says how many.
          </p>
        </div>
        <Shot className="r-wide">
          <ChronologyMock />
        </Shot>
        <div className="tile lapis r-big rise">
          <p className="r-fig">
            42 min<span> to merge half of pull requests in October, from about 7 h in September</span>
          </p>
        </div>
        <div className="tile r-proof rise">
          <h3>Faster reviews, fewer bottlenecks</h3>
          <p>
            On a nine-repository delivery team, Limn took over the reviews in October. Half of their pull requests now merge
            within an hour of working time, and twice as many land each week. It cost them nothing extra.
          </p>
          <p className="src">
            Measured by Limn's Chronology report: merged pull requests by people, working hours, September vs October 2026 after
            Limn auto-review introduced.
          </p>
        </div>
        <div className="tile madder r-usd rise">
          <h3>Hours saved, in dollars</h3>
          <p>
            Add an optional hourly cost and the working hours saved also read as an estimate in US$. Until you set one,
            it stays blank.
          </p>
        </div>
      </section>

      {/* ---- 4. over time: mock left, text right ------------------------ */}
      <section className="section board r-split r-flip" aria-labelledby="r-ot-h">
        <Shot className="r-wide">
          <OverTimeMock />
        </Shot>
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
          <Shot className="r-full">
            <WhereWorkMock />
          </Shot>
        </div>
      </section>

      {/* ---- 6. bots: big claim tile + two mocks ------------------------ */}
      <section className="section board r-bots" aria-labelledby="r-bot-h">
        <div className="tile verdigris r-bclaim rise">
          <h2 id="r-bot-h">What your bots are worth</h2>
          <p>Bot comments graded nit, minor, major or critical by Limn's own model, on your own machine.</p>
          <p>
            On 300 bot comments, the model agreed with an independent grader 70% of the time. CodeRabbit&rsquo;s own label
            agreed 47% of the time, on the ones it labelled.
          </p>
          <p>What each bot costs per comment your team acted on.</p>
        </div>
        <Shot className="r-bshot">
          <BotsSeverityMock />
        </Shot>
        <div className="tile r-btxt rise">
          <p>
            How each bot compares with the same bot in similar-sized public repositories, or a plain sentence saying why it
            can't. Cost is per workspace and never added up across workspaces.
          </p>
          <p>For a bot whose comments your team rarely acts on, it says what turning it off would save in a year.</p>
        </div>
        <Shot className="r-bshot2">
          <BenchmarkMock />
        </Shot>
      </section>

      {/* ---- 7. This Sprint: full-width mock under a chapter ------------ */}
      <section className="section r-sprint" aria-labelledby="r-sp-h">
        <div className="r-chap">
          <h2 id="r-sp-h">This Sprint</h2>
          <p>
            The sprint by theme, critical path or person, on your tracker's own status columns. Jira, Linear or GitHub
            Issues. Limn writes nothing back.
          </p>
          <p className="muted">Themes and critical paths are written by your own AI agent.</p>
        </div>
        <div className="board">
          <Shot className="r-full">
            <SprintLanesMock />
          </Shot>
        </div>
      </section>

      <RunIt />
    </div>
  );
}

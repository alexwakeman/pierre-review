import type { DocMeta } from '../../types';
import { FlowMetricsMock, PeriodReportMock, WhereWorkMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, Kbd, Note, Steps, Tip, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the Overview',
  summary: 'The Overview tab: flow metrics for the reporting window, one chart over every period, and where the work is happening.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Reports</Ui> is where Limn measures how your team’s work flows. It opens on the <Ui>Overview</Ui> tab. The
        tab answers three questions for the workspace you have selected: how this window compares with the one
        before it, how the last few sprints or months compare with each other, and which repositories the work is
        in. Every figure is counted from your GitHub data. No AI writes or changes a number on this tab.
      </p>

      <WhoItHelps
        developer="See whether reviews come faster or slower than last sprint, and open the pull requests behind any figure to find the ones that waited."
        manager="Get a sprint-over-sprint view of throughput, review speed and CI health that you can check pull request by pull request, and copy into a report."
      />

      <p>
        Reports covers every repository in the workspace. The repository picker on the <Ui>Timeline</Ui> does not
        narrow it. To measure a different set of repositories, switch workspace (see{' '}
        <DocLink to="getting-started/workspaces">Workspaces</DocLink>). The tabs along the top are{' '}
        <Ui>Overview</Ui>, <Ui>Chronology</Ui>, <Ui>Stories</Ui> and, while AI is on, <Ui>AI usage</Ui>. Press{' '}
        <Kbd>1</Kbd> to <Kbd>4</Kbd> to switch between them.
      </p>

      <H2 id="flow-metrics">Flow metrics</H2>
      <p>
        The first block is <Ui>Flow metrics</Ui>. Its five tiles cover the workspace’s{' '}
        <DocLink to="reports/reporting-window">reporting window</DocLink>, which the heading names, for example{' '}
        <Ui>This sprint so far</Ui> or <Ui>Last 14 days</Ui>. Each tile compares the window with the earlier one
        named beside the heading. Select a tile to open the pull requests behind its figure. The picture below is a
        working model with made-up data: select a tile to try it.
      </p>
      <FlowMetricsMock />
      <ul>
        <li>
          <Ui>Merged</Ui>: how many pull requests merged in the window.
        </li>
        <li>
          <Ui>Time to merge</Ui>: the median time from opened to merged, for pull requests merged in the window.
        </li>
        <li>
          <Ui>Time to first review</Ui>: the median time from opened to the first review, for pull requests opened in
          the window that have had a review.
        </li>
        <li>
          <Ui>Checks green at merge</Ui>: the share of merged pull requests whose checks were green when they merged.
        </li>
        <li>
          <Ui>Time to fix red checks</Ui>: the median time from checks going red to green again.
        </li>
      </ul>
      <p>
        When either window has fewer than three pull requests behind a figure (or fewer than three fixes, for{' '}
        <Ui>Time to fix red checks</Ui>), the tile shows the earlier value, “was …”, instead of an up or down arrow.
        A small sample does not get a trend arrow.
      </p>

      <H3 id="right-now">Right now</H3>
      <p>
        Two tiles sit apart under <Ui>Right now</Ui> because they are not tied to the window.{' '}
        <Ui>Open pull requests</Ui> counts what is open at this moment, drafts not counted; select it to see the
        list. <Ui>Red checks now</Ui> counts open pull requests whose checks are red, with how long they have been red
        (counted from the pull request’s last commit).
      </p>

      <H3 id="last-12-weeks">Last 12 weeks</H3>
      <p>
        Under <Ui>Last 12 weeks</Ui> are weekly charts: <Ui>Reviews and comments per merged pull request</Ui> (people
        and bots drawn apart), <Ui>Pull requests opened and merged</Ui> and <Ui>Time to fix red checks</Ui>. Open{' '}
        <Ui>More charts</Ui> for the rest: failing checks, time to merge, checks green at merge, changes requested,
        review coverage (human-reviewed, bot-only and unreviewed merges), rework after review, time to resolve
        threads and time from review request to first review. These charts always cover 12 weeks, so they span more
        than one reporting window.
      </p>

      <H2 id="where-the-work-is-happening">Where the work is happening</H2>
      <p>Two cards show the same window, split by repository.</p>
      <WhereWorkMock />
      <ul>
        <li>
          <Ui>Activity by repository</Ui>: pull requests opened in the window, split into those opened by people and
          those opened by automation, and the lines changed on them. Each column has its own scale, so compare bars
          down a column, never across the two.
        </li>
        <li>
          <Ui>Reach by repository</Ui>: every pull request merged in the window, by how far its change could reach:
          Low, Medium or High. This is the same estimate as the{' '}
          <DocLink to="pull-request/blast-radius">blast radius</DocLink> chip on a pull request, and it is a guess.
          The levels follow the sensitivity you set in{' '}
          <DocLink to="settings/pull-requests">Settings → Pull requests</DocLink>.
        </li>
      </ul>
      <p>
        Both cards tell you what they leave out. A repository whose lines changed are not known says “size unknown”
        rather than showing zero. A pull request with no reach level yet is not drawn, and a line under the card
        says how many there are. When the list is cut, a line says how many repositories and pull requests are not
        shown, and how many repositories in the workspace had nothing in the window.
      </p>

      <H2 id="period-reports">Period reports</H2>
      <p>
        <Ui>Period reports</Ui> puts every completed period on one chart, one band per period, so you can see a
        trend rather than one comparison. The band for the period still in progress is hatched and shows a
        projection.
      </p>
      <PeriodReportMock />
      <Steps>
        <li>
          Choose a <Ui>Grain</Ui>: <Ui>Sprint</Ui> (the last 12 weeks, at the workspace’s sprint length) or{' '}
          <Ui>Month</Ui> (the last 6 calendar months). Months have no projection, because they are not all the same
          length.
        </li>
        <li>
          Choose <Ui>Show as</Ui>: <Ui>Change</Ui> draws each metric as the change from its first period with enough
          data, so metrics of any size share one chart. <Ui>Values</Ui> draws the figures, one chart per unit.
        </li>
        <li>Select the metric chips to add or remove lines.</li>
        <li>Hover over or tap a band for its figures. Select a band to see its effort versus automation.</li>
        <li>Press the copy button to copy the periods as Markdown, for a sprint report or a wiki page.</li>
      </Steps>
      <p>
        The metrics include <Ui>Merged PRs</Ui> and, under it, <Ui>…by people</Ui> (merges without dependency bumps,
        code agents and release bots), <Ui>Automation share of merges</Ui>, <Ui>Lead time</Ui>,{' '}
        <Ui>Time to first review by a person</Ui> (bot approvals do not count), <Ui>Merge CI success</Ui>,{' '}
        <Ui>PR size</Ui> and its people-only twin, <Ui>Review threads opened</Ui>,{' '}
        <Ui>Threads replied within 36h</Ui>, <Ui>Bot review comments</Ui>, <Ui>Human review comments</Ui>,{' '}
        <Ui>Bot comments per merged PR</Ui> and <Ui>Reviewer concentration</Ui> (the share taken by the busiest
        human reviewer). A metric with too little data in every period says so, rather than drawing a flat line.
      </p>
      <H3 id="effort-vs-automation">Effort vs automation</H3>
      <p>
        Below the chart, <Ui>Effort vs automation</Ui> splits the selected period’s merged pull requests, review
        comments and approvals by who did them: <Ui>People</Ui>, <Ui>Code agents</Ui>, <Ui>Dependency bots</Ui>,{' '}
        <Ui>Limn</Ui>, <Ui>AI review</Ui>, <Ui>Quality gates & CI</Ui>, <Ui>Release automation</Ui> and{' '}
        <Ui>Housekeeping</Ui>. Only the groups that did something are listed. Its headline is one number, for example
        “38% of merges were automated”, which tells you how much of the throughput above is people’s work.
      </p>
      <Note title="Sprint reports need a sprint cadence">
        The <Ui>Sprint</Ui> grain follows the workspace’s sprints. If none is set, the panel says{' '}
        <Ui>Set a sprint cadence first</Ui>. Set one in{' '}
        <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>, or switch to{' '}
        <Ui>Month</Ui>, which needs no setting.
      </Note>

      <H2 id="new-repositories">Why adding a repository does not move the lines</H2>
      <p>
        History is only as complete as the repositories Limn has been tracking. If you add three repositories in
        March, merges “go up” in March even though nobody worked faster. To stop that, every period is measured over
        the same repositories: the ones tracked since the first period shown. A line under the chip row says so, for
        example “4 of 6 repos: the ones tracked across every period.” The <Ui>Effort vs automation</Ui> panel counts
        all repositories and says so in its heading.
      </p>
      <Tip>
        Press <Kbd>⌘K</Kbd> (or <Kbd>Ctrl K</Kbd>) on Reports and type “Flow metrics” to open any tile’s pull
        requests, or “Period reports by month” to switch the grain.
      </Tip>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Every figure on this tab opens the pull requests it counts, says which window it covers and says what it
        leaves out. You can quote a number in a retrospective and show where it came from. For where the time inside
        a pull request goes, read <DocLink to="reports/chronology">Chronology</DocLink>.
      </p>
    </>
  );
}

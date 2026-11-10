import type { DocMeta } from '../../types';
import { ChronologyMock, OverTimeMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, Note, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Chronology',
  summary: 'Where every open hour of a pull request goes: waiting on a reviewer, on the author, or on landing.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every hour a pull request is open, somebody is holding it: a reviewer who has not looked yet, an author who
        owes a reply, or nobody, because it is approved and waiting to merge. <Ui>Chronology</Ui>, the second tab of
        Reports, adds up those hours across the workspace. It shows which wait is the bottleneck, whether each wait
        is inside the time you allow for it, and what the quick pull requests do differently from the slow ones. It
        names no person.
      </p>

      <WhoItHelps
        developer="See whether your pull requests wait mostly for review or mostly for you, and what the quick ones on your team have in common."
        manager="Find out whether the team is short of review time, slow to answer reviews or slow to land approved work, and track whether a change of process helped."
      />

      <H2 id="what-it-measures">What it measures</H2>
      <ul>
        <li>
          <strong>Pull requests a person wrote,</strong> merged in the window you pick. Pull requests opened by
          automation, such as dependency bumps, are not measured here. Bots Monitoring covers them.
        </li>
        <li>
          <strong>Working hours.</strong> The charts count only the working hours set for the workspace, for example
          Monday to Friday, 09:00–17:30 in your time zone. Nights, weekends and days off do not count. Set them under{' '}
          <Ui>Working hours and budgets</Ui> in{' '}
          <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>.
        </li>
        <li>
          <strong>Three waits:</strong> <Ui>With reviewer</Ui> (waiting for a person to look, or to look again),{' '}
          <Ui>With author</Ui> (waiting for the author to answer a review) and <Ui>Waiting to merge</Ui> (approved and
          not merged yet).
        </li>
      </ul>

      <H2 id="choose-the-view-and-window">Choose the view and the window</H2>
      <Steps>
        <li>
          Open <Ui>Reports</Ui> and choose <Ui>Chronology</Ui>.
        </li>
        <li>
          Choose a view. In <Ui>People</Ui>, only people’s reviews and comments move a pull request on; work only a bot
          reviewed counts as merged without a review. In <Ui>People + bots</Ui>, a review or comment by Limn or by an
          AI review bot such as CodeRabbit also counts. Compare the two to see what your review bots change. The
          choice is saved for the workspace.
        </li>
        <li>
          Choose a <Ui>Window</Ui>. The first option is the workspace’s{' '}
          <DocLink to="reports/reporting-window">reporting window</DocLink>; <Ui>30 days</Ui>, <Ui>60 days</Ui> and{' '}
          <Ui>90 days</Ui> are longer views.
        </li>
      </Steps>
      <p>
        In both views, CI, quality gates and housekeeping bots never count, and a push counts whoever made it. Lines
        under the heading say which working hours apply, how many pull requests were measured and what was set aside.
      </p>

      <H2 id="where-the-working-hours-went">Where the working hours went</H2>
      <ChronologyMock />
      <p>
        The aim is equal thirds. A marker shows where the window’s working hours sit between the three waits, with a
        ringed centre: inside the filled ring reads as balanced; past the dashed ring, one wait dominates. One very
        slow pull request can move the marker a long way, so the bar beside it gives the split as percentages.
      </p>
      <p>
        The target leaves out pull requests approved on their first review, with no changes asked for. They never
        wait for their author, so they would pull every team away from the centre. A green number counts them, with
        a line showing that count week by week.
      </p>

      <H2 id="each-wait-against-its-budget">Each wait against its time budget</H2>
      <p>
        Four waits are measured against a budget you set: <Ui>First look</Ui> (opened to the first human review or
        comment), <Ui>Reply to review</Ui> (review to the author’s answer), <Ui>Approved to merged</Ui> and{' '}
        <Ui>Opened to merged</Ui>. Each bar ends where three in four pull requests had finished that wait; a dot marks
        half, and a thin line runs on to nine in ten. The dashed line is the budget. The verdicts are{' '}
        <Ui>Within budget</Ui>, <Ui>Acceptable</Ui>, <Ui>Past limit</Ui> and, with too few pull requests,{' '}
        <Ui>Too few to judge</Ui>.
      </p>
      <p>
        Above the budgets, <Ui>Review target</Ui> gives the share of merged pull requests whose first review came
        within the good mark of the first-look budget. Pending uses the same target: a review that has waited longer
        says “Over the review target”.
      </p>

      <H2 id="the-detail">The detail below</H2>
      <ul>
        <li>
          <Ui>Every pull request</Ui>: one dot per merged pull request, by the day it merged and the working hours it
          was open. Colour shows which wait took most of its time; bigger dots changed more lines. Select a dot to open
          the pull request. A table lists the same pull requests for keyboard and screen-reader users.
        </li>
        <li>
          <Ui>What the quick ones do differently</Ui>: the quickest quarter against the slowest quarter, by size and by
          the day they opened. <Ui>Clear difference?</Ui> says <Ui>Yes</Ui>, <Ui>Slight</Ui> or <Ui>No</Ui>.
        </li>
        <li>
          <Ui>Approved, waiting to merge</Ui>: pull requests that waited more than a working day after approval,
          longest first, with any pull requests on the same ticket in other repositories that merged while they
          waited.
        </li>
        <li>
          <Ui>Who gives the first review</Ui>: for each repository, how many people give first reviews and how much
          the busiest one does. A high share is a cover risk for when that person is away. Nobody is named.
        </li>
        <li>
          <Ui>Asking for a review</Ui>: whether pull requests asked a named person, a team or nobody first, and how
          long each took to get a first look.
        </li>
        <li>
          <Ui>By repository, in clock hours</Ui>: a repository is called out only when one wait holds a large share of
          its time <em>and</em> its pull requests are slow. The rest are under <Ui>Nothing stands out</Ui>. Clock hours
          here, because the rule was set on them.
        </li>
        <li>
          <Ui>Merged without a human review</Ui>: repositories where pull requests a person wrote merged with no
          review, comment or approval from a person. This is a branch protection setting, not a habit.
        </li>
      </ul>

      <H3 id="pointers">Pointers</H3>
      <p>
        While AI is on, <Ui>Write pointers</Ui> asks AI for patterns, examples worth copying and things to try, from
        the pull requests on the page. Each pointer links the pull requests it is based on; one that cites none is
        dropped. Pointers name no one and contain no figures: every figure on this page is measured. Nothing is
        written until you press the button.
      </p>

      <H2 id="over-time">Over time</H2>
      <p>
        <Ui>Over time</Ui> repeats the split and the budgets week by week for the last 26 weeks, by the week each pull
        request merged. Weeks with too few pull requests are drawn faint and left out of every comparison.
      </p>
      <OverTimeMock />
      <ul>
        <li>
          <strong>Markers</strong> show when something first happened: a repository joined, a bot or a person was seen
          for the first time, or a setting changed. A dashed marker is a shift the numbers show on their own.
        </li>
        <li>
          <strong>Before and after:</strong> select a marker above the first chart to compare the weeks before it with
          the weeks after.
        </li>
        <li>
          <strong>Working hours saved</strong> against a baseline (the first eight usable weeks). Set an{' '}
          <Ui>Hourly cost $</Ui> to see the hours in dollars. The cost is kept on your computer, for this workspace
          only.
        </li>
      </ul>
      <Warning title="Hours saved is an estimate">
        The hours-saved figure prices an estimate. It is not money that left a budget, and a new repository can move
        it without anything changing in how people work. Check the repository markers before you quote it.
      </Warning>
      <Note>
        Chronology is worked out from your stored GitHub history. History older than Limn keeps is not counted, so the
        earliest weeks may be thin.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        “Reviews are slow” and “authors are slow” need different fixes. Chronology tells you which one you have,
        whether it is getting better, and which repositories cause it, without ranking people. For the headline flow
        figures, see <DocLink to="reports/overview">Read the Overview</DocLink>.
      </p>
    </>
  );
}

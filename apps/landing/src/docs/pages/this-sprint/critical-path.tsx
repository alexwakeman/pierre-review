import type { DocMeta } from '../../types';
import { Card, DocLink, FindingRow, H2, H3, Illustration, MiniTable, Note, Pill, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'The Critical path view',
  summary:
    'The chains of tickets that decide when the sprint can finish, how far the sprint has got, and the call-outs that need a look.',
};

function PathLane(): JSX.Element {
  return (
    <Illustration
      label="One critical path: a high-risk chain of three ledger tickets, with a line of advice, above the pace figures for the sprint"
      caption="A critical path lane: the risk as a word, a short title, one sentence of advice, then its tickets in their columns."
      title="Payments Sprint 24"
      meta="day 10 of 14"
    >
      <MiniTable
        cols={[
          { key: 'k', label: 'Pace' },
          { key: 'v', label: 'So far', num: true },
        ]}
        rows={[
          { _key: 'd', k: 'Day', v: '10 of 14' },
          { _key: 'm', k: 'Code merged', v: '9 of 18' },
          { _key: 'p', k: 'Product review', v: '4 of 18' },
          { _key: 'c', k: 'Complete', v: '5 of 18' },
          { _key: 'o', k: 'Open dependencies', v: '3 in 2 chains' },
        ]}
      />
      <Card title="Ledger move must land first" chip={<Pill tone="red">High risk</Pill>}>
        <p>Finish the table rename before the nightly job is retired, or the export reads the old tables.</p>
        <FindingRow chip="In progress">PAY-146 Rename ledger tables</FindingRow>
        <FindingRow chip="Not started" tone="amber">
          PAY-158 Retire the nightly ledger job — waits on PAY-146
        </FindingRow>
      </Card>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Critical path</Ui> view answers &ldquo;what decides when this sprint can finish?&rdquo;. It shows the
        sprint&rsquo;s pace in plain counts, then the chains of tickets that wait on each other, ranked by how much
        risk they put on the sprint, then a short list of things worth a look.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <PathLane />

      <H3 id="the-pace">The pace</H3>
      <p>
        A strip of figures, each with what it counts: the day of the sprint with a bar for time used, how many
        tickets have their code merged, how many are in Product review (when you have that column), how many are
        complete, and how many open dependencies there are in how many chains. Limn counts all of these from the
        tracker and GitHub. AI does not write any number on this page.
      </p>

      <H3 id="critical-paths">Critical paths</H3>
      <p>
        Up to five paths, each one a row of the board. A path is an ordered chain of tickets where one waits on the
        next. Each row has:
      </p>
      <ul>
        <li>
          The risk as a word: <Ui>High risk</Ui>, <Ui>Medium risk</Ui> or <Ui>Low risk</Ui>.
        </li>
        <li>A short title and one sentence of advice.</li>
        <li>The path&rsquo;s tickets in their status columns, with the arrows between them drawn as critical.</li>
      </ul>
      <p>
        A ticket on a path that is not in the sprint sits in an extra column on the left, <Ui>Outside the sprint</Ui>
        . That is often the most important card on the page: work your sprint waits on that nobody planned for this
        sprint.
      </p>
      <Note>
        AI chooses the paths, their order, the titles and the advice from what Limn found: the tickets, their
        status, their pull requests and the links between them. It is a judgement, not a schedule. The arrows,
        columns and figures are Limn&rsquo;s own.
      </Note>

      <H3 id="call-outs">Call-outs</H3>
      <p>Under the paths, a short list of tickets worth a look. Each call-out has its ticket keys as buttons.</p>
      <ul>
        <li>
          Up to three from AI, marked <Ui>Call-out</Ui>.
        </li>
        <li>
          Limn&rsquo;s own, from what it has stored: <Ui>Since you last looked</Ui> (tickets that changed column, tickets
          added and pull requests merged since your last visit), <Ui>Out of step</Ui> (the tracker and the code
          disagree: in code review with no open pull request, Complete with one still open, or Not started with one
          open) and <Ui>Blocked outside the sprint</Ui> (sprint tickets that wait on an unfinished ticket outside
          the sprint).
        </li>
      </ul>

      <H3 id="the-count-table">The count table</H3>
      <p>
        At the bottom, <Ui>Every ticket, by theme and column</Ui>: every sprint ticket once, counted by theme and
        status column, with totals. It does not change with the filters.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Select a ticket on a path, or a key in a call-out, to read its story in the panel on the right.</li>
        <li>Hover over an arrow, or its number, to read why one ticket waits on the other.</li>
        <li>
          Press <Ui>Refresh</Ui> after a big change in the tracker. The paths are worked out again after the next
          sprint read, and the line under the heading says &ldquo;Working out the critical paths…&rdquo; while that
          runs. Older paths stay on screen, marked <Ui>Updating</Ui>, until the new ones arrive.
        </li>
      </Steps>

      <H2 id="when-there-are-no-paths">When there are no paths</H2>
      <ul>
        <li>The sprint needs at least 4 tickets.</li>
        <li>With AI off, the page says there are no critical paths. The pace, call-outs and table still show.</li>
        <li>
          When AI finds no chain worth naming, the heading reads &ldquo;No critical paths in this sprint.&rdquo;
        </li>
        <li>
          If a run fails, the page says why and when Limn tries again. It does not try again until the sprint
          changes.
        </li>
      </ul>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Most late sprints are late because of a chain, not a single ticket: a rename that a migration waits on, that
        a release waits on. A status board shows each ticket alone. This view puts the chain in one row, names the
        ticket outside the sprint that holds it up, and gives you a few days&rsquo; warning. See also{' '}
        <DocLink to="this-sprint/theme">The Theme view</DocLink> and{' '}
        <DocLink to="this-sprint/people">The People view</DocLink>.
      </p>
    </>
  );
}

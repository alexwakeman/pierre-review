import type { DocMeta } from '../../types';
import { Card, DocLink, FindingRow, H2, Illustration, Note, Pill, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'The People view',
  summary: 'Tickets by assignee, so you can see who has what and whose reviews are waiting.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>People</Ui> view puts the sprint&rsquo;s tickets in one row per assignee. It is for planning and
        stand-ups: who has which tickets and how far each person&rsquo;s tickets have got.
      </p>
      <p>
        To give a ticket to someone else, open it and pick them from the assignee menu (Jira, GitHub Issues and
        Linear). See <DocLink to="this-sprint/story-view#assign-the-ticket">Assign the ticket</DocLink>.
      </p>

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="Two people rows: Priya Nair with two tickets and one review waiting, Tom Becker with one ticket"
        caption="People rows: the person's ticket count and waiting reviews, then their tickets. Each card shows the ticket's theme."
      >
        <Card title="Priya Nair" chip={<Pill>2 tickets · 1 review waiting</Pill>}>
          <FindingRow chip="In progress">PAY-146 Rename ledger tables · Ledger</FindingRow>
          <FindingRow chip="Product review" tone="gold">
            PAY-139 Refund reasons in the export · Refunds
          </FindingRow>
        </Card>
        <Card title="Tom Becker" chip={<Pill>1 ticket</Pill>}>
          <FindingRow chip="Not started" tone="grey">
            PAY-158 Retire the nightly ledger job · Ledger
          </FindingRow>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>One row per person</strong>, in alphabetical order, with <Ui>Unassigned</Ui> last. The order never
          depends on how much a person has.
        </li>
        <li>
          <strong>The row header</strong> says how many tickets the person has and, when Ensemble can match the
          tracker&rsquo;s name to a GitHub account, how many pull-request reviews are waiting on them. When it cannot
          match the name, it says nothing rather than zero.
        </li>
        <li>
          <strong>The colour bar</strong> shows the person&rsquo;s tickets by column. Hover over it to read the
          counts.
        </li>
        <li>
          <strong>Each card shows the ticket&rsquo;s theme</strong> where the other views show the assignee.
        </li>
        <li>
          <strong>No arrows.</strong> A ticket that waits on another unfinished ticket wears the waiting mark. The
          chains between tickets are on the <DocLink to="this-sprint/critical-path">Critical path view</DocLink>.
        </li>
      </ul>
      <Note>
        Names are spelled as the tracker spells them, and the same way on every view. Ensemble matches a tracker name to
        a GitHub account only when the two clearly agree; it never guesses between two people.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Select a card to read its story in the panel on the right.</li>
        <li>
          Turn on <Ui>Has PRs</Ui> to see only the tickets with code in flight.
        </li>
      </Steps>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A stand-up goes person by person. The People view puts each person&rsquo;s tickets and waiting reviews in one
        row, so nobody has to read the whole board to find their own work. For the chains that put the sprint at
        risk, see{' '}
        <DocLink to="this-sprint/critical-path">The Critical path view</DocLink>.
      </p>
    </>
  );
}

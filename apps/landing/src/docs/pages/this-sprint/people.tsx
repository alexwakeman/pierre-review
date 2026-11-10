import type { DocMeta } from '../../types';
import { Card, DocLink, FindingRow, H2, Illustration, Note, Pill, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'The People view',
  summary: 'Tickets by assignee, so you can see who has what, whose reviews are waiting, and who waits on whom.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>People</Ui> view puts the sprint&rsquo;s tickets in one row per assignee. It is for planning and
        stand-ups: who has which tickets, how far each person&rsquo;s tickets have got, and where one person&rsquo;s
        work waits on another&rsquo;s.
      </p>
      <p>
        To give a ticket to someone else, open it and pick them from the assignee menu (Jira, GitHub Issues and
        Linear). See <DocLink to="this-sprint/story-view#assign-the-ticket">Assign the ticket</DocLink>.
      </p>

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="Two people rows: Priya Nair with two tickets and one review waiting, Tom Becker with one ticket that waits on Priya"
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
            PAY-158 Retire the nightly ledger job · Ledger — Tom Becker waits on Priya Nair
          </FindingRow>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>One row per person</strong>, in alphabetical order, with <Ui>Unassigned</Ui> last. The order never
          depends on how much a person has.
        </li>
        <li>
          <strong>The row header</strong> says how many tickets the person has and, when Limn can match the
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
          <strong>Arrows between rows</strong> are hand-offs, read as &ldquo;Tom Becker waits on Priya Nair&rdquo;.
        </li>
      </ul>
      <Note>
        Names are spelled as the tracker spells them, and the same way on every view. Limn matches a tracker name to
        a GitHub account only when the two clearly agree; it never guesses between two people.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Select a card to read its story in the panel on the right.</li>
        <li>Follow an arrow between two rows to see which ticket holds up the other person.</li>
        <li>
          Turn on <Ui>Has PRs</Ui> to see only the tickets with code in flight.
        </li>
      </Steps>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A hand-off between two people is where work most often stalls: one person finishes, the other does not
        know. The People view draws those hand-offs, so they come up in the stand-up rather than at the sprint
        review. For the chains that put the sprint at risk, see{' '}
        <DocLink to="this-sprint/critical-path">The Critical path view</DocLink>.
      </p>
    </>
  );
}

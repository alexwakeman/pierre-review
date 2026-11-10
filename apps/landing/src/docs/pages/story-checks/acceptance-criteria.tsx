import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, H3, Illustration, MiniTable, Note, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Acceptance criteria',
  summary:
    'Where Limn finds a ticket\'s acceptance criteria on each tracker, how the story check judges each one, and what every status means.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Acceptance criteria are the testable parts of a ticket: &ldquo;a partial refund keeps the order
        open&rdquo;, &ldquo;no refunds after 30 days&rdquo;. The story check judges the code against each one. This
        page says where Limn reads them from, what it does when a ticket has none, and what each status on a
        criterion means.
      </p>

      <WhoItHelps
        developer="Know which line of the ticket each verdict is about, and why a criterion reads Can't tell rather than Not met."
        manager="Know that a count like 3 of 4 met is counted from the ticket's own criteria, and that Limn says where it got them."
      />

      <H2 id="where-limn-finds-them">Where Limn finds them</H2>
      <MiniTable
        cols={[
          { key: 't', label: 'Tracker' },
          { key: 'w', label: 'Where the criteria come from' },
        ]}
        rows={[
          {
            _key: 'jira',
            t: 'Jira',
            w: 'The acceptance criteria field you choose for each issue type. "Limn picks" uses the field whose name best matches "Acceptance Criteria".',
          },
          {
            _key: 'gh',
            t: 'GitHub Issues',
            w: 'The issue\'s sub-issues, else a task list in the body, else an "Acceptance criteria" heading in the body.',
          },
          {
            _key: 'linear',
            t: 'Linear',
            w: 'The issue\'s sub-issues, else a task list in the description, else an "Acceptance criteria" heading.',
          },
          {
            _key: 'notion',
            t: 'Notion',
            w: 'The property you map as Acceptance criteria, else a task list or an "Acceptance criteria" heading in the page.',
          },
        ]}
      />
      <p>
        The story check&rsquo;s ticket block says where the criteria came from, for example &ldquo;Criteria from:
        Acceptance Criteria · Change in Settings&rdquo;. On Jira, choose the field in{' '}
        <DocLink to="integrations/jira#choose-the-ticket-fields">Settings → Integrations → Ticket fields</DocLink>. A
        change applies at once to every stored ticket of that type.
      </p>
      <p>
        Criteria can be written any way: bullets, a numbered list, Given/When/Then scenarios, a table or prose. The
        check makes one entry per testable requirement.
      </p>

      <H3 id="a-ticket-with-no-criteria">A ticket with no criteria</H3>
      <p>
        When a ticket has no criteria written, AI works out a short numbered list from the title and description.
        Limn marks these &ldquo;Worked out from the description&rdquo; so nobody mistakes them for the
        ticket&rsquo;s own. It is better to write the criteria in the ticket: the check is only as good as the
        ticket.
      </p>

      <H2 id="what-each-status-means">What each status means</H2>
      <Illustration
        label="The six criterion statuses as chips, each with a one-line example"
        caption="Criterion statuses, as the story check shows them."
      >
        <FindingRow chip="Met" tone="green">
          The code does it, in a pull request the check names.
        </FindingRow>
        <FindingRow chip="Met outside code changes" tone="green">
          No code needed; a person&rsquo;s comment on the ticket says it was done.
        </FindingRow>
        <FindingRow chip="Partly met" tone="amber">
          Some of it is there; the check says what is missing.
        </FindingRow>
        <FindingRow chip="Not met" tone="red">
          It is not in any of the ticket&rsquo;s pull requests.
        </FindingRow>
        <FindingRow chip="Can&rsquo;t tell from the code" tone="grey">
          The code alone cannot show it, or a pull request could not be read.
        </FindingRow>
        <FindingRow chip="Not checked" tone="grey">
          No check has judged it yet.
        </FindingRow>
      </Illustration>
      <ul>
        <li>
          <Ui>Met</Ui>: a pull request delivers it. The check names the pull request (&ldquo;Done in #612&rdquo;)
          and the evidence.
        </li>
        <li>
          <Ui>Met outside code changes</Ui>: no pull request delivers it and none needs to, because a person&rsquo;s
          comment on the ticket says plainly it was done another way: a setting, content, a manual step or a
          decision. The criterion shows &ldquo;Per Dana Wu&rsquo;s comment, 4 Mar&rdquo;, which opens that comment.
          See <DocLink to="story-checks/ticket-comments">Ticket comments</DocLink>.
        </li>
        <li>
          <Ui>Partly met</Ui>: part of it is in the code; the check says which part is not.
        </li>
        <li>
          <Ui>Not met</Ui>: it is not in the code. The check says which pull request it belongs in (&ldquo;Code
          in&rdquo; or &ldquo;Where this belongs&rdquo;), so you can post it there as a gap.
        </li>
        <li>
          <Ui>Can&rsquo;t tell from the code</Ui>: the code cannot answer it (a wording decision, a visual detail), or
          one of the pull requests could not be read. Limn never turns &ldquo;could not look&rdquo; into &ldquo;not
          met&rdquo;.
        </li>
        <li>
          <Ui>Not checked</Ui>: no check has run since the criterion appeared.
        </li>
      </ul>

      <H2 id="how-the-counts-work">How the counts work</H2>
      <p>
        &ldquo;Met&rdquo; and &ldquo;Met outside code changes&rdquo; both count as done, but they are counted apart,
        for example &ldquo;4 met + 1 outside code of 6&rdquo;. Partly met, Not met and Can&rsquo;t tell all count as
        not done. The number on a This Sprint card comes from the same latest check.
      </p>
      <Note>
        A verdict is AI&rsquo;s reading of the code against the ticket. Each one names its evidence so you can check
        it. A &ldquo;Met outside code changes&rdquo; verdict stands only when the comment it cites is a real
        comment by a person on that ticket; Limn checks that before it shows it.
      </Note>
    </>
  );
}

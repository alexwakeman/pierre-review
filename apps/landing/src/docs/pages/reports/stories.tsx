import type { DocMeta } from '../../types';
import { DocLink, FindingRow, Group, H2, Illustration, MiniTable, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Stories',
  summary: 'How each tracker story moved through review, and where it waited.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Stories</Ui>, the third tab of Reports, looks at your work ticket by ticket instead of pull request by
        pull request. It lists every ticket with at least one pull request merged in the{' '}
        <DocLink to="reports/reporting-window">reporting window</DocLink>, how long the work took, how big it was, and
        whether its latest ticket review found the acceptance criteria met.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <p>
        An issue tracker connected to the workspace: Jira, GitHub Issues, Linear or Notion. The tracker links a ticket
        to its pull requests. Without one, the tab says <Ui>Stories needs an issue tracker</Ui>. Set it up in{' '}
        <DocLink to="settings/integrations">Settings → Integrations</DocLink>. The “met” verdicts come from ticket
        reviews; see <DocLink to="story-checks/overview">Story checks</DocLink>.
      </p>

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The Stories tab: a Time and pull requests chart with three tickets, then the lists: 1 fell short, 1 not reviewed"
        caption="Stories: working time and pull requests per ticket, then the tickets sorted by what their ticket review found."
      >
        <Group first>Time and pull requests</Group>
        <MiniTable
          cols={[
            { key: 't', label: 'Ticket' },
            { key: 'h', label: 'Working time', num: true },
            { key: 'p', label: 'Pull requests', num: true },
          ]}
          rows={[
            { _key: '142', t: 'PAY-142 Partial refunds', h: '4.5 days', p: '3' },
            { _key: '146', t: 'PAY-146 Rename ledger tables', h: '2 days', p: '2' },
            { _key: '139', t: 'PAY-139 Refund reasons in the export', h: '0.5 days', p: '1' },
          ]}
        />
        <Group>All 3 stories · 1 fell short · 1 not reviewed</Group>
        <FindingRow chip="Fell short" tone="amber">
          PAY-142 Partial refunds
        </FindingRow>
        <FindingRow chip="Not reviewed">PAY-139 Refund reasons in the export</FindingRow>
        <FindingRow chip="Reviewed, no gaps" tone="green">
          PAY-146 Rename ledger tables
        </FindingRow>
      </Illustration>
      <ul>
        <li>
          <Ui>Time and pull requests</Ui>: for each ticket, the working time from its first pull request opened to its
          last one merged (in the workspace’s working hours), and how many pull requests it has, open, merged or
          closed. Each column has its own scale.
        </li>
        <li>
          <Ui>Size and criteria</Ui>: one mark per ticket, lines changed across its merged pull requests against how
          many acceptance criteria it has. Tickets that fell short are drawn hollow. A ticket with a pull request of
          unknown size is listed under the chart (<Ui>Size unknown</Ui>), not drawn; a ticket with no criteria is
          listed under <Ui>No criteria found</Ui>.
        </li>
        <li>
          The lists: <Ui>Fell short</Ui> (the latest ticket review found criteria not met, partly met or missing),{' '}
          <Ui>Not reviewed</Ui> (no ticket review yet) and <Ui>Reviewed, no gaps</Ui>. Open{' '}
          <Ui>All n stories</Ui> to see them; the split is shown before you open it.
        </li>
      </ul>
      <p>
        The criteria count comes from the latest ticket review if there is one, else from the ticket’s criteria
        field, else from bullets under an “Acceptance criteria” heading in the ticket’s description.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open <Ui>Reports</Ui> and choose <Ui>Stories</Ui>.
        </li>
        <li>Select a ticket’s name to open it, with its pull requests, in a tab.</li>
        <li>Use the link beside a ticket to open it in your tracker.</li>
        <li>
          For a ticket under <Ui>Not reviewed</Ui>, open it and run a ticket review from the story view.
        </li>
      </Steps>
      <Note>
        When a window holds more tickets than the tab can list, a line says it shows the latest ones and that earlier
        ones are not listed.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Merged pull requests tell you code landed. Stories tells you whether the thing the ticket asked for was
        delivered, and it marks the tickets nobody checked, so a “done” column is not taken on trust.
      </p>
    </>
  );
}

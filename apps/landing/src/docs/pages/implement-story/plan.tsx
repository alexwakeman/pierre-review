import type { DocMeta } from '../../types';
import { Btn, Card, Chip, DocLink, FindingRow, Group, H2, H3, Illustration, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Plan the work',
  summary: 'The plan lists what the agent will do and the questions it has, with the evidence for each.',
};

function PlanPicture(): JSX.Element {
  return (
    <Illustration
      label="The plan for PAY-142. Acceptance criteria 1 and 4 are Planned, criterion 2 is Already met. One point to settle: the story says no refunds after 30 days, but the payments handbook section 4.2 counts working days; evidence is the handbook section and refunds/policy.py lines 10 to 14. Buttons Agree, Keep the story and Reply. Two pull requests are planned. An Approve and start button."
      caption="The plan: each criterion, the points to settle with their evidence, the pull requests, then Approve and start."
      title="The plan"
      meta="PAY-142 Partial refunds"
    >
      <Group first>Acceptance criteria</Group>
      <FindingRow chip="Planned" tone="blue">AC1 Partial refund keeps the order open</FindingRow>
      <FindingRow chip="Already met" tone="green">AC2 Customer gets one email</FindingRow>
      <FindingRow chip="Planned" tone="blue">AC3 No refunds after 30 days</FindingRow>
      <Group>Points to settle (0 of 1 answered)</Group>
      <Card title="30 days or 30 working days?" chip={<Chip tone="amber">AC3</Chip>}>
        The story says: no refunds after 30 days. Evidence: Payments handbook §4.2 · refunds/policy.py lines 10–14.
      </Card>
      <p>
        <Btn>Agree</Btn> <Btn>Keep the story</Btn> <Btn>Reply</Btn>
      </p>
      <Group>The pull requests</Group>
      <FindingRow chip="P1">acme/payments · refund window check</FindingRow>
      <FindingRow chip="P2">acme/payments · partial refund state · Builds on P1</FindingRow>
      <p>
        <Btn tone="go">Approve and start</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every Implement session starts with a plan. The agent reads the ticket, the code, the data and the reference
        documents that help with the ticket (it says which it used), and says what it will build, where, and where it thinks the story is wrong or unclear. Limn
        checks every piece of evidence in the plan before you see it. Nothing is built until you approve the plan.
      </p>

      <H2 id="what-the-plan-holds">What the plan holds</H2>
      <PlanPicture />
      <ul>
        <li>
          <b>The repositories</b> it will change.
        </li>
        <li>
          <b>Each acceptance criterion</b>, in the ticket's order: <Ui>Planned</Ui>, <Ui>Already met</Ui> or{' '}
          <Ui>Not planned</Ui>.
        </li>
        <li>
          <b>Points to settle</b>: each place where the agent says the story is wrong, unclear, or does not match the
          code, the docs or the data. Each says what the story says, what the agent suggests, and its evidence.
        </li>
        <li>
          <b>The pull requests</b>: the agent splits the work so each pull request is smaller to review, at most three per
          repository and six in all. Each one must build and pass its tests on its own. In one repository, each builds on
          the one before it.
        </li>
        <li>
          <b>A ticket update (draft)</b>, when the story needs work.
        </li>
      </ul>

      <H2 id="evidence">Evidence Limn checks</H2>
      <p>
        <Ui>Limn checks every piece of evidence itself. A point it cannot check is left out.</Ui> Evidence can be lines in
        the code as they were when the session started, a section of a reference document, a data file (a fixture, seed
        data, a schema or a migration) or a query the agent ran against a sandbox service and Limn saw run. Nothing comes
        from production. When Limn removes something, one line says how much, for example "Limn left out 1 point it could
        not check."
      </p>

      <H2 id="settle-the-points">Settle the points</H2>
      <p>For each point, press one of:</p>
      <ul>
        <li>
          <Ui>Agree</Ui>: build what the agent suggests.
        </li>
        <li>
          <Ui>Keep the story</Ui>: build what the story says.
        </li>
        <li>
          <Ui>Reply</Ui>: tell the agent what you think. It revises the plan.
        </li>
      </ul>
      <p>
        The heading counts your answers, for example <Ui>Points to settle (2 of 3 answered)</Ui>. You can also talk to the
        agent freely in the conversation: <Ui>Ask a question, or tell the agent what to change in the plan.</Ui> When a
        reply changes the plan, Limn says <Ui>The plan changed. Look at the new revision.</Ui> Earlier revisions stay
        readable. Your answers carry to a new revision while the point is unchanged.
      </p>
      <Note>
        In this stage the agent reads and runs commands but does not change files. If the plan cannot be used, the tab
        says <Ui>The plan did not pass Limn's checks.</Ui> and the agent is asked once to repair it.
      </Note>

      <H2 id="update-the-ticket">Update the ticket</H2>
      <p>
        After planning, <Ui>The ticket</Ui> shows the whole ticket in two boxes: the description and the acceptance criteria.
        Each box starts with the agent&rsquo;s draft, or with the ticket&rsquo;s current text when the plan does not change
        it. The agent must write a draft when it raises a point to settle or does not plan a criterion, and it keeps the
        ticket&rsquo;s layout: the same headings in the same order, the same list style, and GIVEN / WHEN / THEN when the
        ticket uses it.
      </p>
      <p>
        Change the text as you like. In each box, the words that differ from the ticket are highlighted, in the same
        colour as a quote from your reference docs. Under each box, <Ui>What changes</Ui> shows the lines that differ from the ticket, and
        a note says where the text no longer keeps the ticket&rsquo;s layout. The notes are advice; you decide.
      </p>
      <Warning>
        On a Jira ticket, <Ui>Update ticket</Ui> writes only the boxes that change, after it asks once. The acceptance
        criteria go where the ticket keeps them: their own field, in that field&rsquo;s format, or the criteria section
        of the description. <Ui>Approve and start</Ui> then reads the ticket again. For other trackers, copy the text in
        yourself. See <DocLink to="integrations/jira">Jira</DocLink>.
      </Warning>

      <H2 id="approve-and-start">Approve and start</H2>
      <Steps>
        <li>Answer every point to settle.</li>
        <li>
          Press <Ui>Approve and start</Ui>. Limn reads the ticket again and the agent switches to building.
        </li>
        <li>
          Watch the build. <Ui>The agent then builds to the end. You can stop it or message it.</Ui>
        </li>
      </Steps>
      <H3 id="approve-automatically">Approve automatically</H3>
      <p>
        Tick <Ui>Approve the plan automatically</Ui> at Start, or in the build tab before the plan is ready. When the plan
        is ready, Limn takes every point as <Ui>Agree</Ui>, approves it and starts the build. The agent builds the plan as
        revised, its acceptance criteria included.
      </p>
      <ul>
        <li>The ticket is not changed.</li>
        <li>
          When the pull request is open, the build tab shows the ticket changes the plan suggested. Press{' '}
          <Ui>Update ticket</Ui> to write them to Jira, or <Ui>No update needed</Ui>.
        </li>
        <li>
          When the AI spend limit is reached, or another build is running, the plan waits for you to press{' '}
          <Ui>Approve and start</Ui>.
        </li>
      </ul>
      <H3>What the build reports</H3>
      <p>
        When the build ends, <Ui>The agent says</Ui> gives, per pull request, <Ui>Done</Ui>, <Ui>Partly done</Ui> or{' '}
        <Ui>Not done</Ui>, a summary, and the checks it ran (<Ui>Passed</Ui>, <Ui>Failed</Ui> or <Ui>Not run</Ui>), and per
        criterion whether it is met. This is the agent's own account, not a gate: read the diff. If the agent ran out of
        steps with work unfinished, Limn asks it to carry on, at most twice.
      </p>
      <p>
        Then push the result: see <DocLink to="implement-story/push">Push the result</DocLink>.
      </p>
    </>
  );
}

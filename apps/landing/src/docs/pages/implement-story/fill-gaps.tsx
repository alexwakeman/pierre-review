import type { DocMeta } from '../../types';
import { Btn, DocLink, FindingRow, H2, Illustration, Note, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Fill gaps',
  summary: 'When a story check finds gaps in a ticket that is under way, Fill gaps builds just those gaps in a sandbox.',
};

function GapsPicture(): JSX.Element {
  return (
    <Illustration
      label="The Fill gaps build tab for PAY-142. It lists the gaps the story check found: criterion 3 not met, criterion 2 partly met, and a missing audit log entry. Criterion 1 is already met by pull request 612. A Fill gaps button."
      caption="Fill gaps lists the gaps up front, from the latest story check."
      title="PAY-142 Partial refunds"
      meta="Fill gaps"
    >
      <FindingRow chip="Not met" tone="red">AC3 No refunds after 30 days</FindingRow>
      <FindingRow chip="Partly met" tone="amber">AC2 Customer gets one email</FindingRow>
      <FindingRow chip="Missing" tone="amber">An audit log entry for each partial refund</FindingRow>
      <FindingRow chip="Met" tone="green">AC1 Partial refund keeps the order open · #612</FindingRow>
      <p>
        <Btn tone="go">Fill gaps</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A ticket can be under way and still incomplete: the pull requests so far meet some criteria and miss others. When
        the story check finds that, the story view offers <Ui>Fill gaps</Ui>. It is the same session as Implement story,
        but the agent is told what the check found and works only on those gaps.
      </p>
      <WhoItHelps
        developer="Finish a ticket's leftovers without rereading the whole story to find what is missing."
        manager="Partly delivered stories get finished against their criteria, not left with a gap nobody noticed."
      />

      <H2 id="when-it-is-offered">When it is offered</H2>
      <p>On the ticket's story view, in place of <Ui>Implement</Ui>, when all of these hold:</p>
      <ul>
        <li>the ticket has started (it has a pull request, or its status is past "not started") and is not complete;</li>
        <li>there is no open session for it; and</li>
        <li>
          its latest story check is current and found gaps: criteria not met or partly met, unsettled ones, or missing
          pieces.
        </li>
      </ul>
      <p>
        With no story check, or one that is out of date, nothing is offered: run the story check first. A session never
        starts a story check itself. See <DocLink to="story-checks/overview">Story checks</DocLink>.
      </p>

      <H2 id="what-it-builds">What it builds</H2>
      <GapsPicture />
      <p>
        The tab lists the gaps up front. A criterion already met by a pull request is not a gap. A criterion met outside
        the code, by a person's ticket comment, is not a gap either: the agent is told it is already done and not to build
        it. See <DocLink to="story-checks/ticket-comments">Ticket comments</DocLink>.
      </p>

      <H2 id="the-flow">The flow</H2>
      <Steps>
        <li>
          On the story view, press <Ui>Fill gaps</Ui>, or <Ui>Fill gaps with docs</Ui> from the caret when the workspace has
          reference documents.
        </li>
        <li>
          In the build tab, press <Ui>Fill gaps</Ui>. The tab says{' '}
          <Ui>The agent is reading the gaps, the code and the ticket to make a plan.</Ui>
        </li>
        <li>
          Settle the plan as for Implement. The plan covers only the gaps; a gap may not be marked already met. See{' '}
          <DocLink to="implement-story/plan">Plan the work</DocLink>.
        </li>
        <li>
          <Ui>Approve and start</Ui>. The agent builds only the gaps the plan names.
        </li>
        <li>
          Review and push. Each new pull request's description names the gaps it covers. See{' '}
          <DocLink to="implement-story/push">Push the result</DocLink>.
        </li>
      </Steps>
      <Note>
        When a repository already has your own open pull request for the ticket, the new work stacks on it: it branches
        from that pull request and targets its branch. Someone else's open pull request is not stacked on; the new branch
        starts from the default branch, and the tab says so.
      </Note>
    </>
  );
}

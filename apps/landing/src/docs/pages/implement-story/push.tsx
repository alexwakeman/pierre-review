import type { DocMeta } from '../../types';
import { Btn, Chip, Diff, DocLink, H2, H3, Illustration, Note, PrRow, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Push the result',
  summary: 'Check the changes, then push them to a new branch and open the pull request.',
};

function StackPicture(): JSX.Element {
  return (
    <Illustration
      label="The pull requests of the PAY-142 build, in order. P1, the refund window check in acme/payments, is Ready to push. P2, partial refund state, builds on P1 and is Ready to push. Draft is ticked. Buttons Push all (2) and Push as draft."
      caption="Two pull requests, in order. Push them one by one, or Push all."
      title="2 pull requests, in order"
      meta="PAY-142 Partial refunds"
    >
      <p>
        <Chip>☑ Draft</Chip> <Btn tone="go">Push all (2)</Btn>
      </p>
      <PrRow title="P1 · Refund window check" repo="acme/payments" status={<Chip tone="green">Ready to push</Chip>} why="Covers AC3 · tests passed" />
      <Diff
        file="refunds/policy.py"
        lines={[
          { k: '+', t: '    if now() - order.paid_at > settings.REFUND_DAYS:' },
          { k: '+', t: '        return False' },
        ]}
      />
      <PrRow title="P2 · Partial refund state" repo="acme/payments" status={<Chip tone="green">Ready to push</Chip>} why="Builds on P1 · covers AC1" />
      <p>
        <Btn>Push as draft</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When the build ends, each planned pull request has its own diff, ready to review. Nothing has left your computer.{' '}
        <Ui>Push</Ui> sends one pull request's changes to a new branch on GitHub and opens the pull request, from your
        computer, under your GitHub account.
      </p>

      <H2 id="check-the-changes">Check the changes</H2>
      <StackPicture />
      <p>
        The tab lists the pull requests in plan order, each with its status (<Ui>Ready to push</Ui>,{' '}
        <Ui>No changes</Ui>, <Ui>Failed</Ui> or <Ui>Pushed</Ui>), the criteria it covers and its diff. Each pull request's
        diff is against the one before it, so you review only its own changes. Edits the agent made in a repository with no
        planned pull request are listed under <Ui>What Limn left out</Ui>.
      </p>
      <p>
        Not happy? Tell the agent in the conversation: <Ui>Ask for a change. It is a build turn: the agent may edit and
        test.</Ui> The diffs update after the turn.
      </p>

      <H2 id="push">Push</H2>
      <Steps>
        <li>
          Leave <Ui>Draft</Ui> ticked to open each new pull request as a draft (the default), or untick it to open them
          ready for review.
        </li>
        <li>
          Press <Ui>Push</Ui> (or <Ui>Push as draft</Ui>) on the first pull request, then the next. Or press{' '}
          <Ui>Push all</Ui> to push every ready one in order.
        </li>
        <li>
          Open the new pull request from the tab, or find it on <Ui>Open pull requests</Ui> once it syncs.
        </li>
      </Steps>
      <Warning>
        Push writes to GitHub under your name: a new branch, one commit by you, and a new pull request. It never pushes to
        your default branch and never forces. If the branch already exists on GitHub, Push refuses and says so.
      </Warning>

      <H2 id="what-is-pushed">What is pushed</H2>
      <ul>
        <li>
          <b>The branch</b>: <b>limn/</b> and the ticket key, for example <b>limn/PAY-142</b>; a second and third pull
          request in the same repository add <b>-2</b> and <b>-3</b>.
        </li>
        <li>
          <b>The title</b>: the ticket key and title, for example "PAY-142 (1/2): Partial refunds", so your tracker links
          it.
        </li>
        <li>
          <b>The description</b>: a summary, the story, the criteria this pull request covers, the list of parts, what it
          builds on, and your decisions on the story ("Kept the story: …", "Changed from the story: …"). A GitHub Issues
          ticket built in one repository is closed by its last pull request.
        </li>
      </ul>
      <p>What is pushed is exactly what you reviewed: Limn checks the commit matches the reviewed change before it pushes.</p>

      <H2 id="stacks">Pushing a stack</H2>
      <p>
        In one repository, each pull request is based on the branch of the one before it, so push them in order. Push
        refuses a pull request whose previous one is not pushed yet ("Push P1 … first."), or whose previous one was merged
        or closed meanwhile. A pull request that depends on another repository's waits for that one. If one push fails,
        the later ones in the same repository wait; other repositories go on. Pressing <Ui>Push all</Ui> again pushes what
        is left.
      </p>
      <H3>Stacking on your own open pull request</H3>
      <p>
        When a repository already has your own open pull request for the ticket, the first new pull request targets its
        branch. A pull request from a fork is never stacked on.
      </p>

      <H2 id="after-the-push">After the push</H2>
      <ul>
        <li>Limn syncs each new pull request and links it to the ticket.</li>
        <li>The sprint card's mark becomes <Ui>Pushed</Ui> once every planned pull request is pushed.</li>
        <li>
          Review the new pull requests like any other: see <DocLink to="ai-review/run-a-review">Run a review</DocLink>.
        </li>
      </ul>
      <Note>
        A closed session keeps its changes. <Ui>Resume</Ui> starts a new sandbox with them, so you can ask for more or
        push later. The agent does not remember the conversation.
      </Note>
    </>
  );
}

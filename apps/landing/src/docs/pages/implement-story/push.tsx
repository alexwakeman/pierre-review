import type { DocMeta } from '../../types';
import { Btn, Chip, Diff, DocLink, H2, H3, Illustration, Note, PrRow, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Push the result',
  summary: 'Check the changes, then push them to a new branch and open the pull request.',
};

function ReviewLoopPicture(): JSX.Element {
  return (
    <Illustration
      label="Review rounds of the PAY-142 build. The state reads Reviewing round 2 of 3. Acceptance criteria: 3 of 4 met, 1 not applicable. Round 1 for acme/payments: a blocker, the refund window is not checked, marked Fixed; a nit, marked Pushed back with the agent's reason. Fixes pushed: acme/payments 3f2a1c9."
      caption="Each round: what the review found, and what the agent did about it."
      title="Review rounds"
      meta="PAY-142 Partial refunds"
    >
      <p>
        <Chip>Reviewing round 2 of 3</Chip> <Chip tone="green">AC1 · met</Chip> <Chip tone="green">AC2 · met</Chip>{' '}
        <Chip tone="green">AC3 · met</Chip> <Chip>AC4 · not applicable</Chip>
      </p>
      <PrRow title="Round 1 · acme/payments" repo="acme/payments" status={<Chip tone="red">Request changes</Chip>} why="2 findings" />
      <p>
        <Chip tone="red">Blocker</Chip> The refund window is not checked · <Chip tone="green">Fixed</Chip>
      </p>
      <p>
        <Chip>Nit</Chip> Rename policy.py · <Chip>Pushed back</Chip> The module name matches the other apps.
      </p>
      <p>Fixes pushed: acme/payments 3f2a1c9.</p>
    </Illustration>
  );
}

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
        When the build ends, each planned pull request has its own diff, ready to review. Nothing has left your computer,
        unless you chose <DocLink to="implement-story/push#review-and-fix">review and fix</DocLink>.{' '}
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

      <H2 id="branch-exists">When the branch already exists</H2>
      <p>
        An earlier session may have pushed the same branch, for example <b>PAY-142</b>. Push then says so, and the
        pull request shows a <Ui>New branch</Ui> field in place of the button, filled in with a free name such as{' '}
        <b>PAY-142-v2</b>. Change it if you like and press <Ui>Push</Ui>. Limn checks the name and still never
        overwrites a branch. In a stack, the pull requests after it build on the new branch.
      </p>

      <H2 id="review-and-fix">Review and fix, then open the pull request</H2>
      <ReviewLoopPicture />
      <p>
        Tick <Ui>After the build: review and fix, then open the pull request</Ui> before you start, or later in the tab
        until the first review starts. It is off by default. Set <Ui>Rounds</Ui> (1 to 6, 4 by default) beside it.
      </p>
      <Steps>
        <li>When the build finishes, Limn pushes the branch to GitHub. It does not open a pull request yet.</li>
        <li>
          Limn reviews the branch the way it reviews a pull request, with the AI review setting of your workspace (Claude,
          or Claude and Codex). It also checks the work against the ticket&apos;s acceptance criteria, across all
          repositories.
        </li>
        <li>
          The agent deals with every point: blockers, warnings, nits, questions and unmet criteria. It fixes the code,
          answers, or pushes back with a reason. It can say a criterion does not apply to this work; the next check
          judges that.
        </li>
        <li>Limn pushes each fix as a new commit on the branch, then reviews again.</li>
        <li>
          When nothing is left, or after the last round, Limn opens the pull request, ready for review. Its description
          sums up the rounds.
        </li>
      </Steps>
      <p>
        The tab shows each round: the findings per repository, what the agent did with each one, and which criteria are
        met. The review stays in Limn: nothing is posted on GitHub except the commits and the pull request.
      </p>
      <ul>
        <li>
          Each review and fix uses your AI allowance. If the{' '}
          <DocLink to="settings/ai-usage-and-spend#spend-budget">spend limit</DocLink> is reached, the rounds pause. Press{' '}
          <Ui>Continue</Ui> to go on.
        </li>
        <li>
          If a push fails, or Limn restarts, the rounds pause and say why. <Ui>Continue</Ui> tries once more. A branch
          that already exists gets a <Ui>New branch</Ui> field first.
        </li>
        <li>
          <Ui>Stop review loop</Ui> ends the rounds. The branch stays on GitHub, and <Ui>Open the pull request</Ui> opens it
          when you want.
        </li>
        <li>
          The pull request is yours. Limn keeps its last review on it, so auto review does not review the same commit
          again.
        </li>
      </ul>

      <H2 id="what-is-pushed">What is pushed</H2>
      <ul>
        <li>
          <b>The branch</b>: the ticket key, for example <b>PAY-142</b>; a second and third pull
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

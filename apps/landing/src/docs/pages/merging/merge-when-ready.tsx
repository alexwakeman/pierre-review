import type { DocMeta } from '../../types';
import { Btn, CheckRow, DocLink, H2, Illustration, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Merge when ready',
  summary: 'Arm a pull request and Limn merges it when GitHub says it can, with your consent at every step.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Merge when ready</Ui> lets you approve a merge now and have it happen later. You arm a pull request that
        is waiting on something, such as checks still running, a required review or a branch that is behind. Limn
        watches it, updates it from the base branch if it needs to, and merges it as soon as GitHub allows. If the
        code changes after you armed it, Limn does not merge it.
      </p>


      <H2 id="arm-a-pull-request">Arm a pull request</H2>
      <Steps>
        <li>
          Open the pull request’s <Ui>Overview</Ui> tab and press <Ui>Show actions</Ui>. You can also arm from a card
          on the Pending board.
        </li>
        <li>
          Press <Ui>Merge when ready</Ui> (or <Ui>Queue when ready</Ui> on a repository with a merge queue). Limn asks
          GitHub for the live merge state.
        </li>
        <li>
          Read what Limn will do, for example “Updates from trunk if needed and merges when checks pass — while Limn is
          running.”, and press <Ui>Arm auto-merge</Ui>.
        </li>
      </Steps>
      <Illustration
        label="An armed pull request: Armed — merging when ready, with the line Checks running… and a Cancel auto-merge button"
        caption="An armed pull request on the Overview tab. The line under it says what it is waiting for."
      >
        <CheckRow name="Armed — merging when ready" state="Checks running…" tone="blue" />
        <Btn>Cancel auto-merge</Btn>
      </Illustration>
      <p>
        The button is offered only when something is in the way that can clear by itself, and only where you can
        push to the repository. A pull request that conflicts, or that must wait for another open pull request to
        merge first, cannot be armed.
      </p>

      <H2 id="what-limn-does-while-it-waits">What Limn does while it waits</H2>
      <p>Limn checks every armed pull request every two minutes while it is running. On each check it:</p>
      <ul>
        <li>
          stops if the pull request has closed or merged, if its base branch changed, or if you no longer have
          permission to merge;
        </li>
        <li>
          stops if anyone pushed a new commit to the branch. Arming is consent to merge the code you saw, not code
          that came later. The only exception is the update that Limn itself made from the base branch;
        </li>
        <li>updates the branch from the base branch once, if it is behind and the repository requires it;</li>
        <li>waits while checks run, reviews are missing or branch protection is not met;</li>
        <li>merges when GitHub says the pull request can merge, checking first that you have not cancelled.</li>
      </ul>
      <p>
        The toasts in the bottom right show what each armed pull request is doing: for example{' '}
        <Ui>Waiting for CI</Ui>, <Ui>Blocked: needs approval</Ui>, <Ui>Updating the branch</Ui>,{' '}
        <Ui>Waiting its turn</Ui> or <Ui>Merged automatically</Ui>. When an arm stops, it says why:{' '}
        <Ui>Auto-merge disarmed — the branch moved</Ui>, <Ui>Auto-merge stopped</Ui>, <Ui>Auto-merge expired</Ui> or{' '}
        <Ui>Auto-merge failed</Ui>.
      </p>
      <Note title="An arm lasts 72 hours">
        If a pull request has not merged 72 hours after you armed it, the arm expires. Arm it again if you still want
        it to land.
      </Note>
      <Warning title="Only while Limn is running">
        Limn runs on your computer, so it can merge only while it is running there. If you close Limn, armed pull
        requests wait until you start it again. The merge goes out under your GitHub account.
      </Warning>

      <H2 id="one-at-a-time">One at a time on each repository</H2>
      <p>
        When you arm several pull requests on one repository, Limn lands them one at a time, in the order you armed
        them. Each one is updated against the base branch as it now stands, after the one before it merged. The rest
        show <Ui>Waiting its turn</Ui> with their place, for example “2 of 5 on this repo”. If the first in line has
        failing checks or conflicts, which Limn cannot fix by waiting, it steps aside and lets the next one through,
        and keeps its place. See <DocLink to="merging/merge-queues">Merge queues</DocLink>.
      </p>

      <H2 id="cancel">Cancel</H2>
      <p>
        Press <Ui>Cancel auto-merge</Ui> on the Overview tab, or <Ui>Cancel</Ui> in the toast. On a merge-queue
        repository the button is <Ui>Cancel & dequeue</Ui>, which also takes the pull request out of GitHub’s queue.
        Cancelling always wins: Limn checks again just before it merges.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        GitHub’s own auto-merge refuses pull requests that do not already meet the merge rules, which are exactly the
        ones you want to arm. Limn’s version waits out the blockers for you and still merges only the code you saw.
        Dependency updates can be armed by a rule instead of by hand; see{' '}
        <DocLink to="merging/dependency-automation">Dependency automation</DocLink>.
      </p>
    </>
  );
}

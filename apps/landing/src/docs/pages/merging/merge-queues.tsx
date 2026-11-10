import type { DocMeta } from '../../types';
import { CheckRow, DocLink, H2, Illustration, MiniTable, Note, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Merge queues',
  summary: 'How Limn works with GitHub\'s merge queue and lands one pull request at a time per repository.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        There are two queues in Limn, and they are different things. <strong>GitHub’s merge queue</strong> is a
        repository setting: GitHub tests each pull request against the ones ahead of it and merges them in turn.{' '}
        <strong>Limn’s landing order</strong> is how Limn lands the pull requests you armed with{' '}
        <DocLink to="merging/merge-when-ready">Merge when ready</DocLink> on a repository without a merge queue: one
        at a time, in the order you armed them. Limn never mixes up the two in what it shows you.
      </p>

      <WhoItHelps
        developer="Add a pull request to the queue from Limn, see its place and state, and take it out again, without opening GitHub."
        manager="Arm a batch of approved pull requests on one repository and have them land in order, without each one breaking the next."
      />

      <H2 id="the-two-queues">The two queues side by side</H2>
      <MiniTable
        cols={[
          { key: 'w', label: '' },
          { key: 'g', label: 'GitHub’s merge queue' },
          { key: 'l', label: 'Limn’s landing order' },
        ]}
        rows={[
          { _key: 'who', w: 'Who runs it', g: 'GitHub', l: 'Limn, on your computer, while it is running' },
          { _key: 'when', w: 'Applies to', g: 'Repositories with a merge queue', l: 'Pull requests you armed, on repositories without one' },
          { _key: 'shown', w: 'Shown as', g: 'In the merge queue', l: 'Waiting its turn' },
          { _key: 'order', w: 'Order', g: 'GitHub’s', l: 'The order you armed them' },
        ]}
      />

      <H2 id="githubs-merge-queue">GitHub’s merge queue</H2>
      <p>
        On a repository whose branch uses a merge queue, GitHub refuses a direct merge, so Limn does not offer one.
        The merge button becomes <Ui>Add to merge queue</Ui>, and <Ui>Merge when ready</Ui> becomes{' '}
        <Ui>Queue when ready</Ui>.
      </p>
      <Illustration
        label="A pull request in GitHub's merge queue: In the merge queue, position 2, running checks, with a Remove from queue button"
        caption="A queued pull request on the Overview tab. Its place and time to merge come from GitHub when you open it."
      >
        <CheckRow name="In the merge queue · position 2 · running checks · ~12 min" state="Queued" tone="blue" />
      </Illustration>
      <Steps>
        <li>
          Open the pull request’s <Ui>Overview</Ui> tab and press <Ui>Show actions</Ui>.
        </li>
        <li>
          Press <Ui>Add to merge queue</Ui>. GitHub now runs its checks and merges it in turn.
        </li>
        <li>
          To take it out, press <Ui>Remove from queue</Ui>.
        </li>
      </Steps>
      <p>
        While a pull request is queued, the Overview tab shows its place and estimated time, read from GitHub when you
        open it. The Pending board shows that it is queued but not its place, because the board does not ask GitHub
        when it opens. If GitHub is taking it out of the queue because it can no longer merge, the card says so.
      </p>
      <p>
        With <Ui>Queue when ready</Ui>, Limn updates the branch from the base branch if needed, before it first adds
        the pull request to the queue, and adds it once the required reviews are in. It never updates a branch that
        is already in the queue. If the queue refuses it because required checks are still running, Limn waits and
        tries again; it does not give up.
      </p>

      <H2 id="limns-landing-order">Limn’s landing order</H2>
      <p>
        When you arm several pull requests on a repository without a merge queue, only the first in line is updated
        and merged. The others show <Ui>Waiting its turn</Ui> and their place, for example “Waiting its turn — 2 of 5
        on this repo”, and <Ui>Next up on this repo</Ui> for the second. When one merges, the next is updated against
        the new base branch and merged in turn. So five pull requests cost five branch updates and five CI runs, not
        one for every pair.
      </p>
      <ul>
        <li>
          If the first in line has failing checks or conflicts, it lets the next one through and keeps its place:{' '}
          <Ui>Waiting — checks failed, letting the next PR through</Ui>.
        </li>
        <li>
          A pull request that stops for its own reason, such as a new commit or a closed pull request, stops at once,
          wherever it is in line.
        </li>
        <li>A waiting pull request that conflicts says so, with its place, rather than just “waiting its turn”.</li>
      </ul>
      <Note>
        If a repository’s merge queue is turned off after you armed a pull request, Limn moves it into its own
        landing order and merges it directly, from its place in line.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Merging a batch of pull requests on one repository is where branches fall behind and CI runs pile up. Limn
        either hands the batch to GitHub’s queue or lands it in order itself, and tells you plainly which one is
        happening.
      </p>
    </>
  );
}

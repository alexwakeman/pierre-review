import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, H3, Illustration, Kbd, Note, Pill, PrRow, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Ready to land',
  summary: 'Pull requests GitHub will merge now, or once the branch is updated, with the buttons to land them.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Ready to land</Ui> lists open pull requests that GitHub says can merge now (<Ui>Ready to merge</Ui>)
        and those that only need their branch brought up to date first (<Ui>Behind trunk</Ui>). Where you can push
        to the repository, each card has the buttons to land it. An approved pull request scores higher than one
        nobody has approved yet.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>
          <b>
            <Ui>Ready to merge</Ui>
          </b>
          : GitHub will merge it now. This includes a pull request whose only red checks are ones the branch
          does not require, because GitHub's own merge button merges it too.
        </li>
        <li>
          <b>
            <Ui>Behind trunk</Ui>
          </b>
          : the repository requires branches to be up to date, and this one is not. GitHub will not merge it
          until the branch is updated.
        </li>
      </ul>
      <p>
        A pull request stacked on another open pull request is not listed as ready to merge: it lands after its
        parent. Your own ready pull requests are in <DocLink to="pending/my-turn">My turn</DocLink> under{' '}
        <Ui>Your PRs</Ui>, with the same buttons. Dependency updates are in{' '}
        <DocLink to="pending/dependencies">Dependencies</DocLink>.
      </p>

      <Illustration
        label="Ready to land: #482 ready to merge with Merge and Merge when ready buttons, and #476 behind trunk with Update branch."
        caption="Two Ready to land cards."
      >
        <PrRow title="#482 Retry budget" repo="acme/payments · approved by sam" status={<Pill tone="green">Ready to merge</Pill>}>
          <Btn tone="go">Merge</Btn> <Btn>Merge when ready</Btn>
        </PrRow>
        <PrRow title="#476 Ledger index" repo="acme/payments · 3 commits behind main" status={<Pill tone="amber">Behind trunk</Pill>}>
          <Btn>Update branch</Btn>
        </PrRow>
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <H3>Merge</H3>
      <p>
        <Ui>Merge</Ui> opens the merge options: <Ui>Create a merge commit</Ui>, <Ui>Squash and merge</Ui> or{' '}
        <Ui>Rebase and merge</Ui>, as the repository allows. Limn reads the live merge state from GitHub only when
        you press the button, and checks it again before it merges. With a row selected, <Kbd>m</Kbd> merges it.
      </p>
      <H3>Merge when ready</H3>
      <p>
        <Ui>Merge when ready</Ui> arms Limn's own auto-merge for this pull request: Limn merges it as soon as it can
        land, while the app is running. If new commits are pushed after you arm it, Limn does not merge them
        without you. <Ui>Cancel auto-merge</Ui> stops it. See{' '}
        <DocLink to="merging/merge-when-ready">Merge when ready</DocLink>.
      </p>
      <H3>Update branch</H3>
      <p>
        <Ui>Update branch</Ui> brings the base branch's new commits into the pull request's branch on GitHub.
        The card then waits for the checks to run again.
      </p>
      <H3>Merge queues</H3>
      <p>
        In a repository that uses GitHub's merge queue, the buttons read <Ui>Add to merge queue</Ui> and{' '}
        <Ui>Queue when ready</Ui>. A queued pull request shows <Ui>In the merge queue</Ui> with what the queue is
        doing, and <Ui>Remove from queue</Ui>; Merge and Merge when ready are hidden, because GitHub merges it from
        there. See <DocLink to="merging/merge-queues">Merge queues</DocLink>.
      </p>

      <Note>
        The buttons show only where you can push to the repository. Where you cannot, the card has no buttons,
        rather than buttons that do not work.
      </Note>

      <Warning>
        Merge, Update branch and Add to merge queue change the repository on GitHub, under your account. A merge
        from the keyboard waits a few seconds so that <Kbd>z</Kbd> can stop it.
      </Warning>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Finished work that sits unmerged goes stale and starts to conflict. This tab shows it in one place and
        lets you land it without opening each pull request. See also{' '}
        <DocLink to="merging/can-it-land">Can it land?</DocLink>
      </p>
    </>
  );
}

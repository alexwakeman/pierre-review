import type { DocMeta } from '../../types';
import { CheckRow, DocLink, H2, H3, Illustration, MiniTable, Note, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Can it land?',
  summary: 'How Limn decides if a pull request can merge, and what each blocker means.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every place in Limn that tells you whether a pull request can merge gives the same answer: the Open pull
        requests list, the Pending board, the Timeline and the pull request’s own Overview tab. Limn reads it from
        GitHub’s own merge state, which takes your branch protection rules into account, and turns it into one plain
        status. When GitHub only says “blocked”, Limn lists the likely reasons.
      </p>

      <WhoItHelps
        developer="Know what stands between your pull request and the merge button, without opening GitHub’s branch settings."
        manager="See at a glance which approved work is really ready to land and which is stuck, and on what."
      />

      <H2 id="the-statuses">The statuses</H2>
      <MiniTable
        cols={[
          { key: 's', label: 'Status' },
          { key: 'm', label: 'What it means' },
          { key: 'c', label: 'Can merge?' },
        ]}
        rows={[
          { _key: 'ready', s: 'ready to merge', m: 'Nothing is in the way.', c: 'Yes' },
          {
            _key: 'failing',
            s: 'checks failing',
            m: 'Some checks that are not required are failing. GitHub will still merge it.',
            c: 'Yes',
          },
          {
            _key: 'behind',
            s: 'behind base',
            m: 'The repository requires branches to be up to date. Update the branch first.',
            c: 'No',
          },
          { _key: 'blocked', s: 'blocked', m: 'Required checks or reviews are not satisfied. Limn lists the likely reasons.', c: 'No' },
          { _key: 'conflicts', s: 'conflicts', m: 'It conflicts with the base branch. Resolve the conflicts first.', c: 'No' },
          { _key: 'draft', s: 'draft', m: 'Mark it ready for review to merge.', c: 'No' },
          { _key: 'lands', s: 'lands after #N', m: 'It targets the branch of another open pull request, #N, which must merge first.', c: 'No' },
          { _key: 'queue', s: 'in merge queue', m: 'GitHub’s merge queue has it and will merge it in turn.', c: 'Queued' },
          { _key: 'armed', s: 'auto-merge armed', m: 'Limn will merge it once the blockers clear.', c: 'Armed' },
          { _key: 'unknown', s: 'mergeability unknown', m: 'GitHub has not worked it out yet. It usually knows within a minute.', c: '—' },
        ]}
      />
      <Note title="A red check is not always a blocker">
        <Ui>checks failing</Ui> means only checks your branch protection does not require are red. GitHub’s own merge
        button merges it, and so does Limn. A required check that is red makes the pull request <Ui>blocked</Ui>.
      </Note>

      <H2 id="why-is-it-blocked">Why is it blocked?</H2>
      <p>
        GitHub folds many different rules into the one word “blocked” and does not say which one applies. Most people
        cannot read a repository’s branch protection settings either. So on the pull request’s Overview tab, the{' '}
        <Ui>Blocked</Ui> row lists the likely causes from what Limn already knows, the surest first:
      </p>
      <Illustration
        label="The Overview tab's Status and Blocked rows: blocked, with two reasons: required reviews aren't in yet, and CI is red on the head commit"
        caption="The Overview tab: the status, then the likely reasons it is blocked, the surest first."
      >
        <CheckRow name="Status" state="blocked" tone="red" />
        <CheckRow name="required reviews aren’t in yet" state="Blocked" tone="amber" />
        <CheckRow name="CI is red on the head commit" state="Blocked" tone="amber" />
      </Illustration>
      <ul>
        <li>
          <strong>From GitHub itself</strong> (certain): “a reviewer requested changes” or “required reviews aren’t in
          yet”.
        </li>
        <li>
          <strong>From the pull request’s facts</strong> (likely): “CI is red on the head commit”, checks that have not
          reported yet, or review threads not resolved on GitHub (with how many of them look addressed).
        </li>
        <li>
          When none of these explains it, Limn says so, rather than leaving “blocked” on its own. Other rules, such
          as signed commits or required deployments, may be the cause.
        </li>
      </ul>
      <p>
        Limn never states that unresolved threads are the blocker. Many repositories do not require threads to be
        resolved, and Limn cannot see that setting.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open the pull request and stay on the <DocLink to="pull-request/overview-tab">Overview</DocLink> tab.
        </li>
        <li>
          Press <Ui>Show actions</Ui>. The actions are hidden until you ask, so a click cannot write to GitHub by
          accident.
        </li>
        <li>
          If it is ready, press <Ui>Merge</Ui> and choose <Ui>Create a merge commit</Ui>, <Ui>Squash and merge</Ui> or{' '}
          <Ui>Rebase and merge</Ui> (only the methods the repository allows).
        </li>
        <li>
          If it is behind, press <Ui>Update branch</Ui>. Where both are allowed, first choose{' '}
          <Ui>Rebase onto main</Ui> or <Ui>Merge main in</Ui> (with your base branch’s name in place of main).
        </li>
        <li>
          If something must clear first, press <Ui>Merge when ready</Ui> (see{' '}
          <DocLink to="merging/merge-when-ready">Merge when ready</DocLink>).
        </li>
        <li>
          If it conflicts, press <Ui>Resolve conflicts</Ui> (see{' '}
          <DocLink to="merging/resolve-conflicts">Resolve conflicts by hand</DocLink>).
        </li>
      </Steps>
      <H3>On the Pending board</H3>
      <p>
        Cards on <DocLink to="pending/ready-to-land">Ready to land</DocLink> show <Ui>Merge</Ui> only when the stored
        state says it can merge. The board never asks GitHub when it opens; the live merge options load only when you
        press. A pull request already in a merge queue never shows <Ui>Merge</Ui>.
      </p>
      <Warning title="Merging writes to GitHub">
        A merge goes out under your GitHub account. Limn shows a button only where you can push to the repository; if
        you cannot, the button is not shown.
      </Warning>
      <p>
        <Ui>Withdraw approval</Ui> on the Overview tab dismisses your own latest approval, if you gave one.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        GitHub’s “mergeable” only means “no conflicts”. A pull request with failing required checks is still
        “mergeable”. Limn’s status uses the state that respects branch protection, says it the same way everywhere,
        and tells you what to do next. For failing checks, see <DocLink to="merging/ci-logs">Read CI logs</DocLink>.
      </p>
    </>
  );
}

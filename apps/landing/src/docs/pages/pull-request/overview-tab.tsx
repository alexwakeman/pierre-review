import type { DocMeta } from '../../types';
import { CheckRow, DocLink, H2, H3, Illustration, Note, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Overview tab',
  summary: 'The pull request\'s state at a glance: can it land, what blocks it, checks, reviews and the AI review.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Overview</Ui> tab is where a pull request opens. It answers "can this land, and if not, why not?",
        then shows the AI review, the checks, the people and the description, in five sections, top to bottom.
      </p>

      <WhoItHelps
        developer="See what stands between your pull request and a merge, and open the failing check's log in one click."
        manager="Read one pull request's state without opening GitHub: blockers, reviewers, checks and the ticket."
      />

      <H2 id="can-it-land">Can it land</H2>
      <ul>
        <li>
          <b>
            <Ui>Status</Ui>
          </b>
          : Limn's verdict, for example ready to merge, blocked, behind base, conflicts, draft, or in the merge
          queue. See <DocLink to="merging/can-it-land">Can it land?</DocLink>
        </li>
        <li>
          <b>
            <Ui>Conflicts</Ui>
          </b>
          : shown when the branch conflicts with its base, with the way to resolve it.
        </li>
        <li>
          <b>
            <Ui>Auto-merge</Ui>
          </b>
          : whether <DocLink to="merging/merge-when-ready">Merge when ready</DocLink> is armed, and what it is
          waiting for.
        </li>
        <li>
          <b>
            <Ui>Blocked</Ui>
          </b>
          : why GitHub says the pull request is blocked. See <DocLink to="#blocked">below</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Actions</Ui>
          </b>
          : <Ui>Show actions</Ui> reveals approve, request changes, merge and close. See{' '}
          <DocLink to="pull-request/overview#show-actions">The actions</DocLink>.
        </li>
      </ul>

      <H3 id="blocked">Why a pull request is blocked</H3>
      <p>
        GitHub says "blocked" for many different reasons and does not say which. Limn lists the facts it can see,
        the ones GitHub itself confirms first:
      </p>
      <ul>
        <li>"a reviewer requested changes" or "required reviews aren't in yet", from GitHub's review decision;</li>
        <li>"CI is red on the head commit", "checks are still running" or "a required check hasn't reported yet";</li>
        <li>
          "N review threads aren't resolved on GitHub", with how many of them look addressed;
        </li>
        <li>or "nothing we can see explains it", when none of these applies.</li>
      </ul>
      <Note>
        Limn cannot read a repository's branch protection rules without admin access, so apart from the review
        decision these are facts, not proof of the cause. Which one GitHub is enforcing is for you to judge.
      </Note>

      <H2 id="ai-review">AI review</H2>
      <p>
        With the AI features on, a card shows the latest AI review: its verdict and commit, its findings, the
        earlier review's findings fixed or still open, the CI review, what was posted, when it ran, and the one
        action you need (<Ui>Review</Ui>, <Ui>Re-review</Ui> or <Ui>Open review</Ui>). It is the same card as the
        side panel on Open pull requests. See <DocLink to="pull-request/ai-review-tab">AI Review tab</DocLink>.
      </p>

      <H2 id="checks">Checks</H2>
      <p>
        A short summary of the checks, which opens to the full list. Choose a check's name to read its log in
        Limn; the small link beside it opens the run on GitHub. A check marked <Ui>Flaky</Ui> has both passed and
        failed on the same commit. See <DocLink to="merging/ci-logs">CI logs</DocLink>.
      </p>
      <Illustration
        label="The Checks section with build passing, test failing and lint running."
        caption="Three checks; the failing one opens its log."
      >
        <CheckRow name="build" state="Passing" tone="green" />
        <CheckRow name="test" state="Failing" tone="red" note="2 tests failed in refunds/test_policy.py" />
        <CheckRow name="lint" state="Running" tone="blue" />
      </Illustration>

      <H2 id="people">People</H2>
      <ul>
        <li>
          <Ui>Reviews</Ui>: each reviewer's latest standing.
        </li>
        <li>
          <Ui>Requested</Ui>: who has been asked and not yet reviewed.
        </li>
        <li>
          <Ui>Suggested</Ui>: reviewers Limn suggests from the code owners and the repository's history, each with{' '}
          <Ui>Assign</Ui>.
        </li>
        <li>
          <Ui>Bots</Ui> and <Ui>Bot activity</Ui>: which review bots commented, and how many of their threads need a
          look.
        </li>
      </ul>

      <H2 id="about">About</H2>
      <p>
        <Ui>Ticket</Ui> (the linked tickets, where the workspace has a tracker, or "No ticket found"),{' '}
        <Ui>Branch</Ui> (the head branch and its base, with a button to copy the branch name), <Ui>Labels</Ui>,{' '}
        <Ui>Merged by</Ui>, <Ui>Updated</Ui>, and the description.
      </p>
    </>
  );
}

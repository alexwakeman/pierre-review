import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, Thread, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Unanswered threads',
  summary: 'Review threads nobody has answered or acted on.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Unanswered threads</Ui> lists review comments with no reply and no later commit to their file, older
        than 24 hours. In Limn's words these threads are <Ui>Untouched</Ui>. Each card quotes the opening
        comment. Items are ordered by score.
      </p>

      <WhoItHelps
        developer="Find the review comments on your team's pull requests that nobody has answered, before the pull request is blocked on them."
        manager="See how many review comments go unanswered, and on which pull requests."
      />

      <H2 id="what-you-see">What you see</H2>
      <p>
        Each card names the pull request, the file and line, who wrote the comment and when, and the first
        part of the comment. The mark turns amber after 48 hours and red after 96.
      </p>

      <Illustration
        label="An unanswered thread card quoting a reviewer's comment on policy.py."
        caption="An Untouched thread, two days old."
      >
        <Thread
          file="payments/refunds/policy.py:42"
          state="Untouched"
          tone="red"
          comments={[{ who: 'priya', when: '2d', text: 'What happens to a refund after 30 days? I think this lets it through.' }]}
        />
      </Illustration>

      <Note>
        An unanswered thread on your own pull request is in <DocLink to="pending/my-turn">My turn</DocLink>{' '}
        instead, under <Ui>Your PRs</Ui>. A thread on a dependency update is in the Dependencies tab's card.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          Choose <Ui>Open thread</Ui>, or go to the item, to open the thread in the pull request. Reply or
          resolve it there. See <DocLink to="pull-request/threads">Threads tab</DocLink>.
        </li>
      </ul>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A comment with no reply can block a merge, or hide a real problem. A reply, or a commit to the file,
        takes the thread off this tab; resolving it on GitHub does too. See{' '}
        <DocLink to="timeline/thread-states">What the thread states mean</DocLink>.
      </p>
    </>
  );
}

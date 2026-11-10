import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Activity tab',
  summary: 'The conversation and the events, newest first.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Activity</Ui> tab is everything that happened on the pull request, newest first, on one line down
        the left: when it was opened, marked ready or reopened, each commit, each review, each comment, each
        resolved thread, and the merge or close. The box to write a comment is at the top. The number on the tab
        counts the comments and reviews.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>
          <b>Each entry has a mark</b> that names its type: a comment, approved, changes requested, a review, a
          commit, opened, ready, reopened, merged, closed, or Limn's own work.
        </li>
        <li>
          <b>A commit</b> shows its short id (with a copy button) and the first line of its message.
        </li>
        <li>
          <b>A comment or a review with a body</b> is a card. It shows the first few lines; choose it to read it
          all.
        </li>
        <li>
          <b>A resolved thread</b> is an entry at the time Limn first saw it resolved, with who resolved it. A
          thread that was already resolved when Limn first synced it has no time, so it is listed only on the
          Threads tab.
        </li>
        <li>
          <b>Limn's own reviews and findings</b> carry a <Ui>Limn</Ui> chip. The newest auto review adds{' '}
          <Ui>Auto review · latest</Ui>.
        </li>
      </ul>

      <Illustration
        label="The Activity tab: a review comment card from priya, under it a commit by sam."
        caption="Two entries on the Activity tab."
      >
        <Thread comments={[{ who: 'priya', when: '3h · changes requested', text: 'Refunds after 30 days should be refused. See policy.py.' }]} />
        <p className="muted">● a1b2c3d Check paid_at before a refund · sam · 1h</p>
      </Illustration>

      <H3>What changed since the last review</H3>
      <p>
        Where the AI features are on, under the commit an AI review ran on, a short block says what the pushes
        since the review before it changed: "Since the last review · N commits", then two sentences or a few
        points.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>Write a comment in the box at the top. It posts to GitHub under your account.</li>
        <li>
          Open a card to read the whole comment, add a reaction, <Ui>Reply</Ui> (the reply quotes it), or{' '}
          <Ui>View on GitHub</Ui>.
        </li>
        <li>
          Open a resolved thread to read it, then <Ui>Show in Threads</Ui> or view it on GitHub.
        </li>
        <li>
          Choose "N new" in the header to see only what is new since you last looked. <Ui>Show all</Ui> shows the
          rest again.
        </li>
      </ul>
      <Note>
        Reactions are read from GitHub only when you open a card. A link to a comment (from Pending, the Feed or
        the Timeline) opens this tab with that comment open and marked.
      </Note>
      <p>
        Review comments on code lines live on the <DocLink to="pull-request/threads">Threads tab</DocLink> and in
        the <DocLink to="pull-request/changes">Changes tab</DocLink>.
      </p>
    </>
  );
}

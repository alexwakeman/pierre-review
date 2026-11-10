import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Thread, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'What the thread states mean',
  summary: 'Resolved, Likely addressed, Replied and Untouched: how Limn reads each review thread, and why Likely addressed is a guess.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn gives every review thread on a pull request one of four states, from what GitHub reports and from
        the commits that came after the thread. The states show on the Threads tab, in the Feed, in the
        sidebar's thread bars and in the Timeline's filters. They answer one question: does this comment still
        need someone?
      </p>

      <WhoItHelps
        developer="Tell at a glance which comments on your pull request you still have to answer or fix."
        manager="See how many review comments go unanswered across the workspace, and how many were fixed but never resolved."
      />

      <H2 id="the-states">The four states</H2>
      <table>
        <thead>
          <tr>
            <th>State</th>
            <th>What it means</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Ui>Resolved</Ui>
            </td>
            <td>Marked resolved on GitHub.</td>
          </tr>
          <tr>
            <td>
              <Ui>Likely addressed</Ui>
            </td>
            <td>A commit touched the thread's file after the last comment. This is a guess.</td>
          </tr>
          <tr>
            <td>
              <Ui>Replied</Ui>
            </td>
            <td>Someone replied, but the thread is not resolved and no later commit touched the file.</td>
          </tr>
          <tr>
            <td>
              <Ui>Untouched</Ui>
            </td>
            <td>No reply, and no later commit touched the file.</td>
          </tr>
        </tbody>
      </table>

      <Illustration
        label="Two threads: one Likely addressed after a commit to its file, one Untouched."
        caption="Two threads on #612 with their states."
      >
        <Thread
          file="payments/refunds/policy.py:42"
          state="Likely addressed"
          tone="blue"
          comments={[
            { who: 'priya', when: '2d', text: 'Refunds after 30 days should be refused.' },
            { who: 'sam', when: '1d', text: 'Pushed a check for paid_at.' },
          ]}
        />
        <Thread
          file="payments/refunds/mail.py:18"
          state="Untouched"
          tone="red"
          comments={[{ who: 'priya', when: '2d', text: 'A retried refund sends a second email.' }]}
        />
      </Illustration>

      <H2 id="likely-addressed-is-a-guess">Likely addressed is a guess</H2>
      <p>
        Limn cannot know that a commit fixed what a comment asked for. It knows only that someone changed the same
        file after the comment. The change may be unrelated, or a rebase. So Limn calls it <Ui>Likely addressed</Ui>,
        never "addressed", and a thread in this state still counts as not resolved on GitHub.
      </p>
      <H3>How sure Limn is</H3>
      <p>Where it can, Limn grades a Likely addressed thread:</p>
      <ul>
        <li>
          <b>High</b>: GitHub marked the commented lines as outdated and a later commit touched them, or the bot
          that wrote the comment confirmed or resolved it.
        </li>
        <li>
          <b>Medium</b>: one sign of change, either a later commit to the file or GitHub marking the lines
          outdated.
        </li>
        <li>
          <b>Low</b>: only a reply, with no change found.
        </li>
      </ul>
      <p>
        With the AI features on, a review can also judge whether each thread was really addressed. See{' '}
        <DocLink to="ai-review/check-threads">Check threads</DocLink>.
      </p>

      <Warning>
        Do not resolve a Likely addressed thread on its state alone. Read the commit first. Resolving a thread on
        GitHub is visible to everyone on the pull request.
      </Warning>

      <H2 id="where-states-are-used">Where the states are used</H2>
      <ul>
        <li>
          <DocLink to="pending/unanswered-threads">Unanswered threads</DocLink> lists Untouched threads older than a
          day.
        </li>
        <li>
          A thread you started that becomes Likely addressed puts a card in{' '}
          <DocLink to="pending/my-turn">My turn</DocLink>, so you can check the fix.
        </li>
        <li>
          The <DocLink to="pull-request/threads">Threads tab</DocLink> groups threads by file with their states.
        </li>
        <li>
          The <DocLink to="timeline/filters">Threads filter</DocLink> narrows the Timeline by state.
        </li>
      </ul>
      <Note>
        A pull request's "can it land" row counts every unresolved thread, Likely addressed included, because
        GitHub only counts the resolve click.
      </Note>
    </>
  );
}

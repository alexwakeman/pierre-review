import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Thread, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Threads tab',
  summary: 'Every review thread with its state. Reply, resolve, or show it in context.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Threads</Ui> tab lists every review thread on the pull request, grouped by file, each with its
        state: <Ui>Untouched</Ui>, <Ui>Replied</Ui>, <Ui>Likely addressed</Ui> or <Ui>Resolved</Ui>. It shows the
        conversation without the code; <Ui>Show in context</Ui> takes you to the thread's lines on the Changes tab.
        The number on the tab counts the unresolved threads.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>
          <b>State filters</b> at the top: choose one or more states to show only those threads.
        </li>
        <li>
          <b>Threads grouped by file.</b> A file renamed in the pull request keeps its threads.
        </li>
        <li>
          <b>The bot summary.</b> When bots left several review comments, one line sums them up, for example "12
          bot comments: 3 real issues · 6 likely addressed · 3 nit-flagged", with a button to resolve the addressed ones.
        </li>
        <li>
          <b>What the AI says.</b> Where an AI review or a thread check judged a thread, its judgement shows on the
          thread, for example still open or addressed.
        </li>
      </ul>

      <Illustration label="A thread on policy.py, Replied, with a reply from sam." caption="One thread, Replied.">
        <Thread
          file="payments/refunds/policy.py:42"
          state="Replied"
          tone="amber"
          comments={[
            { who: 'priya', when: '2d', text: 'Refunds after 30 days should be refused.' },
            { who: 'sam', when: '1d', text: 'Good catch, I will add a check today.' },
          ]}
        />
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>Reply.</b> Type in the thread's reply box. The reply posts to GitHub under your account.
        </li>
        <li>
          <b>
            <Ui>Resolve</Ui>
          </b>{' '}
          marks the thread resolved on GitHub; <Ui>Unresolve</Ui> reopens it.
        </li>
        <li>
          <b>
            <Ui>Show in context</Ui>
          </b>{' '}
          opens the Changes tab at the thread's lines. If the lines are no longer in the diff, <Ui>Show file</Ui>{' '}
          shows the file's code instead.
        </li>
        <li>
          <b>
            <Ui>View thread on GitHub</Ui>
          </b>
          .
        </li>
        <li>
          <b>
            <Ui>Check threads</Ui>
          </b>{' '}
          asks the AI to judge every thread that has no current judgement. See{' '}
          <DocLink to="ai-review/check-threads">Check threads</DocLink>.
        </li>
      </ul>
      <H3>Resolve the addressed bot threads</H3>
      <p>
        The bot summary's button resolves the bot threads that look addressed, after you confirm. It never
        touches a person's thread.
      </p>
      <Warning>
        Resolving is visible on GitHub to everyone on the pull request. A Likely addressed thread is a guess; read
        the change before you resolve it. See{' '}
        <DocLink to="timeline/thread-states#likely-addressed-is-a-guess">Likely addressed is a guess</DocLink>.
      </Warning>
      <Note>
        Each bot comment also has a severity from Limn's own scorer: nit, minor, major or critical. See{' '}
        <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
      </Note>
    </>
  );
}

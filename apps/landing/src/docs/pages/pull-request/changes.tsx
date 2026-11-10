import type { DocMeta } from '../../types';
import { Diff, DocLink, H2, H3, Illustration, Kbd, Note, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Changes tab',
  summary: 'The diff, file by file, with the review threads on their lines.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Changes</Ui> tab is the pull request's diff, file by file, with the code highlighted and each
        review thread shown under the line it is about. A list of the changed files sits beside the diff. The
        number on the tab counts the changed files.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>
          <b>
            <Ui>Changed files</Ui>
          </b>
          : the files as a tree, each with its thread states. Choose one to jump to it. Drag its edge to resize it.
        </li>
        <li>
          <b>The diff</b>, with added and removed lines. Lock files and large files (over about 400 changed lines)
          start folded; open one with its header.
        </li>
        <li>
          <b>Threads on their lines.</b> A thread whose code has moved since it was written is placed on the code
          it was written against, and says it may be a few lines off.
        </li>
      </ul>

      <Illustration
        label="The Changes tab showing a diff of policy.py with a review thread under the changed line."
        caption="A diff with a thread under its line."
      >
        <Diff
          file="payments/refunds/policy.py"
          lines={[
            { k: ' ', t: 'def allows(refund):' },
            { k: '-', t: '    return refund.amount > 0' },
            { k: '+', t: '    return refund.amount > 0 and refund.age_days <= 30' },
          ]}
          after={
            <Thread
              state="Likely addressed"
              tone="blue"
              comments={[{ who: 'priya', when: '2d', text: 'Refunds after 30 days should be refused.' }]}
            />
          }
        />
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>Move around.</b> <Kbd>n</Kbd> and <Kbd>p</Kbd> go to the next or previous file; <Kbd>]</Kbd> and{' '}
          <Kbd>[</Kbd> go to the next or previous review thread.
        </li>
        <li>
          <b>Fold files.</b> Collapse or expand one file, or use <Ui>Expand all</Ui> and <Ui>Collapse all</Ui>.
        </li>
        <li>
          <b>See more of the file.</b> Expand the gaps between changed parts to read the code around them.
        </li>
        <li>
          <b>Wrap lines.</b> <Ui>Wrap lines</Ui> wraps long lines instead of scrolling sideways.
        </li>
        <li>
          <b>Comment on a line.</b> <Ui>Comment on this line</Ui> starts a review comment on GitHub, under your
          account.
        </li>
        <li>
          <b>Reply to and resolve threads</b> in place, as on the <DocLink to="pull-request/threads">Threads tab</DocLink>.
        </li>
        <li>
          <b>Copy file path</b>, or <b>view this file</b> on GitHub.
        </li>
      </ul>

      <H3>Very large pull requests</H3>
      <p>
        GitHub sends only part of a very large diff. Limn shows what it has and offers <Ui>Load full diff</Ui>.
        GitHub lists at most 3,000 files in a pull request. A file over 1 MB, or a binary file, is listed without a
        diff.
      </p>
      <Note>
        The diff is read from GitHub when you open the tab, and kept in your browser for later.
      </Note>
    </>
  );
}

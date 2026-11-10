import type { DocMeta } from '../../types';
import { Btn, CheckRow, DocLink, H2, Illustration, Log, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'CI review',
  summary: 'When checks fail, Limn reads the logs and says what broke and why.',
};

function CiPicture(): JSX.Element {
  return (
    <Illustration
      label="The CI check section of pull request 612. The test-api check failed; Limn says it is Flaky or infra with 85% confidence and not from this change. The build check failed in Code; it can be fixed in this pull request, with a Fix with AI button."
      caption="CI check: one row per failing check, with the cause, how sure Limn is, and whether this pull request can fix it."
      title="CI check"
      meta="On latest commit"
    >
      <CheckRow name="test-api" state="Failed" tone="red" note="Flaky or infra · Confidence 85% · Not from this change" />
      <Log lines={['ConnectionResetError: [Errno 104]', '  at tests/test_webhooks.py:88']} />
      <CheckRow name="build" state="Failed" tone="red" note="Code · Confidence 90%" />
      <p className="muted">Fix: import Decimal in refunds/amounts.py.</p>
      <p>
        <Btn>Re-check</Btn> <Btn tone="go">Fix with AI →</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A red check usually means opening a long log and scrolling for the error. The CI review does that for you. It
        reads each failing GitHub Actions job's log, picks out the error lines, reads the code, and says why the check
        failed, how sure it is, and whether this pull request can fix it. It is a run of its own, separate from the
        code review.
      </p>

      <H2 id="where-to-find-it">Where to find it</H2>
      <p>
        On the pull request's <Ui>AI Review</Ui> tab, in the <Ui>CI check</Ui> section. It shows a result only for the
        pull request's latest commit; an earlier commit's diagnosis is hidden.
      </p>
      <CiPicture />

      <H2 id="run-a-check">Run a check</H2>
      <Steps>
        <li>
          Open the pull request and choose the <Ui>AI Review</Ui> tab.
        </li>
        <li>
          In <Ui>CI check</Ui>, press <Ui>Check CI</Ui>. The status line says <Ui>Reading the logs</Ui>, then{' '}
          <Ui>Reading the code</Ui>.
        </li>
        <li>
          Read each failing check's row. Press <Ui>Re-check</Ui> after new commits or new failures.
        </li>
      </Steps>
      <p>
        When you start a code review on a pull request whose checks are red, Limn starts a CI check beside it, so you
        get both.
      </p>

      <H2 id="read-the-result">Read the result</H2>
      <p>Each failing check gets one row:</p>
      <ul>
        <li>
          <b>The cause</b>, in a sentence, and an explanation you can open.
        </li>
        <li>
          <b>A category</b>: <Ui>Code</Ui>, <Ui>Test</Ui>, <Ui>Flaky or infra</Ui>, <Ui>Config</Ui> or <Ui>Unclear</Ui>.
        </li>
        <li>
          <b>Confidence</b>, as a percentage. Limn is told to go above 50% only when the log lines it cites show the
          cause.
        </li>
        <li>
          <b>Whether this pull request can fix it.</b> A failure that is not caused by the change says{' '}
          <Ui>Not from this change</Ui>.
        </li>
        <li>
          <b>A suggested fix</b>, when there is one, and the file and line it points at.
        </li>
      </ul>
      <p>
        A chip says when the result is out of date: <Ui>Pushed since</Ui>, <Ui>Changed since</Ui> (other checks fail
        now) or <Ui>Passing now</Ui>.
      </p>
      <p>When Limn cannot read the failure, it says why instead of guessing:</p>
      <ul>
        <li>
          <Ui>The failing checks do not run on GitHub Actions, so there are no logs to read.</Ui> Such checks are listed
          only.
        </li>
        <li>
          <Ui>The failing jobs’ logs could not be read.</Ui>
        </li>
        <li>
          <Ui>Nothing is failing on this commit any more.</Ui>
        </li>
      </ul>

      <H2 id="fix-it">Fix it</H2>
      <p>
        When at least one failure can be fixed in this pull request, <Ui>Fix with AI</Ui> opens the <Ui>AI Fix</Ui> tab
        with just those failures ticked. Nothing changes until you press <Ui>Start fix</Ui>, and nothing is pushed until
        you press <Ui>Push</Ui>. This works even when the pull request has no AI review yet. See{' '}
        <DocLink to="ai-fix/what-to-fix">Choose what to fix</DocLink>.
      </p>
      <p>
        To read the log yourself, see <DocLink to="merging/ci-logs">CI logs</DocLink>.
      </p>

      <H2 id="when-it-runs-by-itself">When it runs by itself</H2>
      <p>
        With auto review on for the workspace, a check that fails on a pull request a person opened is looked at on its
        own, once for each set of failing checks on a commit. Only failures seen after auto review was switched on are
        checked. Automatic CI checks have their own daily limit, 20 per workspace by default, and ask your spend budget
        first. Checks you start never count.
      </p>
      <Warning title="Posting">
        With auto-posting on and <Ui>CI failure reasons, in one PR comment</Ui> ticked under <Ui>What to post</Ui>, the
        causes Limn is more than 50% sure of are posted to the pull request as one comment, once for each set of failing
        checks. A failure that is likely flaky or an infrastructure problem is labelled as such. The section then says{' '}
        <Ui>Posted to the PR automatically.</Ui>
      </Warning>
    </>
  );
}

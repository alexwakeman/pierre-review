import type { DocMeta } from '../../types';
import { Btn, CheckRow, DocLink, H2, H3, Illustration, Log, Note, Pill, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Read CI logs',
  summary: 'Open the failing part of a CI log without leaving Limn, and re-run failed jobs.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A pull request’s checks are listed on its Overview tab, in the <Ui>Status</Ui> row. For a check that runs on
        GitHub Actions, you can open its job log right there, read the end of it where the failure usually is, and
        re-run the failed jobs. Limn also marks checks that look flaky, so you know when a red build is probably not
        your code.
      </p>

      <WhoItHelps
        developer="See why a check failed in two clicks, and re-run a flaky job without opening GitHub Actions."
        manager="Spend less of the team’s time on red builds that are not real failures."
      />

      <H2 id="open-a-log">Open a log</H2>
      <Illustration
        label="The checks list: test-unit failing and flagged Flaky, lint passing; the test-unit log is open at its last lines"
        caption="A failing check with its log open at the end. Scroll up for earlier lines."
      >
        <CheckRow
          name="test-unit"
          state="Failing"
          tone="red"
          note={<Pill tone="amber">Flaky</Pill>}
        />
        <Log
          lines={[
            'FAILED tests/test_refunds.py::test_partial_refund_email',
            'ConnectionResetError: [Errno 104] Connection reset by peer',
            '1 failed, 212 passed in 41.2s',
          ]}
        />
        <CheckRow name="lint" state="Passing" tone="green" />
        <Btn>Re-run failed jobs</Btn> <Btn>Re-run all jobs</Btn>
      </Illustration>
      <Steps>
        <li>
          Open the pull request and stay on the <DocLink to="pull-request/overview-tab">Overview</DocLink> tab.
        </li>
        <li>
          In the <Ui>Status</Ui> row, select a check’s row to show its job log. The log opens at its last lines.
        </li>
        <li>Scroll up to load earlier parts of the log.</li>
        <li>Select the row again to hide the log.</li>
      </Steps>
      <p>
        Logs open for passing checks too, if you want to see what a green check actually ran. A check that does not
        run on GitHub Actions has no log Limn can read, so it is listed with a link to where it runs.
      </p>

      <H2 id="re-run">Re-run jobs</H2>
      <ul>
        <li>
          <Ui>Re-run failed jobs</Ui> re-runs only the failed jobs of the failing workflow runs.
        </li>
        <li>
          <Ui>Re-run all jobs</Ui> re-runs the whole workflow runs from the start.
        </li>
      </ul>
      <p>
        After you press, Limn says “Re-run requested — CI updates on the next sync.” The re-run goes out under your
        GitHub account, so you need push access to the repository.
      </p>

      <H2 id="flaky-checks">Flaky checks</H2>
      <p>A failing check gets a <Ui>Flaky</Ui> chip when either of these is true:</p>
      <ul>
        <li>
          <strong>Passed and failed on this commit:</strong> it passed earlier on the same commit and fails now.
        </li>
        <li>
          <strong>The CI review says: network or infrastructure:</strong> the{' '}
          <DocLink to="ai-review/ci-review">CI review</DocLink> of this commit found the failure was a network or
          infrastructure problem.
        </li>
      </ul>
      <p>
        On the Pending board, a card whose failing checks are all flaky offers <Ui>Re-run failed jobs</Ui> directly.
      </p>
      <Note title="A flaky check is still a failure">
        The chip is a hint. It does not change whether the pull request can merge, and it does not hide the card.
      </Note>

      <H3>Ask AI what went wrong</H3>
      <p>
        While AI is on, the <Ui>CI check</Ui> section of the <Ui>AI Review</Ui> tab reads the failing logs and explains
        the cause; AI Fix can then work on it. See <DocLink to="ai-review/ci-review">CI review</DocLink>.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Most of a red build’s story is in the last lines of one log. Opening that log beside the pull request, and
        knowing whether it is flaky, saves a trip through GitHub Actions for every failure. For what blocks a merge,
        see <DocLink to="merging/can-it-land">Can it land?</DocLink>.
      </p>
    </>
  );
}

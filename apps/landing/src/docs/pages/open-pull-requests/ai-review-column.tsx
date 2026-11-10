import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, H3, Illustration, Note, Pill, PrRow, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'See the AI review on each pull request',
  summary: 'The AI review column shows where Limn\'s review of each pull request stands, and who ran it.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Where the AI features are on, every row on <Ui>Open pull requests</Ui> has an <Ui>AI review</Ui>{' '}
        column. It shows the verdict of the newest AI review of that pull request, or that no review has run.
        The side panel shows the rest of the review and has the one action you need next: <Ui>Review</Ui>,{' '}
        <Ui>Re-review</Ui> or <Ui>Open review</Ui>.
      </p>

      <WhoItHelps
        developer="Start a review of the pull requests nobody has reviewed yet, and see which of yours have findings to fix, without opening each one."
        manager="See which open pull requests have had an AI review, what it said, and whether a teammate already ran one."
      />

      <H2 id="what-you-see">What the column shows</H2>
      <ul>
        <li>
          <b>Not reviewed:</b> no AI review has run on this pull request.
        </li>
        <li>
          <b>
            <Ui>Queued</Ui>
          </b>{' '}
          or{' '}
          <b>
            <Ui>Reviewing…</Ui>
          </b>{' '}
          with a pulsing mark: a review is waiting for a free slot, or running. Several reviews can run at
          once; the rest wait their turn.
        </li>
        <li>
          <b>Review failed:</b> the last run did not finish. <Ui>Review</Ui> starts it again.
        </li>
        <li>
          <b>The verdict:</b> <Ui>Approve</Ui>, <Ui>Request changes</Ui> or <Ui>Comment</Ui>. If a teammate's
          posted review is the newest one, the column shows their name and picture.
        </li>
        <li>
          <b>
            <Ui>Auto review</Ui>
          </b>{' '}
          beside the verdict: the review was started by{' '}
          <DocLink to="ai-review/auto-review">auto review</DocLink>, not by a person.
        </li>
      </ul>

      <H2 id="the-panel">What the side panel adds</H2>
      <p>Select the row. The panel's AI review section can show:</p>
      <ul>
        <li>
          <Ui>Verdict</Ui> and <Ui>Commit</Ui>: the verdict, and whether it was made on the latest commit or
          there are newer commits since.
        </li>
        <li>
          <Ui>Findings</Ui>: the open findings by severity. Findings you chose to ignore are counted apart.
          With none found, it says <Ui>No issues</Ui>.
        </li>
        <li>
          <Ui>Earlier</Ui>: how many findings from the previous review are fixed or still open.
        </li>
        <li>
          <Ui>CI</Ui>: what the CI review says about failing checks, for example "2 CI failures, 1 explained".
        </li>
        <li>
          <Ui>Story check</Ui>: how the change meets its ticket. See{' '}
          <DocLink to="story-checks/overview">Story checks</DocLink>.
        </li>
        <li>
          <Ui>Posted</Ui>: whether the review is on GitHub, for example "2 of 3 posted" or{' '}
          <Ui>Not posted</Ui>.
        </li>
        <li>
          <Ui>Reviewed</Ui> or <Ui>Last run</Ui>: when it ran. <Ui>AI Fix</Ui>: whether a fix is running or
          ready.
        </li>
      </ul>
      <p>A section with nothing to say is left out.</p>

      <Illustration
        label="The AI review part of the side panel for #612: verdict Request changes, two findings, two of three posted, and a Re-review button."
        caption="The AI review part of the side panel."
      >
        <PrRow title="#612 Partial refunds" repo="acme/payments" status={<Pill tone="red">Request changes</Pill>} />
        <FindingRow chip="Major" tone="red">
          RefundPolicy.allows() never reads paid_at.
        </FindingRow>
        <FindingRow chip="Minor" tone="amber">
          Retried refund sends a second email.
        </FindingRow>
        <p className="muted">2 of 3 posted · 2 newer commits · Re-review</p>
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>
            <Ui>Review</Ui>
          </b>{' '}
          starts an AI review with your default provider and settings, where none has run.
        </li>
        <li>
          <b>
            <Ui>Re-review</Ui>
          </b>{' '}
          shows when there are commits newer than the last review.
        </li>
        <li>
          <b>
            <Ui>Open review</Ui>
          </b>{' '}
          (or the verdict) opens the pull request's <DocLink to="pull-request/ai-review-tab">AI Review tab</DocLink>.
        </li>
        <li>
          <b>The AI Fix button</b> opens the <DocLink to="pull-request/ai-fix-tab">AI Fix tab</DocLink> when a fix
          is running or ready.
        </li>
      </ul>
      <p>
        A run started here follows the same rules as one started on the AI Review tab. See{' '}
        <DocLink to="ai-review/run-a-review">Run a review</DocLink>.
      </p>

      <H3>Auto reviews today</H3>
      <p>
        While auto review is on for the workspace, the page's header says how many auto reviews started today
        and when the count resets, for example "7 of 20 auto reviews today · resets in 3h 12m". The day is
        counted in UTC. <Ui>Run auto reviews now</Ui> starts the reviews auto review is due to run, now.
      </p>

      <Warning>
        A review started from this page is not posted to GitHub unless the workspace's auto-posting rules say
        so. See <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting</DocLink>.
      </Warning>

      <Note>
        The column shows only where the AI features are on. Without a Claude or Codex sign-in, the Review
        button is replaced by one line that says what to set up. See{' '}
        <DocLink to="settings/ai">Settings → AI</DocLink>.
      </Note>
    </>
  );
}

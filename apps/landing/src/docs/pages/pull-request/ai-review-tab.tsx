import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, H3, Illustration, Note, Pill, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'AI Review tab',
  summary: 'Run, read and post Limn\'s AI review of this pull request.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI Review</Ui> tab is where you run an AI review of the pull request, read what it found, and
        choose what to post to GitHub. The review runs on your own Claude or Codex sign-in. The number on the tab
        counts the findings that are open now. This page describes the tab; the{' '}
        <DocLink to="ai-review/overview">AI review</DocLink> section explains the review itself.
      </p>


      <H2 id="run-a-review">Run a review</H2>
      <p>
        Under <Ui>Run a review</Ui>, choose a model (or leave the default) and press the run button. The button
        has two modes, on its arrow:
      </p>
      <ul>
        <li>
          <b>
            <Ui>Review only</Ui>
          </b>
          : the review stays in Limn until you post it. This is the default.
        </li>
        <li>
          <b>
            <Ui>Review and post</Ui>
          </b>
          : the review is posted to GitHub when it is done, under your account, following the workspace's posting
          rules.
        </li>
      </ul>
      <p>
        Once a review exists, the button reads <Ui>Re-review only</Ui> or <Ui>Re-review and post</Ui>. Limn
        remembers your last choice. While a review runs, the tab shows its progress and a stop button. See{' '}
        <DocLink to="ai-review/run-a-review">Run a review</DocLink>.
      </p>
      <Warning>
        <Ui>Review and post</Ui> writes to GitHub when the review finishes, without asking again. The tab says
        "Posts to GitHub when done." while it runs.
      </Warning>

      <H2 id="what-you-see">What you see</H2>
      <p>The tab reads top to bottom (on a wide screen, the facts and actions sit in a column on the right):</p>
      <ul>
        <li>
          <b>Where this PR stands</b>: who reviewed it, the verdict, whether it is on the latest commit, and the
          run's cost or share of your subscription.
        </li>
        <li>
          <b>
            <Ui>Summary</Ui>
          </b>
          : what the change does and the review's main points.
        </li>
        <li>
          <b>
            <Ui>Previous review</Ui>
          </b>
          : which earlier findings are fixed, partly fixed or still open. See{' '}
          <DocLink to="ai-review/follow-ups">Follow-up reviews</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Review threads</Ui>
          </b>
          : the AI's judgement of the open threads from people and bots.
        </li>
        <li>
          <b>
            <Ui>Findings</Ui>
          </b>
          : each finding with its severity, the code it is about, and who raised it.
        </li>
        <li>
          <b>
            <Ui>Story check</Ui>
          </b>
          , the CI check, <Ui>SonarCloud</Ui> and <Ui>Reference docs</Ui>, where those are set up. See{' '}
          <DocLink to="story-checks/overview">Story checks</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Design</Ui>
          </b>
          : diagrams of the change. See <DocLink to="ai-review/design-diagrams">Design diagrams</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Review chat</Ui>
          </b>
          : ask about the review. See <DocLink to="ai-review/review-chat">Review chat</DocLink>.
        </li>
      </ul>

      <Illustration
        label="The AI Review tab's findings for #612: one Major, one Minor and one Nit finding."
        caption="Findings on the AI Review tab."
      >
        <p style={{ margin: '0 0 6px' }}>
          <Pill tone="red">Request changes</Pill> <span className="muted">On latest commit · Claude</span>
        </p>
        <FindingRow chip="Major" tone="red">
          RefundPolicy.allows() never reads paid_at.
        </FindingRow>
        <FindingRow chip="Minor" tone="amber">
          Retried refund sends a second email.
        </FindingRow>
        <FindingRow chip="Nit" tone="grey">
          Unused import in policy.py.
        </FindingRow>
      </Illustration>

      <H2 id="post-to-github">Post to GitHub</H2>
      <p>
        Tick the findings to keep, reword any of them, write or edit the summary, and choose the verdict. Use the
        preview, then post. Everything you post goes to GitHub as one review under your account. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting</DocLink>.
      </p>
      <H3>Fix what it found</H3>
      <p>
        <Ui>Generate fix from this review</Ui> hands the review's findings to the{' '}
        <DocLink to="pull-request/ai-fix-tab">AI Fix tab</DocLink>, where you choose what to fix.
      </p>

      <Note>
        The tab shows only where the AI features are on. With no Claude or Codex sign-in, the run button is
        replaced by one line that says what to set up. See <DocLink to="settings/ai">Settings → AI</DocLink>.
      </Note>
    </>
  );
}

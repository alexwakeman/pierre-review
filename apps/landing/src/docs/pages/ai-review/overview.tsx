import type { DocMeta } from '../../types';
import {
  Btn,
  Chip,
  DocLink,
  FindingRow,
  H2,
  Illustration,
  Note,
  Tabs,
  Ui,
  Warning,
  } from '../../kit';

export const meta: DocMeta = {
  title: 'How AI review works',
  summary: 'Limn reviews a pull request with Claude or Codex on your own account. Nothing is posted until you say so.',
};

function ReviewPicture(): JSX.Element {
  return (
    <Illustration
      label="The AI Review tab of pull request 612, Partial refunds. The verdict is Request changes. A review by Claude + Codex found one blocker, one warning and one nit."
      caption="The AI Review tab after a review: the verdict, then the findings."
      title="#612 Partial refunds"
      meta="acme/payments"
    >
      <Tabs
        tabs={[
          { label: 'Overview' },
          { label: 'Activity' },
          { label: 'Threads' },
          { label: 'Changes' },
          { label: 'AI Review', count: 3, on: true },
          { label: 'AI Fix' },
        ]}
      />
      <p>
        <Chip tone="red">Request changes</Chip> <Chip>Claude + Codex</Chip>
      </p>
      <FindingRow chip="Blocker" tone="red">
        RefundPolicy.allows() never reads paid_at, so refunds older than 30 days still go through.
      </FindingRow>
      <FindingRow chip="Warning" tone="amber">
        A retried refund sends the customer a second email.
      </FindingRow>
      <FindingRow chip="Nit">Unused import in refunds/policy.py.</FindingRow>
      <p>
        <Btn>Re-review only</Btn> <Btn tone="go">Post to GitHub</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        An AI review reads a pull request the way a careful teammate would: the change, the code around it and,
        when there is one, the ticket it delivers. It then gives a verdict, a short summary and a list of findings,
        each tied to a file and a line where it can be. The review runs on your computer, with your own Claude or
        Codex sign-in. Limn charges nothing for it.
      </p>

      <H2 id="where-it-lives">Where it lives</H2>
      <p>
        Open any pull request and choose the <Ui>AI Review</Ui> tab. Everything about AI review for that pull request
        is on this one tab: the run controls, the latest review, earlier reviews, the review threads, the{' '}
        <Ui>CI check</Ui>, the <Ui>Story check</Ui>, the design diagram and the <Ui>Review chat</Ui>. The{' '}
        <DocLink to="open-pull-requests/ai-review-column">AI review column on Open pull requests</DocLink> and the{' '}
        <DocLink to="pending/ai-reviews">AI reviews tab on Pending</DocLink> show the same reviews across the
        workspace.
      </p>
      <ReviewPicture />

      <H2 id="what-a-review-does">What a review does</H2>
      <p>When a review starts, Limn first decides how much reading the change needs. You do not choose this.</p>
      <ul>
        <li>
          <Ui>Deep review</Ui>: the reviewer has a copy of the repository at the pull request's latest commit, so it
          can open other files, follow callers and check how the change fits. On a deep review it may also ask up to
          three specialists for a second look: design, tests, impact on other code, security, performance and, when
          the change touches screens, accessibility.
        </li>
        <li>
          <Ui>Quick review</Ui>: for a small change that touches nothing other code depends on, the reviewer reads
          the diff alone. It is faster and uses less of your subscription.
        </li>
        <li>
          <Ui>Skipped</Ui>: when there is no change to the code to read, no model reads anything. On a review you
          start, the open review threads are still checked.
        </li>
      </ul>
      <p>
        The reviewer can read code. It cannot change files, run commands or reach the web. Anything it reads from the
        pull request (the description, comments, the code) is treated as text to judge, never as instructions to
        follow.
      </p>

      <H2 id="what-you-get">What you get</H2>
      <ul>
        <li>
          <b>A verdict</b>: <Ui>Approve</Ui>, <Ui>Comment</Ui> or <Ui>Request changes</Ui>. It is a suggestion until
          a review is posted. See <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
        </li>
        <li>
          <b>A summary</b>: one plain sentence, then a bullet for each main issue, most serious first.
        </li>
        <li>
          <b>Findings</b>, each with a severity: <Ui>Blocker</Ui> (must change before merge), <Ui>Warning</Ui> (should
          change), <Ui>Nit</Ui> (small and optional) and <Ui>Question</Ui> (the reviewer asks the author something).
          A finding that cannot be placed on a line becomes a comment on the whole pull request.
        </li>
        <li>
          <b>A follow-up</b> of earlier findings when the pull request was reviewed before. See{' '}
          <DocLink to="ai-review/follow-ups">Follow-up reviews</DocLink>.
        </li>
        <li>
          <b>A judgement of other people's threads</b>: whether each comment holds up and whether the code now deals
          with it. See <DocLink to="ai-review/check-threads">Check threads</DocLink>.
        </li>
      </ul>
      <p>
        Beside the review, and as separate runs, Limn can explain failing CI (
        <DocLink to="ai-review/ci-review">CI review</DocLink>), check the pull request against its ticket (
        <DocLink to="story-checks/overview">Story checks</DocLink>) and draw how data moves through the change (
        <DocLink to="ai-review/design-diagrams">Design diagrams</DocLink>).
      </p>

      <H2 id="claude-codex-or-both">Claude, Codex or both</H2>
      <p>
        Limn reviews with Claude, with Codex, or with both at once. With both signed in, the default is{' '}
        <Ui>Claude + Codex</Ui>: the two review the same commit without seeing each other, and Limn merges what they
        found into one review. See <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>. To
        sign in, see <DocLink to="integrations/claude">Claude</DocLink> and{' '}
        <DocLink to="integrations/codex">Codex</DocLink>.
      </p>

      <H2 id="nothing-posts-until-you-say-so">Nothing posts until you say so</H2>
      <p>
        A review you start with <Ui>Review only</Ui> stays in Limn. You read it, change the wording, set findings
        aside and post when you are ready. A review you start with <Ui>Review and post</Ui> goes to GitHub, under your
        account, when it finishes.
      </p>
      <Warning title="The one exception: automatic reviews">
        When you switch on auto review for a workspace, its reviews post to GitHub by themselves unless you choose{' '}
        <Ui>Keep it in Limn</Ui>. Auto review is off until you switch it on. See{' '}
        <DocLink to="ai-review/auto-review">Auto review</DocLink>.
      </Warning>

      <H2 id="what-it-costs">What it costs</H2>
      <p>
        Every review runs on your own Claude Code login or Anthropic API key, or on your own ChatGPT sign-in for
        Codex. Limn charges nothing and stores no key. While a review runs, the tab shows the tokens used so far and,
        on an API key, an estimate in US dollars. On a subscription, Limn shows your share of the week instead.
        Automatic runs stop when your spend budget is used up. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </p>
      <Note>
        How hard each review works is one setting for Claude and Codex together: <Ui>Settings → AI</Ui>,{' '}
        <Ui>Effort for reviews and AI Fix</Ui>. Higher effort reads more and finds more, and uses more of your
        subscription. See <DocLink to="ai-review/run-a-review#effort">Run a review</DocLink>.
      </Note>
    </>
  );
}

import type { DocMeta } from '../../types';
import {
  Btn,
  Chip,
  DocLink,
  FindingRow,
  H2,
  H3,
  Illustration,
  Note,
  Steps,
  Tip,
  Toolbar,
  Ui,
  Warning,
  WhoItHelps,
} from '../../kit';

export const meta: DocMeta = {
  title: 'Run a review',
  summary: 'Start a review, pick the provider and model, and read the findings.',
};

function RunControls(): JSX.Element {
  return (
    <Illustration
      label="The Run a review controls: a Model menu set to Claude + Codex, then a split button that reads Review only, with a caret that offers Review and post."
      caption="Run a review: pick the model, then press Review only, or open the caret for Review and post."
    >
      <p>
        <b>Run a review</b>
      </p>
      <Toolbar>
        <Chip>Model: Claude + Codex</Chip>
        <Btn tone="go">Review only ▾</Btn>
      </Toolbar>
      <FindingRow chip="Review only">Kept in Limn</FindingRow>
      <FindingRow chip="Review and post">Posts when done</FindingRow>
    </Illustration>
  );
}

function RunningLine(): JSX.Element {
  return (
    <Illustration
      label="A review in progress: the status line says Reviewing, a Deep review chip, a Stop button and the tokens used so far."
      caption="While a review runs: what it is doing, how deep it goes, and what it has used so far."
    >
      <Toolbar>
        <span>Reviewing · 2 min</span>
        <Chip tone="blue">Deep review</Chip>
        <Btn>Stop</Btn>
      </Toolbar>
      <p className="muted">↓ 18k out · ↑ 41k in · 310k cache</p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        You start a review from the pull request's <Ui>AI Review</Ui> tab. You choose who reviews and whether the
        result stays in Limn or goes to GitHub when it is done. This page walks through one review from start to
        post.
      </p>
      <WhoItHelps
        developer="Review your own pull request before you ask for a human review, or get a second opinion on a teammate's."
        manager="The same steps for everyone, and a record of every review on the pull request."
      />

      <H2 id="before-you-start">Before you start</H2>
      <ul>
        <li>
          AI must be on for this machine and you must be signed in to Claude, Codex or both. If something is missing,
          the <Ui>AI Review</Ui> tab shows one line in place of the Run button that says what to do. See{' '}
          <DocLink to="settings/ai">Settings → AI</DocLink>.
        </li>
        <li>
          The first time, Limn downloads the AI runtimes in the background. Signing in is the only step for you.
        </li>
      </ul>

      <H2 id="start-a-review">Start a review</H2>
      <RunControls />
      <Steps>
        <li>
          Open the pull request and choose the <Ui>AI Review</Ui> tab.
        </li>
        <li>
          In <Ui>Run a review</Ui>, open the <Ui>Model</Ui> menu and pick who reviews. The menu lists each signed-in
          provider's models, most thorough first, for example <Ui>Claude Opus 5.5 (most thorough)</Ui>. With both
          Claude and Codex signed in, <Ui>Claude + Codex</Ui> is last in the list and is the default.
        </li>
        <li>
          Press <Ui>Review only</Ui> to keep the result in Limn. To post it when it finishes, open the caret beside
          the button and choose <Ui>Review and post</Ui>. The button remembers your last choice.
        </li>
      </Steps>
      <Warning>
        <Ui>Review and post</Ui> posts the review to GitHub under your account when it is done, the same way an
        automatic review posts: one review, with your workspace's rules for what is posted and which verdict is
        allowed. The workspace's auto-post switch does not need to be on. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </Warning>
      <Tip>
        You can also start a review from <Ui>Open pull requests</Ui>, without opening the pull request. See{' '}
        <DocLink to="open-pull-requests/ai-review-column">The AI review column</DocLink>.
      </Tip>

      <H2 id="while-it-runs">While it runs</H2>
      <RunningLine />
      <p>
        A status line says what the reviewer is doing (for example <Ui>Fetching the diff</Ui>,{' '}
        <Ui>Cloning the worktree</Ui>, <Ui>Reviewing</Ui>, <Ui>Saving findings</Ui>) and how long it has taken. A chip
        says the depth Limn chose: <Ui>Deep review</Ui> or <Ui>Quick review</Ui> (see{' '}
        <DocLink to="ai-review/overview#what-a-review-does">How AI review works</DocLink>). Under it, a short log
        shows what the reviewer is reading, and the tokens used so far. With an API key, an estimate of the cost
        appears too. Limn charges nothing; the figure recorded when the run finishes is the one that counts.
      </p>
      <p>
        Press <Ui>Stop</Ui> to end the run. You can leave the tab or open another pull request while it runs. A
        Claude + Codex review says which half is running, then <Ui>Merging the two reviews…</Ui> at the end.
      </p>
      <Note>
        If a teammate's Limn is already reviewing the same commit with the same model, the tab names them. Your
        review still goes ahead. See <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
      </Note>

      <H2 id="read-the-findings">Read the findings</H2>
      <p>
        The finished review opens with its verdict, a fact line (the commit it read, for example{' '}
        <Ui>On latest commit · abc1234</Ui>, the model and the effort) and the summary. The findings follow, most
        serious first. Each finding names its file and line, says what is wrong and why, and may carry a suggested
        change.
      </p>
      <p>On each finding you can:</p>
      <ul>
        <li>
          <Ui>Reword</Ui> it. Your wording is what posts; the reviewer's stays beside it. After a reword the button
          reads <Ui>Edit wording</Ui>.
        </li>
        <li>
          <Ui>Ignore</Ui> it, so it is left out of the review you post and out of AI Fix.
        </li>
        <li>
          <Ui>Copy</Ui> it as Markdown, or use <Ui>Copy all</Ui> for every finding you kept.
        </li>
        <li>
          <Ui>Send to chat</Ui> to ask about it in the <Ui>Review chat</Ui>. See{' '}
          <DocLink to="ai-review/review-chat">Ask about a review</DocLink>.
        </li>
        <li>
          Show it in the <Ui>Changes</Ui> tab, or open the line on GitHub.
        </li>
        <li>
          Post it alone with <Ui>Post as comment</Ui> (on its line) or <Ui>Post as PR comment</Ui> (when it has no
          line). Once posted, the finding shows <Ui>Posted</Ui> with a link, and it cannot be posted twice.
        </li>
      </ul>
      <p>
        On a pull request that was reviewed before, a <Ui>Previous review</Ui> section says which earlier findings
        are fixed. A finding marked <Ui>Raised in the previous review</Ui> is one that is still open. See{' '}
        <DocLink to="ai-review/follow-ups">Follow-up reviews</DocLink>.
      </p>

      <H2 id="post-your-review">Post your review</H2>
      <p>
        <Ui>Post to GitHub</Ui> sends one review: your summary as its top comment, with the verdict you pick, and
        every finding you have not ignored or already posted, each on its line.
      </p>
      <Steps>
        <li>
          Edit the summary box. After a <Ui>Review only</Ui> run it is filled with the reviewer's summary. It takes
          Markdown, and <Ui>@</Ui> mentions a teammate. <Ui>Save draft</Ui> keeps it without posting.
        </li>
        <li>
          Pick the <Ui>Verdict</Ui>: <Ui>Comment</Ui>, <Ui>Request changes</Ui> or <Ui>Approve</Ui>. The reviewer's
          verdict is chosen for you; you can change it.
        </li>
        <li>
          Press <Ui>Post to GitHub</Ui>, then <Ui>Confirm post</Ui>.
        </li>
      </Steps>
      <Note>
        GitHub never lets the author of a pull request approve it or request changes on it. On your own pull request,
        post as a comment.
      </Note>

      <H2 id="run-it-again">Run it again</H2>
      <p>
        After new commits, the header says how far behind the review is (for example <Ui>2 newer commits</Ui>) and
        the Run button becomes the main action again, labelled <Ui>Re-review only</Ui> or{' '}
        <Ui>Re-review and post</Ui>. A re-review follows up the earlier findings rather than starting over.
      </p>
      <p>
        If you run a review on a commit that already has one, Limn says <Ui>This commit is already reviewed.</Ui> and
        asks you to press <Ui>Run anyway</Ui> or <Ui>Cancel</Ui>.
      </p>
      <H3>Earlier reviews</H3>
      <p>
        <Ui>Reviews on this PR</Ui> lists every review: yours, automatic ones and your teammates' posted reviews, with
        the verdict, date and commit of each. Pick one to read it. Only the latest review can be edited and posted;
        an earlier one is shown as <Ui>An earlier review · read-only</Ui>.
      </p>

      <H2 id="effort">Effort</H2>
      <p>
        <Ui>Settings → AI</Ui> has one setting, <Ui>Effort for reviews and AI Fix</Ui>, for both providers:{' '}
        <Ui>Default</Ui>, <Ui>Low</Ui>, <Ui>Medium</Ui>, <Ui>High</Ui>, <Ui>Extra high</Ui> and <Ui>Max</Ui>. Higher
        effort reads more and finds more, and uses more of your subscription or costs more.
      </p>
      <ul>
        <li>
          It reaches every review (AI Review, the CI review, the story check and Check threads), AI Fix and Implement
          story.
        </li>
        <li>
          <Ui>Default</Ui> runs Claude at medium and Codex at high on its most thorough model.
        </li>
        <li>
          A quick review of a small change can run one level lower, but never below what <Ui>Default</Ui> would use
          unless you pick a lower level.
        </li>
        <li>Each review shows the effort it used beside its model, for example "Claude Opus 5.5 · high".</li>
      </ul>
    </>
  );
}

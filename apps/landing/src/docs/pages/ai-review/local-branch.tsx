import type { DocMeta } from '../../types';
import { DocLink, H2, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Review a local branch from Claude Code or Codex (MCP)',
  summary:
    'Add Ensemble to Claude Code or Codex as an MCP server, and your coding agent can ask Ensemble to review the branch it is working on before anything is pushed.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Your coding agent writes the code; Ensemble reviews it, with the same review it gives a pull request. You do not
        need to push or open a pull request first. The agent asks, waits for the result, fixes what applies, and asks
        again. Ensemble must be running on your machine (<code>npx ensemble-review</code>).
      </p>

      <H2 id="set-it-up">Set it up</H2>
      <Steps>
        <li>
          Start Ensemble, and make sure the repository is in one of your workspaces and has finished its first sync.
        </li>
        <li>
          Claude Code: in a terminal, run <code>claude mcp add ensemble -- npx ensemble-review mcp</code>.
        </li>
        <li>
          Codex: add this to <code>~/.codex/config.toml</code>:
          <pre className="mk-diff">
            {'[mcp_servers.ensemble]\ncommand = "npx"\nargs = ["ensemble-review", "mcp"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 120'}
          </pre>
          The two timeouts give <code>npx</code> time to download Ensemble the first time, and a review time to start.
        </li>
        <li>Start a new session of the agent in your repository. Ask it to review the branch with Ensemble.</li>
      </Steps>
      <Note>
        The MCP server does not start Ensemble. If Ensemble is not running, every tool answers{' '}
        <Ui>Ensemble is not running. Start it with: npx ensemble-review</Ui>. If AI is off in Ensemble, the tools say so.
      </Note>

      <H2 id="what-is-reviewed">What is reviewed</H2>
      <ul>
        <li>
          The commits on your branch since the base: the branch's upstream when it is stacked on another branch, else
          the default branch on GitHub. The agent can name another base.
        </li>
        <li>
          Your uncommitted changes to files git already tracks, unless the agent turns them off. Files git does not
          track are never sent.
        </li>
        <li>
          The acceptance criteria, when Ensemble finds the ticket: in the branch name or a commit message (the branch
          name only when your workspace has project keys set in its tracker settings). Otherwise the agent passes the
          ticket key.
        </li>
      </ul>
      <p>
        Ensemble packs the branch as a git bundle and sends it to the copy of the repository it keeps. It never writes
        to your repository. The base commit must already be on GitHub. A changed file that uses a git filter, such as
        Git LFS, is reviewed as last committed.
      </p>

      <H2 id="the-tools">The tools your agent gets</H2>
      <ul>
        <li>
          <Ui>review_local_branch</Ui>: start a review. It returns an id at once; a review takes a few minutes.
        </li>
        <li>
          <Ui>get_local_review</Ui>: the result: each finding with its file, line, severity, title and text, and each
          acceptance criterion with its status. While the review runs, it waits up to 50 seconds per call.
        </li>
        <li>
          <Ui>check_story</Ui>: check the acceptance criteria only, with no code review.
        </li>
        <li>
          <Ui>list_local_reviews</Ui> and <Ui>cancel_local_review</Ui>.
        </li>
      </ul>
      <p>
        One review of a branch runs at a time. If the agent starts another while one runs, it gets the running one.
      </p>

      <H2 id="who-reviews">Who reviews</H2>
      <p>
        The same reviewers as a review you start: <DocLink to="settings/ai#run-settings">Settings → AI → Review</DocLink>.
        With Claude and Codex both on and signed in, both review and you get one merged review (see{' '}
        <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>). The agent can ask for one of
        them, or another effort, for one review.
      </p>

      <H2 id="answer-and-review-again">Answer and review again</H2>
      <p>
        When the agent reviews the branch again, it can answer the last review: each finding (<Ui>fixed</Ui>,{' '}
        <Ui>answered</Ui>, <Ui>pushed_back</Ui>) and each open criterion (<Ui>fixed</Ui>, <Ui>not_applicable</Ui>,{' '}
        <Ui>cannot_meet</Ui>), always with a reason. The next review checks each answer, as a{' '}
        <DocLink to="ai-review/follow-ups">follow-up review</DocLink> does. A criterion the agent cannot meet stays not
        met, with its reason.
      </p>

      <H2 id="from-the-terminal">From the terminal</H2>
      <p>
        <code>ensemble review</code> does the same in your terminal and prints the result. Add <code>--json</code> for
        the same fields the tools return, <code>--no-uncommitted</code> to leave out uncommitted changes,{' '}
        <code>--ticket PAY-142</code> to name the ticket, and <code>--story</code> to check the criteria only. Press{' '}
        <code>Ctrl-C</code> to stop the review.
      </p>

      <H2 id="what-ensemble-writes">What Ensemble writes</H2>
      <p>
        Nothing on GitHub, and nothing in your repository. A local review is never posted, pushed or fixed, does not
        start an AI Fix, and adds no card to Pending. It counts as a review you started: the AI spend limit never stops
        it, and its use shows in <DocLink to="reports/ai-usage">Reports → AI usage</DocLink>.
      </p>
      <Warning>
        A review runs on your Claude or Codex account and uses your allowance, like any review you start.
      </Warning>
    </>
  );
}

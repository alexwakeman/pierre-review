import type { DocMeta } from '../../types';
import { BotsSeverityMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, Kbd, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'What Bots Monitoring shows',
  summary: 'Every review bot in the workspace, what it flags, how often people act on it, and what it costs.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Most teams now have several bots commenting on their pull requests: AI reviewers such as CodeRabbit, Copilot
        or Greptile, quality gates such as SonarCloud, and dependency bots such as Dependabot. <Ui>Bots Monitoring</Ui>{' '}
        is where you find out which of them earn their place. It measures what each review bot says, how serious it
        is, how often your team acts on it, and what it costs, for every repository in the workspace.
      </p>


      <H2 id="the-tabs">The tabs</H2>
      <ul>
        <li>
          <DocLink to="bots-monitoring/roi">ROI</DocLink>: one row per bot, with its threads, how many were used, how
          many were left, the severity mix, the cost per used thread and a verdict: <Ui>Keep</Ui>, <Ui>Tune</Ui> or{' '}
          <Ui>Rarely used</Ui>.
        </li>
        <li>
          <DocLink to="bots-monitoring/themes">Themes</DocLink>: what the bots keep raising, grouped into themes by AI.
          Shown only while AI is on.
        </li>
        <li>
          <DocLink to="bots-monitoring/benchmark">Benchmark</DocLink>: how each bot does for you against the same bot
          in other teams’ repositories of a similar size.
        </li>
      </ul>
      <p>
        Press <Kbd>1</Kbd>, <Kbd>2</Kbd> or <Kbd>3</Kbd> to switch tabs. A repository’s own page has a{' '}
        <Ui>Bots</Ui> tab with the same three views, measured over that repository alone (see{' '}
        <DocLink to="getting-started/repository-pages">Repository pages</DocLink>).
      </p>

      <H2 id="what-the-bots-are-flagging">What the bots are flagging</H2>
      <p>
        On the <Ui>ROI</Ui> tab, a summary strip counts the bots’ findings in the window: how many there were, the
        share that is high severity (major plus critical), the share of nits and the top topic. Each bot’s row opens
        its breakdown. The picture below is a working model with made-up data.
      </p>
      <BotsSeverityMock />
      <p>
        The severity and topic come from a small model that runs on your computer, not from the bot’s own label. See{' '}
        <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
      </p>

      <H2 id="callouts">The two callouts</H2>
      <H3>Only a bot reviewed</H3>
      <p>
        When open pull requests have had a review from a bot and none from a person, a callout says how many. Select{' '}
        <Ui>Show list →</Ui> to see them. Consider a human pass before they merge.
      </p>
      <H3>Likely-addressed bot threads</H3>
      <p>
        When later commits look as if they dealt with bot threads that are still open, a second callout counts them.
        Select <Ui>Show list →</Ui> to review them and resolve them on GitHub in one go. “Looks addressed” is a guess
        (a commit touched the file after the comment), so check each one before you resolve it.
      </p>

      <H2 id="which-accounts-are-bots">Which accounts count as bots</H2>
      <p>
        Limn recognises most bots by their GitHub account and how they behave, and gives each one a category:{' '}
        <Ui>Review bot</Ui>, <Ui>Quality check</Ui>, <Ui>Dependency updates</Ui>, <Ui>Code agent</Ui>,{' '}
        <Ui>Release automation</Ui> or <Ui>Housekeeping</Ui>. Only review bots are measured on the ROI table; quality
        checks are listed apart, because nobody is meant to reply to them. To change a bot’s category, mark an
        account as a bot or a person, or set its price, open{' '}
        <DocLink to="settings/bots">Settings → Bots</DocLink>.
      </p>
      <Note title="Price is per workspace">
        A bot’s price is set for each workspace. If the same bot works for two workspaces, each holds its own price,
        and Limn never adds them together.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Choose <Ui>Bots Monitoring</Ui> in the sidebar.
        </li>
        <li>
          Pick a window on the ROI tab: <Ui>7d</Ui>, <Ui>14d</Ui>, <Ui>30d</Ui> or <Ui>Sprint</Ui>. The other tabs use
          the same window.
        </li>
        <li>Select a bot’s name to open its comments and the pull requests it touched.</li>
        <li>
          Select <Ui>Depth →</Ui> on a bot’s row for its response times, coverage, consistency and severity over
          time.
        </li>
      </Steps>
      <p>
        A bot’s activity, comment by comment, is on the <DocLink to="feed/people-and-bots">Feed</DocLink>’s Bots side.
        A single pull request’s bots are on its <DocLink to="pull-request/bot-activity">Bot activity</DocLink> tab.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A bot that comments on everything trains people to ignore it, and its useful comments get lost. Bots
        Monitoring shows you the signal-to-noise of each one, in numbers you can check comment by comment, so you can
        tune or drop the noisy ones and keep the ones your team acts on.
      </p>
    </>
  );
}

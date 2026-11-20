import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Kbd, MiniTable, Pill, Steps, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'ROI',
  summary: 'What each bot is worth: comments people acted on, set against its price.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>ROI</Ui> tab is the first tab of Bots Monitoring. It has one row per review bot in the workspace. Each
        row says how much the bot said in the window you picked, how much of it your team used, how much was left
        unanswered, how serious its findings were and, if you entered its price, what each useful thread cost. A
        verdict sums it up.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The ROI table: CodeRabbit with 132 threads, 58% used, verdict Keep; Greptile with 125 threads, 39% used, verdict Tune"
        caption="Part of the ROI table. Click a bot's name for its own charts."
      >
        <MiniTable
          cols={[
            { key: 'bot', label: 'Bot' },
            { key: 'threads', label: 'Threads', num: true },
            { key: 'used', label: 'Used', num: true },
            { key: 'na', label: 'Not addressed', num: true },
            { key: 'cost', label: '$ per used thread', num: true },
            { key: 'v', label: 'Verdict' },
          ]}
          rows={[
            { _key: 'cr', bot: 'CodeRabbit', threads: '132', used: '77', na: '55', cost: '$0.45', v: <Pill tone="green">Keep</Pill> },
            { _key: 'gr', bot: 'Greptile', threads: '125', used: '49', na: '76', cost: '$0.92', v: <Pill tone="amber">Tune</Pill> },
            { _key: 'bb', bot: 'Cursor Bugbot', threads: '41', used: '9', na: '32', cost: '$3.10', v: <Pill tone="red">Rarely used</Pill> },
          ]}
        />
      </Illustration>
      <H3>The two tiles</H3>
      <p>Above the table, two tiles cover every review bot in the workspace together, over the window you picked.</p>
      <ul>
        <li>
          <Ui>Time to first review</Ui>: the median time from a pull request being ready for review (or opened, when
          that was not seen) to the first review or comment by any review bot. Below it: the p90 and the number of
          pull requests.
        </li>
        <li>
          <Ui>Follow-ups after first review</Ui>: the share of those pull requests where a review bot posted again,
          and the average number of extra posts. A second bot’s first pass counts as a follow-up, and so does each
          inline comment posted with a review.
        </li>
      </ul>
      <p>A tile shows “—” when no pull request was reviewed by a bot in the window.</p>
      <H3>The columns</H3>
      <ul>
        <li>
          <Ui>Threads</Ui>, <Ui>Comments</Ui> and <Ui>Comments/PR</Ui>: how much the bot says, and how much it says on
          each pull request it comments on.
        </li>
        <li>
          <Ui>Used</Ui>: threads the team used. A thread counts as used if it was resolved, a person replied after the
          bot’s last comment, or a later commit touched its file. The commit test is a guess: the commit may have
          changed something else.
        </li>
        <li>
          <Ui>Not addressed</Ui>: still unresolved, nobody replied and no later commit touched the file. A thread
          counts as unanswered only once it is older than 36 hours, so a bot is not marked down for threads nobody
          has reached yet.
        </li>
        <li>
          <Ui>Merged anyway</Ui>: pull requests that merged with at least one of the bot’s threads not addressed.
        </li>
        <li>
          <Ui>Time to address</Ui> and <Ui>% not addressed</Ui>.
        </li>
        <li>
          <Ui>First review</Ui> and <Ui>Follow-ups</Ui>: the two tiles’ figures for this bot alone. Hover a cell for
          the p90 or the average.
        </li>
        <li>
          <Ui>Overlap</Ui>: the share of the bot’s threads within three lines of another bot’s thread in the same file.
          A high figure means two bots say the same thing.
        </li>
        <li>
          <Ui>Severity mix</Ui> and <Ui>Inflation</Ui>: from Ensemble’s own severity model (see{' '}
          <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>). These columns appear once comments
          have been scored.
        </li>
        <li>
          <Ui>$ per used thread</Ui>: the bot’s monthly price divided by the used threads it produces in a month, at
          this window’s rate.
        </li>
      </ul>

      <H2 id="the-verdicts">The verdicts</H2>
      <ul>
        <li>
          <Ui>Rarely used</Ui>: at least 10 threads, under 30% used, and at least half unanswered.
        </li>
        <li>
          <Ui>Tune</Ui>: at least 5 threads and under 60% used, or at least 20 scored findings of which 70% or more
          are nits.
        </li>
        <li>
          <Ui>Keep</Ui>: everything else.
        </li>
      </ul>
      <p>
        For a priced bot marked <Ui>Rarely used</Ui>, a line under the table says what turning it off would save in a
        year (its monthly price times 12). Tuning suggestions under the table name the bot and the paths where most
        of its comments go unused, so you can narrow what it reviews.
      </p>

      <H2 id="set-a-price">Set a bot’s price</H2>
      <Steps>
        <li>
          Open <DocLink to="settings/bots">Settings → Bots</DocLink>.
        </li>
        <li>Find the bot’s card and enter its price, per month or per seat.</li>
        <li>
          Return to <Ui>Bots Monitoring</Ui>. The <Ui>$ per used thread</Ui> column now shows a figure for that bot.
        </li>
      </Steps>
      <p>
        A price is set per workspace, and another workspace can hold a different price for the same bot. The two are
        never added together. The cost column shows only on the Bots Monitoring page, not on a single repository’s
        Bots tab, because one repository’s share of a workspace price is not a real cost.
      </p>

      <H2 id="bot-charts">Charts</H2>
      <p>
        Above the table: <Ui>Thread volume</Ui>, <Ui>Time to first review</Ui> and <Ui>Follow-up rate</Ui>, each
        weekly for the last 12 weeks, one line per review bot.
      </p>
      <p>
        Click a bot’s name for its own charts: response times, coverage, consistency and severity over time.
      </p>
      <H3>Show one bot</H3>
      <p>
        Click a bot in a chart’s legend to show only that bot. The other bots fade in every chart on the page. Click
        it again to show all. Each Ensemble account (“Ensemble · alice”) has its own shade of orange, and each account
        of a bot with several accounts has its own shade of that bot’s colour.
      </p>

      <H2 id="workspace-charts">Workspace charts</H2>
      <p>
        At the bottom of the tab, open <Ui>Workspace charts</Ui> for <Ui>Bot effectiveness</Ui> (the share of threads
        used, by verdict), <Ui>Used vs not addressed</Ui> (by bot, for this window), <Ui>Findings density</Ui>,{' '}
        <Ui>Where bots work</Ui>, <Ui>PR size vs bot comment volume</Ui> and the overlap between bots.
      </p>
      <Tip>
        Press <Kbd>⌘K</Kbd> and type “Bots: measure” to change the window, or “Bots: open PRs only a bot reviewed” to
        see the pull requests no person has looked at.
      </Tip>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A bot’s vendor tells you how many comments it wrote. This tab tells you how many your team used, at what
        price, and how much went unread. That is the figure you need when a renewal comes round. To see how the same
        bot does for other teams, open <DocLink to="bots-monitoring/benchmark">Benchmark</DocLink>.
      </p>
    </>
  );
}

import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Kbd, MiniTable, Pill, Steps, Tip, Ui, WhoItHelps } from '../../kit';

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

      <WhoItHelps
        developer="Know which bot’s threads are usually worth a reply, and which ones the team ships past."
        manager="See the cost of each bot per thread your team actually used, and which bots to tune or turn off."
      />

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The ROI table: CodeRabbit with 132 threads, 58% used, verdict Keep; Greptile with 125 threads, 39% used, verdict Tune"
        caption="Part of the ROI table. Each figure opens the threads or pull requests behind it."
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
          counts as <Ui>Unanswered</Ui> only once it is older than 36 hours, so a bot is not marked down for threads
          nobody has reached yet.
        </li>
        <li>
          <Ui>Merged anyway</Ui>: pull requests that merged with at least one of the bot’s threads not addressed.
        </li>
        <li>
          <Ui>Time to address</Ui>, <Ui>Oldest not addressed</Ui> and <Ui>% not addressed</Ui>.
        </li>
        <li>
          <Ui>Overlap</Ui>: the share of the bot’s threads within three lines of another bot’s thread in the same file.
          A high figure means two bots say the same thing.
        </li>
        <li>
          <Ui>Severity mix</Ui>, <Ui>High</Ui>, <Ui>Nits</Ui>, <Ui>Not addressed by severity</Ui> and{' '}
          <Ui>Inflation</Ui>: from Limn’s own severity model (see{' '}
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

      <H2 id="workspace-charts">Workspace charts</H2>
      <p>
        At the bottom of the tab, open the charts for <Ui>Thread volume</Ui> (weekly, for the last 12 weeks),{' '}
        <Ui>Bot effectiveness</Ui> (the share of threads used, by verdict) and <Ui>Used vs not addressed</Ui> (by bot,
        for this window).
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

import type { DocMeta } from '../../types';
import { BenchmarkMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, MiniTable, Note, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Benchmark',
  summary: 'How your bots compare with the same bots in similar-sized repositories, and when Limn refuses to compare.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Benchmark</Ui> tab of Bots Monitoring compares each of your review bots with the same bot running in
        other teams’ repositories of a similar size. It answers questions your own data cannot: is CodeRabbit this
        noisy for everyone, or only for us? Do other teams act on more of what Copilot says? Where a fair comparison
        is not possible, Limn says so and shows no number.
      </p>

      <WhoItHelps
        developer="Find out whether a bot is genuinely noisy or whether your team simply skips its comments."
        manager="See what a bot costs per useful comment, and whether teams like yours get more out of it, before you renew or drop it."
      />

      <H2 id="where-the-comparison-comes-from">Where the comparison comes from</H2>
      <p>
        The comparison data ships inside Limn. It was measured from about 2,200 other repositories and is grouped by
        bot and by repository size (how many pull requests a repository merges in 14 days). Limn places your
        repositories in those groups on your computer. Nothing about your repositories is sent anywhere to make the
        comparison.
      </p>
      <p>
        Each figure is measured the way the comparison data measures it, which is not always the way the ROI tab
        does. For example, “Acted on” here is counted differently from <Ui>Used</Ui> on the ROI tab, so the two need
        not match. The ⓘ button beside the heading, <Ui>How Benchmark works</Ui>, lists how each figure is measured
        and its limits.
      </p>

      <H2 id="what-you-see">What you see</H2>
      <p>On the Bots Monitoring page there is one card per bot, for the whole workspace.</p>
      <BenchmarkMock />
      <ul>
        <li>
          <strong>Cost:</strong> the price you entered, then <Ui>Per merged PR</Ui> and{' '}
          <Ui>Per comment your team used</Ui>, each marked with where it comes from, for example “From your own data”.
        </li>
        <li>
          <strong>One plain sentence</strong> comparing you with similar teams, for example “Your team used 52% of
          what it said. Teams with similar repos used 74%.”
        </li>
        <li>
          <Ui>Where these numbers come from</Ui>: one row per repository the bot works in, with its size group and
          your team’s acted-on rate there.
        </li>
      </ul>
      <p>
        A repository’s own <Ui>Bots</Ui> tab shows the full detail for that repository: each figure against the spread
        of similar repositories, and any finding that stands out.
      </p>

      <H3>Findings that stand out</H3>
      <p>
        Limn raises a finding only when a figure is far from typical <em>and</em> the gap is large, so a healthy
        repository is not flagged just for being at one end of the range. The findings are:
      </p>
      <ul>
        <li>“Comments far more than it does for other teams”</li>
        <li>“Your team uses far less of it than other teams do”</li>
        <li>“Someone gets to it far later than on similar repos”</li>
        <li>“Repeats another bot on the same lines”</li>
      </ul>
      <p>Each finding comes with a suggested action. No AI writes them.</p>

      <H2 id="when-limn-refuses">When Limn refuses to compare</H2>
      <p>
        A comparison against the wrong group is worse than none, so Limn shows a reason instead of a number. The
        reasons you may see include:
      </p>
      <MiniTable
        cols={[
          { key: 'r', label: 'What it says' },
          { key: 'm', label: 'What it means' },
        ]}
        rows={[
          { _key: 'v', r: 'We have never measured this bot', m: 'The comparison data has no record of this product.' },
          { _key: 'f', r: 'Too few teams run this bot to compare against', m: 'The group is too small to be fair.' },
          { _key: 'c', r: 'No team we measured runs this bot on a repo this size', m: 'There is no group of your size for it.' },
          { _key: 'n', r: 'This repo is too new to compare', m: 'Limn has watched it for under 14 days, so its figures would be too low.' },
          { _key: 'i', r: 'Nothing merged here recently', m: 'There is no recent work to measure.' },
          { _key: 'p', r: 'Price entered, but the seat count is missing', m: 'A per-seat price needs the number of seats to give a monthly cost.' },
        ]}
      />
      <p>
        Severity and category comparisons are not offered yet, because the comparison data has no severity scores.
        The ⓘ button lists them as not compared yet, rather than showing your figures against nothing.
      </p>
      <Note title="The comparison data ages">
        The data is a snapshot. As it ages the tab says <Ui>Comparison data is getting old</Ui>, then{' '}
        <Ui>Comparison data is out of date</Ui>, then <Ui>Comparison data has expired</Ui>. Updating Limn brings a
        newer snapshot when one is released.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open <Ui>Bots Monitoring</Ui> and choose <Ui>Benchmark</Ui>.
        </li>
        <li>
          Enter each bot’s price in <DocLink to="settings/bots">Settings → Bots</DocLink> to see the cost lines.
        </li>
        <li>Open a repository’s page and its <Ui>Bots</Ui> tab for the per-repository detail.</li>
      </Steps>
      <Note title="Money is per workspace">
        Cost is worked out for the whole workspace only. The same subscription may also cover repositories outside
        this workspace, which Limn cannot see, and the card says so.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Your own figures on <DocLink to="bots-monitoring/roi">ROI</DocLink> cannot tell you what “good” looks like.
        Benchmark gives you a fair reference, and refuses where the reference would mislead.
      </p>
    </>
  );
}

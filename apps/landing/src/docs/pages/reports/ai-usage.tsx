import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, MiniTable, Note, Stat, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI usage',
  summary: 'What Limn\'s AI runs cost you this week: share of your subscription or US dollars on an API key.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>AI usage</Ui>, the last tab of Reports, shows where Limn’s own AI runs went for this workspace in the{' '}
        <DocLink to="reports/reporting-window">reporting window</DocLink>: reviews, story reviews, AI Fix, chat,
        diagrams and the rest. It also lists ways to use fewer tokens, worked out from your runs. The tab appears only
        while AI is on.
      </p>

      <WhoItHelps
        developer="See which pull requests and features use the most of your allowance, and which setting would save the most."
        manager="See what AI review costs the team per pull request and per story, and whether usage is rising week on week."
      />

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="AI usage totals: 4.2M tokens, 63 runs, Claude 18% of a week, then a table of where it goes by feature"
        caption="The totals for the window, then where the tokens went."
      >
        <div className="mk-stats">
          <Stat k="Tokens" v="4.2M" />
          <Stat k="Runs" v="63" />
          <Stat k="Claude" v="18%" d="of a week" />
        </div>
        <MiniTable
          cols={[
            { key: 'f', label: 'Where it goes' },
            { key: 't', label: 'Tokens', num: true },
            { key: 'r', label: 'Runs', num: true },
          ]}
          rows={[
            { _key: 'rev', f: 'AI Review', t: '2.6M', r: '31' },
            { _key: 'fix', f: 'AI Fix', t: '0.9M', r: '6' },
            { _key: 'story', f: 'Story review', t: '0.5M', r: '14' },
            { _key: 'chat', f: 'Chat', t: '0.2M', r: '12' },
          ]}
        />
      </Illustration>
      <ul>
        <li>
          <strong>The totals:</strong> <Ui>Tokens</Ui> (input plus output, for Claude and Codex alike; tokens Claude
          read from its cache are not counted), <Ui>Runs</Ui>, and the cost. Runs that are not tied to a repository,
          such as This Sprint, Docs and summaries, count in every workspace, and a line says how many there are.
        </li>
        <li>
          <Ui>Tokens over time</Ui>: <Ui>By day</Ui> or <Ui>By week</Ui>, Claude and Codex drawn apart, with the number
          of runs.
        </li>
        <li>
          <Ui>Where it goes</Ui>: tokens by feature.
        </li>
        <li>
          <Ui>Top pull requests</Ui> and <Ui>Top stories</Ui>: where the most tokens went. A story counts its own story
          reviews plus every other run on its pull requests.
        </li>
        <li>
          <Ui>Last 12 weeks</Ui>: a weekly bar chart and its trend, whatever the reporting window is. The last bar is
          this week so far.
        </li>
        <li>
          <Ui>Ways to use fewer tokens</Ui>: suggestions with an estimate of what each would have saved in this
          window, and a link to the setting it changes, such as <Ui>Auto review settings</Ui> or{' '}
          <Ui>Effort settings</Ui>. Limn works these out from your runs; no AI writes them.
        </li>
      </ul>

      <H2 id="how-cost-is-shown">How cost is shown</H2>
      <ul>
        <li>
          <strong>Claude on a subscription</strong> (your Claude Code sign-in): the share of a week’s allowance,
          estimated from your plan. Limn never shows US dollars for a subscription.
        </li>
        <li>
          <strong>Claude on an API key:</strong> US dollars.
        </li>
        <li>
          <strong>Codex on a ChatGPT sign-in:</strong> tokens only.
        </li>
      </ul>
      <Note>
        Runs that Limn skipped because the AI spend limit was reached are not recorded, so they are not counted here.
        To change the limit, see <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open <Ui>Reports</Ui> and choose <Ui>AI usage</Ui>.
        </li>
        <li>Select a pull request or story in the top lists to open it.</li>
        <li>Under <Ui>Ways to use fewer tokens</Ui>, press a suggestion’s link to open the setting it changes.</li>
      </Steps>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        AI review runs on your own Claude or Codex account. This tab shows you what Limn spends of it, per feature and
        per pull request, so you can turn down what is not worth it rather than guess.
      </p>
    </>
  );
}

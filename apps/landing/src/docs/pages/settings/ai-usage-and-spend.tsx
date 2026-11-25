import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Quote, SettingsRow, Stat, Steps, TextBox, Tip, Toggle, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'AI subscription usage and spend',
  summary: 'How Ensemble uses your Claude or ChatGPT subscription, the daily and weekly quotas for its automatic runs, and what happens when one is used.',
};

const HELP = 'https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan';
const LEGAL = 'https://code.claude.com/docs/en/legal-and-compliance';

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Ensemble has no AI service of its own. Every review, fix and summary runs on your own Claude or Codex account, from
        your computer, and counts against your own plan&rsquo;s limits or your own API bill. This page explains which
        account Ensemble uses, how much of it Ensemble may use on its own, and what happens when that share runs out. The
        settings are on the <DocLink to="settings/ai">AI</DocLink> tab, under <Ui>AI spend</Ui>.
      </p>

      <H2 id="which-account">Which account Ensemble uses</H2>
      <H3>Claude</H3>
      <p>Ensemble picks one Claude credential, in this order:</p>
      <ol>
        <li>
          <b>An Anthropic API key</b>, set as <code>ANTHROPIC_API_KEY</code> in the environment Ensemble starts in. Runs are
          billed by Anthropic at API prices.
        </li>
        <li>
          <b>A Claude Code login on this computer</b>, only when no key is set. Runs then use your plan&rsquo;s usage.
          Read <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Using a Claude login</DocLink> first.
        </li>
      </ol>
      <p>
        When both exist, Ensemble uses the key. To put the login first, untick <Ui>Use my API keys first</Ui> in
        Settings → AI (or start Ensemble with <code>ENSEMBLE_AI_USE_API_KEY=false</code>); the key is then hidden from
        login runs, so they are never billed to it by accident. Ensemble stores
        neither: it reads the login Claude Code already keeps, and the key only from the environment.
      </p>
      <Note title="Different from Claude Code on its own">
        Anthropic notes that Claude Code itself prefers an API key when one is set:
        <Quote source="Use Claude Code with your Pro, Max, or Ultra plan | Claude Help Center (retrieved 2026-11-09)" href={HELP}>
          Important: If you have an ANTHROPIC_API_KEY environment variable set on your system, Claude Code will use this
          API key for authentication instead of your Claude subscription (Pro, Max, Ultra, Team, or Enterprise plans),
          resulting in API usage charges rather than using your subscription&rsquo;s included usage.
        </Quote>
        Ensemble does the same by default.
      </Note>
      <H3>Codex</H3>
      <p>
        Codex runs only on a ChatGPT sign-in, made in Ensemble&rsquo;s own Codex folder from the AI tab or with{' '}
        <code>ensemble ai login codex</code>. An OpenAI API key is refused for now, because Ensemble cannot yet show what its
        runs cost. Your own Codex setup and sign-in are never read or changed.
      </p>

      <H2 id="shared-limits">Your plan&rsquo;s limits are shared</H2>
      <p>
        On a subscription, Ensemble&rsquo;s runs come out of the same limits as your own use of Claude or ChatGPT. Anthropic
        says so for Claude:
      </p>
      <Quote source="Use Claude Code with your Pro, Max, or Ultra plan | Claude Help Center (retrieved 2026-11-09)" href={HELP}>
        These limits are shared across Claude and Claude Code, meaning all activity in both tools counts against the
        same limits.
      </Quote>
      <p>
        Claude limits each week, and on some plans each five-hour session too. Ensemble&rsquo;s budget is a share of the
        week, a smaller share for each day, and the weekly share of the session where your plan has one.
      </p>

      <H2 id="spend-budget">The spend budget</H2>
      <p>
        Ensemble runs some AI work by itself: auto review and re-reviews, Check threads, auto fix, the CI and ticket
        reviews, story and docs checks, diagrams, This Sprint&rsquo;s briefs and the Slack summary. The spend budget
        limits only those automatic runs. It is the one limit: there is no count of reviews or checks a day.
      </p>
      <Illustration
        label="The AI spend section: Pause automatic runs over a quota is on, the daily quota is 10 percent and the weekly quota 50 percent of your weekly Claude usage."
        caption="AI spend on a Claude subscription, at the defaults."
      >
        <SettingsRow label="Pause automatic runs over a quota" control={<Toggle on />} />
        <SettingsRow
          label="Daily quota (% of your weekly Claude usage)"
          hint="about 25 automatic reviews a day"
          control={<TextBox value="10" />}
        />
        <SettingsRow label="Weekly quota (% of your weekly Claude usage)" hint="1 to 100" control={<TextBox value="50" />} />
        <Stat k="This week" v="18%" d="of your week used by Ensemble" />
      </Illustration>
      <H3>Two quotas</H3>
      <ul>
        <li>
          <b>Daily quota</b>: what Ensemble&rsquo;s automatic runs may use since midnight on this computer (your local
          time), as a share of your weekly allowance. The default is 10%, which is the weekly 50% spread over five
          working days. From 1 to 100. When it is used, automatic runs stop until midnight.
        </li>
        <li>
          <b>Weekly quota</b>: Ensemble&rsquo;s share of your week. The default is 50%, from 1 to 100.
        </li>
      </ul>
      <H3>On a subscription</H3>
      <ul>
        <li>
          The budget is <b>on by default</b>. Change either quota, or untick <Ui>Pause automatic runs over a quota</Ui>.
        </li>
        <li>
          If your plan limits each five-hour session, Ensemble takes the weekly share of it too (50% of the week means 50%
          of each session). There is no separate setting for it. Ensemble shows the five-hour bar only when your provider
          has reported a five-hour limit in the last 12 hours.
        </li>
        <li>
          Everything is shown in <b>percentages of your plan</b>, never in dollars.
        </li>
        <li>
          Claude: Ensemble adds up what its own runs use and compares it with your subscription&rsquo;s usual weekly
          allowance. Anthropic does not publish exact figures, so this is an estimate. Choose{' '}
          <Ui>Your subscription</Ui> (<Ui>Pro</Ui>, <Ui>Max 5x</Ui>, <Ui>Ultra</Ui> or <Ui>Team</Ui>) if Ensemble asks;
          when Claude reports only &ldquo;Max&rdquo;, Ensemble asks whether it is Max 5x or Ultra rather than guess.
        </li>
        <li>
          Codex: ChatGPT reports how much of its weekly limit, and five-hour limit where there is one, your account
          has used, in whole percent.
          Ensemble&rsquo;s share is that figure times the part of your Codex use that came from its own runs, so it moves in
          coarse steps.
        </li>
      </ul>
      <H3>On an API key</H3>
      <p>
        There is no limit until you set one. Select <Ui>Set a budget</Ui> and enter a <Ui>Weekly budget (US$)</Ui>{' '}
        and a <Ui>Daily quota (% of the weekly budget)</Ui>. A weekly budget of $25 with a daily quota of 10% allows
        $2.50 a day. The section then shows what Ensemble&rsquo;s runs have cost this week, in US dollars.
      </p>

      <H2 id="the-meter">The meter and the notifications</H2>
      <ul>
        <li>
          Beside each Run button, a small meter reads, for example, <Ui>Ensemble today: 3% of 10% · week 12% of 50%</Ui>.
          On an API key: <Ui>Today $1.20 of $2.50 · week $4.10 of $25</Ui>.
        </li>
        <li>
          At 80% of either quota, a card with a &ldquo;!&rdquo; shows in the bottom-right corner, for example{' '}
          <Ui>Daily AI quota nearly used</Ui>: <Ui>Ensemble has used 85% of today&apos;s AI quota. Automatic runs pause at
          100%.</Ui>
        </li>
        <li>
          At 100%, the card says the quota is used and when automatic runs resume.
        </li>
        <li>
          <Ui>Change quota</Ui> on either card opens Settings → AI spend. You can dismiss a card; it comes back when the
          state changes.
        </li>
      </ul>

      <H2 id="when-it-runs-out">When a quota is used</H2>
      <ul>
        <li>
          <b>Automatic runs are skipped, not queued.</b> A message says, for example,{' '}
          <Ui>Ensemble has used today&apos;s quota. Automatic runs resume Wed 00:00.</Ui> They start again at midnight, or
          when the week or the session resets.
        </li>
        <li>
          <b>Your own runs are never refused.</b> Over budget, a Run button asks for a second press to confirm, then
          runs.
        </li>
        <li>Your own use of Claude or ChatGPT outside Ensemble is never limited by Ensemble.</li>
      </ul>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>AI</Ui> tab.
        </li>
        <li>
          Under <Ui>AI spend</Ui>, tick or untick <Ui>Pause automatic runs over a quota</Ui>, and type the daily and
          weekly quotas. They save as you change them.
        </li>
      </Steps>

      <H2 id="effort-and-usage">Effort and how much a run uses</H2>
      <p>
        Higher <DocLink to="settings/ai#effort">Effort</DocLink> reads more and finds more, and uses more of your plan.
        Turning off design diagrams saves about a third of a review&rsquo;s usage. A Claude + Codex review uses both
        providers&rsquo; limits. Each run shows its cost: a share of your week on a subscription, or US$ on an API key.
        For the history of your use, see <DocLink to="reports/ai-usage">AI usage</DocLink>.
      </p>

      <H2 id="heavy-use">Heavy or automatic use</H2>
      <p>Anthropic sets its subscription limits for one person&rsquo;s ordinary use:</p>
      <Quote source="Legal and compliance - Claude Code Docs (retrieved 2026-11-09)" href={LEGAL}>
        Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the
        Agent SDK.
      </Quote>
      <Note title="Choosing between your login and an API key">
        Both work the same in Ensemble. On your own Claude Code login, Ensemble&rsquo;s runs share your plan&rsquo;s limits,
        which assume ordinary, individual use. An Anthropic API key is billed separately at API prices, falls under
        Anthropic&rsquo;s commercial terms, and is the route Anthropic recommends for products built on its Agent SDK.
        If you turn on auto review, auto fix or dependency automation across busy repositories, or your organisation
        prefers it, use an API key. See{' '}
        <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Using your own Claude login</DocLink>.
      </Note>
      <Tip>
        While the budget is on, the meter beside each Run button shows how much of each quota is used, so you can see
        the effect of a run before you start it.
      </Tip>
    </>
  );
}

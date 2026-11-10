import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Quote, SettingsRow, Stat, Steps, TextBox, Tip, Toggle, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI subscription usage and spend',
  summary: 'How Limn uses your Claude or ChatGPT subscription, the weekly spend budget, and what automatic runs do when it is reached.',
};

const HELP = 'https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan';
const LEGAL = 'https://code.claude.com/docs/en/legal-and-compliance';

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn has no AI service of its own. Every review, fix and summary runs on your own Claude or Codex account, from
        your computer, and counts against your own plan&rsquo;s limits or your own API bill. This page explains which
        account Limn uses, how much of it Limn may use on its own, and what happens when that share runs out. The
        settings are on the <DocLink to="settings/ai">AI</DocLink> tab, under <Ui>AI spend</Ui>.
      </p>
      <WhoItHelps
        developer="Automatic reviews never use up the week you need for your own Claude or Codex work."
        manager="Each person's automatic AI use has a ceiling they chose, in plain percentages of their plan."
      />

      <H2 id="which-account">Which account Limn uses</H2>
      <H3>Claude</H3>
      <p>Limn picks one Claude credential, in this order:</p>
      <ol>
        <li>
          <b>Your Claude Code login on this computer</b> (a Claude Pro, Max, Ultra, Team or Enterprise subscription). Run{' '}
          <code>claude</code> in a terminal and sign in. Runs then use your subscription&rsquo;s usage.
        </li>
        <li>
          <b>An Anthropic API key</b>, set as <code>ANTHROPIC_API_KEY</code> in the environment Limn starts in. Runs are
          then billed by Anthropic at API prices.
        </li>
      </ol>
      <p>
        When both exist, Limn uses the login and hides the key from the run, so a subscription run is never billed to
        the key by accident. To use the key first, start Limn with <code>LIMN_AI_USE_API_KEY=true</code>. Limn stores
        neither: it reads the login Claude Code already keeps, and the key only from the environment.
      </p>
      <Note title="Different from Claude Code on its own">
        Anthropic notes that Claude Code itself prefers an API key when one is set:
        <Quote source="Use Claude Code with your Pro, Max, or Ultra plan | Claude Help Center (retrieved 2026-11-09)" href={HELP}>
          Important: If you have an ANTHROPIC_API_KEY environment variable set on your system, Claude Code will use this
          API key for authentication instead of your Claude subscription (Pro, Max, Ultra, Team, or Enterprise plans),
          resulting in API usage charges rather than using your subscription&rsquo;s included usage.
        </Quote>
        Inside Limn the order is reversed, as above, unless you set <code>LIMN_AI_USE_API_KEY=true</code>.
      </Note>
      <H3>Codex</H3>
      <p>
        Codex runs only on a ChatGPT sign-in, made in Limn&rsquo;s own Codex folder from the AI tab or with{' '}
        <code>limn ai login codex</code>. An OpenAI API key is refused for now, because Limn cannot yet show what its
        runs cost. Your own Codex setup and sign-in are never read or changed.
      </p>

      <H2 id="shared-limits">Your plan&rsquo;s limits are shared</H2>
      <p>
        On a subscription, Limn&rsquo;s runs come out of the same limits as your own use of Claude or ChatGPT. Anthropic
        says so for Claude:
      </p>
      <Quote source="Use Claude Code with your Pro, Max, or Ultra plan | Claude Help Center (retrieved 2026-11-09)" href={HELP}>
        These limits are shared across Claude and Claude Code, meaning all activity in both tools counts against the
        same limits.
      </Quote>
      <p>
        Claude limits each five-hour session and each week. That is why Limn&rsquo;s budget is a share of both.
      </p>

      <H2 id="spend-budget">The spend budget</H2>
      <p>
        Limn runs some AI work by itself: auto review and re-reviews, Check threads, auto fix, the CI and ticket
        reviews, diagrams, This Sprint&rsquo;s briefs and the Slack summary. The spend budget limits only those
        automatic runs.
      </p>
      <Illustration label="The AI spend section: on, Limn's share of the week set to 50 percent." caption="AI spend on a Claude subscription, at the default share.">
        <SettingsRow label="Your Claude subscription: pause automatic runs once Limn has used its share of your week." control={<Toggle on />} />
        <SettingsRow label="Limn’s share of your weekly Claude usage (%)" control={<TextBox value="50" />} />
        <Stat k="This week" v="18%" d="of your week used by Limn" />
      </Illustration>
      <H3>On a subscription</H3>
      <ul>
        <li>
          The budget is <b>on by default at 50% of your week</b>. Change the share, or switch the budget off.
        </li>
        <li>
          Limn takes the same share of each five-hour session (50% of the week means 50% of each session). Open{' '}
          <Ui>Set a separate 5-hour limit</Ui> to choose a different share; <Ui>Use the weekly share</Ui> goes back.
        </li>
        <li>
          Everything is shown in <b>percentages of your plan</b>, never in dollars.
        </li>
        <li>
          Claude: Limn adds up what its own runs use and compares it with your subscription&rsquo;s usual weekly
          allowance. Anthropic does not publish exact figures, so this is an estimate. Choose{' '}
          <Ui>Your subscription</Ui> (<Ui>Pro</Ui>, <Ui>Max 5x</Ui>, <Ui>Max 20x</Ui> or <Ui>Team</Ui>) if Limn asks;
          when Claude reports only &ldquo;Max&rdquo;, Limn asks which one rather than guess.
        </li>
        <li>
          Codex: ChatGPT reports how much of its weekly and five-hour limits your account has used, in whole percent.
          Limn&rsquo;s share is that figure times the part of your Codex use that came from its own runs, so it moves in
          coarse steps.
        </li>
      </ul>
      <H3>On an API key</H3>
      <p>
        There is no limit until you set one. Select <Ui>Set a budget</Ui> and enter a <Ui>Weekly budget (US$)</Ui>.
        The section then shows what Limn&rsquo;s runs have cost this week, in US dollars.
      </p>

      <H2 id="when-it-runs-out">When Limn&rsquo;s share is used</H2>
      <ul>
        <li>
          <b>Automatic runs are skipped, not queued.</b> A message says, for example,{' '}
          <Ui>Limn has used its share of your week. Automatic runs resume Tue 09:00.</Ui> They start again when the week
          or the session resets.
        </li>
        <li>
          <b>Your own runs are never refused.</b> Over budget, a Run button asks for a second press to confirm, then
          runs.
        </li>
        <li>Your own use of Claude or ChatGPT outside Limn is never limited by Limn.</li>
      </ul>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>AI</Ui> tab.
        </li>
        <li>
          Under <Ui>AI spend</Ui>, tick or untick the budget, and type Limn&rsquo;s share.
        </li>
        <li>
          Select <Ui>Save</Ui>.
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
        Both work the same in Limn. On your own Claude Code login, Limn&rsquo;s runs share your plan&rsquo;s limits,
        which assume ordinary, individual use. An Anthropic API key is billed separately at API prices, falls under
        Anthropic&rsquo;s commercial terms, and is the route Anthropic recommends for products built on its Agent SDK.
        If you turn on auto review, auto fix or dependency automation across busy repositories, or your organisation
        prefers it, use an API key. See{' '}
        <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Using your own Claude login</DocLink>.
      </Note>
      <Tip>
        While the budget is on, a small meter beside each Run button shows how much of Limn&rsquo;s share is used, so
        you can see the effect of a run before you start it.
      </Tip>
    </>
  );
}

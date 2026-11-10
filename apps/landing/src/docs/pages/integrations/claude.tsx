import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Claude (Anthropic)',
  summary: 'Sign in to Claude Code or use an API key, and what Limn runs on Claude.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Claude, made by Anthropic, is one of the two AI providers Limn can use. Limn runs Claude on your computer, on
        your own Claude Code login or your own Anthropic API key. There is no Limn account in between, and Limn
        stores no Claude credentials. When both Claude and Codex are signed in, Limn uses Claude by default and runs
        reviews on both.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <p>One of these two. Both are fully supported; choose the one that suits you or your organisation.</p>
      <ul>
        <li>
          <b>Your Claude Code login</b>: a Claude plan that includes Claude Code (Pro, Max, Ultra, Team or
          Enterprise), signed in on this computer. Runs count against your plan&rsquo;s limits.
        </li>
        <li>
          <b>An Anthropic API key</b> from the Claude Console. Runs are billed at API prices to your organisation, and
          Anthropic&rsquo;s commercial terms apply. This is the route Anthropic recommends for products built on its
          Agent SDK.
        </li>
      </ul>
      <p>
        You do not need to install anything for Limn itself: Limn downloads the Claude programs it needs (about 110 MB)
        the first time it starts.
      </p>

      <H2 id="set-it-up">Set it up</H2>
      <H3>With your Claude Code login</H3>
      <Steps>
        <li>Install Claude Code from Anthropic if you do not have it.</li>
        <li>
          In a terminal, run <code>claude</code> and sign in with your Claude account.
        </li>
        <li>
          Start Limn. In <Ui>Settings → AI</Ui> the Claude line reads <Ui>Signed in to Claude Code.</Ui>
        </li>
      </Steps>
      <Tip>
        On a computer with no browser, set <code>CLAUDE_CODE_OAUTH_TOKEN</code> to a Claude Code sign-in token before
        you start Limn.
      </Tip>
      <H3>With an API key</H3>
      <Steps>
        <li>Create an API key in the Claude Console.</li>
        <li>
          Start Limn with the key in the environment: <code>ANTHROPIC_API_KEY=… npx limn-review</code>. To make it
          permanent, export <code>ANTHROPIC_API_KEY</code> in your shell profile.
        </li>
        <li>
          If you are also signed in to Claude Code and want the key to be used, add{' '}
          <code>LIMN_AI_USE_API_KEY=true</code> the same way.
        </li>
        <li>
          The Claude line reads <Ui>Using ANTHROPIC_API_KEY.</Ui>
        </li>
      </Steps>
      <Illustration label="The Claude line in Settings, AI, reading Signed in to Claude Code." caption="The Claude status line on the AI tab.">
        <SettingsRow label="Claude" hint="Signed in to Claude Code." control={<Pill tone="green">Ready</Pill>} />
      </Illustration>
      <H3>When you have both</H3>
      <p>
        Limn uses the login first and hides the key from those runs, so nothing is billed to the key by accident. To
        use the key first, start Limn with <code>LIMN_AI_USE_API_KEY=true</code>. See{' '}
        <DocLink to="settings/ai-usage-and-spend#which-account">Which account Limn uses</DocLink>.
      </p>

      <H2 id="what-runs-on-claude">What Limn runs on Claude</H2>
      <p>Every AI feature can run on Claude:</p>
      <ul>
        <li>
          <DocLink to="ai-review/overview">AI review</DocLink>: reviews, follow-ups, auto review, Check threads, the CI
          review, design diagrams and the review chat.
        </li>
        <li>
          <DocLink to="story-checks/overview">Story checks</DocLink> against the ticket and your docs.
        </li>
        <li>
          <DocLink to="ai-fix/overview">AI Fix</DocLink> and <DocLink to="implement-story/overview">Implement story</DocLink>
          , in the sandbox.
        </li>
        <li>
          The <DocLink to="docs-library/overview">Docs library</DocLink>, This Sprint&rsquo;s briefs and critical
          paths, and the summaries in Reports, Bots Monitoring and Slack.
        </li>
      </ul>
      <p>
        Limn picks a Claude model for each job (from Haiku for short summaries to Opus for deep reviews). Where
        a screen has a model menu, you can choose. Each run is labelled with the model and effort that ran it. Set the
        effort on the <DocLink to="settings/ai#effort">AI</DocLink> tab.
      </p>

      <H2 id="what-limn-sends">What Limn sends to Anthropic</H2>
      <p>
        For each run, the prompt and the material the run needs: code, diffs, pull request and ticket text, and docs
        sections. Every request goes from your computer straight to Anthropic. How Anthropic treats it depends on
        your account; see <DocLink to="settings/how-providers-treat-your-work#anthropic">How Anthropic and OpenAI treat
        your work</DocLink>.
      </p>
      <Note title="Your login stays yours">
        Limn runs on your computer, for your own work, with the Claude Code login you made through Anthropic&rsquo;s
        own sign-in. Limn never sees, stores or forwards that login, and there is no Limn server in between.
        Anthropic&rsquo;s policy recommends API keys for products built on its Agent SDK, and its plan limits assume
        ordinary, individual use. If your organisation prefers that route, or you run a lot of automatic reviews and
        fixes, use an API key. See{' '}
        <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Using your own Claude login</DocLink>.
      </Note>

      <H2 id="limits-and-spend">Limits and spend</H2>
      <p>
        On a subscription, Limn&rsquo;s automatic runs stop at 50% of your week unless you change it, and everything is
        shown as a share of your plan. On an API key, there is no cap until you set a weekly amount in US dollars. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>

      <H2 id="turn-it-off">Turn it off</H2>
      <ul>
        <li>
          To use Codex instead, choose <Ui>Codex</Ui> under <Ui>Automatic runs and default</Ui> on the AI tab, or start
          Limn with <code>LIMN_AI_PROVIDER=codex</code>.
        </li>
        <li>
          To turn every AI feature off, start Limn with <code>LIMN_AI_DISABLED=true</code>. The rest of Limn works as
          before.
        </li>
      </ul>
      <Note>
        If a download fails, the AI tab shows the reason and <Ui>Retry</Ui>. You can also run{' '}
        <code>limn ai install</code>, and <code>limn ai status</code> to check.
      </Note>
    </>
  );
}

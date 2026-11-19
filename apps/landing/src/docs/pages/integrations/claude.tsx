import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Claude (Anthropic)',
  summary: 'Use an Anthropic API key (the default), and what Ensemble runs on Claude.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Claude, made by Anthropic, is one of the two AI providers Ensemble can use. Ensemble runs Claude on your computer, on
        your own Anthropic API key. There is no Ensemble account in between, and Ensemble stores no Claude credentials. When both Claude and Codex are signed in, Ensemble uses Claude by default and runs
        reviews on both.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <p>
        <b>An Anthropic API key</b> from the Claude Console. Anthropic bills each run to you at API prices, under its
        commercial terms. This is the route Anthropic&rsquo;s terms ask for in tools built on its Agent SDK, which
        Ensemble is, so it is the default.
      </p>
      <p>
        You do not need to install anything for Ensemble itself: Ensemble downloads the Claude programs it needs (about 110 MB)
        the first time it starts.
      </p>

      <H2 id="set-it-up">Set it up</H2>
      <Steps>
        <li>Create an API key in the Claude Console.</li>
        <li>
          Start Ensemble with the key in the environment: <code>ANTHROPIC_API_KEY=… npx ensemble-review</code>. To make it
          permanent, export <code>ANTHROPIC_API_KEY</code> in your shell profile.
        </li>
        <li>
          The Claude line in <Ui>Settings → AI</Ui> reads <Ui>Using ANTHROPIC_API_KEY.</Ui>
        </li>
      </Steps>
      <Illustration label="The Claude line in Settings, AI, reading Using ANTHROPIC_API_KEY." caption="The Claude status line on the AI tab.">
        <SettingsRow label="Claude" hint="Using ANTHROPIC_API_KEY." control={<Pill tone="green">Ready</Pill>} />
      </Illustration>
      <H3 id="claude-code-login">If you use a Claude Code login instead</H3>
      <p>
        With no key set, Ensemble falls back to a Claude Code login on this computer. If you have both, the key wins
        unless you untick <Ui>Use my API keys first</Ui> in Settings → AI. Anthropic&rsquo;s terms limit how tools
        built on its Agent SDK may use Free, Pro, Max and Ultra plan sign-ins.{' '}
        <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Read them</DocLink> before you choose this.
      </p>

      <H2 id="what-runs-on-claude">What Ensemble runs on Claude</H2>
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
        Ensemble picks a Claude model for each job (from Haiku for short summaries to Opus for deep reviews). Where
        a screen has a model menu, you can choose. Each run is labelled with the model and effort that ran it. Set the
        effort on the <DocLink to="settings/ai#effort">AI</DocLink> tab.
      </p>

      <H2 id="what-ensemble-sends">What Ensemble sends to Anthropic</H2>
      <p>
        For each run, the prompt and the material the run needs: code, diffs, pull request and ticket text, and docs
        sections. Every request goes from your computer straight to Anthropic. How Anthropic treats it depends on
        your account; see <DocLink to="settings/how-providers-treat-your-work#anthropic">How Anthropic and OpenAI treat
        your work</DocLink>.
      </p>
      <Note title="Your key stays yours">
        Ensemble reads the key from the environment it starts in. It never stores, logs or forwards the key, and there
        is no Ensemble server in between.
      </Note>

      <H2 id="limits-and-spend">Limits and spend</H2>
      <p>
        On an API key, there is no cap until you set a weekly amount in US dollars. On a Claude Code login,
        Ensemble&rsquo;s automatic runs stop at 50% of your week unless you change it. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>

      <H2 id="turn-it-off">Turn it off</H2>
      <ul>
        <li>
          To use Codex instead, choose <Ui>Codex</Ui> under <Ui>Automatic runs and default</Ui> on the AI tab, or start
          Ensemble with <code>ENSEMBLE_AI_PROVIDER=codex</code>.
        </li>
        <li>
          To turn every AI feature off, start Ensemble with <code>ENSEMBLE_AI_DISABLED=true</code>. The rest of Ensemble works as
          before.
        </li>
      </ul>
      <Note>
        If a download fails, the AI tab shows the reason and <Ui>Retry</Ui>. You can also run{' '}
        <code>ensemble ai install</code>, and <code>ensemble ai status</code> to check.
      </Note>
    </>
  );
}

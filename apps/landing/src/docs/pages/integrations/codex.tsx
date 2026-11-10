import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Codex (OpenAI)',
  summary: 'Sign in to Codex with ChatGPT, and how Limn keeps Codex locked down.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Codex, made by OpenAI, is the second AI provider Limn can use. Limn runs the Codex program on your computer, on
        your own ChatGPT sign-in. It can run every AI feature Limn has. When both Claude and Codex are signed in, Limn
        reviews each pull request with both at once, and merges the two into one review.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>A ChatGPT account whose plan includes Codex.</li>
        <li>Nothing else to install: Limn downloads the Codex program (about 360 MB) the first time it starts.</li>
      </ul>
      <Note title="No API keys yet">
        Limn runs Codex only on a ChatGPT sign-in. An OpenAI API key is refused for now, because Limn cannot yet show
        what its runs cost.
      </Note>

      <H2 id="set-it-up">Sign in</H2>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>AI</Ui> tab.
        </li>
        <li>
          On the Codex line, select <Ui>Sign in with ChatGPT</Ui>.
        </li>
        <li>
          Select <Ui>Open the ChatGPT sign-in</Ui> and sign in in your browser. On a computer with no browser, select{' '}
          <Ui>Use a code instead</Ui> and enter the code on the page it names.
        </li>
        <li>
          The line reads <Ui>Signed in with ChatGPT.</Ui>, or names your plan.
        </li>
      </Steps>
      <Illustration label="The Codex line in Settings, AI, reading Signed in with ChatGPT, with a Sign out button." caption="The Codex status line once signed in.">
        <SettingsRow label="Codex" hint="Signed in with ChatGPT." control={<Pill tone="grey">Sign out</Pill>} />
      </Illustration>
      <p>
        From a terminal, <code>limn ai login codex</code> does the same (add <code>--device-auth</code> on a computer
        with no browser), and <code>limn ai logout codex</code> signs out.
      </p>

      <H2 id="your-own-codex">Your own Codex is left alone</H2>
      <p>
        Limn keeps its Codex sign-in in its own folder, <code>~/.limn/codex</code>. Your own Codex settings and sign-in
        in <code>~/.codex</code> are never read or changed, and neither is an <code>OPENAI_API_KEY</code> in your
        environment.
      </p>

      <H2 id="locked-down">How Limn locks Codex down</H2>
      <p>For reviews, chats and summaries, Limn starts Codex with almost everything switched off:</p>
      <ul>
        <li>No shell, no web access, no images, no plugins and no memories.</li>
        <li>No project instruction files are read.</li>
        <li>Files are read only through Limn&rsquo;s own read-only tools, limited to the repository under review.</li>
        <li>
          A safety check approves every tool Codex calls. Limn proves the check is running before each run, and refuses
          to start if it cannot.
        </li>
      </ul>
      <p>
        AI Fix and Implement story give Codex a shell, but only inside the sandbox, with no GitHub credentials. See{' '}
        <DocLink to="security/ai-and-the-sandbox">AI agents and the sandbox</DocLink>.
      </p>

      <H2 id="using-codex">Using Codex</H2>
      <H3>As the default</H3>
      <p>
        Choose <Ui>Codex</Ui> under <Ui>Automatic runs and default</Ui> on the AI tab, or start Limn with{' '}
        <code>LIMN_AI_PROVIDER=codex</code>. <Ui>Auto</Ui> uses Claude when both are signed in.
      </p>
      <H3>Beside Claude</H3>
      <p>
        With both signed in, reviews run on both by default. A point both raise is shown once, and if one half fails
        the other half still counts as the review. See <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>
      <H3>Effort</H3>
      <p>
        At <Ui>Default</Ui> effort, Codex runs at high on its most thorough model. The same Effort setting applies to
        both providers. See <DocLink to="settings/ai#effort">Effort</DocLink>.
      </p>

      <H2 id="limits">Limits and your data</H2>
      <p>
        ChatGPT reports how much of its weekly and five-hour limits your account has used. Limn&rsquo;s automatic runs
        stop at their share (50% of the week by default), shown in percentages. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>
      <p>
        With a ChatGPT sign-in, Codex follows your ChatGPT workspace&rsquo;s data settings. On a personal plan, check
        your ChatGPT data controls. See{' '}
        <DocLink to="settings/how-providers-treat-your-work#openai">How Anthropic and OpenAI treat your work</DocLink>.
      </p>
    </>
  );
}

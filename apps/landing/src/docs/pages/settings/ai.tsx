import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'AI',
  summary: 'Choose the provider, sign in, set the models and effort, the spend budget and the disk space Ensemble may use.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI</Ui> tab sets up the AI that runs Ensemble&rsquo;s reviews, fixes and summaries. Ensemble runs on your own
        Claude or Codex account: there is no Ensemble AI service in between. This tab says which provider runs by
        default, whether each one is ready and signed in, how hard the AI works, how much of your plan Ensemble may use on
        its own, and how much disk space AI runs take. Every setting here applies to you in every workspace.
      </p>

      <H2 id="provider">Choose the provider</H2>
      <p>
        <Ui>Automatic runs and default</Ui> has three choices: <Ui>Auto</Ui>, <Ui>Claude</Ui> and <Ui>Codex</Ui>. The
        provider you pick runs every automatic run (auto review, auto fix, the ticket and CI reviews, diagrams and the
        summaries) and every AI feature that has no model menu. <Ui>Auto</Ui> uses Claude when both are signed in, and
        otherwise whichever one is.
      </p>
      <p>
        AI Review, AI Fix and Implement story have their own model menu. When both Claude and Codex are signed in, the
        menu lists both and starts on the choice in{' '}
        <DocLink to="settings/ai#run-settings">Review, AI Fix and Implement story</DocLink>. When both are signed in, reviews run on both by default; see{' '}
        <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>
      <p>
        A change applies to the next run. A run already going finishes on the provider it started on, and every run
        keeps the name of the provider and model that ran it.
      </p>
      <Note>
        If the choice is greyed out with <Ui>Set by ENSEMBLE_AI_PROVIDER.</Ui>, whoever started Ensemble fixed the provider
        with that setting. Start Ensemble without it to choose here.
      </Note>

      <H2 id="sign-in">Download and sign in</H2>
      <p>
        Download only the agents you use. A new install downloads Claude by itself; Codex downloads when you select its{' '}
        <Ui>Download</Ui>. An install that already had both keeps both. Ensemble keeps each downloaded agent up to date by
        itself. The tab shows one line for each provider:
      </p>
      <Illustration label="The provider lines: Claude downloaded and on an API key, Codex not downloaded." caption="Each provider's status line.">
        <SettingsRow label="Claude" hint="Using ANTHROPIC_API_KEY." control={<Pill tone="grey">Remove</Pill>} />
        <SettingsRow label="Codex" hint="Not downloaded." control={<Pill tone="grey">Download (about 360 MB)</Pill>} />
      </Illustration>
      <p>
        <Ui>Remove</Ui> deletes that agent&rsquo;s download from your computer. Until you download it again, every AI
        feature reads it as not downloaded and uses the other agent, if it is signed in. From a terminal,{' '}
        <code>ensemble ai install claude</code> (or <code>codex</code>) and <code>ensemble ai remove claude</code> (or{' '}
        <code>codex</code>) do the same.
      </p>
      <H3>Claude</H3>
      <p>
        Ensemble uses the Anthropic API key set as <code>ANTHROPIC_API_KEY</code> when Ensemble starts. With no key, it
        falls back to a Claude Code login on this computer. The line then reads <Ui>Using ANTHROPIC_API_KEY.</Ui> or{' '}
        <Ui>Signed in to Claude Code.</Ui>, or asks you to set a key. Full details:{' '}
        <DocLink to="integrations/claude">Claude (Anthropic)</DocLink>.
      </p>
      <H3>Codex</H3>
      <p>
        Codex signs in with your ChatGPT account, in Ensemble&rsquo;s own folder. Your own Codex setup is not used, and
        neither is an OpenAI API key.
      </p>
      <Steps>
        <li>
          Select <Ui>Sign in with ChatGPT</Ui>.
        </li>
        <li>
          Select <Ui>Open the ChatGPT sign-in</Ui> and finish signing in in your browser. On a computer with no browser,
          select <Ui>Use a code instead</Ui> and enter the code on the page it names.
        </li>
        <li>
          The line changes to <Ui>Signed in with ChatGPT.</Ui> (or names your ChatGPT plan).
        </li>
      </Steps>
      <p>
        <Ui>Sign out</Ui> removes Ensemble&rsquo;s Codex sign-in. Full details:{' '}
        <DocLink to="integrations/codex">Codex (OpenAI)</DocLink>.
      </p>
      <Tip>
        If a download failed, the line says why and shows <Ui>Retry</Ui>. An AI feature whose agent is not downloaded
        says so and links here. If AI is switched off, it links to{' '}
        <DocLink to="settings/features">Settings → Features</DocLink> instead.
      </Tip>

      <H2 id="api-keys">Use my API keys first</H2>
      <p>
        <Ui>Use my API keys first</Ui> is ticked by default: AI runs use an API key, not a subscription. Ensemble reads
        the keys from the environment it started in (your shell, or the <code>.env</code> file), and never stores one.
        The line under the box says which keys are set.
      </p>
      <ul>
        <li>
          <b>Claude</b> reads <code>ANTHROPIC_API_KEY</code>. With the box ticked and the key set, every Claude run uses
          the key, even while you are signed in to Claude Code. Anthropic bills it per token, and Ensemble shows its spend
          in US$. Untick the box to use your Claude Code sign-in first. Anthropic&rsquo;s terms limit how tools like
          Ensemble may use a plan sign-in; see{' '}
          <DocLink to="settings/how-providers-treat-your-work#your-claude-login">Using a Claude login</DocLink>.
        </li>
        <li>
          <b>Codex</b> reads <code>OPENAI_API_KEY</code>. Codex runs on an API key are not available yet, so Codex keeps
          using your ChatGPT sign-in.
        </li>
      </ul>
      <p>
        Starting Ensemble with <code>ENSEMBLE_AI_USE_API_KEY=true</code> or <code>false</code> decides it from the
        environment, and the box shows that value, locked.
      </p>

      <H2 id="run-settings">Review, AI Fix and Implement story</H2>
      <p>
        Three blocks say which vendor, model and effort each AI feature runs on. The run menus of AI Review, AI Fix and
        Implement story open on these, and can pick another model for one run. A run picked that way keeps the effort set
        here for its vendor. A vendor that is not signed in shows its sign-in line instead.
      </p>
      <Illustration label="The Review block: Claude on with Claude Opus 5.5 at High, Codex on with GPT-6.1 Sol at Default." caption="The Review block, one row per vendor.">
        <SettingsRow label="Claude" hint="On · Claude Opus 5.5 (most thorough)" control={<Pill tone="grey">High</Pill>} />
        <SettingsRow label="Codex" hint="On · Codex · GPT-6.1 Sol (most thorough)" control={<Pill tone="grey">Default</Pill>} />
      </Illustration>
      <H3 id="review">Review</H3>
      <p>
        One row per vendor: <Ui>On</Ui>, a model and an effort. Every review uses them: AI Review, auto reviews, the CI
        review, the story check, Check threads and the review rounds of Implement story and AI Fix.
      </p>
      <ul>
        <li>
          With both on and signed in, Claude and Codex review together as one review, each at its own model and effort.
          See <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
        </li>
        <li>With one on, it reviews alone. One vendor must stay on.</li>
        <li>
          A workspace whose auto reviews use one vendor runs the first one that is on and signed in, Claude before Codex.
        </li>
      </ul>
      <H3 id="ai-fix">AI Fix</H3>
      <p>
        A vendor, a model and an effort for AI Fix, Plan first and auto fix, and <Ui>Review rounds</Ui>: how many times
        Ensemble reviews a fix and the agent answers, before anything is pushed. It is 5 by default, from 1 to 6, and
        applies to every fix, manual and automatic. The reviews use the Review settings above. Changing only the rounds
        leaves auto fix on its review&rsquo;s model. See <DocLink to="ai-fix/push-and-auto-fix#review-rounds">Review rounds</DocLink>.
      </p>
      <H3 id="implement-story">Implement story</H3>
      <p>
        A vendor, a model and an effort for Implement story&rsquo;s plan and build, and <Ui>Review rounds</Ui>: how many
        times the review loop reviews and fixes the work before it opens the pull request. It is 5 by default, from 1 to
        6. The start panel opens on this number and can change it for one build.
      </p>
      <p>
        If the AI Fix or Implement story vendor is not signed in or is over its usage limit when a run starts, the other
        signed-in vendor runs, at its usual model and Default effort. The run shows what it used.
      </p>
      <H3 id="effort">Effort</H3>
      <p>Higher effort reads more and finds more, and uses more of your plan or costs more.</p>
      <ul>
        <li>
          <Ui>Default</Ui> runs Claude at medium, and Codex at high on its most thorough model. A review of a small
          change from its diff alone can run one level lower.
        </li>
        <li>
          <Ui>Low</Ui>, <Ui>Medium</Ui>, <Ui>High</Ui>, <Ui>Extra high</Ui> and <Ui>Max</Ui> set the level for that
          vendor&rsquo;s runs.
        </li>
      </ul>
      <p>Each run shows the model and effort it used. Until you change a block, it runs as it did before.</p>
      <Note>
        If every effort menu is greyed out with <Ui>Effort is set by REVIEW_EFFORT.</Ui>, the effort was fixed when
        Ensemble started.
      </Note>

      <H2 id="ai-spend">AI spend</H2>
      <p>
        <Ui>AI spend</Ui> limits the runs Ensemble starts by itself, so they use only a share of your week. It is on by
        default at 50% of the week on a subscription. Your own runs are never limited. The full explanation is on{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>

      <H2 id="disk-space">Disk space</H2>
      <p>
        Ensemble keeps one copy of each repository an AI run has read, and checks a pull request out for each run. A run
        removes its checkout when it ends. <Ui>Disk space</Ui> shows how much space this takes and how much Ensemble freed
        in the last 30 days.
      </p>
      <p>
        A checkout left behind by a crash, or for a pull request that has merged or closed, is removed when Ensemble starts
        and when a new run begins. A checkout that holds a fix you have not pushed is kept until you push or discard it,
        for up to 14 days.
      </p>
    </>
  );
}

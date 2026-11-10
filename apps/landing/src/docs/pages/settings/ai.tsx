import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Tip, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI',
  summary: 'Choose the provider, sign in, set the effort, the spend budget and the disk space Limn may use.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI</Ui> tab sets up the AI that runs Limn&rsquo;s reviews, fixes and summaries. Limn runs on your own
        Claude or Codex account: there is no Limn AI service in between. This tab says which provider runs by
        default, whether each one is ready and signed in, how hard the AI works, how much of your plan Limn may use on
        its own, and how much disk space AI runs take. Every setting here applies to you in every workspace.
      </p>
      <WhoItHelps
        developer="Choose between Claude and Codex, and trade depth for speed with one Effort setting."
        manager="Cap how much of each person's AI plan Limn's automatic runs may use, so review never eats the week."
      />

      <H2 id="provider">Choose the provider</H2>
      <p>
        <Ui>Automatic runs and default</Ui> has three choices: <Ui>Auto</Ui>, <Ui>Claude</Ui> and <Ui>Codex</Ui>. The
        provider you pick runs every automatic run (auto review, auto fix, the ticket and CI reviews, diagrams and the
        summaries) and every AI feature that has no model menu. <Ui>Auto</Ui> uses Claude when both are signed in, and
        otherwise whichever one is.
      </p>
      <p>
        AI Review and AI Fix have their own model menu. When both Claude and Codex are signed in, the menu lists both
        and starts on this provider. When both are signed in, reviews run on both by default; see{' '}
        <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>
      <p>
        A change applies to the next run. A run already going finishes on the provider it started on, and every run
        keeps the name of the provider and model that ran it.
      </p>
      <Note>
        If the choice is greyed out with <Ui>Set by LIMN_AI_PROVIDER.</Ui>, whoever started Limn fixed the provider
        with that setting. Start Limn without it to choose here.
      </Note>

      <H2 id="sign-in">Set up and sign in</H2>
      <p>
        Limn downloads Claude and Codex by itself the first time it starts. Signing in is the only step. The tab shows
        one line for each provider:
      </p>
      <Illustration label="The provider lines: Claude signed in, Codex not signed in." caption="Each provider's status line.">
        <SettingsRow label="Claude" hint="Signed in to Claude Code." control={<Pill tone="green">Ready</Pill>} />
        <SettingsRow label="Codex" hint="Not signed in." control={<Pill tone="grey">Sign in with ChatGPT</Pill>} />
      </Illustration>
      <H3>Claude</H3>
      <p>
        Limn uses your Claude Code login on this computer. Run <code>claude</code> in a terminal and sign in there.
        When there is no login, Limn uses an Anthropic API key set as <code>ANTHROPIC_API_KEY</code> when Limn starts.
        The line then reads <Ui>Signed in to Claude Code.</Ui> or <Ui>Using ANTHROPIC_API_KEY.</Ui>, or asks you to
        sign in. Full details:{' '}
        <DocLink to="integrations/claude">Claude (Anthropic)</DocLink>.
      </p>
      <H3>Codex</H3>
      <p>
        Codex signs in with your ChatGPT account, in Limn&rsquo;s own folder. Your own Codex setup is not used, and
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
        <Ui>Sign out</Ui> removes Limn&rsquo;s Codex sign-in. Full details:{' '}
        <DocLink to="integrations/codex">Codex (OpenAI)</DocLink>.
      </p>
      <Tip>
        If a download failed, the line says why and shows <Ui>Retry</Ui>. The terminal command{' '}
        <code>limn ai install</code> does the same.
      </Tip>

      <H2 id="effort">Effort</H2>
      <p>
        <Ui>Effort for reviews and AI Fix</Ui> sets how hard the AI works. Higher effort reads more and finds more, and
        uses more of your plan or costs more. It applies to every review (AI Review, the CI review, the story check and
        Check threads), AI Fix and Implement, on both Claude and Codex.
      </p>
      <ul>
        <li>
          <Ui>Default</Ui> runs Claude at medium, and Codex at high on its most thorough model. A review of a small
          change from its diff alone can run one level lower.
        </li>
        <li>
          <Ui>Low</Ui>, <Ui>Medium</Ui>, <Ui>High</Ui>, <Ui>Extra high</Ui> and <Ui>Max</Ui> set the level for every
          run.
        </li>
      </ul>
      <p>Each run shows the effort it used beside its model.</p>
      <Note>
        If the menu is greyed out with <Ui>Set by REVIEW_EFFORT.</Ui>, the effort was fixed when Limn started.
      </Note>

      <H2 id="ai-spend">AI spend</H2>
      <p>
        <Ui>AI spend</Ui> limits the runs Limn starts by itself, so they use only a share of your week. It is on by
        default at 50% of the week on a subscription. Your own runs are never limited. The full explanation is on{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>

      <H2 id="disk-space">Disk space</H2>
      <p>
        Limn keeps one copy of each repository an AI run has read, and checks a pull request out for each run. A run
        removes its checkout when it ends. <Ui>Disk space</Ui> shows how much space this takes and how much Limn freed
        in the last 30 days.
      </p>
      <p>
        A checkout left behind by a crash, or for a pull request that has merged or closed, is removed when Limn starts
        and when a new run begins. A checkout that holds a fix you have not pushed is kept until you push or discard it,
        for up to 14 days.
      </p>
    </>
  );
}

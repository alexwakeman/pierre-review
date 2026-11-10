import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, Pill, Steps, Toolbar, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'People or bots',
  summary: 'The feed shows people or bots, never both at once. How Limn decides who is a bot, and how to correct it.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The Feed has two sides, <Ui>People</Ui> and <Ui>Bots</Ui>. <Ui>People</Ui> (the default) is what humans
        did, including their replies to bots. <Ui>Bots</Ui> is what bots did, including their replies to people. A
        thread where a person and a bot both replied shows on both sides. The two are never mixed, so a busy review
        bot cannot bury the team's conversation.
      </p>


      <Illustration
        label="The feed's People and Bots switch, with Bots selected."
        caption="The switch between the two sides."
      >
        <Toolbar>
          <Pill>People</Pill>
          <Pill tone="blue">Bots</Pill>
        </Toolbar>
      </Illustration>

      <H2 id="who-is-a-bot">How Limn decides who is a bot</H2>
      <p>An account counts as a bot when any of these is true:</p>
      <ul>
        <li>GitHub says it is a bot or an app.</li>
        <li>
          It is a known automation account, such as a review bot (CodeRabbit, Copilot and others), a dependency bot
          (Dependabot, Renovate), a CI bot or a coding agent.
        </li>
        <li>
          Someone in the workspace marked it as a bot in{' '}
          <DocLink to="settings/bots">Settings → Bots</DocLink>.
        </li>
      </ul>
      <p>
        The same rule hides bots on the <DocLink to="timeline/filters">Timeline</DocLink> by default and splits{' '}
        <Ui>People</Ui> and <Ui>Automation</Ui> on Pending.
      </p>

      <H2 id="correct-it">Correct a mistake</H2>
      <p>
        If a person is treated as a bot, mark them as a person. If a bot is treated as a person, mark it as a
        bot. A choice made here wins over Limn's own rule, in both directions.
      </p>
      <Steps>
        <li>
          On a bot's card in the Feed, choose <Ui>not a bot?</Ui> beside its name, and confirm.
        </li>
        <li>
          Or open <DocLink to="settings/bots">Settings → Bots</DocLink> to see every reviewer the workspace treats as
          automated, and change any of them.
        </li>
      </Steps>
      <Warning>
        The change applies to every repository in the workspace, not only the pull request you are looking at.
        Other workspaces are not affected. You can undo it from Settings → Bots.
      </Warning>
      <Note>
        My turn uses its own, stricter bot rule: no action by a known automation account ever puts a card in My
        turn, whatever the workspace setting. See <DocLink to="pending/my-turn#what-does-not-count">My turn</DocLink>.
      </Note>
    </>
  );
}

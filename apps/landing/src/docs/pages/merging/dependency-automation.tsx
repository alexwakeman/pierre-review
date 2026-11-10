import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, SettingsRow, Steps, Toggle, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Dependency automation',
  summary: 'Merge, approve or resolve dependency updates automatically, by rules you set.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Dependabot, Renovate and other dependency bots open a steady stream of small pull requests. Dependency
        automation lets Limn handle them for you, by rules you set per workspace: merge them when their checks pass,
        approve them, ask the bot to rebase when they conflict, and, with AI on, fix them when CI fails. Everything is
        off until you switch it on.
      </p>


      <H2 id="switch-it-on">Switch it on</H2>
      <Illustration
        label="The Dependency updates section of Settings: Merge them automatically on, Approve them automatically on, Resolve their conflicts off, Fix them with AI off"
        caption="Settings → Dependencies, for one workspace."
      >
        <SettingsRow
          label="Merge them automatically"
          hint="In repositories you can push to, once their required checks pass."
          control={<Toggle on />}
        />
        <SettingsRow label="Approve them automatically" hint="Once CI passes, as you. Trusted bots only." control={<Toggle on />} />
        <SettingsRow label="Resolve their conflicts" hint="Asks the bot to rebase. Trusted bots only." control={<Toggle on={false} />} />
        <SettingsRow label="Fix them with AI" hint="When CI fails, AI fixes the branch and pushes." control={<Toggle on={false} />} />
      </Illustration>
      <Steps>
        <li>
          Open <DocLink to="settings/dependencies">Settings → Dependencies</DocLink>. The settings apply to the
          workspace you have selected.
        </li>
        <li>
          Switch on the actions you want: <Ui>Merge them automatically</Ui>, <Ui>Approve them automatically</Ui>,{' '}
          <Ui>Resolve their conflicts</Ui> and, while AI is on, <Ui>Fix them with AI</Ui>.
        </li>
        <li>
          Under <Ui>Which updates</Ui>, choose <Ui>Patch updates only</Ui>, <Ui>Patch and minor updates</Ui> or{' '}
          <Ui>All updates, major ones too</Ui>. Tick <Ui>Security fixes only</Ui> to narrow it further.
        </li>
        <li>
          Under <Ui>Ecosystems</Ui>, keep <Ui>All ecosystems</Ui> or choose <Ui>Only these</Ui> and tick them.
        </li>
        <li>
          Under <Ui>Trusted bots</Ui>, tick the bots Limn may approve, resolve and fix for. Merging does not need a
          trusted bot; the other three do nothing until you trust one.
        </li>
        <li>
          Press <Ui>Save</Ui>.
        </li>
      </Steps>

      <H2 id="what-each-action-does">What each action does</H2>
      <ul>
        <li>
          <strong>Merge:</strong> Limn arms the pull request with <DocLink to="merging/merge-when-ready">Merge when ready</DocLink>{' '}
          and merges it once GitHub’s required checks pass, in repositories you can push to. Drafts and conflicting
          pull requests are left alone. Armed this way, a pull request says{' '}
          <Ui>Armed automatically (dependency setting)</Ui>.
        </li>
        <li>
          <strong>Approve:</strong> once all CI is green, Limn approves under your GitHub account. It approves each new
          commit once and never retries a failed approval.
        </li>
        <li>
          <strong>Resolve conflicts:</strong> Limn first asks the bot to rebase: a comment for Dependabot, the rebase
          checkbox for Renovate. With AI on, if the branch still conflicts 30 minutes later, or the bot cannot be
          asked, AI resolves the conflicts and pushes a merge commit. It pushes only when Limn’s check of the merge
          passes.
        </li>
        <li>
          <strong>Fix with AI:</strong> when CI fails on a trusted bot’s pull request, for example because a companion
          package or lock file was not updated, AI fixes the branch and pushes the change. It runs once per commit and
          at most twice a day per pull request.
        </li>
      </ul>
      <p>
        After any push, CI must pass again before Limn approves or merges. AI actions stop while you are over your AI
        spend limit (see <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>), and need a sandbox
        runtime on your computer (see <DocLink to="integrations/sandbox-runtimes">Sandbox runtimes</DocLink>).
      </p>
      <H3>How Limn reads an update’s size</H3>
      <p>
        From the version numbers in the pull request. When Limn cannot read them, only <Ui>All updates, major ones
        too</Ui> lets it through. An ecosystem list lets a pull request through only when every ecosystem it changes
        is ticked.
      </p>
      <Warning title="These actions write to GitHub as you">
        Approvals, merges, comments to the bot and AI pushes go out under your GitHub account. Limn checks every two
        minutes while it is running. If you cancel a pull request’s automation yourself, Limn leaves that pull request
        alone after that.
      </Warning>

      <H2 id="see-what-it-did">See what it did</H2>
      <p>
        On <DocLink to="pending/dependencies">Pending → Dependencies</DocLink>, open <Ui>What automation did</Ui> for
        the last two weeks of actions, grouped by pull request. To act on everything at once, press{' '}
        <Ui>Merge or arm all</Ui>: each pull request that can merge is merged, and each that cannot yet is armed.
      </p>
      <Note title="Teams with more than one Limn">
        When a teammate also runs Limn, each action first puts a <code>limn/deps</code> status on the commit, such as
        “alex handling · fixing CI”. Limn skips a commit a teammate is working on, and an action a teammate already
        did. Turning off <Ui>Mark auto reviews on GitHub</Ui> turns these statuses off too.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Dependency bumps are many, small and mostly safe. Handing the safe ones to a rule, within limits you choose,
        frees your reviews for code people wrote, while major updates and untrusted bots still wait for a person.
      </p>
    </>
  );
}

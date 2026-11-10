import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, SettingsRow, Steps, Toggle, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Dependencies settings',
  summary: 'The rules for merging, approving and resolving dependency updates.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Dependencies</Ui> tab decides what Limn does with the pull requests that Dependabot, Renovate and other
        dependency bots open in the current workspace. Every switch is off until you turn it on, and nothing changes
        until you select <Ui>Save</Ui>. This page lists the settings; how the automation behaves day to day is in{' '}
        <DocLink to="merging/dependency-automation">Dependency automation</DocLink>.
      </p>

      <H2 id="what-limn-can-do">What Limn can do</H2>
      <Illustration label="The four dependency switches, all off." caption="The four actions. All start off.">
        <SettingsRow label="Merge them automatically" hint="Once their required checks pass." control={<Toggle on={false} />} />
        <SettingsRow label="Approve them automatically" hint="Once CI passes, as you. Trusted bots only." control={<Toggle on={false} />} />
        <SettingsRow label="Resolve their conflicts" hint="Asks the bot to rebase. Trusted bots only." control={<Toggle on={false} />} />
        <SettingsRow label="Fix them with AI" hint="When CI fails, AI fixes the branch and pushes." control={<Toggle on={false} />} />
      </Illustration>
      <ul>
        <li>
          <Ui>Merge them automatically</Ui>: in repositories you can push to, once their required checks pass. Drafts
          and pull requests with conflicts are left alone.
        </li>
        <li>
          <Ui>Approve them automatically</Ui>: once CI passes, under your GitHub account. Trusted bots only. Limn
          approves each new commit once and never retries a failed approval.
        </li>
        <li>
          <Ui>Resolve their conflicts</Ui>: Limn first asks the bot to rebase (a comment for Dependabot, the rebase
          checkbox for Renovate). Where the AI features are on, and the branch still conflicts 30 minutes later or the
          bot cannot be asked, AI resolves the conflicts and pushes a merge commit. It pushes only when Limn&rsquo;s
          check of the merge passes. Trusted bots only.
        </li>
        <li>
          <Ui>Fix them with AI</Ui> (only where the AI features are on): when CI fails on a trusted bot&rsquo;s pull
          request, AI fixes the branch and pushes the change, for example a companion package or lockfile that was not
          updated. When a pull request both conflicts and fails CI, one AI run merges first, then fixes CI on top.
        </li>
      </ul>
      <p>CI must pass again after any AI push before Limn approves or merges.</p>
      <Warning title="These act as you">
        Approvals, comments and pushes are made with your GitHub account. Turn on only what you would be happy to do
        yourself without looking.
      </Warning>

      <H2 id="which-updates">Which updates</H2>
      <p>One policy covers all four actions:</p>
      <H3>Which updates</H3>
      <ul>
        <li>
          <Ui>Patch updates only</Ui>, <Ui>Patch and minor updates</Ui>, or <Ui>All updates, major ones too</Ui>. Limn
          reads the size from the version numbers in the pull request. When it cannot read them, only{' '}
          <Ui>All updates</Ui> lets the pull request through.
        </li>
        <li>
          <Ui>Security fixes only</Ui>: limit the actions to updates that fix a security problem.
        </li>
      </ul>
      <H3>Ecosystems</H3>
      <p>
        Choose <Ui>All ecosystems</Ui>, or <Ui>Only these</Ui> and tick the package ecosystems you allow. A pull request
        gets through only when every ecosystem it changes is ticked.
      </p>

      <H2 id="trusted-bots">Trusted bots</H2>
      <p>
        Approving, resolving conflicts and fixing with AI happen only for bots you trust. The list shows every
        dependency bot that has opened a pull request in this workspace. A bot marked{' '}
        <Ui>Can&rsquo;t be asked to rebase</Ui> cannot be asked, so only the AI step can resolve its conflicts.
      </p>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>Dependencies</Ui> tab.
        </li>
        <li>Turn on the actions you want.</li>
        <li>Choose the update sizes and ecosystems.</li>
        <li>
          Under <Ui>Trusted bots</Ui>, tick each bot you trust.
        </li>
        <li>
          Select <Ui>Save</Ui>.
        </li>
      </Steps>

      <H2 id="limits">Limits and teammates</H2>
      <ul>
        <li>Limn checks dependency pull requests every two minutes while it is running.</li>
        <li>
          AI work stops while you are over your AI spend budget. See{' '}
          <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
        </li>
        <li>
          When a teammate also runs Limn, each action first puts a <Ui>limn/deps</Ui> status on the commit, such as
          &ldquo;alex handling · fixing CI&rdquo;. Limn skips a commit a teammate is already working on. The{' '}
          <Ui>Mark auto reviews on GitHub</Ui> setting on the <DocLink to="settings/ai-review">AI review</DocLink> tab
          turns these statuses off too.
        </li>
      </ul>
      <Note>Limn acts only while it is running on your computer. Nothing is merged or approved while it is stopped.</Note>
    </>
  );
}

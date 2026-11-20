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
        The <Ui>Dependencies</Ui> tab decides what Ensemble does with the pull requests that Dependabot, Renovate and other
        dependency bots open in the current workspace. Every switch is on until you turn it off, and each change saves
        at once. This page lists the settings; how the automation behaves day to day is in{' '}
        <DocLink to="merging/dependency-automation">Dependency automation</DocLink>.
      </p>

      <H2 id="what-ensemble-can-do">What Ensemble can do</H2>
      <Illustration label="The four dependency switches, all on." caption="The four actions. All start on.">
        <SettingsRow label="Merge them automatically" hint="Once their required checks pass." control={<Toggle on />} />
        <SettingsRow label="Approve them automatically" hint="Once CI passes, as you. Trusted bots only." control={<Toggle on />} />
        <SettingsRow label="Resolve their conflicts" hint="Asks the bot to rebase. Trusted bots only." control={<Toggle on />} />
        <SettingsRow label="Fix them with AI" hint="When CI fails, AI fixes the branch and pushes." control={<Toggle on />} />
      </Illustration>
      <ul>
        <li>
          <Ui>Merge them automatically</Ui>: in repositories you can push to, once their required checks pass. Drafts
          and pull requests with conflicts are left alone.
        </li>
        <li>
          <Ui>Approve them automatically</Ui>: once CI passes, under your GitHub account. Trusted bots only. Ensemble
          approves each new commit once and never retries a failed approval.
        </li>
        <li>
          <Ui>Resolve their conflicts</Ui>: Ensemble first asks the bot to rebase (a comment for Dependabot, the rebase
          checkbox for Renovate). Where the AI features are on, and the branch still conflicts 30 minutes later or the
          bot cannot be asked, AI resolves the conflicts and pushes a merge commit. It pushes only when Ensemble&rsquo;s
          check of the merge passes. Trusted bots only.
        </li>
        <li>
          <Ui>Fix them with AI</Ui> (only where the AI features are on): when CI fails on a trusted bot&rsquo;s pull
          request, AI fixes the branch and pushes the change, for example a companion package or lockfile that was not
          updated. When a pull request both conflicts and fails CI, one AI run merges first, then fixes CI on top.
        </li>
      </ul>
      <p>CI must pass again after any AI push before Ensemble approves or merges.</p>
      <Warning title="These act as you">
        Approvals, comments and pushes are made with your GitHub account. Turn off anything you would not be happy to
        do yourself without looking.
      </Warning>

      <H2 id="which-updates">Which updates</H2>
      <p>One policy covers all four actions:</p>
      <H3>Which updates</H3>
      <ul>
        <li>
          <Ui>Patch updates only</Ui>, <Ui>Patch and minor updates</Ui>, or <Ui>All updates, major ones too</Ui>. Ensemble
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
        dependency bot that has opened a pull request in this workspace. Dependabot and Renovate are trusted until you
        untick them: their GitHub accounts belong to GitHub apps, so nobody else can open a pull request as them. Any
        other bot is trusted only once you tick it. A bot marked{' '}
        <Ui>Can&rsquo;t be asked to rebase</Ui> cannot be asked, so only the AI step can resolve its conflicts.
      </p>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>Dependencies</Ui> tab.
        </li>
        <li>Turn off the actions you don&rsquo;t want.</li>
        <li>Choose the update sizes and ecosystems.</li>
        <li>
          Under <Ui>Trusted bots</Ui>, tick each bot you trust and untick any you don&rsquo;t.
        </li>
      </Steps>

      <H2 id="limits">Limits and teammates</H2>
      <ul>
        <li>Ensemble checks dependency pull requests every two minutes while it is running.</li>
        <li>
          AI work stops while you are over your AI spend budget. See{' '}
          <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
        </li>
        <li>
          When a teammate also runs Ensemble, each action first puts an <Ui>ensemble/deps</Ui> status on the commit, such as
          &ldquo;alex handling · fixing CI&rdquo;. Ensemble skips a commit a teammate is already working on.
        </li>
        <li>
          If a teammate&rsquo;s Ensemble stops partway, its status is cleared or runs out, and yours takes over. An armed
          merge is held for two hours at a time while it stays armed; when it ends without merging, the status says so
          and a teammate&rsquo;s Ensemble may arm it.
        </li>
        <li>
          When your Ensemble asked the bot to rebase but can&rsquo;t run AI (no AI, no container runtime, over budget), its
          status says &ldquo;AI step open to teammates&rdquo;, so a teammate&rsquo;s Ensemble can resolve the conflicts.
        </li>
      </ul>
      <Note>Ensemble acts only while it is running on your computer. Nothing is merged or approved while it is stopped.</Note>
    </>
  );
}

import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Toggle, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Push the fix, and auto fix',
  summary: 'Nothing leaves your computer until you press Push. Auto fix can fix your own pull requests after an auto review.',
};

function PushPicture(): JSX.Element {
  return (
    <Illustration
      label="The push controls of a finished fix: the commit message, a choice between Push to the PR branch, dana/partial-refunds, and New branch + open a PR, then a Push button."
      caption="Push: to the pull request's own branch, or to a new branch with a new pull request."
      title="AI Fix"
      meta="#612 Partial refunds"
    >
      <SettingsRow label="Commit message" control={<TextBox value="Reject refunds after the 30-day window" />} />
      <SettingsRow label="◉ Push to the PR branch" hint="dana/partial-refunds" control={<span />} />
      <SettingsRow label="○ New branch + open a PR" control={<span />} />
      <p>
        <Btn tone="go">Push</Btn> <Btn>Discard</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A finished fix waits in the <Ui>AI Fix</Ui> tab until you decide. Push sends it to GitHub from your computer,
        with your own GitHub sign-in; the sandbox never holds your GitHub credentials. This page also covers auto fix,
        which prepares a fix by itself after an auto review of your own pull request.
      </p>

      <H2 id="push">Push a fix</H2>
      <PushPicture />
      <Steps>
        <li>Read the report and the diff.</li>
        <li>
          Choose where it goes:
          <ul>
            <li>
              <Ui>Push to the PR branch</Ui> (the default) adds one commit to the pull request.
            </li>
            <li>
              <Ui>New branch + open a PR</Ui> pushes to a branch you name and opens a new pull request. Use it when the
              pull request comes from a fork you cannot push to.
            </li>
          </ul>
        </li>
        <li>
          Press <Ui>Push</Ui> (or <Ui>Push + open PR</Ui>). The tab says <Ui>Pushing…</Ui>, then <Ui>Pushed.</Ui>
        </li>
      </Steps>
      <Warning>
        Push writes to GitHub under your name. It is never forced, and it is refused if the branch moved since the fix
        started. Only the pull request's repository is pushed; edits the agent made in other repositories are shown
        under <Ui>Left out</Ui> and dropped. Limn does not build or test the fix again before the push.
      </Warning>
      <p>
        After the push, Limn syncs the pull request, so the new commit shows at once. If auto review is on, the new
        commit is reviewed, which checks the fix. A fix that includes the merge item pushes only to the pull request's
        own branch; see <DocLink to="ai-fix/resolve-merge-conflicts">Resolve merge conflicts with AI Fix</DocLink>.
      </p>

      <H2 id="discard-and-resume">Discard and resume</H2>
      <ul>
        <li>
          <Ui>Discard</Ui> stops the agent and removes the sandbox. Nothing is pushed. It asks once while the sandbox is
          running.
        </li>
        <li>
          A sandbox with nothing to do closes after an hour, or when Limn restarts. The tab says{' '}
          <Ui>The sandbox is closed. The changes are kept: push them, or resume.</Ui>
        </li>
        <li>
          <Ui>Resume</Ui> starts a new sandbox with the fix's changes put back, so you can ask for more. The agent does
          not remember the conversation.
        </li>
        <li>
          <Ui>New fix</Ui> opens <Ui>What to fix</Ui> again for another run. One fix runs per pull request at a time.
        </li>
      </ul>

      <H2 id="auto-fix">Auto fix</H2>
      <p>
        With <Ui>Auto AI Fix on your own PRs</Ui> on, Limn prepares one fix after each auto review of a pull request you
        opened. It is set per workspace in <Ui>Settings → AI review</Ui>, and it is off by default. It runs only while
        auto review is on.
      </p>
      <Illustration
        label="The Auto AI Fix settings: Auto AI Fix on your own PRs is on; Push automatically is off."
        caption="Auto AI Fix and Push automatically, both off until you switch them on."
        title="Auto AI Fix"
        meta="Settings → AI review"
      >
        <SettingsRow
          label="Auto AI Fix on your own PRs"
          hint="After an auto review of a PR you opened, prepare a fix. Nothing is pushed."
          control={<Toggle on />}
        />
        <SettingsRow label="Push automatically" hint="Pushes a finished fix to the PR’s branch. Not built or tested first." control={<Toggle on={false} />} />
      </Illustration>
      <ul>
        <li>Only your own pull requests. Other people's pull requests are never fixed automatically.</li>
        <li>
          It works on the sections ticked under <Ui>Always include</Ui> (by default all except style bot comments). It
          never fixes ticket gaps and never resolves merge conflicts, and it never plans first.
        </li>
        <li>It runs one build turn, then the sandbox closes. The fix waits in the <Ui>AI Fix</Ui> tab, marked <Ui>Auto fix</Ui>.</li>
        <li>
          Open pull requests shows <Ui>Fixing…</Ui> while it runs and <Ui>Fix ready</Ui> when it waits for you.
        </li>
      </ul>
      <H3>Why an auto fix did not start</H3>
      <p>
        The <Ui>AI Review</Ui> tab says <Ui>Auto fix started. See the AI Fix tab.</Ui> when one starts. When one could
        not start for a reason you can fix on this computer, it says why:
      </p>
      <MiniTable
        cols={[{ key: 'r', label: 'No auto fix: …' }]}
        rows={[
          { _key: '1', r: 'the fixer could not start' },
          { _key: '2', r: 'your AI spend budget is reached' },
          { _key: '3', r: 'no container runtime is running on this computer' },
        ]}
      />
      <p>
        Other skips are not shown: nothing to fix, a finished fix waiting to be pushed, the daily limit, new commits, or
        auto AI Fix off.
      </p>
      <p>A skipped auto fix is not queued; the next auto review decides again.</p>

      <H2 id="push-automatically">Push automatically</H2>
      <p>
        <Ui>Push automatically</Ui>, under Auto AI Fix, pushes a finished automatic fix to the pull request's branch
        without waiting for you. It is off by default.
      </p>
      <Warning>
        With Push automatically on, code an agent wrote reaches your branch with no person reading it first, and it is
        not built or tested by Limn before the push. Your CI and the next auto review are the checks. If the push fails,
        the <Ui>AI Fix</Ui> tab says <Ui>Automatic push failed</Ui> and Limn does not try again; you can push by hand.
      </Warning>
      <Note>
        Limits stop a loop of fix, review, fix: at most 3 automatic fixes per pull request a day, no new one while a fix
        runs or waits to be pushed, and none when the last one could not address the same items. Each one also asks your
        spend budget first. See <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>
    </>
  );
}

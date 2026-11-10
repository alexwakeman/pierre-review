import type { DocMeta } from '../../types';
import { Btn, Chip, Diff, DocLink, FindingRow, H2, H3, Illustration, Log, Note, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Fix a pull request with AI Fix',
  summary: 'Pick what to fix, let an agent work in a sandbox, check the diff, then push it.',
};

function FixPicture(): JSX.Element {
  return (
    <Illustration
      label="The AI Fix tab of pull request 612 after a fix. The agent read and edited refunds/policy.py and ran the refund tests, which passed. The report says the blocker on paid_at is fixed. Below is the diff and a Push button."
      caption="A finished fix: what the agent did in the sandbox, its report per file, the diff, and Push."
      title="#612 Partial refunds"
      meta="AI Fix"
    >
      <Log lines={['⏺ Read(refunds/policy.py)', '⏺ Edit(refunds/policy.py)', '⏺ Bash(pytest tests/refunds)', '  ⎿  42 passed']} />
      <FindingRow chip="F1" tone="red">
        refunds/policy.py: allows() now rejects orders paid more than 30 days ago.
      </FindingRow>
      <Diff
        file="refunds/policy.py"
        lines={[
          { k: '-', t: '    return order.status == "paid"' },
          { k: '+', t: '    if now() - order.paid_at > REFUND_WINDOW:' },
          { k: '+', t: '        return False' },
          { k: '+', t: '    return order.status == "paid"' },
        ]}
      />
      <p>
        <Chip>Push to the PR branch</Chip> <Btn tone="go">Push</Btn> <Btn>Discard</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        AI Fix turns review findings, open threads, failing checks and merge conflicts into a change you can push. An
        agent (Claude Code or Codex) works in a sandbox on your computer, with a copy of the code, and can run the
        project's own tests. You watch it work, read what it changed, and push the result to the pull request's
        branch. Nothing leaves your computer until you press <Ui>Push</Ui>.
      </p>
      <WhoItHelps
        developer="Clear a review's findings in one pass, tested, and spend your time checking the change instead of typing it."
        manager="Small review fixes stop bouncing between author and reviewer, and every fix is still pushed by a person who read it."
      />

      <H2 id="before-you-start">Before you start</H2>
      <ul>
        <li>
          <b>An AI review.</b> A fix starts from a finished AI review of the pull request. With none, the tab says so
          and offers <Ui>Open AI Review</Ui>. The exception: a finished CI check can start a fix of its failures on its
          own. See <DocLink to="ai-fix/what-to-fix">Choose what to fix</DocLink>.
        </li>
        <li>
          <b>A container runtime</b>, such as Docker or Colima, on this computer. With none, the tab shows one line with{' '}
          <Ui>How to set up</Ui>. See <DocLink to="integrations/sandbox-runtimes">Docker and microsandbox</DocLink>.
        </li>
        <li>
          <b>AI signed in</b>: Claude Code or Codex. See <DocLink to="settings/ai">Settings → AI</DocLink>.
        </li>
      </ul>

      <H2 id="start-a-fix">Start a fix</H2>
      <Steps>
        <li>
          Open the pull request and choose the <Ui>AI Fix</Ui> tab. You can also press{' '}
          <Ui>Generate fix from this review</Ui> on the <Ui>AI Review</Ui> tab, or <Ui>Fix with AI</Ui> beside a CI
          check.
        </li>
        <li>
          Under <Ui>What to fix</Ui>, tick the items the agent should work on.
        </li>
        <li>Pick the model from the <Ui>Model</Ui> menu.</li>
        <li>
          Optionally tick <Ui>Plan first</Ui> to talk the fix through before any code changes. See{' '}
          <DocLink to="ai-fix/plan-first">Plan first</DocLink>.
        </li>
        <li>
          Press <Ui>Start fix</Ui>. It starts at once.
        </li>
      </Steps>

      <H2 id="watch-it-work">Watch it work</H2>
      <FixPicture />
      <p>
        The tab first says <Ui>Setting up the sandbox.</Ui>, then <Ui>The agent is fixing and testing.</Ui> The
        conversation shows each step: the files it reads and edits and the commands it runs. While it works you can:
      </p>
      <ul>
        <li>
          Press <Ui>Stop</Ui> to stop the current turn. The sandbox stays, with the work so far.
        </li>
        <li>
          Ask for more in the message box. Each message is another build turn in the same session; the agent may edit
          and test again, and rewrites its report for the whole change.
        </li>
        <li>
          Open the <Ui>Network</Ui>, <Ui>Services</Ui> and <Ui>Spend</Ui> panels to see what the sandbox reached, which
          services it started and what the session has used.
        </li>
      </ul>

      <H2 id="read-the-result">Read the result</H2>
      <p>
        When it is done, the tab says <Ui>Fixed. Review the changes and push them, or ask for more.</Ui> Above the diff,
        the agent's report lists, for each changed file, what it changed and which items it covers (each item is a chip,
        such as a finding). Then:
      </p>
      <ul>
        <li>
          <Ui>Not addressed</Ui>: items the agent left alone, each with its reason.
        </li>
        <li>
          <Ui>Left out</Ui>: edits it made in other repositories of the workspace. Only the pull request's repository is
          ever pushed.
        </li>
        <li>
          <Ui>No report</Ui>, when the agent did not write one. The diff still counts.
        </li>
      </ul>
      <Note>
        The report is the agent's own account. <Ui>The diff below is what actually changed.</Ui> Read the diff before you
        push.
      </Note>

      <H2 id="push-or-discard">Push or discard</H2>
      <p>
        <Ui>Push</Ui> sends the change, as one commit with the agent's commit message, to the pull request's branch, or
        to a new branch with a new pull request. <Ui>Discard</Ui> removes the sandbox and pushes nothing. See{' '}
        <DocLink to="ai-fix/push-and-auto-fix">Push the fix, and auto fix</DocLink>.
      </p>
      <Warning>
        The fix is pushed as it is. Limn does not build or test it again before the push; the agent's own test runs in
        the sandbox are the only ones. Your CI runs on the pushed commit as usual.
      </Warning>

      <H2 id="the-sandbox">The sandbox</H2>
      <p>The sandbox is a container on your computer, made for this fix and removed after it.</p>
      <ul>
        <li>
          It holds every repository in the workspace. The pull request's repository is at the pull request's latest
          commit; the others are read only.
        </li>
        <li>
          The agent has a shell there, so it can run the project's own tests, lint and type checks, and start the
          services you picked for integration tests (<Ui>Settings → Sandbox</Ui>).
        </li>
        <li>
          It has no GitHub credentials and no way to change your own files. The only way out to the network is Limn's
          allow-list. A blocked host shows in the <Ui>Network</Ui> panel, where you can allow it.
        </li>
        <li>
          A session with nothing to do closes after an hour. Its changes are kept, and <Ui>Resume</Ui> starts it again.
        </li>
      </ul>
      <H3>Sharing the computer with Implement story</H3>
      <p>
        AI Fix and Implement story use the same sandboxes: two open sessions on this computer at a time, and one of them
        building at a time. One fix runs per pull request. See{' '}
        <DocLink to="security/ai-and-the-sandbox">AI and the sandbox</DocLink> for the full safety story.
      </p>
    </>
  );
}

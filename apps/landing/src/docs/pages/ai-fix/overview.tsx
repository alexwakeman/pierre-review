import type { DocMeta } from '../../types';
import { Btn, Chip, Diff, DocLink, FindingRow, H2, H3, Illustration, Log, Note, Steps, Ui, Warning } from '../../kit';

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
        <li>
          The <Ui>Model</Ui> menu opens on <DocLink to="settings/ai#ai-fix">Settings → AI → AI Fix</DocLink>. Pick
          another model for this fix if you want to.
        </li>
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
        Before <Ui>Push</Ui> shows, Ensemble reviews the fix and the agent answers the review, for a few rounds. See{' '}
        <DocLink to="ai-fix/push-and-auto-fix#review-rounds">Review rounds before the push</DocLink>.
      </p>
      <p>
        <Ui>Push</Ui> sends the change, as one commit with the agent's commit message, to the pull request's branch, or
        to a new branch with a new pull request. <Ui>Discard</Ui> removes the sandbox and pushes nothing. See{' '}
        <DocLink to="ai-fix/push-and-auto-fix">Push the fix, and auto fix</DocLink>.
      </p>
      <Warning>
        The fix is pushed as it is. Ensemble reviews it but does not build or test it again before the push; the agent's
        own test runs in the sandbox are the only ones. Your CI runs on the pushed commit as usual.
      </Warning>

      <H2 id="the-sandbox">The sandbox</H2>
      <p>The sandbox is a container on your computer, made for this fix and removed after it.</p>
      <ul>
        <li>
          It holds the pull request's repository, at the pull request's latest commit, and the workspace's other
          repositories, read only at their default branch, so the agent can check code that calls or serves the pull
          request. A repository with another open pull request of the same ticket is at that pull request&rsquo;s
          latest commit instead, so the agent sees the change that is not merged yet. At most 12 repositories: the pull request's own, the ones of its ticket's other pull requests, your
          related repositories, then the rest by name. The session names the ones it did not load.{' '}
          <Ui>Settings → Sandbox → AI Fix reads every repository</Ui> (on by default) turns this off: then only the
          pull request's repository and its ticket's come. A dependency fix always gets the short list.
        </li>
        <li>
          When the workspace has reference documents, the relevant sections come in too, read only: the ticket's own
          choice, else the whole library when it is small, else the sections that best match the pull request's words
          and changed files.
        </li>
        <li>
          Only the pull request's repository is pushed. A change the agent makes in another repository is shown under{' '}
          <Ui>Left out</Ui> and never pushed.
        </li>
        <li>
          The agent has a shell there, so it can run the project's own tests, lint and type checks, and start the
          services you picked for integration tests (<Ui>Settings → Sandbox</Ui>).
        </li>
        <li>
          It has no GitHub credentials and no way to change your own files. The only way out to the network is Ensemble's
          allow-list. A blocked host shows in the <Ui>Network</Ui> panel, where you can allow it.
        </li>
        <li>
          A session with nothing to do closes after an hour. Its changes are kept, and <Ui>Resume</Ui> starts it again.
        </li>
      </ul>
      <H3>Sharing the computer with Implement story</H3>
      <p>
        AI Fix and Implement story use the same sandboxes: up to four open sessions on this computer, and up to three
        building at once. One fix runs per pull request. When every sandbox is busy, a fix waits in line and starts by
        itself when one frees; the <Ui>AI Fix</Ui> tab shows its place, with <Ui>Cancel</Ui>. To make room, a fix
        session of yours that has done nothing for a minute is closed; its changes are kept, and <Ui>Resume</Ui> goes
        on. See{' '}
        <DocLink to="security/ai-and-the-sandbox">AI and the sandbox</DocLink> for the full safety story.
      </p>
      <H3 id="one-ticket-at-a-time">Pull requests of the same ticket</H3>
      <p>
        A fix reads the other open pull requests of its ticket that are in another repository. Fixes of those pull
        requests take turns, so no fix works from another pull request&rsquo;s old code. While a fix of #12 runs, a fix
        that reads #12 waits, and the tab says <Ui>Waiting for the fix of #12 (same ticket).</Ui> It starts by itself
        when the fix of #12 is built, stopped or failed. <Ui>Start now</Ui> starts your fix at once, with #12 as it is
        now. <Ui>Start fix</Ui> after <Ui>Plan first</Ui> waits the same way. Automatic fixes always wait.
      </p>
      <ul>
        <li>
          When the other pull request has a finished fix you have not pushed, the sandbox shows its repository with
          that fix applied, read only. The session names it <Ui>PR #12&rsquo;s head plus its AI Fix not pushed yet</Ui>.
          If that pull request changed since its fix was made, the fix is not applied, and the session says so.
        </li>
        <li>
          When the other pull request changes after your fix is built, the tab says{' '}
          <Ui>#12 changed after this fix was built.</Ui> A new fix of #12 built on top of yours does not count. The fix is
          not pushed automatically then, and neither is a fix that builds on a fix of #12 that is not pushed yet.{' '}
          <Ui>Push</Ui> still pushes it. Nothing runs again by itself.
        </li>
      </ul>
    </>
  );
}

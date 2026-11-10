import type { DocMeta } from '../../types';
import { Diff, DocLink, FindingRow, H2, Illustration, Note, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI Fix tab',
  summary: 'Ask an agent to fix findings, failing checks or merge conflicts, then push the result.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI Fix</Ui> tab asks an AI agent to change the pull request's code for you. You choose what to
        fix: findings from the AI review, review threads, failing checks, unmet ticket criteria, or the branch's
        merge conflicts. The agent works on a copy of the branch inside a sandbox on your computer, runs the
        repository's own checks there, and shows you the diff. Nothing is pushed until you press Push. This page
        describes the tab; the <DocLink to="ai-fix/overview">AI Fix</DocLink> section explains it in full.
      </p>

      <WhoItHelps
        developer="Hand the review's small fixes to an agent, read the diff, and push it to your branch in one press."
        manager="Turn agreed review findings into commits without the author losing a morning to them."
      />

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open the tab. It lists what can be fixed, as the same cards the AI Review tab shows, each with a tick
          box. Use <Ui>Tick all</Ui> or <Ui>Untick all</Ui>.
        </li>
        <li>
          Choose a model, and choose <Ui>Make a plan</Ui> if you want to agree a plan first. See{' '}
          <DocLink to="ai-fix/plan-first">Plan first</DocLink>.
        </li>
        <li>
          Choose <Ui>Start fix</Ui>. The agent's work shows as a conversation, with the repositories, services and
          spend beside it. Send it a message to ask for more.
        </li>
        <li>
          Read the result: a report of what it fixed, what it did not and why, the test results, and the diff.
        </li>
        <li>
          Choose Push to push the commits to the pull request's branch, or discard the fix.
        </li>
      </Steps>

      <Illustration
        label="An AI Fix result: two findings fixed, and the diff of policy.py."
        caption="A finished fix, before Push."
      >
        <FindingRow chip="Fixed" tone="green">
          RefundPolicy.allows() now reads paid_at.
        </FindingRow>
        <FindingRow chip="Fixed" tone="green">
          A retried refund sends one email.
        </FindingRow>
        <Diff
          file="payments/refunds/policy.py"
          lines={[
            { k: '-', t: '    return refund.amount > 0' },
            { k: '+', t: '    return refund.amount > 0 and not refund.too_late()' },
          ]}
        />
      </Illustration>

      <H2 id="merge-conflicts">Resolve merge conflicts with AI</H2>
      <p>
        When the branch conflicts with its base, the list includes <Ui>Resolve merge conflicts</Ui>. The agent
        merges the base first, then makes the other fixes on top. Limn checks the merge before it lets you push
        it. See <DocLink to="ai-fix/resolve-merge-conflicts">Resolve merge conflicts with AI Fix</DocLink>.
      </p>

      <Note title="What you need">
        AI Fix needs the AI features and a container runtime (Docker or microsandbox) for the sandbox. Without a
        runtime, the tab still lists what would be fixed and shows one line with <Ui>How to set up</Ui>. See{' '}
        <DocLink to="integrations/sandbox-runtimes">Sandbox runtimes</DocLink>.
      </Note>
      <Warning>
        Push writes commits to the pull request's branch on GitHub, under your account. AI Fix pushes only to this
        pull request's repository. Edits the agent made in any other repository are left out.
      </Warning>
    </>
  );
}

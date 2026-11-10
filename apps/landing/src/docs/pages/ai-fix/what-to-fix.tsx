import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, FindingRow, Group, H2, Illustration, MiniTable, Note, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Choose what to fix',
  summary: 'Tick the findings, threads, failing checks and ticket gaps the agent should work on.',
};

function PickerPicture(): JSX.Element {
  return (
    <Illustration
      label="What to fix on pull request 612: under Claude's findings, the blocker and the warning are ticked; under Ticket gaps, criterion 3 is ticked; under Style bot comments, one comment is not ticked. A Start fix button with Plan first."
      caption="What to fix: each item is ticked or not, in sections. Style bot comments start unticked."
      title="What to fix"
      meta="#612 Partial refunds"
    >
      <Group first>Claude’s findings</Group>
      <FindingRow chip="☑ Blocker" tone="red">RefundPolicy.allows() never reads paid_at.</FindingRow>
      <FindingRow chip="☑ Warning" tone="amber">A retried refund sends a second email.</FindingRow>
      <Group>Ticket gaps</Group>
      <FindingRow chip="☑ Not met" tone="red">Criterion 3: No refunds after 30 days.</FindingRow>
      <Group>Style bot comments</Group>
      <FindingRow chip="☐ Style">Line too long (104 &gt; 100).</FindingRow>
      <p>
        <Chip>Model: Claude Opus 5.5</Chip> <Chip>☐ Plan first</Chip> <Btn tone="go">Start fix</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Before a fix starts, the <Ui>AI Fix</Ui> tab shows <Ui>What to fix</Ui>: every item the agent could work on, in
        sections, each with a tick box. The agent is given exactly the items you tick, and nothing else. Each item is
        drawn with the same card you see on the <Ui>AI Review</Ui> tab, so you know what you are picking.
      </p>

      <H2 id="the-sections">The sections</H2>
      <PickerPicture />
      <MiniTable
        cols={[
          { key: 's', label: 'Section' },
          { key: 'w', label: 'What it holds' },
          { key: 'd', label: 'Ticked at first' },
        ]}
        rows={[
          { _key: 'm', s: 'Merge conflicts', w: 'Resolve merge conflicts with the base branch, when the pull request has conflicts and you can push to it.', d: 'Yes' },
          { _key: 'f', s: 'Claude’s findings (or Codex’s)', w: 'The review’s findings, except ones you ignored. Questions are left out: they are answered with a reply, not a code change.', d: 'Yes' },
          { _key: 'e', s: 'Earlier findings still open', w: 'Findings of earlier reviews that the follow-up found not, or only partly, addressed.', d: 'Yes' },
          { _key: 'j', s: 'Threads Claude says need a fix', w: 'Other people’s threads a judgement found valid and not addressed.', d: 'Yes' },
          { _key: 'u', s: 'Unanswered threads', w: 'Threads with no reply and no later change.', d: 'Yes' },
          { _key: 'c', s: 'CI failures', w: 'Failures the CI review says this pull request can fix.', d: 'Yes' },
          { _key: 'q', s: 'SonarCloud issues', w: 'Issues SonarCloud found on this commit.', d: 'Yes' },
          { _key: 'b', s: 'Style bot comments', w: 'Comments by linters and style bots.', d: 'No' },
          { _key: 't', s: 'Ticket gaps', w: 'Acceptance criteria the story check found not met or partly met, and missing pieces.', d: 'Yes' },
        ]}
      />
      <p>
        A thread appears in one section only. A section is shown only when it has items. <Ui>Tick all</Ui> and{' '}
        <Ui>Untick all</Ui> change every item at once.
      </p>
      <p>
        For where each of these comes from, see <DocLink to="ai-review/run-a-review#read-the-findings">Run a review</DocLink>,{' '}
        <DocLink to="ai-review/check-threads">Check threads</DocLink>, <DocLink to="ai-review/ci-review">CI review</DocLink>,{' '}
        <DocLink to="integrations/sonarcloud">SonarCloud</DocLink> and{' '}
        <DocLink to="story-checks/acceptance-criteria">Acceptance criteria</DocLink>.
      </p>

      <H2 id="which-review">Which review it uses</H2>
      <p>
        The tab uses the last review that finished. It says so when a newer one is running, or when the latest one
        failed. When you press <Ui>Generate fix from this review</Ui> on an earlier review, it uses that one and says{' '}
        <Ui>Uses the review you picked, not the latest.</Ui>
      </p>

      <H2 id="wont-fit">When an item will not fit</H2>
      <p>
        There is a limit to how much text one fix can be given. Items are given in order of priority: CI failures and
        blockers first, nits last. When your ticks go over the limit, the items that would be cut show{' '}
        <Ui>Won’t fit</Ui>. Untick something else to make room, or fix them in a second run. Nothing is cut silently:
        the agent is told which items were left out.
      </p>

      <H2 id="fix-ci-failures-only">Fix CI failures only</H2>
      <p>
        <Ui>Fix with AI</Ui>, in the <Ui>CI check</Ui> section of the <Ui>AI Review</Ui> tab, opens <Ui>AI Fix</Ui> with
        only the CI failures ticked. You can tick more before you press <Ui>Start fix</Ui>. With no AI review at all, the
        tab says <Ui>No AI review yet. This fix works on the CI check’s failures.</Ui>
      </p>

      <H2 id="add-your-own-words">Add your own words</H2>
      <p>
        Once the fix is running or done, the message box takes your own instructions: "also add a test for a refund on
        day 30", "keep the old function name". Each message is one more build turn in the same sandbox. See{' '}
        <DocLink to="ai-fix/overview#watch-it-work">Fix a pull request with AI Fix</DocLink>.
      </p>
      <Tip>
        To shape the fix before any code changes, tick <Ui>Plan first</Ui>. See <DocLink to="ai-fix/plan-first">Plan first</DocLink>.
      </Tip>
      <Note>
        An automatic fix (after an auto review of your own pull request) uses the sections ticked under{' '}
        <Ui>Always include</Ui> in <Ui>Settings → AI review</Ui>: by default every section except style bot comments.
        It never fixes ticket gaps or merge conflicts. See <DocLink to="ai-fix/push-and-auto-fix">Push the fix, and auto fix</DocLink>.
      </Note>
    </>
  );
}

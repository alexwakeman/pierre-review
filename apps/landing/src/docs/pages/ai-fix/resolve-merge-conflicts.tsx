import type { DocMeta } from '../../types';
import { Btn, Chip, Diff, DocLink, FindingRow, Group, H2, Illustration, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Resolve merge conflicts with AI Fix',
  summary: 'The agent merges the default branch, resolves the conflicts and Limn checks the result before it can push.',
};

function MergePicture(): JSX.Element {
  return (
    <Illustration
      label="A finished AI Fix on pull request 701, Rename ledger, with the merge item. How the conflicts were resolved shows one hunk in ledger/post.py that keeps both changes. A line says the merge commit matches git's own merge outside the conflicts. Then the fixes on top."
      caption="A fix with the merge item: the resolution and the fixes on top are shown apart."
      title="#701 Rename ledger"
      meta="AI Fix"
    >
      <Group first>How the conflicts were resolved</Group>
      <Diff
        file="ledger/post.py"
        lines={[
          { k: '-', t: '    entry = LedgerEntry(amount=amt)' },
          { k: '+', t: '    entry = Entry(amount=amt, currency=cur)' },
        ]}
      />
      <p className="muted">The merge commit matches git's own merge outside the conflicts.</p>
      <FindingRow chip="Fixes on top · 1 file">api/routes.py: the import uses the renamed Entry.</FindingRow>
      <p>
        <Chip>Push to the PR branch</Chip> <Btn tone="go">Push</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When a pull request conflicts with its base branch, AI Fix can merge the base branch in and resolve the
        conflicts, then fix the other items on top. Limn checks the merge itself before anything can be pushed. You
        review how each conflict was resolved, apart from the other changes.
      </p>

      <H2 id="when-it-is-offered">When it is offered</H2>
      <p>
        The first item under <Ui>What to fix</Ui> reads <Ui>Resolve merge conflicts with</Ui> and the base branch, for
        example <b>main</b>. It is there, and ticked, when:
      </p>
      <ul>
        <li>GitHub says the pull request conflicts with its base branch;</li>
        <li>the pull request is not in a merge queue; and</li>
        <li>you can push to its branch.</li>
      </ul>
      <p>
        It needs no AI review and no CI item. Ticked alone, the agent resolves the conflicts and changes nothing else.
      </p>

      <H2 id="what-the-agent-does">What the agent does</H2>
      <Steps>
        <li>Limn starts the merge of the base branch's latest commit in the sandbox, before the agent starts.</li>
        <li>
          The agent resolves each conflict with judgement, not by taking one side. It reads the lines around each
          conflict, so nothing is repeated, nothing is lost and no conflict marker is left.
        </li>
        <li>It makes the merge commit, builds and tests, then fixes the other ticked items on top.</li>
      </Steps>

      <H2 id="limns-check">Limn's check</H2>
      <p>
        After each build turn, Limn checks the agent's commits on your computer, outside the sandbox: the merge commit
        must join exactly the pull request and the base branch, no conflict marker may remain, and the fixes must come
        after the merge. The result is shown from Limn's own copy of those commits, not from anything the agent says.
      </p>
      <ul>
        <li>
          When the merge passes, the tab says <Ui>The merge commit matches git's own merge outside the conflicts.</Ui>
        </li>
        <li>
          When it fails, the merge item is <Ui>Not addressed</Ui> with Limn's reason, the tab shows{' '}
          <Ui>Merge not valid</Ui>, and nothing can be pushed, not even the other fixes:{' '}
          <Ui>The merge did not pass Limn’s check, so nothing can be pushed. Ask for more, or discard.</Ui>
        </li>
      </ul>

      <H2 id="review-the-merge">Review the merge</H2>
      <MergePicture />
      <p>
        <Ui>How the conflicts were resolved</Ui> shows only what the agent decided inside the conflicts, compared with
        git's own merge. <Ui>Fixes on top</Ui> shows the other changes. If there are none, the tab says{' '}
        <Ui>No other changes on top of the merge.</Ui>
      </p>

      <H2 id="push-it">Push it</H2>
      <p>
        <Ui>Push sends the merge commit and the fixes on top to the PR's branch. A merge that fails the check sends
        nothing.</Ui> A fix with the merge item pushes only to the pull request's own branch, never to a new branch, and
        never to a fork's branch.
      </p>
      <Warning>
        Push refuses if the pull request's branch moved since the fix started. It is never a forced push.
      </Warning>

      <H2 id="by-hand-instead">By hand instead</H2>
      <p>
        You can always resolve conflicts yourself in Limn's resolver, region by region, with nothing applied until you
        press a button. See <DocLink to="merging/resolve-conflicts">Resolve conflicts</DocLink>.
      </p>
      <Note>
        An automatic fix resolves merge conflicts only when you tick <Ui>Merge conflicts with the base branch</Ui> under{' '}
        <DocLink to="ai-fix/push-and-auto-fix#auto-fix">Auto fix</DocLink> (off by default). Dependency automation can,
        for a trusted bot's update, when you switch that on. See{' '}
        <DocLink to="merging/dependency-automation">Dependency automation</DocLink>.
      </Note>
    </>
  );
}

import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, H2, H3, Illustration, Note, Steps, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Resolve conflicts by hand',
  summary: 'The conflict resolver: decide each conflicting region yourself, then commit the merge.',
};

function ResolverPicture(): JSX.Element {
  return (
    <div className="dx-panes" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
      <div>
        <b>Your version</b>
        <pre className="mk-diff">
          <span className="add">+ amount = to_pence(raw)</span>
        </pre>
      </div>
      <div>
        <b>Result</b> <Chip tone="amber">Needs a decision</Chip>
        <pre className="mk-diff">
          <span className="ctx">  amount = float(raw)</span>
        </pre>
      </div>
      <div>
        <b>Changes from main</b>
        <pre className="mk-diff">
          <span className="add">+ amount = Decimal(raw)</span>
        </pre>
      </div>
    </div>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When a pull request conflicts with its base branch, GitHub will not merge it and its own editor handles only
        simple cases. Limn’s conflict resolver lets you settle the conflicts inside Limn. You see your version, the
        base branch’s changes and the result side by side, decide each conflicting region, and commit the merge. Limn
        never picks a side for you, and nothing is pushed until you press the button.
      </p>


      <H2 id="open-the-resolver">Open the resolver</H2>
      <p>
        Press <Ui>Resolve conflicts</Ui>. You find it on the pull request’s Overview tab (the <Ui>Conflicts</Ui> row),
        in the merge controls, and on the Pending board’s conflicts card. It shows only on open pull requests you can
        push to. If you cannot push, you see the conflict and a link to GitHub instead. You can resolve one pull
        request at a time.
      </p>

      <H2 id="decide-each-change">Decide each change</H2>
      <Illustration
        label="The resolver's three panes: Your version on the left, the Result in the middle marked Needs a decision, and Changes from main on the right"
        caption="Your version on the left, the base branch’s changes on the right, the result in the middle."
      >
        <ResolverPicture />
      </Illustration>
      <ul>
        <li>
          <strong>Left:</strong> <Ui>Your version</Ui>, the pull request’s branch.
        </li>
        <li>
          <strong>Right:</strong> <Ui>Changes from main</Ui> (with your base branch’s name).
        </li>
        <li>
          <strong>Middle:</strong> the result. It starts from the last commit both branches shared, and changes only
          when you decide a region. Every region starts as <Ui>Needs a decision</Ui>.
        </li>
      </ul>
      <p>For each region, choose one of:</p>
      <ul>
        <li>
          <Ui>Take your version</Ui> or <Ui>Take the change from main</Ui>;
        </li>
        <li>
          <Ui>Take both — yours first, then main</Ui> or the other way round, and <Ui>Swap which side goes first</Ui>;
        </li>
        <li>
          <Ui>Ignore this change and keep the ancestor</Ui>;
        </li>
        <li>
          <Ui>Edit the result for this change</Ui>, to type the result yourself;
        </li>
        <li>
          <Ui>Undo this decision</Ui>.
        </li>
      </ul>
      <p>
        To compare with the starting point, open <Ui>Merge base</Ui>, the last commit both branches shared. For a whole
        file at once, use <Ui>Take your file</Ui> or <Ui>Take main’s file</Ui>.
      </p>
      <H3>Take the obvious ones</H3>
      <p>
        <Ui>Take the obvious ones</Ui> applies every change only one side made, and merges conflicts whose edits do
        not overlap. It never picks a side where both sides changed the same lines. You still decide those.
      </p>
      <Tip>
        The toolbar counts what is left, for example “All files: 3 of 11 changes left”. <Ui>Next file that needs
        decisions</Ui> jumps to the next one.
      </Tip>

      <H2 id="commit-and-push">Commit and push</H2>
      <Steps>
        <li>
          Decide every region in every file. Until you have, <Ui>Commit and push</Ui> stays shut and{' '}
          <Ui>What is left to decide</Ui> lists each file still open.
        </li>
        <li>
          Press <Ui>Commit and push</Ui> in the toolbar. The landing step shows <Ui>What is being committed</Ui>.
        </li>
        <li>
          Under <Ui>How to land it</Ui>, choose <Ui>Merge</Ui> (one merge commit on your branch, plain push) or{' '}
          <Ui>Rebase</Ui> (replays your commit onto the base branch and force-pushes safely).
        </li>
        <li>
          Under <Ui>Where to put it</Ui>, choose <Ui>Push to</Ui> your branch, or <Ui>Commit to a new branch</Ui>, with{' '}
          <Ui>Open a pull request for it</Ui> if you want one.
        </li>
        <li>
          Press <Ui>Commit and push</Ui>.
        </li>
      </Steps>
      <Illustration label="The Commit and push button" caption="Nothing is pushed until you press this.">
        <Btn tone="go">Commit and push</Btn>
      </Illustration>
      <Warning title="This pushes to GitHub">
        The commit goes out under your GitHub account. If either branch moved while you worked, nothing is pushed,
        and you are told so.
      </Warning>
      <Note>
        Some files cannot be resolved in the resolver, for example a file that is binary. They are listed under{' '}
        <Ui>Still conflicted:</Ui>, and the pull request stays conflicted until you resolve them on GitHub or
        locally. If the pull request has very many conflicting files, the resolver shows a part of them and says how
        many.
      </Note>

      <H2 id="let-ai-do-it">Let AI do it instead</H2>
      <p>
        If you would rather not decide region by region, AI Fix can merge the base branch in for you in its sandbox,
        and you push the result once you have read it. See{' '}
        <DocLink to="ai-fix/resolve-merge-conflicts">Resolve merge conflicts with AI Fix</DocLink>.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A conflict is often a few lines, but settling it usually means checking out the branch, merging, fixing and
        pushing. The resolver does it in the browser, keeps every decision yours, and will not commit a half-finished
        merge. Once it is resolved, see <DocLink to="merging/can-it-land">Can it land?</DocLink>.
      </p>
    </>
  );
}

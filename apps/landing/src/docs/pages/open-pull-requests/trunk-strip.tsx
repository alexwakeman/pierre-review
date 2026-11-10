import type { DocMeta } from '../../types';
import { CheckRow, DocLink, H2, H3, Illustration, Note, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Check the default branches',
  summary: 'The strip at the top of Open pull requests shows whether each repository\'s default branch is green.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A broken default branch (often <code>main</code>) affects every open pull request in that repository at
        once, because each one is tested against it. The strip at the top of <Ui>Open pull requests</Ui> shows
        the default branch of every repository in the workspace, with the result of its latest checks.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>One row per repository, each with a coloured dot. Point at the dot to read its state:</p>
      <ul>
        <li>
          <Ui>CI passing</Ui> (green): the latest commit&rsquo;s checks passed.
        </li>
        <li>
          <Ui>CI failing</Ui> or <Ui>CI error</Ui> (red): a check failed on the latest commit. The row names the
          failing checks.
        </li>
        <li>
          <Ui>CI running</Ui> (yellow): the checks have not finished.
        </li>
        <li>
          <Ui>No CI reported</Ui>: GitHub reports no checks for the branch. The dot is a hollow ring.
        </li>
      </ul>
      <p>
        Each row also says which pull request the latest commit came from, and how long ago. Choose the
        pull request's number to open it in Limn.
      </p>

      <Illustration
        label="The default branch strip: acme/payments main passing, acme/api main failing on the test job, acme/web main running."
        caption="The default branch strip, one row per repository."
      >
        <CheckRow name="acme/payments · main" state="CI passing" tone="green" note="#612 Partial refunds · 2h" />
        <CheckRow name="acme/api · main" state="CI failing" tone="red" note="test, lint · #488 Webhook timeouts · 40m" />
        <CheckRow name="acme/web · main" state="CI running" tone="amber" note="#1184 Checkout redesign · 5m" />
      </Illustration>

      <H2 id="open-a-row">Open a row</H2>
      <p>Open a repository's row to see:</p>
      <ul>
        <li>
          <b>The pull requests that merged into it</b>, up to ten, in merge order. Each row's dot is the result
          of its newest commit. Hover the commit count to see the commits. A branch that only had direct pushes
          says so.
        </li>
        <li>
          <b>
            <Ui>Trunk CI · daily</Ui>
          </b>
          : one cell per day, coloured by how the branch's checks went, with the number of pull requests merged
          that day above the cells. Hover a cell for its counts. It covers the days Limn keeps history for.
        </li>
        <li>
          <b>
            <Ui>Flaky</Ui>
          </b>{' '}
          marks a check that both passed and failed on the same commit, so a red result may not be the code's
          fault.
        </li>
      </ul>

      <H3>Where else it shows</H3>
      <p>
        Each <DocLink to="getting-started/repository-pages">repository page</DocLink> shows the same row for its
        own branch. A red default branch in a repository you maintain also shows in{' '}
        <DocLink to="pending/needs-fixing">Needs fixing</DocLink> as <Ui>Trunk CI failing</Ui>.
      </p>

      <Note>
        The strip is information only. It adds nothing to a count, a badge or My turn, because a red default
        branch is not one person's task.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        When <code>main</code> goes red, every open pull request in the repository can look broken. The strip
        tells you that first, names the pull request that landed the failing commit, and the daily chart shows
        whether a repository is red now and then or most of the time.
      </p>
    </>
  );
}

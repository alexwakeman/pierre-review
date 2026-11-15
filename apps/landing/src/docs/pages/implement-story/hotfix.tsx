import type { DocMeta } from '../../types';
import { DocLink, H2, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Hotfix a release',
  summary: 'Treat as a hotfix builds one fix on your latest release and ports it to the default branch, with two pull requests per repository.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A bug in a released version needs a fix on that release and the same fix on the default branch.{' '}
        <Ui>Treat as a hotfix</Ui>, at Implement&rsquo;s start, does both in one sandbox: the agent fixes the release
        first, then ports the fix to the default branch and runs the tests again.
      </p>

      <H2 id="when-it-is-offered">When it is offered</H2>
      <ul>
        <li>
          Both suffixes are set in <DocLink to="settings/releases">Settings → Releases</DocLink>.
        </li>
        <li>
          At least one repository of the workspace has a latest release: its newest release or hotfix tag. See{' '}
          <DocLink to="this-sprint/releases">Release safe version tags</DocLink>.
        </li>
      </ul>
      <p>Ticked, the start lists each repository&rsquo;s base, for example:</p>
      <ul>
        <li>
          <Ui>acme/api from v2.4.0-rc (12 Nov) → PRs into hotfix/v2.4.0-rc and main</Ui>
        </li>
        <li>
          <Ui>acme/worker no release yet — read only</Ui>
        </li>
      </ul>
      <p>A repository with no release is read only: the agent can read it, and Limn keeps none of its changes.</p>

      <H2 id="the-flow">The flow</H2>
      <Steps>
        <li>
          On the story view, press <Ui>Implement</Ui>. In the build tab, tick <Ui>Treat as a hotfix</Ui> and press{' '}
          <Ui>Start</Ui>.
        </li>
        <li>
          Settle the plan as usual. See <DocLink to="implement-story/plan">Plan the work</DocLink>.
        </li>
        <li>
          <Ui>Approve and start</Ui>. The agent fixes each release checkout and runs its tests, then ports the fix to the
          default branch, resolves the differences and runs the tests again.
        </li>
        <li>
          Each repository shows two diffs: <Ui>Release fix</Ui> and <Ui>Main fix</Ui>.
        </li>
        <li>
          Press <Ui>Push both as drafts</Ui> (or untick drafts first).
        </li>
      </Steps>

      <H2 id="what-push-opens">What Push opens</H2>
      <ul>
        <li>
          <Ui>hotfix/&lt;tag&gt;</Ui>, made at the release commit if it is not there yet.
        </li>
        <li>A pull request from the ticket key into <Ui>hotfix/&lt;tag&gt;</Ui>, with the release fix.</li>
        <li>A pull request from the ticket key plus <Ui>-main</Ui> into the default branch, with the main fix.</li>
      </ul>
      <p>
        Both are titled with the ticket key and title, and each description links the other. Both are yours, as with any
        Implement push. After they open, Limn writes nothing more for the build.
      </p>
      <p>
        If <Ui>hotfix/&lt;tag&gt;</Ui> already has commits past the release, for example from an earlier hotfix, the
        release pull request still targets it, and the tab names the pull requests already open on it.
      </p>
      <Note>
        The review loop and <Ui>Build end to end</Ui> are off for a hotfix build. When the team tags the hotfix with your
        hotfix suffix, that tag becomes the latest release, and the next hotfix starts from it.
      </Note>
    </>
  );
}

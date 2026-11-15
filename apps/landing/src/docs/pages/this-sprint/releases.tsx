import type { DocMeta } from '../../types';
import { SprintLanesMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, Kbd, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Release safe version tags',
  summary:
    'The Releases tab says, for each repository you release, which version tag is safe to release, and tags it with your release suffix in one press.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>This Sprint → Releases</Ui> (press <Kbd>4</Kbd> on This Sprint) checks the version tags of each repository you
        release against your tickets. For each one it finds the newest version tag on the default branch whose pull
        requests link only to Done tickets. Each repository is checked on its own. That tag is the <strong>candidate</strong>. One press then tags every
        candidate as a release, publishes the release notes and comments on each ticket.
      </p>
      <p>
        Ensemble never cuts a version tag and deploys nothing. Your CI, or a person, tags the default branch. The release
        tag is what starts your team&rsquo;s own build.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          A release suffix and a hotfix suffix, in <DocLink to="settings/releases">Settings → Releases</DocLink>. Until
          both are set, the tab shows one line and a <Ui>Set up in Settings</Ui> button.
        </li>
        <li>
          The repositories you release, ticked under <Ui>Released from this workspace</Ui> in the same settings. Only
          those are checked. Test and docs repositories you never release stay unticked and are ignored.
        </li>
        <li>
          An issue tracker for the workspace, so pull requests can be joined to tickets. See{' '}
          <DocLink to="this-sprint/overview#what-you-need">What you need</DocLink> on the This Sprint page.
        </li>
        <li>Push access to a repository to release it.</li>
      </ul>

      <H2 id="what-you-see">What you see</H2>
      <SprintLanesMock initialView="releases" />
      <H3 id="the-header">The header</H3>
      <p>
        &ldquo;Latest release: none&rdquo; or the date of the latest release, for example &ldquo;Latest release: 12
        Nov&rdquo;. <Ui>View notes</Ui> opens the latest release made here: its steps and its notes.{' '}
        <Ui>Refresh</Ui> reads the tickets that hold a version tag back from the tracker again, then checks again.
      </p>
      <H3 id="repository-rows">Repository rows</H3>
      <p>One row for each repository you release. It shows the latest version tag on the default branch and the candidate:</p>
      <ul>
        <li>&ldquo;Latest 0.394.0 is the candidate → 0.394.0-rc&rdquo;. The last name is the release tag the press would create.</li>
        <li>&ldquo;Latest 0.394.0 · candidate 0.390.0 → 0.390.0-rc&rdquo;. A later tag is held back.</li>
        <li>&ldquo;No candidate: 0.391.0 held by BMD-1048 (In PO Review)&rdquo;. The first tag after the last release is held back.</li>
        <li>&ldquo;Latest 0.394.0 · Reading changes…&rdquo;. Ensemble is still reading which pull requests are in the tags.</li>
        <li>&ldquo;Nothing new since 0.390.0-rc&rdquo;. This repository is left out of the release.</li>
      </ul>
      <p>
        Select a row to see its version tags since the last release, newest first. Each tag lists its tickets, with their
        status, and its pull requests with no ticket. The candidate has a star, and the first tag held back is marked.
        Select a pull request to open it, or a ticket to open its story.
      </p>
      <H3 id="start-from-a-tag">Start from a tag</H3>
      <p>
        With no release yet, only the newest 40 tags are checked, and an old ticket that is not Done can hold every one of
        them. Press <Ui>Start from this tag</Ui> beside a version tag to treat it, and everything before it, as accepted.
        Only the tags after it are checked. The row then says &ldquo;Starts from 0.380.0&rdquo;, with <Ui>Change</Ui> to
        pick another version tag and <Ui>Clear</Ui> to remove it. Nothing is written to GitHub.
      </p>
      <p>
        If that tag later moves to another commit or is deleted, the row says so and the check goes back to the last
        release. A release newer than the start tag always counts from the release.
      </p>
      <H3 id="warnings">Warnings</H3>
      <p>A pull request with no ticket is listed as a warning. It never holds a release back.</p>

      <H2 id="the-rules">The rules</H2>
      <ul>
        <li>
          A ticket counts as Done only when it is in your Complete column. A cancelled ticket, such as &ldquo;Won&rsquo;t
          do&rdquo;, is not Done, so it holds the release back like any other unfinished ticket.
        </li>
        <li>A ticket that could not be read from the tracker holds the release back, with the reason.</li>
        <li>
          Only the ticket counts. Its pull requests in other repositories, and its open pull requests, hold nothing
          back.
        </li>
        <li>Pull requests into a hotfix branch never count.</li>
        <li>A bot pull request with no ticket is listed under dependency and bot changes, with no warning.</li>
      </ul>

      <H2 id="create-a-release">Create a release</H2>
      <p>
        <Ui>Create release…</Ui> shows only when a repository you can push to has a candidate.
      </p>
      <Steps>
        <li>Untick any repository you do not want to release now. The others are released as they are.</li>
        <li>Read the release notes, one section per repository, and change them if you want.</li>
        <li>Read the comment each ticket will get.</li>
        <li>
          Press <Ui>Confirm</Ui>. Ensemble first reads every ticket in the release again and checks each version tag. If
          anything changed, it stops, lists what changed and writes nothing.
        </li>
      </Steps>
      <p>Then, in order: the release tags, a GitHub pre-release on each with that repository&rsquo;s notes, and a comment on each ticket whose repositories all tagged. The dialog lists each step and whether it worked.</p>
      <Warning>
        A release tag that already exists is never moved. That repository is refused and the others go ahead. A ticket
        in a repository that failed to tag gets no comment.
      </Warning>
      <Note>
        With AI on, the notes add a one-paragraph summary per story. Version numbers and counts always come from your
        tags, never from the model. Comments are posted on Jira; other trackers are not supported yet.
      </Note>
    </>
  );
}

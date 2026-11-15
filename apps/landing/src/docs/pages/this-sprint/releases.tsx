import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Kbd, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Release safe version tags',
  summary:
    'The Releases tab says, per repository, which version tag is safe to release, and tags it with your release suffix in one press.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>This Sprint → Releases</Ui> (press <Kbd>4</Kbd> on This Sprint) checks each repository&rsquo;s version tags
        against your tickets. For each repository it finds the newest version tag on the default branch whose pull
        requests link only to Done tickets. That tag is the <strong>candidate</strong>. One press then tags every
        candidate as a release, publishes the release notes and comments on each ticket.
      </p>
      <p>
        Limn never cuts a version tag and deploys nothing. Your CI, or a person, tags the default branch. The release
        tag is what starts your team&rsquo;s own build.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          A release suffix and a hotfix suffix, in <DocLink to="settings/releases">Settings → Releases</DocLink>. Until
          both are set, the tab shows one line and a <Ui>Set up in Settings</Ui> button.
        </li>
        <li>
          An issue tracker for the workspace, so pull requests can be joined to tickets. See{' '}
          <DocLink to="this-sprint/overview#what-you-need">What you need</DocLink> on the This Sprint page.
        </li>
        <li>Push access to a repository to release it.</li>
      </ul>

      <H2 id="what-you-see">What you see</H2>
      <H3 id="the-header">The header</H3>
      <p>
        &ldquo;Latest release: none&rdquo; or the date of the latest release, for example &ldquo;Latest release: 12
        Nov&rdquo;. <Ui>View notes</Ui> opens the latest release made here: its steps and its notes.{' '}
        <Ui>Refresh</Ui> reads the sprint&rsquo;s tickets from the tracker again and checks again.
      </p>
      <H3 id="repository-rows">Repository rows</H3>
      <ul>
        <li>
          A candidate: &ldquo;api ★ v2.4.0 → v2.4.0-rc · 6 tickets · 1 warning&rdquo;. The second name is the release
          tag the press would create.
        </li>
        <li>
          Nothing to release: &ldquo;Nothing new since v2.3.0-rc&rdquo;. This repository is left out of the release.
        </li>
        <li>
          Held back: &ldquo;No candidate: v0.3.0 held by PLAT-301 (In review)&rdquo;.
        </li>
      </ul>
      <p>
        Select a row to see its version tags since the last release, newest first, with their pull requests and
        tickets. The candidate has a star, and a held tag says why. Select a pull request to open it, or a ticket to
        open its story.
      </p>
      <H3 id="tickets">Tickets</H3>
      <p>
        Each ticket in the release, or holding it back, with its state in each repository: in candidate, released,
        merged after candidate, open PR, or linked with no PR.
      </p>
      <H3 id="warnings">Warnings</H3>
      <p>
        A pull request with no ticket, and a ticket linked to a repository that has no pull request for it, are
        listed as warnings. They never hold a release back.
      </p>

      <H2 id="the-rules">The rules</H2>
      <ul>
        <li>A ticket counts as Done when it is in your Complete column. &ldquo;Won&rsquo;t do&rdquo; counts as Done.</li>
        <li>A ticket that could not be read from the tracker holds the release back, with the reason.</li>
        <li>An open pull request into the default branch for a ticket holds it back.</li>
        <li>
          A ticket ships whole. If it has a merged pull request in another repository that is not in a version tag
          yet, it holds back the tag it is in, and the row says to cut a tag in that repository.
        </li>
        <li>Pull requests into a hotfix branch never count.</li>
        <li>A bot pull request with no ticket is listed under dependency and bot changes, with no warning.</li>
      </ul>

      <H2 id="create-a-release">Create a release</H2>
      <p>
        <Ui>Create release…</Ui> shows only when a repository you can push to has a candidate.
      </p>
      <Steps>
        <li>Untick any repository you do not want to release. If a ticket would then ship in part, the dialog names it and Confirm is not shown.</li>
        <li>Read the release notes, one section per repository, and change them if you want.</li>
        <li>Read the comment each ticket will get.</li>
        <li>
          Press <Ui>Confirm</Ui>. Limn first reads every ticket in the release again and checks each version tag. If
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

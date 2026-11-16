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
        release against your tickets, by itself. The <strong>candidate</strong> is the newest version tag on the default
        branch whose tickets are all Complete, with no pull request still open for any of them. Ensemble starts at the
        newest tag and stops at the first one that qualifies. Each repository is checked on its own. Check what the tab
        lists, then one press tags every candidate as a release, publishes the release notes and comments on each
        ticket.
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
        <Ui>Refresh</Ui> reads the tickets that are not Complete, not read yet or not found from the tracker again, then
        checks again.
      </p>
      <H3 id="repository-rows">Repository rows</H3>
      <p>One row for each repository you release:</p>
      <ul>
        <li>
          &ldquo;Release 0.392.0 → 0.392.0-rc&rdquo;, with &ldquo;Latest 0.394.0&rdquo; beside it when a newer tag does not
          qualify, and the counts, for example &ldquo;6 tickets · 1 to check&rdquo;. The last name is the release tag the
          press would create.
        </li>
        <li>
          &ldquo;No tag can be released — 0.394.0: BMD-1048 is In PO Review&rdquo;: no tag qualifies, and this is why the
          newest one does not. After a release it reads &ldquo;No tag since 0.380.0-rc can be released — …&rdquo;.
        </li>
        <li>
          &ldquo;Checking…&rdquo;, with a progress bar and one line of what is happening now, for example &ldquo;Reading
          main&rsquo;s history: 1,200 of 5,400 commits&rdquo; or &ldquo;Reading tickets from Jira: 300 of 420&rdquo;. The
          tab updates by itself until every repository is checked. It often has an answer before the whole history is
          read: the newest tags are read first.
        </li>
        <li>&ldquo;Nothing new since 0.390.0-rc&rdquo;. This repository is left out of the release.</li>
        <li>&ldquo;No version tags on main yet&rdquo;.</li>
      </ul>
      <H3 id="the-tag-list">The tag list</H3>
      <p>Select a row to open one list, newest at the top, in three parts:</p>
      <ul>
        <li>
          <strong>Newer than the candidate — can&rsquo;t be released.</strong> Every newer tag, open, with all its
          tickets. If no tag can be released, every tag that was checked is here.
        </li>
        <li>
          <strong>Candidate.</strong> The tag to release, with every ticket it covers and what was checked:
          &ldquo;this tag&rsquo;s own changes&rdquo; before your first release, or &ldquo;everything since
          0.380.0-rc&rdquo; after one.
        </li>
        <li>
          <strong>Older tags — for checking.</strong> The 10 tags below the candidate, one line each, such as
          &ldquo;✓ all 2 tickets Complete&rdquo; or &ldquo;✗ BMD-127 In Progress&rdquo;. Select a tag to see its tickets.{' '}
          <Ui>Show 50 more</Ui> adds the next 50. These tags never change the candidate. After a release the list stops
          at that release, for example &ldquo;0.380.0-rc — last release&rdquo;.
        </li>
      </ul>
      <p>
        Each tag shows its date, its commit (select it to open the commit on GitHub), and how many pull requests and
        tickets it has. Under each tag, tickets that stop it come first, then tickets to check by hand, then Complete
        ones:
      </p>
      <ul>
        <li>
          ✗ a ticket that stops the tag: its status, such as &ldquo;In PO Review&rdquo;, or &ldquo;Complete, but has an
          open PR: frontend #812&rdquo;. When your Complete, Cancelled or other column has a different name from the
          tracker&rsquo;s status, it is shown in brackets, for example &ldquo;Won&rsquo;t Do (Cancelled)&rdquo;.
        </li>
        <li>? a ticket to check by hand, such as &ldquo;not found in Jira — check by hand&rdquo;.</li>
        <li>✓ a Complete ticket.</li>
      </ul>
      <p>
        Select a ticket to see its type, its assignee, when its status was last read, the pull requests for it in this
        tag, and its pull requests elsewhere in the repositories you release: open ones, and merged ones with the tag
        that holds them (or &ldquo;not in a tag yet&rdquo;). <Ui>Open in Jira</Ui> opens the ticket, and <Ui>Story</Ui>{' '}
        opens its story. Select &ldquo;3 pull requests with no ticket&rdquo; under a tag to list them. Select a pull
        request to open it.
      </p>
      <H3 id="the-whole-history">The whole history</H3>
      <p>
        There is nothing to pick. The first check of a repository reads the history of main once, from the newest
        commit back to your last release (or the first commit), with each commit&rsquo;s pull request — beyond the 90
        days Ensemble normally syncs. It stops early once the candidate and the older tags you asked for are known. The tickets are then read from your tracker in batches (Jira: up to 100 in one
        request). Later checks read only the commits that are new since the last one. It works within your GitHub rate
        limit and waits when the limit is low.
      </p>

      <H2 id="the-rules">The rules</H2>
      <ul>
        <li>
          A tag&rsquo;s tickets: after a release, every ticket merged since that release up to the tag. Before your first
          release, only the tickets the tag itself added since the tag before it.
        </li>
        <li>
          A tag qualifies when each of its tickets is in your Complete column and has no open pull request into the
          default branch of any repository you release. A cancelled ticket, such as &ldquo;Won&rsquo;t do&rdquo;, is not
          Complete.
        </li>
        <li>
          A ticket the tracker could not find, or has no access to, does not stop a tag. It is listed under the tag for
          you to check. A ticket that is not read yet keeps the row checking; if the tracker does not answer three times
          in a row, it is listed as &ldquo;could not be read&rdquo; instead.
        </li>
        <li>
          Pull requests with no ticket never stop a tag and are not warnings. They are listed under the tag, and in the
          notes under untracked or dependency and bot changes.
        </li>
        <li>Commits with no pull request are noted on their tag.</li>
        <li>Pull requests into a hotfix branch never count.</li>
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
          Press <Ui>Confirm</Ui>. Ensemble first checks each candidate again: it reads its tickets again, looks for pull
          requests opened since, and checks each version tag. If anything changed, it stops, lists what changed and
          writes nothing.
        </li>
      </Steps>
      <p>Then, in order: the release tags, a GitHub pre-release on each with that repository&rsquo;s notes, and a comment on each ticket whose repositories all tagged. The dialog lists each step and whether it worked.</p>
      <Warning>
        A release tag that already exists is never moved. That repository is refused and the others go ahead. A ticket
        in a repository that failed to tag gets no comment.
      </Warning>
      <Note>
        After a release, the notes list everything since it. Before your first release they list only the
        tag&rsquo;s own stories and say &ldquo;Earlier changes are not listed.&rdquo; With AI on, the notes add a
        one-paragraph summary per story. Version numbers and counts always come from your
        tags, never from the model. Comments are posted on Jira; other trackers are not supported yet.
      </Note>
    </>
  );
}

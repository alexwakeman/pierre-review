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
        release against your tickets, by itself. It walks the version tags on the default branch from the oldest after
        the last release, or from the very first tag when there is no release yet. The first tag with a pull request
        whose ticket is not Done holds itself and every later tag back. The tag before it is the{' '}
        <strong>candidate</strong>. Each repository is checked on its own. One press then tags every candidate as a
        release, publishes the release notes and comments on each ticket.
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
      <p>One row for each repository you release:</p>
      <ul>
        <li>
          &ldquo;Release 0.388.0 → 0.388.0-rc&rdquo;, with &ldquo;Latest 0.394.0&rdquo; beside it when a later tag is held
          back, and the counts, for example &ldquo;6 tickets · 1 warning&rdquo;. The last name is the release tag the press
          would create.
        </li>
        <li>
          &ldquo;No tag can be released: the oldest tag, 0.12.0, already contains BMD-127 (In Progress)&rdquo;. After a
          release it reads &ldquo;No tag can be released since 0.380.0-rc: the next tag, 0.381.0, contains …&rdquo;.
        </li>
        <li>
          &ldquo;Candidate at most 0.388.0 — checking older history (40%)&rdquo;, with a progress bar. Ensemble reads the
          history of main newest first, so it knows early which tag the candidate can be at most: the tag just before the
          oldest held tag found so far. The candidate is confirmed when the reading reaches your last release (or the
          first commit) and every ticket is read.
        </li>
        <li>
          &ldquo;Checking…&rdquo;, with a progress bar and one line of what is happening now, for example &ldquo;Reading
          main&rsquo;s history: 1,200 of 5,400 commits&rdquo; or &ldquo;Reading tickets from Jira: 300 of 420&rdquo;. A
          candidate already found while later tags are still being read shows with a small &ldquo;Still reading later
          tags&rdquo; bar. The tab updates by itself until every repository is checked.
        </li>
        <li>&ldquo;Nothing new since 0.390.0-rc&rdquo;. This repository is left out of the release.</li>
        <li>&ldquo;No version tags on main yet&rdquo;.</li>
      </ul>
      <p>
        Select a row to see every tag after the candidate, newest first, then the candidate itself. Each held tag says
        why: its own tickets that are not Done, with their status, and what it carries from an earlier held tag, such as
        &ldquo;Also contains BMD-127 (from 0.312.0).&rdquo; Each tag also lists its pull requests with no ticket. Select a
        pull request to open it, or a ticket to open its story.
      </p>
      <H3 id="the-whole-history">The whole history</H3>
      <p>
        There is nothing to pick. The first check of a repository reads the history of main once, from the newest
        commit back to your last release (or the first commit), with each commit&rsquo;s pull request — beyond the 90
        days Ensemble normally syncs. The tickets are then read from your tracker in batches (Jira: up to 100 in one
        request). Later checks read only the commits that are new since the last one. It works within your GitHub rate
        limit and waits when the limit is low.
      </p>
      <H3 id="warnings">Warnings</H3>
      <p>A pull request with no ticket is listed as a warning. It never holds a release back.</p>

      <H2 id="the-rules">The rules</H2>
      <ul>
        <li>
          A ticket counts as Done only when it is in your Complete column. A cancelled ticket, such as &ldquo;Won&rsquo;t
          do&rdquo;, is not Done, so it holds the release back like any other unfinished ticket.
        </li>
        <li>
          A ticket the tracker could not find, or has no access to, holds the release back, with the reason. A ticket
          that is not read yet only keeps the row checking; if the tracker does not answer three times in a row, it
          holds the release back too.
        </li>
        <li>Commits with no pull request are noted on their tag. They hold nothing back.</li>
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

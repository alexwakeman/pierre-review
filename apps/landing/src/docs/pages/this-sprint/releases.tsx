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
        release against your tickets, by itself. Releasing a tag ships everything below it, so the{' '}
        <strong>candidate</strong> is the newest version tag on the default branch where that tag and every tag below it
        have all their tickets Complete, with no pull request still open for any of them. That is the tag just below
        the oldest tag that can&rsquo;t be released. The repositories are picked together, so no ticket is released
        with only part of its work. Check what the tab
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
      <H3 id="repositories">Repositories with no candidate</H3>
      <p>
        Above the tickets, a repository you release gets a line only when it has no candidate. Repositories with a
        candidate are named on the candidate ticket (see below).
      </p>
      <ul>
        <li>&ldquo;No tag can be released&rdquo;, or after a release &ldquo;No tag since 0.380.0-rc can be released&rdquo;.</li>
        <li>
          &ldquo;Checking…&rdquo;, with a progress bar and one line of what is happening now, for example &ldquo;Reading
          main&rsquo;s history: 1,200 of 5,400 commits&rdquo; or &ldquo;Reading tickets from Jira: 300 of 420&rdquo;. The
          tab updates by itself until every repository is checked. A candidate is shown once the whole history is
          read, because a tag far down can still hold one back.
        </li>
        <li>&ldquo;Nothing new since 0.390.0-rc&rdquo;. This repository is left out of the release.</li>
        <li>&ldquo;No version tags on main yet&rdquo;.</li>
      </ul>
      <H3 id="the-ticket-list">The ticket list</H3>
      <p>
        Below the repositories is one list of tickets for all of them, newest tag first. A ticket with work in two
        repositories is one card. It sits where its latest tag sits, in either repository. The list opens on the newest
        ticket in the release candidates, marked ★, with one ticket either side. <Ui>Show 3 later tickets</Ui> and{' '}
        <Ui>Show 3 earlier tickets</Ui> add more each way.
      </p>
      <p>
        The ★ card names the candidate of each repository, for example &ldquo;bng-metric-backend 0.316.0 →
        0.316.0-rc&rdquo;, the release tag a release would create, the candidate&rsquo;s commit (select it to open it on
        GitHub) and its date, and &ldquo;Latest 0.418.0&rdquo; when a newer tag can&rsquo;t be released yet. One{' '}
        <Ui>Release…</Ui> button releases them together.
      </p>
      <p>Each card has a mark:</p>
      <ul>
        <li>✓ the ticket is in the release candidates.</li>
        <li>✗ in red: the ticket is not Complete, or a pull request for it is still open.</li>
        <li>⊘ in amber: the ticket is Complete, but another ticket holds it back.</li>
        <li>
          ? on a dashed card: the tracker could not give the ticket, for example because it was deleted. It never stops
          a release. Check it by hand.
        </li>
      </ul>
      <p>
        A card shows the ticket&rsquo;s status, its latest tag in each repository, and one line. On a card that is not
        in the candidates, the line says what it waits on, for example &ldquo;Waits on BMD-1061: In Code Review&rdquo;.
        Select <Ui>Show BMD-1061</Ui> to go to that ticket. On a card in the candidates, the line says what was done, for
        example &ldquo;9 PRs, last merged 23 Oct by robin&rdquo;.
      </p>
      <p>
        Below the list, in a separate box, <Ui>Not in a tag yet</Ui> lists tickets whose only work is an open pull
        request, and <Ui>Holding the release</Ui> always shows the ticket that stops each repository&rsquo;s next tag.
        Pull requests with no ticket are narrow rows between the cards, for example &ldquo;14 PRs with no ticket · 13 by
        bots&rdquo;. Select one to list them. Bot pull requests are left out of these lists unless you tick{' '}
        <Ui>Show bot PRs</Ui> at the top of the list. These rows are hidden until you tick <Ui>Show PRs with no ticket</Ui>. The
        marks sit on a line down the left side of the list, with a merge mark for each group of pull requests with no
        ticket.
      </p>
      <p>
        Select a card to see its type, its assignee, when its status was last read, and every pull request for it in
        the repositories you release: open ones, and merged ones with the tag that holds them (or &ldquo;not in a tag
        yet&rdquo;). <Ui>Open in Jira</Ui> opens the ticket, and <Ui>Story</Ui> opens its story. Select a pull request to
        open it.
      </p>
      <H3 id="the-whole-history">The whole history</H3>
      <p>
        There is nothing to pick. The first check of a repository reads the history of main once, from the newest
        commit back to your last release (or the first commit), with each commit&rsquo;s pull request — beyond the 90
        days Ensemble normally syncs. The tickets are then read from your tracker in batches (Jira: up to 100 in one
        request). Later checks read only the commits that are new since the last one. It works within your GitHub rate
        limit and waits when the limit is low.
      </p>

      <H2 id="the-rules">The rules</H2>
      <ul>
        <li>
          A tag&rsquo;s tickets are everything releasing it would ship: after a release, every ticket merged since that
          release up to the tag; before your first release, every ticket merged up to the tag.
        </li>
        <li>
          A tag qualifies when each of its tickets is in your Complete column and has no open pull request into the
          default branch of any repository you release. A ticket in your Cancelled column, such as &ldquo;Won&rsquo;t
          do&rdquo;, never stops a tag: it is listed with a tick and gets no comment.
        </li>
        <li>
          A ticket the tracker could not find, or has no access to, does not stop a tag. It is listed for you to
          check. A ticket that is not read yet keeps the row checking; if the tracker does not answer three times
          in a row, it is listed as &ldquo;could not be read&rdquo; instead.
        </li>
        <li>
          Pull requests with no ticket never stop a tag and are not warnings. They are listed between the tickets,
          and in the notes under untracked or dependency and bot changes.
        </li>
        <li>
          A Complete ticket with work in more than one tag is released whole or not at all. If part of it is above a
          candidate, in any repository you release, the tags holding the rest can&rsquo;t be released either, for
          example &ldquo;BMD-1048 &ldquo;Edit an area&rdquo; would ship without bng-metric-backend #539 (in
          0.326.0)&rdquo;.
        </li>
        <li>Commits with no pull request are noted on their tag.</li>
        <li>Pull requests into a hotfix branch never count.</li>
      </ul>

      <H2 id="create-a-release">Create a release</H2>
      <p>
        <Ui>Release…</Ui> is on the candidate ticket. It shows only when a repository you can push to has a
        candidate.
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
        After a release, the notes list everything since it. Before your first release they list everything up to the
        tag and say &ldquo;First release: everything up to this tag.&rdquo; With AI on, the notes add a
        one-paragraph summary per story. Version numbers and counts always come from your
        tags, never from the model. Comments are posted on Jira; other trackers are not supported yet.
      </Note>
    </>
  );
}

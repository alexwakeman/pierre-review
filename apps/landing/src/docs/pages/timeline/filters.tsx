import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, Tip, Toolbar, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Filter the timeline',
  summary: 'Choose repositories, people and states. The repository picker and filters are on the Timeline only.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The bar above the Timeline narrows what the board shows: which repositories, which people, which pull
        request states, which events and which thread states, over which range of time. These filters apply to
        the Timeline only. The other pages always cover the whole workspace.
      </p>


      <Illustration
        label="The timeline's filter bar: Repos, Members, Status, Events and Threads menus, the Range choice, Now and Clear filters."
        caption="The filter bar. A menu that differs from its default shows a number."
      >
        <Toolbar>
          <Pill>Repos</Pill>
          <Pill>Members (2)</Pill>
          <Pill>Status</Pill>
          <Pill>Events (3)</Pill>
          <Pill>Threads</Pill>
          <Pill tone="blue">14d</Pill>
          <Pill>Now</Pill>
          <Pill>Clear filters</Pill>
        </Toolbar>
      </Illustration>

      <H2 id="the-filters">The filters</H2>
      <H3>Repos</H3>
      <p>
        Show or hide each repository in the workspace. <Ui>Show every repo in this workspace</Ui> resets it; the
        last shown repository cannot be hidden. A repository whose last sync failed is marked. To add or remove a
        repository, use <Ui>Manage repos &amp; workspaces</Ui> instead. See{' '}
        <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
      </p>
      <H3>Members</H3>
      <p>
        Choose whose rows show. The menu lists each repository's maintainers first; <Ui>Show N more</Ui> shows the
        rest, and a search finds anyone. <Ui>Maintainers</Ui> selects every maintainer. <Ui>Exclude bots</Ui> (on
        by default) hides bots; tick a single bot to keep it visible while the rest are hidden.
      </p>
      <H3>Status</H3>
      <p>
        <Ui>Draft</Ui>, <Ui>Open</Ui>, <Ui>Merged</Ui> and <Ui>Closed</Ui>. Everything but Closed shows by
        default. <Ui>Show stale PRs</Ui> adds open pull requests with no commits, comments or reviews in the
        range; they are hidden by default.
      </p>
      <H3>Events</H3>
      <p>
        <Ui>PR state events</Ui>, <Ui>Reviews</Ui>, <Ui>Review comments</Ui>, <Ui>PR comments</Ui> and{' '}
        <Ui>Commits</Ui> (off by default), and the review verdicts: <Ui>Approved</Ui>,{' '}
        <Ui>Changes requested</Ui>, <Ui>Commented</Ui> and <Ui>Dismissed</Ui>.
      </p>
      <H3>Threads</H3>
      <p>
        Show only pull requests with threads in the states you tick: <Ui>Untouched</Ui>, <Ui>Replied</Ui>,{' '}
        <Ui>Likely addressed</Ui>, <Ui>Resolved</Ui>. See{' '}
        <DocLink to="timeline/thread-states">What the thread states mean</DocLink>.
      </p>
      <H3>Range and Now</H3>
      <p>
        <Ui>7d</Ui>, <Ui>14d</Ui>, <Ui>30d</Ui> or <Ui>90d</Ui> sets how far back the board reaches. <Ui>Now</Ui>{' '}
        centres the board on the current time and keeps the zoom.
      </p>

      <H2 id="clear-filters">Clear the filters</H2>
      <p>
        <Ui>Clear filters</Ui> puts every filter back to its default. Your workspace stays the same. Each menu
        also has its own reset.
      </p>

      <Note>
        The filters are saved in the address bar, so a link you copy opens the same view, and they are kept in
        this browser between visits. A pull request you selected always shows, even if a filter would hide it.
      </Note>

      <Tip>
        On a phone, the filters fold behind one <Ui>Filters</Ui> button. A Focus tab shows only two of them,{' '}
        <Ui>Events</Ui> and <Ui>Hide bots</Ui>. See <DocLink to="timeline/focus-a-pull-request">Focus one pull request</DocLink>.
      </Tip>
    </>
  );
}

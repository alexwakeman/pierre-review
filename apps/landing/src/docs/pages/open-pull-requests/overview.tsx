import type { DocMeta } from '../../types';
import { AppShell, DocLink, H2, H3, Illustration, Kbd, Note, Pill, PrRow, Steps, Tabs, Tip, Toolbar, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the open pull requests list',
  summary: 'Every open pull request in the workspace on one page, with its review state, checks and age.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Open pull requests</Ui> is the page Limn opens on. It lists every open pull request in the
        workspace, drafts included, one row each, across every repository. Each row shows whether the pull
        request can land, its checks, its review, its open threads and its AI review. Select a row to see the
        rest in a side panel. The <DocLink to="open-pull-requests/trunk-strip">default branch strip</DocLink>{' '}
        sits at the top.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>
        The page has two tabs, <Ui>Open</Ui> and <Ui>Merged</Ui>. <Ui>Open</Ui> is the list described here.
        Each row has two lines:
      </p>
      <ul>
        <li>
          <b>The first line:</b> a coloured mark, the title, then four columns: <Ui>Review</Ui> (approved in
          green, changes requested in red), <Ui>CI</Ui> (a red cross, a tick, or a ring while checks run),{' '}
          <Ui>Threads</Ui> (open review threads; a red dot means one has no reply) and <Ui>AI review</Ui> (see{' '}
          <DocLink to="open-pull-requests/ai-review-column">the AI review column</DocLink>).
        </li>
        <li>
          <b>The second line:</b> the repository and number, the author and the age.
        </li>
      </ul>
      <p>
        The mark at the start of the row is red when the pull request has merge conflicts or is blocked,
        green when it can land, and grey otherwise. It uses the same rules as the pull request's own{' '}
        <DocLink to="merging/can-it-land">Can it land</DocLink> row.
      </p>

      <Illustration
        label="The Open pull requests page: two rows grouped under the ticket PAY-142, one under No ticket."
        caption="Open pull requests, grouped by ticket."
      >
        <AppShell active="Open pull requests">
          <Tabs tabs={[{ label: 'Open', count: 3, on: true }, { label: 'Merged' }]} />
          <Toolbar>
            <Pill>Sort: Recent activity</Pill>
            <Pill>Group by ticket</Pill>
          </Toolbar>
          <p className="muted">PAY-142 · Partial refunds</p>
          <PrRow
            title="#612 Partial refunds"
            repo="acme/payments · priya · 2d"
            status={
              <>
                <Pill tone="green">Approved</Pill> <Pill tone="green">CI</Pill> <Pill tone="amber">2 threads</Pill>
              </>
            }
          />
          <PrRow title="#488 Webhook timeouts" repo="acme/api · sam · 5h" status={<Pill tone="red">CI failing</Pill>} />
          <p className="muted">No ticket</p>
          <PrRow title="#1190 Settings split" repo="acme/web · robin · 1d" status={<Pill>Draft</Pill>} />
        </AppShell>
      </Illustration>

      <H3>The side panel</H3>
      <p>
        Select a row to open its side panel. The panel holds everything the row leaves out, in words:{' '}
        <Ui>Can it land</Ui>, <Ui>Checks</Ui>, <Ui>Reviews</Ui>, <Ui>Threads</Ui>, the author, when it was
        opened and updated, its <Ui>Size</Ui> and <Ui>Reach</Ui> (the{' '}
        <DocLink to="pull-request/blast-radius">blast radius</DocLink>), and the full AI review. The panel's
        place is kept even when it is empty, so the list does not move when you open or close it.
      </p>

      <H2 id="grouped-by-ticket">Grouped by ticket</H2>
      <p>
        Where the workspace has an issue tracker connected, the list is grouped by ticket. Each group shows
        the ticket's key and name; choose it to open the ticket's{' '}
        <DocLink to="this-sprint/story-view">story view</DocLink>. A pull request that names two tickets is in
        both groups. Pull requests with no ticket are in a last group, <Ui>No ticket</Ui>. Tickets that are not
        done come first, then the most recently updated.
      </p>
      <p>
        Choose <Ui>Group by ticket</Ui> or <Ui>List</Ui> to switch. Limn remembers your choice in this browser.
        On a slow tracker, Limn shows the plain list after a few seconds and offers to regroup when the
        tickets arrive.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <H3>Open a pull request</H3>
      <Steps>
        <li>
          Select a row (click it, or press <Kbd>j</Kbd> and <Kbd>k</Kbd>) to open its side panel.
        </li>
        <li>
          Double-click the row, or press <Kbd>↵</Kbd> again, to open the pull request in its own tab. See{' '}
          <DocLink to="pull-request/overview">Open a pull request</DocLink>.
        </li>
      </Steps>
      <p>
        <Kbd>o</Kbd> opens the selected pull request on GitHub, and <Kbd>r</Kbd> opens its AI review.
      </p>

      <H3>Use the row menu</H3>
      <p>
        Right-click a row (or press <Kbd>⇧</Kbd> <Kbd>F10</Kbd> on the selected row) for its menu:{' '}
        <Ui>Merge</Ui>, <Ui>Overview</Ui>, <Ui>Changes</Ui>, <Ui>Threads</Ui> and <Ui>AI Review</Ui>. Each one
        opens the pull request on that tab. <Ui>Merge</Ui> shows only when the pull request can land now, is
        not a draft, is not in GitHub's merge queue, has no merge armed, and you can push to the repository.
        Choosing it opens the merge options; nothing merges until you confirm there.
      </p>

      <H3>Sort and narrow the list</H3>
      <ul>
        <li>
          <b>
            <Ui>Sort</Ui>
          </b>
          : <Ui>Recent activity</Ui> (the default), <Ui>Updated</Ui>, <Ui>Opened</Ui>, <Ui>Size</Ui>,{' '}
          <Ui>Untouched threads</Ui>, <Ui>CI</Ui>, <Ui>Approval</Ui>, <Ui>Repo</Ui>, <Ui>Author</Ui> and{' '}
          <Ui>PR number</Ui>, plus <Ui>AI review</Ui> and <Ui>AI findings</Ui> where the AI features are on.
          The arrow beside the menu reverses the order. The menu always names the order on screen, for example
          "Opened, oldest first". With groups, the sort orders the rows inside each group.
        </li>
        <li>
          <b>The repository menu</b> narrows the list to one repository. It affects this page only.
        </li>
      </ul>
      <Note>
        The list draws the first rows and adds more as you scroll, or when you choose <Ui>Show more</Ui>. The
        counts, the sort and the groups always cover the whole list.
      </Note>

      <H2 id="merged">The Merged tab</H2>
      <p>
        <Ui>Merged</Ui> lists every pull request that merged in the workspace's reporting window (for example,
        the current sprint), newest merge first, with the same ticket groups. Where the tracker and the AI
        features are on, each ticket keeps its story check. See{' '}
        <DocLink to="reports/reporting-window">The reporting window</DocLink>.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        GitHub lists pull requests one repository at a time. This page shows all of them for the workspace,
        with the facts that decide what to do next, on one line each. Grouping by ticket shows which pieces of
        one story are still open. Use <DocLink to="pending/overview">Pending</DocLink> when you want the same
        work sorted by what to do first.
      </p>
      <Tip>
        Press <Kbd>g</Kbd> then <Kbd>o</Kbd> to come back here from anywhere.
      </Tip>
    </>
  );
}

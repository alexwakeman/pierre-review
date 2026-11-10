import type { DocMeta } from '../../types';
import { CheckRow, DocLink, FindingRow, H2, H3, Illustration, Note, Tabs, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Repository pages',
  summary: 'Each repository in the sidebar opens its own page: its open pull requests, its default branch and its sync state.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Choose a repository under <Ui>Repositories</Ui> in the sidebar to open its page. The page shows one
        repository only: what needs attention in it, its default branch, its charts, its open pull requests and
        its activity. It has two tabs, <Ui>Activity</Ui> and <Ui>Bots</Ui>.
      </p>

      <WhoItHelps
        developer="See at a glance whether the repository you own has a red default branch, conflicts or reviews waiting on you."
        manager="Check the health of one repository, with its own charts and its own review bots, apart from the rest of the workspace."
      />

      <H2 id="the-sidebar-dots">What the dots in the sidebar mean</H2>
      <p>Each repository line in the sidebar can carry up to two dots.</p>
      <ul>
        <li>
          <b>Red: needs attention.</b> A pull request is waiting for your review, the default branch is failing
          its checks, an open pull request is failing its checks, or an open pull request has merge conflicts.
          Drafts are not counted.
        </li>
        <li>
          <b>Blue: new to you.</b> Someone else commented, reviewed or pushed on an open pull request you have
          opened before, since you last opened it. Your own activity never turns a repository blue.
        </li>
      </ul>
      <p>
        The <Ui>ⓘ</Ui> beside <Ui>Repositories</Ui> says the same in two lines.
      </p>

      <H2 id="the-activity-tab">The Activity tab</H2>
      <H3>Status</H3>
      <p>
        The <Ui>Status</Ui> panel at the top spells out the dots, one plain line each, for example "2 pull
        requests are waiting for your review" or "main is failing CI". Everything a line names is further down
        the same page. With nothing to report, it shows one calm line.
      </p>
      <p>
        Blue clears for a pull request when you open it. To clear it for the whole repository, choose{' '}
        <Ui>Mark all seen</Ui>. Opening the repository page does not clear it, so the list you came to read is
        still there.
      </p>

      <Illustration
        label="A repository page for acme/payments: the Activity and Bots tabs, a Status panel with two lines, and the default branch row."
        caption="The top of the acme/payments page."
      >
        <Tabs tabs={[{ label: 'Activity', on: true }, { label: 'Bots' }]} />
        <FindingRow chip="Red" tone="red">
          1 pull request is waiting for your review
        </FindingRow>
        <FindingRow chip="Blue" tone="blue">
          New: 3 comments on 1 pull request since you last opened it
        </FindingRow>
        <CheckRow name="main" state="Passing" tone="green" note="#612 Partial refunds merged 2h ago" />
      </Illustration>

      <H3>The default branch</H3>
      <p>
        Under the status, a compact row shows the repository's default branch and whether its latest checks
        passed. Open it to see the pull requests that merged into it, with the daily trend charts. This is the
        same row the <DocLink to="open-pull-requests/trunk-strip">default branch strip</DocLink> shows for
        every repository. A failing default branch is information only: it never adds to a count or to My
        turn.
      </p>

      <H3>Threads, charts and open pull requests</H3>
      <ul>
        <li>
          <b>
            <Ui>Threads</Ui>
          </b>{' '}
          is a bar of the repository's review threads by state: Untouched, Replied, Likely addressed and
          Resolved. See <DocLink to="timeline/thread-states">What the thread states mean</DocLink>.
        </li>
        <li>
          <b>The charts</b> are the workspace's flow figures for this repository alone. Choose{' '}
          <Ui>More charts</Ui> to see the rest.
        </li>
        <li>
          <b>The open pull requests</b> list comes next. <Ui>Show all N open PRs</Ui> opens{' '}
          <DocLink to="open-pull-requests/overview">Open pull requests</DocLink> with this repository already
          chosen.
        </li>
        <li>
          <b>The feed</b> at the bottom is the <DocLink to="feed/overview">Feed</DocLink> for this repository
          only.
        </li>
      </ul>
      <Note>
        If you open a pull request's feed from its page (<Ui>Show in the Activity feed</Ui>), the repository
        page shows only that pull request's activity, under a <Ui>Showing only #…</Ui> line. Clear it to see the
        whole repository again.
      </Note>

      <H2 id="the-bots-tab">The Bots tab</H2>
      <p>
        <Ui>Bots</Ui> is <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink> for this repository:
        which review bots comment here, how much, and how often people act on what they say. The page
        remembers which of the two tabs you last used for each repository.
      </p>

      <H2 id="docs-offers">If Limn cannot read the files</H2>
      <p>
        Where the AI features are on, the status panel can add one line with no dot: "Limn can't read this
        repository's files, so its docs can't be offered", with the reason (no access, an empty repository, or
        not found on GitHub). It changes no count. See{' '}
        <DocLink to="docs-library/add-documents">Add documents</DocLink>.
      </p>
    </>
  );
}

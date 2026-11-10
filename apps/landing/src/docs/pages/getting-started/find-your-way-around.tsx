import type { DocMeta } from '../../types';
import { AppShell, DocLink, H2, H3, Illustration, Kbd, Note, Tip, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Find your way around',
  summary: 'The sidebar, the repository list, open tabs, and Search or jump.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn is one page with one sidebar. The sidebar takes you to every part of the app, lists your
        repositories and the tabs you have open, and shows the sync state at its foot. <Ui>Search or jump</Ui>{' '}
        finds a page, a setting, a pull request or a ticket by name.
      </p>

      <WhoItHelps
        developer="Keep several pull requests open as tabs and move between them, and the board, with the keyboard."
        manager="Go straight to the page you need, in the workspace you need, without hunting through menus."
      />

      <H2 id="the-sidebar">The sidebar</H2>
      <p>From top to bottom, the sidebar holds:</p>
      <ol>
        <li>
          <b>The workspace picker.</b> The workspace every page shows. See{' '}
          <DocLink to="getting-started/workspaces">Group repositories into workspaces</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Search or jump</Ui>
          </b>{' '}
          (<Kbd>⌘</Kbd> <Kbd>K</Kbd> on a Mac, <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> elsewhere). See{' '}
          <DocLink to="#search-or-jump">below</DocLink>.
        </li>
        <li>
          <b>The pages.</b> <Ui>Open pull requests</Ui>, <Ui>Pending</Ui>, <Ui>This Sprint</Ui> and{' '}
          <Ui>Timeline</Ui>; then, under <Ui>Library</Ui>, <Ui>Docs</Ui> and <Ui>Feed</Ui>; then, under{' '}
          <Ui>Insights</Ui>, <Ui>Reports</Ui> and <Ui>Bots Monitoring</Ui>.
        </li>
        <li>
          <b>
            <Ui>Needs you</Ui>
          </b>
          : other workspaces with pull requests waiting on you.
        </li>
        <li>
          <b>
            <Ui>Repositories</Ui>
          </b>
          : one line per repository, with its status dots and its number of open pull requests. It is closed
          until you open it, and it shows the first few rows, then <Ui>Show all</Ui>. Choose a repository to
          open its page. See <DocLink to="getting-started/repository-pages">Repository pages</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Open tabs</Ui>
          </b>
          : every tab you have open. See <DocLink to="#tabs">Tabs</DocLink>.
        </li>
        <li>
          <b>The foot:</b> the sync state, your AI usage, the bell for{' '}
          <DocLink to="pending/notifications">My Turn notifications</DocLink>, <Ui>Help</Ui>, the keyboard
          shortcuts, light or dark, and your account menu. <Ui>Settings</Ui> is in the account menu.
        </li>
      </ol>

      <Illustration
        label="The Limn sidebar with its eight pages, Open pull requests selected."
        caption="The pages in the sidebar. Library and Insights group the last four."
      >
        <AppShell active="Open pull requests">
          <p className="muted">Every open pull request in this workspace.</p>
        </AppShell>
      </Illustration>

      <Note>
        <Ui>Docs</Ui> shows only where the AI features are on. <Ui>Settings → Features</Ui> can hide{' '}
        <Ui>This Sprint</Ui>, <Ui>Feed</Ui>, <Ui>Reports</Ui> and <Ui>Bots Monitoring</Ui> from the sidebar.
        A hidden page still opens from a link or its key. See{' '}
        <DocLink to="settings/features">Settings → Features</DocLink>.
      </Note>

      <H2 id="tabs">Tabs</H2>
      <p>
        A pull request, a ticket's story, a person's activity or a list you drill into from a chart opens as a
        tab. The tabs are listed under <Ui>Open tabs</Ui> in the sidebar, and on a wide screen also along the
        top bar. Your place in each tab is kept while you move between them, and the browser's Back button
        returns to where you were.
      </p>
      <H3>Pin a tab</H3>
      <p>
        Right-click a tab and choose <Ui>Pin tab</Ui> to keep it. A pinned tab has no close button, is listed
        first under <Ui>Pinned</Ui>, stays when you choose <Ui>Close all</Ui>, and comes back after a reload.
        Pull request, Focus, story and build tabs can be pinned.
      </p>
      <H3>Group tabs by author</H3>
      <p>
        <Ui>Group by author</Ui>, beside the <Ui>Open tabs</Ui> heading, puts each pull request tab under its
        author's name: yours first, then the others A to Z.
      </p>

      <H2 id="search-or-jump">Search or jump</H2>
      <p>
        <Ui>Search or jump</Ui> opens a box that finds, as you type:
      </p>
      <ul>
        <li>every page and every tab inside a page;</li>
        <li>every repository page and every workspace;</li>
        <li>every Settings tab, and actions such as sync, theme and notifications;</li>
        <li>your open tabs, and every open pull request;</li>
        <li>
          after two characters, a search of the pull requests, comments and tickets Limn has stored. Choose{' '}
          <Ui>Search everything</Ui> to see all the results in a tab.
        </li>
      </ul>
      <p>
        On a page with its own actions (a selected Pending row, a pull request), the box also lists those
        actions.
      </p>

      <Tip>
        Press <Kbd>/</Kbd> or <Kbd>⌘</Kbd> <Kbd>K</Kbd> to open it, and <Kbd>?</Kbd> for every key. See{' '}
        <DocLink to="getting-started/keyboard-shortcuts">Keyboard shortcuts</DocLink>.
      </Tip>

      <H2 id="on-a-phone">On a phone or a narrow window</H2>
      <p>
        On a narrow screen the sidebar folds into a menu, and a bar at the bottom holds{' '}
        <Ui>Open PRs</Ui>, <Ui>Pending</Ui>, <Ui>Sprint</Ui>, <Ui>Timeline</Ui> and <Ui>More</Ui>. A dot on the
        menu button tells you when a repository's sync failed or the AI budget is near its limit. The Timeline
        shows as a list, one line per pull request.
      </p>
    </>
  );
}

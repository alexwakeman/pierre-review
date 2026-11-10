import type { DocMeta } from '../../types';
import { DocLink, H2, Kbd, Note, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Keyboard shortcuts',
  summary: 'Move around Limn without the mouse: the g keys, Search or jump, and the shortcut sheet.',
};

function Row({ keys, does }: { keys: JSX.Element; does: string }): JSX.Element {
  return (
    <tr>
      <td>{keys}</td>
      <td>{does}</td>
    </tr>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every part of Limn can be reached from the keyboard. Press <Kbd>?</Kbd> anywhere to see the shortcut
        sheet, which lists the keys for the pages you have. Keys do nothing while you type in a text box.
        Shortcuts are not printed on buttons; the sheet and <Ui>Search or jump</Ui> list them.
      </p>

      <H2 id="anywhere">Anywhere</H2>
      <table>
        <thead>
          <tr>
            <th>Keys</th>
            <th>What they do</th>
          </tr>
        </thead>
        <tbody>
          <Row keys={<><Kbd>⌘</Kbd> <Kbd>K</Kbd></>} does="Search or jump: a page, a setting, a pull request, a ticket. Ctrl K on Windows and Linux." />
          <Row keys={<Kbd>/</Kbd>} does="The same." />
          <Row keys={<Kbd>?</Kbd>} does="The shortcut sheet." />
          <Row keys={<Kbd>i</Kbd>} does="Back to the last of Open pull requests, Pending, Docs, Feed, Reports, Bots Monitoring or a repository page that you had open." />
          <Row keys={<Kbd>Esc</Kbd>} does="Close the top layer. With the Timeline on, then leave a tab for the Timeline, or clear its selection." />
        </tbody>
      </table>

      <H2 id="go-to-a-page">Go to a page</H2>
      <p>
        Press <Kbd>g</Kbd>, then a letter, within about a second.
      </p>
      <table>
        <thead>
          <tr>
            <th>Keys</th>
            <th>Page</th>
          </tr>
        </thead>
        <tbody>
          <Row keys={<><Kbd>g</Kbd> <Kbd>o</Kbd></>} does="Open pull requests" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>p</Kbd></>} does="Pending" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>s</Kbd></>} does="This Sprint" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>t</Kbd></>} does="Timeline, when it is on" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>d</Kbd></>} does="Docs" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>f</Kbd></>} does="Feed" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>r</Kbd></>} does="Reports" />
          <Row keys={<><Kbd>g</Kbd> <Kbd>b</Kbd></>} does="Bots Monitoring" />
        </tbody>
      </table>
      <Note>
        A page hidden in <DocLink to="settings/features">Settings → Features</DocLink> is left out of the
        sheet, but its <Kbd>g</Kbd> key still works. The Timeline is the exception: while it is off,{' '}
        <Kbd>g</Kbd> <Kbd>t</Kbd> does nothing.
      </Note>

      <H2 id="lists">Lists</H2>
      <p>
        These keys work in the lists on <Ui>Open pull requests</Ui>, <Ui>Pending</Ui> and the other row lists.
        Nothing is selected when a list opens; <Kbd>j</Kbd>, <Kbd>k</Kbd> or a click selects the first row.
      </p>
      <table>
        <thead>
          <tr>
            <th>Keys</th>
            <th>What they do</th>
          </tr>
        </thead>
        <tbody>
          <Row keys={<Kbd>j</Kbd>} does="Next row." />
          <Row keys={<Kbd>k</Kbd>} does="Previous row." />
          <Row keys={<Kbd>↵</Kbd>} does="Open the selected row in the side panel. Press it again to open the pull request." />
          <Row keys={<><Kbd>⇧</Kbd> <Kbd>↵</Kbd></>} does="Go straight to the item (Pending). A double-click does the same." />
          <Row keys={<Kbd>a</Kbd>} does="Approve, where you were asked to review and approving is allowed." />
          <Row keys={<Kbd>m</Kbd>} does="Merge, where the pull request can land and you can push to the repository." />
          <Row keys={<Kbd>e</Kbd>} does="Dismiss a My turn card (the sheet calls it Done)." />
          <Row keys={<Kbd>z</Kbd>} does="Undo the last dismiss, approve or merge, while the Undo offer shows." />
          <Row keys={<Kbd>o</Kbd>} does="Open the pull request on GitHub." />
          <Row keys={<Kbd>r</Kbd>} does="Open the AI review (Open pull requests)." />
          <Row keys={<Kbd>1</Kbd>} does="1 to 9 switch the page's tabs." />
        </tbody>
      </table>
      <Tip>
        On <Ui>Pending</Ui>, approve and merge wait a moment before they are sent, so <Kbd>z</Kbd> can still
        stop them. If a key cannot act on the selected row, the board says why in one line.
      </Tip>

      <H2 id="timeline-keys">Timeline</H2>
      <p>These work when the Timeline is on.</p>
      <table>
        <tbody>
          <Row keys={<><Kbd>j</Kbd> <Kbd>k</Kbd></>} does="Move through the board's pull requests. Enter opens the selected one's card." />
        </tbody>
      </table>

      <H2 id="pull-request-keys">A pull request</H2>
      <table>
        <tbody>
          <Row keys={<Kbd>1</Kbd>} does="1 to 9 switch its tabs: Overview, Activity, Threads, Changes and the rest." />
          <Row keys={<><Kbd>n</Kbd> <Kbd>p</Kbd></>} does="Changes: next or previous file." />
          <Row keys={<><Kbd>]</Kbd> <Kbd>[</Kbd></>} does="Changes: next or previous review thread." />
        </tbody>
      </table>
      <p>
        More about each tab is in <DocLink to="pull-request/overview">Open a pull request</DocLink>.
      </p>
    </>
  );
}

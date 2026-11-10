import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Kbd, Note, Pill, Tabs, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Open a pull request',
  summary: 'How to open a pull request, what the header shows, and the actions behind Show actions.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every pull request in Limn opens in the same view: a header with its state, then tabs. You can read the
        conversation, the threads and the diff, see whether it can land, run an AI review or an AI fix, and
        review, approve, merge or close it, without going to GitHub. Limn refreshes a pull request every few
        seconds while you have it open.
      </p>


      <H2 id="open-one">Open a pull request</H2>
      <ul>
        <li>Double-click a row on Open pull requests, or press <Kbd>↵</Kbd> twice.</li>
        <li>Go to an item on Pending (double-click, or <Kbd>⇧</Kbd> <Kbd>↵</Kbd>).</li>
        <li>Choose a card in the Feed, or <Ui>Open details</Ui> on a Timeline bar.</li>
        <li>Find it with <Ui>Search or jump</Ui>.</li>
      </ul>
      <p>
        The pull request opens as a tab. It stays under <Ui>Open tabs</Ui> until you close it, and you can pin it.
        When you come back to it in the same session, it opens on the tab and at the place you left it.
      </p>

      <H2 id="the-header">The header</H2>
      <p>The header has three lines:</p>
      <ol>
        <li>
          <b>The title</b>, and the <Ui>…</Ui> menu.
        </li>
        <li>
          <b>The state</b> (open, draft, merged or closed), the checks, the repository, the author, and when it
          was opened.
        </li>
        <li>
          <b>The review</b>: GitHub's review decision (for example <Ui>Review required</Ui>, <Ui>No reviews yet</Ui>,
          approved or changes requested), with the newest reviewer beside it. Then the size in lines, the
          large pull request flag, the <DocLink to="pull-request/blast-radius">blast radius</DocLink> chip, chips
          for a stack or the ticket's criteria, and <Ui>Stalled</Ui>, auto-merge or "N new" when they apply.
        </li>
      </ol>
      <p>
        Choose the review pill to see every reviewer's standing, when they reviewed, and who is still being
        waited on. The review pill is GitHub's decision; the AI review is shown separately and never mixed into
        it.
      </p>

      <Illustration
        label="A pull request header for #612 Partial refunds, with its state, checks, review and tabs."
        caption="The header and tabs of a pull request."
      >
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>#612 Partial refunds</p>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          <Pill>Open</Pill> CI passing · acme/payments · priya · opened 2d ago
        </p>
        <p style={{ margin: '0 0 8px' }}>
          <Pill tone="amber">Review required</Pill> +214 −38 <Pill>Medium</Pill> <Pill>Criteria 3/4</Pill>
        </p>
        <Tabs
          tabs={[
            { label: 'Overview', on: true },
            { label: 'Activity', count: 6 },
            { label: 'Threads', count: 2 },
            { label: 'Changes', count: 7 },
            { label: 'AI Review', count: 3 },
            { label: 'AI Fix' },
            { label: 'Ticket PAY-142' },
          ]}
        />
      </Illustration>

      <H3>The … menu</H3>
      <ul>
        <li>
          <Ui>Open full-screen in its own tab</Ui> (when it is open in a pane).
        </li>
        <li>
          <Ui>Show on the timeline</Ui> and <Ui>Focus in its own timeline tab</Ui>, when the Timeline is on. See{' '}
          <DocLink to="timeline/focus-a-pull-request">Focus one pull request</DocLink>.
        </li>
        <li>
          <Ui>Show in the Activity feed</Ui>: the repository's feed for this pull request only.
        </li>
        <li>
          <Ui>Open ticket</Ui>, for each ticket the pull request names.
        </li>
        <li>
          <Ui>Refresh from GitHub</Ui>, <Ui>Copy the GitHub link</Ui> and <Ui>Open on GitHub</Ui>.
        </li>
      </ul>

      <H2 id="the-tabs">The tabs</H2>
      <table>
        <thead>
          <tr>
            <th>Tab</th>
            <th>What it holds</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <DocLink to="pull-request/overview-tab">Overview</DocLink>
            </td>
            <td>Can it land, the AI review, checks, people and the description. A red dot means checks are failing.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/activity">Activity</DocLink>
            </td>
            <td>The conversation and the events, newest first. The number counts comments and reviews.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/threads">Threads</DocLink>
            </td>
            <td>Every review thread with its state. The number counts unresolved threads.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/changes">Changes</DocLink>
            </td>
            <td>The diff. The number counts changed files.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/ai-review-tab">AI Review</DocLink>
            </td>
            <td>Run, read and post the AI review. The number counts open findings. With the AI features on.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/ai-fix-tab">AI Fix</DocLink>
            </td>
            <td>Ask an agent to fix things, then push. With the AI features on.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/ticket">Ticket</DocLink>
            </td>
            <td>The linked ticket's story, one tab per ticket. Only when the pull request names one.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pull-request/bot-activity">Bot activity</DocLink>
            </td>
            <td>How each review bot behaved on this pull request. Only when a bot took part. A warning mark means a bot was slower than usual.</td>
          </tr>
        </tbody>
      </table>
      <Tip>
        Press <Kbd>1</Kbd> to <Kbd>9</Kbd> to switch tabs.
      </Tip>

      <H2 id="show-actions">The actions</H2>
      <p>
        The buttons that change the pull request on GitHub are kept behind <Ui>Show actions</Ui>, in the{' '}
        <Ui>Can it land</Ui> section of the Overview tab, so a stray click cannot approve or close anything. The
        facts are never hidden. Behind it:
      </p>
      <ul>
        <li>
          <Ui>Approve</Ui> (with an optional comment) and <Ui>Request changes</Ui>. After you approve, you can
          withdraw your approval; Limn asks first.
        </li>
        <li>
          <Ui>Merge</Ui>, <Ui>Merge when ready</Ui> and <Ui>Update branch</Ui>, where the pull request allows them and
          you can push. See <DocLink to="merging/can-it-land">Can it land?</DocLink>
        </li>
        <li>
          <Ui>Close PR</Ui>, which asks "Close without merging?" first, and <Ui>Reopen</Ui> on a closed pull request.
        </li>
      </ul>
      <Warning>
        Every action here writes to GitHub under your own account. Your teammates see it as yours.
      </Warning>
      <Note>
        After a write, Limn checks GitHub until the change shows. If a comment you posted does not show at once,
        it is already on GitHub: wait, do not post it again.
      </Note>
    </>
  );
}

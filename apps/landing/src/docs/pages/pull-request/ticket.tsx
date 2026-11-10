import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, Illustration, Note, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Ticket tab',
  summary: 'The linked ticket\'s story inside the pull request: criteria, comments and the story check.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When a pull request names a ticket from the workspace's issue tracker, it gets a tab for that ticket,
        labelled with the ticket's key, for example <Ui>Ticket PAY-142</Ui>. The tab is the ticket's story view,
        inside the pull request: the ticket, its acceptance criteria, its comments, the other pull requests for
        the same ticket, and the story check. A pull request that names two tickets gets two tabs.
      </p>

      <WhoItHelps
        developer="Check the change against what the ticket asked for without leaving the pull request."
        manager="See whether a pull request meets its story, and what else is still open for that ticket."
      />

      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>The ticket's title, status and assignee, with a link to it in the tracker.</li>
        <li>
          The acceptance criteria, each with what the story check found: <Ui>Met</Ui>, <Ui>Partly met</Ui>,{' '}
          <Ui>Not met</Ui>, <Ui>Met outside code changes</Ui> or <Ui>Not checked</Ui>.
        </li>
        <li>The ticket's comments, newest first, with the ones new since the last check marked.</li>
        <li>Every pull request for the ticket, open and merged.</li>
      </ul>

      <Illustration
        label="The Ticket PAY-142 tab with four acceptance criteria: two met, one partly met, one not met."
        caption="The criteria of PAY-142, as the story check sees them."
      >
        <FindingRow chip="Met" tone="green">
          Partial refund keeps the order open
        </FindingRow>
        <FindingRow chip="Partly met" tone="amber">
          Customer gets one email
        </FindingRow>
        <FindingRow chip="Not met" tone="red">
          No refunds after 30 days
        </FindingRow>
        <FindingRow chip="Met" tone="green">
          Refund reaches the daily ledger
        </FindingRow>
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          Run or re-run the story check, where the AI features are on. See{' '}
          <DocLink to="story-checks/overview">Story checks</DocLink>.
        </li>
        <li>
          Open the full story view in its own tab with <Ui>Open ticket</Ui> in the pull request's <Ui>…</Ui> menu.
          See <DocLink to="this-sprint/story-view">The story view</DocLink>.
        </li>
      </ul>
      <Note>
        The tab is listed only when the pull request names a ticket Limn can open, and the workspace has a tracker
        connected. Limn reads the ticket from what it stored when the pull request arrived; opening the tab does
        not call the tracker. See <DocLink to="settings/integrations">Settings → Integrations</DocLink>.
      </Note>
    </>
  );
}

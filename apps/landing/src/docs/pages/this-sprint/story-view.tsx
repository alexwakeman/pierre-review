import type { DocMeta } from '../../types';
import { Btn, Card, DocLink, FindingRow, H2, H3, Illustration, Kbd, Note, Pill, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: "Open a ticket's story",
  summary:
    "The story view shows one ticket: what it asks for, how far its pull requests deliver it, its comments, and every pull request on it.",
};

function StoryHeader(): JSX.Element {
  return (
    <Illustration
      label="The story view of PAY-142 Partial refunds: status In Review, 3 of 4 met, 2 PRs, then the Ticket section with the summary and the four criteria"
      caption="The top of a story view: the ticket's facts, then the Ticket section with the story check's summary and criteria."
      title="PAY-142 · Ticket"
    >
      <Card title="PAY-142 Partial refunds" chip={<Pill tone="blue">In Review</Pill>}>
        <p>
          <Pill tone="green">3 of 4 met</Pill> <Pill>2 PRs</Pill> <span>1 PR changed since · checked 1 hour ago</span>{' '}
          <Btn>Re-check</Btn>
        </p>
      </Card>
      <Card title="Ticket" chip={<Btn>Check against docs</Btn>}>
        <p>The two pull requests deliver partial refunds. The 30-day limit is still missing.</p>
        <FindingRow chip="Met" tone="green">
          A partial refund keeps the order open
        </FindingRow>
        <FindingRow chip="Met" tone="green">
          The customer gets one email
        </FindingRow>
        <FindingRow chip="Not met" tone="red">
          No refunds after 30 days
        </FindingRow>
        <FindingRow chip="Met outside code changes" tone="green">
          The refund reaches the daily ledger — per Dana Wu&rsquo;s comment, 4 Mar
        </FindingRow>
      </Card>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The story view is Limn&rsquo;s page for one ticket. It brings together what the tracker says, what the
        team said in the comments, what the pull requests deliver, and what is still missing. It works for any
        ticket on the workspace&rsquo;s tracker, including a ticket with no pull request yet.
      </p>

      <WhoItHelps
        developer="Read the ticket, its comments and the check of your code against it in one place, then see the other pull requests on the same ticket, in any repository."
        manager="See whether a ticket is really done: which criteria the code meets, which are missing, and whether someone signed one off in a comment."
      />

      <H2 id="open-it">Open it</H2>
      <p>The same story view opens in two places:</p>
      <ul>
        <li>
          <strong>In a panel on This Sprint.</strong> Select a card, a ticket key in a call-out, or a key in an answer.
          The panel opens on the right, over the board, so no card moves. Use the arrows in its header, or{' '}
          <Kbd>j</Kbd> and <Kbd>k</Kbd>, for the next and previous ticket, and <Kbd>Esc</Kbd> to close it. Drag its
          edge to make it wider.
        </li>
        <li>
          <strong>In its own tab</strong>, named &ldquo;PAY-142 · Ticket&rdquo;. Use the arrow in a card&rsquo;s
          corner, <Ui>Open ticket tab</Ui> in the panel, a ticket chip on a pull request, the pull request&rsquo;s{' '}
          <Ui>Open story</Ui> menu item, the <Ui>Stories</Ui> results of a search, or <Kbd>⌘</Kbd> <Kbd>K</Kbd>.
        </li>
      </ul>
      <p>
        A pull request&rsquo;s own Ticket tab shows the same content for each ticket the pull request names. See{' '}
        <DocLink to="pull-request/ticket">The pull request&rsquo;s Ticket tab</DocLink>.
      </p>

      <H2 id="what-you-see">What you see</H2>
      <StoryHeader />

      <H3 id="the-header">The header</H3>
      <ul>
        <li>The key, a link <Ui>Open in Jira</Ui> (or the name of your tracker), and the title.</li>
        <li>The status, the issue type and the assignee. On Jira the status is a menu (see below).</li>
        <li>
          Facts as chips: how many criteria are met (&ldquo;3 of 4 met&rdquo;), failing CI across the pull
          requests, and the number of pull requests.
        </li>
        <li>
          One line on how current the story check is (&ldquo;1 PR changed since · checked 1 hour ago&rdquo;) and,
          when one is due, when the next automatic check starts. <Ui>Re-check</Ui> runs one now.
        </li>
      </ul>
      <p>On a wide screen these facts sit in a column on the right, with &ldquo;On this page&rdquo; links under them.</p>

      <H3 id="the-ticket-section">The Ticket section</H3>
      <p>Always open, in this order:</p>
      <ol>
        <li>
          <strong>The summary and the criteria.</strong> After a{' '}
          <DocLink to="story-checks/overview">story check</DocLink>: two or three sentences on how far the pull
          requests deliver the ticket, then each criterion with its status and the pull request that does it. Before
          any check: the criteria from the ticket, numbered, or &ldquo;Worked out from the description&rdquo; when
          the ticket has none written. See <DocLink to="story-checks/acceptance-criteria">Acceptance criteria</DocLink>.
        </li>
        <li>
          <strong>The design</strong>, when the ticket has two or more pull requests: a drawing of how the pieces
          fit. <Ui>Draw design</Ui> or <Ui>Redraw design</Ui> is in the section heading.
        </li>
        <li>
          <strong>Asked for outside the criteria</strong>: what the ticket&rsquo;s title or description asks for that
          no criterion covers and no pull request does.
        </li>
        <li>
          <strong>Docs check</strong>, after you press <Ui>Check against docs</Ui>. See{' '}
          <DocLink to="story-checks/check-against-docs">Check against docs</DocLink>.
        </li>
        <li>
          <strong>As written in Jira</strong> (or your tracker): the ticket&rsquo;s own text, closed until you open
          it.
        </li>
        <li>
          <strong>Comments</strong>, open: the newest three, then <Ui>Show all</Ui>. See{' '}
          <DocLink to="story-checks/ticket-comments">Ticket comments</DocLink>.
        </li>
      </ol>

      <H3 id="the-pull-requests">The pull requests</H3>
      <p>
        Under the Ticket section: every open pull request on the ticket as a card, as on Open pull requests, then{' '}
        <Ui>Merged</Ui> and, closed, <Ui>Closed without merging</Ui>. A ticket with none says &ldquo;No pull
        requests for this ticket yet.&rdquo; Pull requests in other workspaces are counted, not listed.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Press <Ui>Re-check</Ui> to run the story check again now.
        </li>
        <li>
          Press <Ui>Check against docs</Ui> to compare the story with your{' '}
          <DocLink to="docs-library/overview">docs library</DocLink>.
        </li>
        <li>
          On This Sprint, press <Ui>Implement</Ui> on a not-started ticket with no pull request to have AI plan and
          build it, or <Ui>Fill gaps</Ui> on a started ticket to build only the criteria the check found not met.
          Nothing is pushed until you press Push. See <DocLink to="implement-story/overview">Implement story</DocLink>.
        </li>
        <li>On Jira, change the ticket&rsquo;s status from the status menu.</li>
      </Steps>

      <H2 id="change-the-status-in-jira">Change the status in Jira</H2>
      <p>
        On a Jira ticket the status chip is a menu. Opening it asks Jira which statuses the ticket can move to from
        here. Pick one and Jira changes the ticket at once; Limn then reads the status back and shows it everywhere.
      </p>
      <Warning>
        This writes to Jira as the owner of the workspace&rsquo;s Jira token. There is no confirm step: the change is
        made when you pick the status. Limn lists only statuses it can make without Jira&rsquo;s own form, and says
        &ldquo;Your Jira token cannot change this issue.&rdquo; when the token may not. On GitHub Issues, Linear and
        Notion the status is shown and not changed.
      </Warning>
      <Note>
        The story view reads what Limn has already stored. Opening it does not call your tracker. Limn reads the
        tracker in the background; see <DocLink to="integrations/jira#how-often-limn-reads">How often Limn reads</DocLink>.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A ticket is often delivered by several pull requests in several repositories, and its real scope lives
        partly in the comments. The story view is the one place that holds all of it, so &ldquo;is PAY-142
        done?&rdquo; has an answer you can check line by line.
      </p>
    </>
  );
}

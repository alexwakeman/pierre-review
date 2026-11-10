import type { DocMeta } from '../../types';
import { SprintLanesMock } from '../../../components/mock/reports';
import { DocLink, H2, H3, Kbd, Note, Steps, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'See the current sprint',
  summary:
    "This Sprint reads your tracker's current sprint and shows each ticket with its pull requests, its status and how much of it is done.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>This Sprint</Ui> is one board for the sprint your team is working in now. Limn reads the sprint&rsquo;s
        tickets from your issue tracker, joins each ticket to the pull requests that name it, and lays the tickets
        out by status. You see in one place what is not started, what is in review, what waits on another ticket
        and what is done.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <p>
        This Sprint needs an issue tracker for the workspace. Set one up in{' '}
        <Ui>Settings → Integrations → Issue tracker</Ui>. Without one, the page shows one line, &ldquo;Connect Jira,
        Linear or GitHub Issues to see this sprint.&rdquo;, and a <Ui>Set up in Settings</Ui> button.
      </p>
      <p>Each tracker gives the sprint in its own way:</p>
      <ul>
        <li>
          <DocLink to="integrations/jira">Jira</DocLink>: the open sprint of the projects the workspace reads. Set
          your <Ui>Project keys</Ui> so Limn knows which projects to ask about.
        </li>
        <li>
          <DocLink to="integrations/linear">Linear</DocLink>: each team&rsquo;s active cycle.
        </li>
        <li>
          <DocLink to="integrations/github-issues">GitHub Issues</DocLink>: the current iteration of a GitHub
          Projects board, else the nearest open milestone that is due.
        </li>
        <li>
          <DocLink to="integrations/notion">Notion</DocLink>: the sprint property you map in Settings.
        </li>
      </ul>
      <p>
        When the tracker has no sprint, or none is active, Limn shows the To do and In progress tickets edited in
        the workspace&rsquo;s reporting window instead, and the title says so.
      </p>
      <Note>
        The one-line summaries, themes, critical paths and the question box use AI. Without AI the board, the
        columns, the pace and the counts still work. Set AI up in <DocLink to="settings/ai">Settings → AI</DocLink>.
      </Note>

      <H2 id="what-you-see">What you see</H2>
      <p>
        The page has three views, <Ui>Theme</Ui>, <Ui>Critical path</Ui> and <Ui>People</Ui>. Each one is the same
        board with the tickets in different rows. Press <Kbd>1</Kbd>, <Kbd>2</Kbd> or <Kbd>3</Kbd> to switch. The
        picture below is a working model of the board with made-up tickets: select a view to see the rows change.
      </p>
      <SprintLanesMock />

      <H3 id="the-toolbar">The toolbar</H3>
      <ul>
        <li>The sprint&rsquo;s name and its dates, for example &ldquo;14 Oct – 27 Oct · day 4 of 14&rdquo;.</li>
        <li>The number of tickets in the sprint.</li>
        <li>
          <Ui>Ask Claude</Ui> (or <Ui>Ask Codex</Ui>, if Codex is your AI provider): ask a question about the
          sprint. See <DocLink to="this-sprint/ask-about-the-sprint">Ask about the sprint</DocLink>.
        </li>
        <li>
          <Ui>Statuses</Ui> (the gear): choose which tracker statuses go in which column. See{' '}
          <DocLink to="#columns-and-statuses">Columns and statuses</DocLink>.
        </li>
        <li>
          <Ui>Refresh</Ui>: read the sprint from the tracker now.
        </li>
      </ul>

      <H2 id="columns-and-statuses">Columns and statuses</H2>
      <p>
        The columns are <Ui>Not started</Ui>, <Ui>In progress</Ui>, <Ui>Code review</Ui>, <Ui>Product review</Ui>{' '}
        and <Ui>Complete</Ui>. Limn puts each tracker status in a column by itself, using the status&rsquo;s
        category in the tracker. If your board has its own stages, press <Ui>Statuses</Ui> to add, rename, reorder
        or remove columns, give each column a meaning, and drag each status into the column it belongs to. A switch
        in the same editor moves a ticket from Code review to Product review when all of its pull requests have
        merged. <Ui>Reset to automatic</Ui> goes back to Limn&rsquo;s own columns. A status that is new on your
        board since you saved is marked &ldquo;not placed yet&rdquo;.
      </p>
      <p>
        The <Ui>Complete</Ui> column is closed at first, to save room. Press <Ui>Show</Ui> to open it, or press a
        row&rsquo;s ticket count to open that row only.
      </p>

      <H2 id="ticket-cards">Ticket cards</H2>
      <p>Every card has the same shape on every view:</p>
      <ul>
        <li>The ticket key and title.</li>
        <li>One line that says what the ticket delivers, written by AI from the ticket.</li>
        <li>
          The criteria line: &ldquo;3 of 4 criteria met&rdquo; from the latest{' '}
          <DocLink to="story-checks/overview">story check</DocLink>, or &ldquo;4 criteria&rdquo; when no check has
          run yet. It is in italics when the check ran before the latest changes.
        </li>
        <li>The assignee (on the People view, the theme instead). &ldquo;Unassigned&rdquo; when nobody has it.</li>
        <li>
          Tags in words: <Ui>CI failing</Ui>, <Ui>No PR</Ui>, &ldquo;2 PRs · 1 open&rdquo;, <Ui>No owner</Ui>.
        </li>
      </ul>
      <p>
        Small marks beside the key show the rest: a pull-request mark when the ticket has an open or merged pull
        request, a route mark when it is on a critical path, and an hourglass when it waits on another ticket that
        is not finished. A ticket from outside the sprint is drawn faint. Inside each cell, tickets with a pull
        request come first. The key under the board names every mark the board uses.
      </p>
      <p>
        Arrows go from a ticket to the ticket that waits on it. They come from the tracker&rsquo;s own
        &ldquo;blocked by&rdquo; links and from what the ticket text says. A number on an arrow points to the reason
        in the line under the board. Hover over an arrow or its number to read it.
      </p>

      <H2 id="filters">Filters</H2>
      <p>
        Two chips above the board narrow every view. <Ui>Has PRs</Ui> keeps tickets with at least one pull request.{' '}
        <Ui>Needs code</Ui> keeps tickets with a pull request and the not-started tickets that AI thinks will need
        code changes; a ticket not judged yet says &ldquo;Not judged yet&rdquo;. With both on, a ticket must pass
        both. The pace figures and the count table always count the whole sprint. Your choice is kept in this
        browser.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Select a card to read its story in the panel on the right. See{' '}
          <DocLink to="this-sprint/story-view">Open a ticket&rsquo;s story</DocLink>.
        </li>
        <li>Select the arrow in a card&rsquo;s corner to open the ticket in its own tab.</li>
        <li>
          Press the hammer button on a not-started ticket with no pull request (<Ui>Implement</Ui>), or{' '}
          <Ui>Fill gaps</Ui> on a started ticket whose check found criteria not met. See{' '}
          <DocLink to="implement-story/overview">Implement story</DocLink>.
        </li>
        <li>
          Press <Ui>Refresh</Ui> to read the sprint again. With AI on, Refresh also starts up to three story checks
          for tickets whose check is missing or out of date, and says how many it started.
        </li>
        <li>
          Press <Kbd>⌘</Kbd> <Kbd>K</Kbd> and type a ticket key to show that ticket&rsquo;s story, or to run
          Refresh, Ask or Statuses.
        </li>
      </Steps>

      <H2 id="how-it-stays-current">How it stays current</H2>
      <p>
        Limn reads the sprint in the background about every 20 minutes, but only for a workspace whose This Sprint
        page someone opened in the last 7 days. Opening the page does not call the tracker. While the page is open
        it checks once a minute whether anything changed and redraws only then, so the board does not jump while
        you read it.
      </p>
      <Tip>
        On GitHub Issues, Limn can read a GitHub Projects iteration only when your <code>gh</code> sign-in has the{' '}
        <code>read:project</code> scope. If it does not, the page uses milestones and shows the command to add the
        scope: <code>gh auth refresh -s read:project</code>.
      </Tip>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A tracker board says what people set the status to. This Sprint also says what the code says: which tickets
        have pull requests, which have failing CI, which criteria the code meets, and which tickets wait on others.
        That makes it a good page for a stand-up or a mid-sprint check, and it needs no extra data entry.
      </p>
      <p>
        If you do not use sprints, hide the page in{' '}
        <DocLink to="settings/features">Settings → Features</DocLink>. Sprint length and the comparison window are
        in <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>.
      </p>
    </>
  );
}

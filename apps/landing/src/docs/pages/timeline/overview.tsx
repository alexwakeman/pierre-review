import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Kbd, Note, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the timeline',
  summary: 'The timeline draws each pull request as a bar over time, with its commits, reviews and comments on it.',
};

function Board(): JSX.Element {
  const row = (who: string, left: number, width: number, tone: string, marks: number[]): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
      <span style={{ width: 70, fontSize: 12 }}>{who}</span>
      <span style={{ position: 'relative', flex: 1, height: 14 }}>
        <span
          style={{
            position: 'absolute',
            left: `${left}%`,
            width: `${width}%`,
            top: 2,
            height: 10,
            borderRadius: 3,
            border: `2px solid ${tone}`,
          }}
        />
        {marks.map((m) => (
          <span
            key={m}
            style={{ position: 'absolute', left: `${m}%`, top: 3, width: 8, height: 8, borderRadius: 8, background: tone }}
          />
        ))}
      </span>
    </div>
  );
  return (
    <div>
      <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 4px' }}>acme/payments</p>
      {row('priya', 10, 60, '#16a34a', [25, 48, 66])}
      {row('sam', 40, 50, '#d97706', [55, 80])}
      <p style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>acme/web</p>
      {row('robin', 20, 70, '#64748b', [30, 70])}
    </div>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Timeline</Ui> is a board of the workspace's pull requests over time. Each repository is a block;
        inside it, each contributor has a row. Each pull request is a bar from when it opened to when it merged
        or closed (or now), and the reviews, comments and commits on it are marks along the bar. It shows the
        last 14 days by default.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The timeline: acme/payments with rows for priya and sam, acme/web with a row for robin, each with a pull request bar and marks along it."
        caption="Two repositories on the timeline, one bar per pull request, marks for events."
      >
        <Board />
      </Illustration>
      <H3>Bars</H3>
      <ul>
        <li>An open pull request's bar is strong; a merged or closed one is faded. A draft is drawn as a draft.</li>
        <li>
          An open bar's outline shows its review: changes requested, approved, or commented. A blocking review
          wins.
        </li>
        <li>
          An orange bar is <b>stalled</b>: it has open review threads and no commit for more than three days.
        </li>
        <li>A pull request whose review is requested from you is marked as yours to do.</li>
      </ul>
      <H3>Marks</H3>
      <p>
        Each event is a small mark whose shape says its type: a review (approve in green, changes requested in
        orange, a comment in grey), a review comment, a pull request comment, a commit, or a change of state
        such as opened or merged. When you zoom out, marks close together join into one mark with a number.
      </p>
      <Note>
        Two things are hidden by default: commits (switch them on in <Ui>Events</Ui>) and bots (switch them on in{' '}
        <Ui>Members</Ui>). See <DocLink to="timeline/filters">Filter the timeline</DocLink>.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>Move and zoom.</b> Drag the board sideways; zoom with the trackpad or the mouse wheel. Choose a{' '}
          <Ui>Range</Ui> (<Ui>7d</Ui>, <Ui>14d</Ui>, <Ui>30d</Ui>, <Ui>90d</Ui>), and <Ui>Now</Ui> to centre on the
          current time.
        </li>
        <li>
          <b>Click a bar</b> to open its card: the repository and number, its state, author, whether it can
          merge, its checks, its review, its size, its age and last activity, and its ticket. Choose{' '}
          <Ui>Open details</Ui> to open the pull request in its own tab, or <Ui>Open on GitHub</Ui>.
        </li>
        <li>
          <b>Click a mark</b> to see that event. <Ui>Open details</Ui> opens the pull request at that event: the
          thread, the comment or the commit.
        </li>
        <li>
          <b>Double-click a bar</b> to open the pull request in a Focus tab. See{' '}
          <DocLink to="timeline/focus-a-pull-request">Focus one pull request</DocLink>.
        </li>
        <li>
          <b>Click a person's name</b> to see their counts for the last 90 days, a link to their GitHub profile,
          and <Ui>Last 14 days of activity →</Ui>, which opens their activity as a tab. A shield beside a name
          marks someone who has merged a pull request in that repository.
        </li>
        <li>
          <b>Collapse a row</b> with the arrow beside a person's name. Limn remembers it.
        </li>
      </ul>
      <Tip>
        Press <Kbd>j</Kbd> and <Kbd>k</Kbd> to move through the bars, and <Kbd>↵</Kbd> to open the selected one's
        card. Click empty space, or press <Kbd>Esc</Kbd>, to close the card.
      </Tip>
      <p>
        From a pull request, <Ui>Show on the timeline</Ui> centres the board on it and makes it pulse, so you can
        see it among the others.
      </p>

      <H2 id="on-a-phone">On a phone</H2>
      <p>
        On a phone the Timeline shows as a list, one line per pull request, grouped by repository, newest
        activity first. Tap a line to open the pull request. Choose <Ui>Board</Ui> to see the board.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Lists show what is waiting now. The timeline shows how the work moved: a pull request that has been open
        for three weeks stands out as a long bar, and a review that came days after the last commit shows as a
        gap.
      </p>
    </>
  );
}

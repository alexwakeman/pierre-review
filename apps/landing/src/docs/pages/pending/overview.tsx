import type { DocMeta } from '../../types';
import { PendingListMock } from '../../../components/mock/home';
import { DocLink, H2, H3, Kbd, Note, Steps, Tip, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Work from the Pending board',
  summary: 'Pending collects everything that is waiting, in tabs, and ranks each tab so the most actionable item comes first.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Pending</Ui> is everything waiting on you or your workspace, across every repository, in eight
        tabs. Each item is one line; select it to see the whole card in a side panel, with the buttons to act
        on it. Pending is worked out again every time it loads, from what GitHub says now. An item leaves when
        the work it describes is done.
      </p>

      <WhoItHelps
        developer="Start the day on My turn, then work down Needs fixing and Ready to land. Approve, merge or dismiss from the keyboard."
        manager="See the reviews that have stalled, the threads nobody answered and who has the most reviews waiting, without asking."
      />

      <H2 id="the-tabs">The tabs</H2>
      <table>
        <thead>
          <tr>
            <th>Tab</th>
            <th>What is in it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <DocLink to="pending/my-turn">My turn</DocLink>
            </td>
            <td>Pull requests where a person is waiting on you.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/ai-reviews">AI reviews</DocLink>
            </td>
            <td>The newest AI review on each pull request, yours and your teammates'.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/needs-fixing">Needs fixing</DocLink>
            </td>
            <td>Failing builds and merge conflicts.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/waiting-on-review">Waiting on review</DocLink>
            </td>
            <td>Stalled reviews, pull requests that need a reviewer, and who has reviews waiting.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/unanswered-threads">Unanswered threads</DocLink>
            </td>
            <td>Review comments with no reply and no later commit to their file.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/ready-to-land">Ready to land</DocLink>
            </td>
            <td>Pull requests GitHub will merge now, or once the branch is updated.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/dependencies">Dependencies</DocLink>
            </td>
            <td>Dependency updates and security alerts, security first.</td>
          </tr>
          <tr>
            <td>
              <DocLink to="pending/waiting-on-others">Waiting on others</DocLink>
            </td>
            <td>Your pull requests where it is someone else's turn. Information only.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The number on a tab is everything in it. A tab lists up to 50 of each kind of item and says when it
        holds more. Where a tab holds two kinds, chips above the list narrow it to one.
      </p>

      <figure className="dx-fig">
        <PendingListMock />
        <figcaption>
          <span>Illustration:</span> Pending, one line per item, with the card in the side panel. Try the tabs and
          the rows.
        </figcaption>
      </figure>

      <H2 id="how-ranking-works">How each tab is ordered</H2>
      <p>
        <b>My turn</b> is not scored. It has fixed groups, with the longest wait first in each. See{' '}
        <DocLink to="pending/my-turn">My turn</DocLink>. <b>Dependencies</b> puts every security item before
        every bump. <b>AI reviews</b> is newest first, and <b>Waiting on others</b> is longest wait first.
      </p>
      <p>Every other tab lists its items by a score out of 100, highest first. The score has three parts:</p>
      <ul>
        <li>
          <b>How close to done (50%).</b> The next step: an approved pull request that is ready to merge is
          closest; then one that needs a branch update, a failing default branch, a failing build, a review, a
          reply, an unanswered thread, and last, waiting on a reviewer. A merge conflict or many unanswered
          threads lower it a little; a small change raises it a little.
        </li>
        <li>
          <b>How long it has waited (30%).</b> Measured from the moment that matters for the item: when you
          were asked, the last commit, or when the thread started.
        </li>
        <li>
          <b>How much it is about you (20%).</b> Most when it names you, less in a repository you maintain,
          least for shared work.
        </li>
      </ul>
      <p>
        The top five in a scored tab are <Ui>Do next</Ui>; the rest are under <Ui>Everything else</Ui>. Items
        in one tab usually share their next step, so the order mostly comes down to how long each has waited
        and how small the change is. The weights are fixed.
      </p>
      <Tip>
        The <Ui>ⓘ</Ui> beside the title, <Ui>How Pending is ordered</Ui>, says this in short. The <Ui>ⓘ</Ui> on
        a card, <Ui>Why this card is here</Ui>, gives that card's own score, line by line. Both open{' '}
        <Ui>How Pending works</Ui>, the full guide.
      </Tip>

      <H3>Colours</H3>
      <p>
        The mark at the start of a row is red when the item blocks a merge or a build (a failing build, a merge
        conflict, a security alert), green when it can land now, amber when it is urgent and neither of those
        applies, and grey otherwise. Colour does not change the order.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Choose a tab, or press <Kbd>1</Kbd> to <Kbd>8</Kbd>.
        </li>
        <li>
          Select an item (a click, <Kbd>j</Kbd> or <Kbd>k</Kbd>) to open its card in the side panel. Nothing is
          selected when the page opens.
        </li>
        <li>
          Act from the card's buttons, or with a key: <Kbd>a</Kbd> approve, <Kbd>m</Kbd> merge,{' '}
          <Kbd>e</Kbd> dismiss (My turn), <Kbd>o</Kbd> open on GitHub.
        </li>
        <li>
          Go to the item itself with a double-click, <Kbd>⇧</Kbd> <Kbd>↵</Kbd>, or the arrow in the panel's
          header. A review request opens the pull request's Changes tab, a thread opens that thread, an AI
          review opens the AI Review tab, and a failing build or a merge opens the Overview.
        </li>
      </Steps>
      <p>
        Dismiss, approve and merge offer <Ui>Undo</Ui> for a few seconds (<Kbd>z</Kbd>). Approve and merge are
        sent only when the offer ends.
      </p>

      <H3>Narrow a tab</H3>
      <ul>
        <li>
          <b>Kind chips</b>, on a tab that holds two kinds (for example, failing builds and conflicts).
        </li>
        <li>
          <b>
            <Ui>Anyone</Ui> · <Ui>People</Ui> · <Ui>Automation</Ui>
          </b>
          : by who opened the pull request. Shown only when both sides have items.
        </li>
        <li>
          <b>
            <Ui>Only yours</Ui> · <Ui>Not tied to you</Ui>
          </b>
          , on My turn. See <DocLink to="pending/my-turn#only-yours">Only yours</DocLink>.
        </li>
      </ul>

      <Note title="Nothing on Pending fetches when you look">
        Pending reads what Limn has already synced. Opening a card, or selecting a row, does not call GitHub.
        Live merge options are read only when you press a merge button. The board refreshes the merge state of
        the pull requests it shows in one batch, in the background.
      </Note>

      <H2 id="the-first-day">The first day</H2>
      <p>
        For the first two weeks after you add your first repositories, Pending shows a one-line summary of
        what it found. If every tab is empty, it lists your own open pull requests, newest first, with what
        blocks each one.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Pending answers "what should I do next?" for a whole workspace. Each item says why it is there and why
        it sits where it does, so you can trust the order or disagree with it. The tabs keep different kinds of
        work apart, so a merge never competes with a review for the top place.
      </p>
    </>
  );
}

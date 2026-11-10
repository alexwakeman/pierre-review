import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, Thread, Toolbar, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the feed',
  summary: 'The feed lists what happened in the workspace, newest first: comments, reviews, pull request events and commits.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Feed</Ui> is one stream of everything that happened across every repository in the workspace,
        newest first: comments, review threads, reviews, pull requests opened, merged and closed, and commit
        pushes. New activity is added at the top as it arrives, marked <Ui>New</Ui>. It shows people by
        default; switch to bots to see what the bots did. It covers the last 14 days.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>
        Each card has an icon for its kind (a comment, a pull request event, or commits), the person, the pull
        request and the time. A review thread card shows its state. A card where it is your turn has a coloured
        bar and says <Ui>My Turn</Ui>. Limn's own posts are named as Limn's.
      </p>

      <Illustration
        label="The feed's filter row with People selected, and one review thread card."
        caption="The feed, People side, with one thread card."
      >
        <Toolbar>
          <Pill tone="blue">People</Pill>
          <Pill>Bots</Pill>
          <Pill>Comments</Pill>
          <Pill>PR events</Pill>
          <Pill>Commits</Pill>
        </Toolbar>
        <Thread
          file="acme/payments #612 · policy.py:42"
          state="Replied"
          tone="amber"
          comments={[
            { who: 'priya', when: '2h', text: 'Refunds after 30 days should be refused.' },
            { who: 'sam', when: '1h', text: 'Agreed, I will add a check.' },
          ]}
        />
      </Illustration>

      <H2 id="narrow-the-feed">Narrow the feed</H2>
      <ul>
        <li>
          <b>
            <Ui>People</Ui> or <Ui>Bots</Ui>
          </b>
          : whose activity shows. Never both at once. See <DocLink to="feed/people-and-bots">People or bots</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Comments</Ui>
          </b>
          : review threads and pull request comments.
        </li>
        <li>
          <b>
            <Ui>PR events</Ui>
          </b>
          : opens, reviews, merges and closes. When it is on, a second row narrows it to <Ui>Opened</Ui>,{' '}
          <Ui>Reviewed</Ui>, <Ui>Merged</Ui> or <Ui>Closed</Ui>. With none of those chosen, all four show.
        </li>
        <li>
          <b>
            <Ui>Commits</Ui>
          </b>
          : every commit push. With it off, the feed shows only the pushes that addressed a review thread.
        </li>
        <li>
          <b>
            <Ui>Thread state</Ui>
          </b>
          : show only threads in the states you choose. See{' '}
          <DocLink to="timeline/thread-states">What the thread states mean</DocLink>.
        </li>
      </ul>
      <p>
        With <Ui>Comments</Ui> and <Ui>PR events</Ui> both off, the feed shows everything. Each pill shows how
        many items it holds.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>Choose a card to open the pull request in its own tab.</li>
        <li>
          Open a comment card to read it in full, react to it, reply, or view it on GitHub. Long comments are
          shortened until you open them.
        </li>
        <li>
          With the Timeline on, choose the Focus button on a card to open that pull request in a Focus tab on the
          Timeline.
        </li>
        <li>Choose a person's name to see their recent activity.</li>
      </ul>
      <H3>One pull request, one repository, one person</H3>
      <p>
        The same feed appears narrowed in three places: on each{' '}
        <DocLink to="getting-started/repository-pages">repository page</DocLink>, for one pull request (from the
        pull request's <Ui>Show in the Activity feed</Ui>), and for one person (from their name). Only the main
        feed adds new items as they arrive.
      </p>

      <Note>
        The Feed does not show My turn lists, failing builds or AI review results: those are on{' '}
        <DocLink to="pending/overview">Pending</DocLink>. A card in the Feed only marks that it is your turn.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        GitHub's notifications arrive one repository and one pull request at a time. The Feed puts the whole
        workspace's conversation in order, and keeps the bots' comments out of the way until you want them.
      </p>
    </>
  );
}

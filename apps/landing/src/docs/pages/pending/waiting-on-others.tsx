import type { DocMeta } from '../../types';
import { PendingListMock } from '../../../components/mock/home';
import { DocLink, H2, H3, Note, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Waiting on others',
  summary: 'Your pull requests that wait on somebody else, so you can nudge them.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Waiting on others</Ui> is the last tab on <Ui>Pending</Ui>. It lists your own open pull requests where
        it is someone else's turn: a review you asked for has not arrived. It says who has it and for how long,
        in working hours, longest wait first. It is information: nothing here is scored, and it is counted only
        on this tab.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>
        Each card names the people or teams who have the review, for example <Ui>With sam · 6h</Ui>. The clock
        starts at the newest request to that person; a re-request, or a Nudge, starts it again. Hours outside
        the workspace's working hours are not counted. When the wait is longer than the review target, the card
        says so: "Over the 4h review target — waiting 9 working hours".
      </p>
      <p>A pull request is left out when:</p>
      <ul>
        <li>it is your turn on it (it is in <DocLink to="pending/my-turn">My turn</DocLink>, or you dismissed it there);</li>
        <li>a person asked for changes after your last push: the next move is yours;</li>
        <li>only bots have been asked to review it;</li>
        <li>it is a draft or a dependency update.</li>
      </ul>

      <figure className="dx-fig">
        <PendingListMock initialTab="waiting" />
        <figcaption>
          <span>Illustration:</span> Waiting on others. Try the Nudge button.
        </figcaption>
      </figure>

      <H2 id="what-you-can-do">What you can do</H2>
      <H3>Nudge</H3>
      <p>
        <Ui>Nudge</Ui> asks the same person for a review again on GitHub, as GitHub's own "Re-request review"
        does. GitHub notifies them. A team cannot be nudged this way.
      </p>
      <H3>Ask someone else</H3>
      <p>
        <Ui>Ask someone else</Ui> finds one other person to ask: someone the code owners and the repository's
        history suggest, who is not already asked, with the fewest reviews waiting on them. Limn names them and
        asks only when you confirm. It adds a reviewer; it removes nobody.
      </p>

      <Note>
        Both buttons write to GitHub under your account and need write access to the repository. The review
        target is set per workspace in <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A review you are waiting for is easy to forget once you move on to the next task. This tab keeps those
        waits in view, with the time in working hours, so a polite nudge goes out at the right moment and not
        three days late.
      </p>
    </>
  );
}

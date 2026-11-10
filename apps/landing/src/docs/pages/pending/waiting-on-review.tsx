import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, PrRow, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Waiting on review',
  summary: 'Pull requests that need a reviewer, reviews that have stalled, and who has reviews waiting.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Waiting on review</Ui> lists pull requests whose review is late or has not been asked for. Above the
        list, a strip shows the people with the most reviews waiting on them. Chips narrow the list to{' '}
        <Ui>Stalled review</Ui> or <Ui>Needs a reviewer</Ui>.
      </p>

      <WhoItHelps
        developer="Pick up a review nobody is doing, or see that yours is late and on whom."
        manager="Spot reviews that have stalled, pull requests nobody was asked to review, and reviewers with too much waiting on them."
      />

      <H2 id="what-you-see">What you see</H2>
      <H3>Stalled review</H3>
      <p>
        A requested review has not arrived, and the pull request has been open more than 24 hours. The mark
        turns amber at 48 hours and red at 72. When the wait is longer than the workspace's review target, the
        card says so, for example "Over the 4h review target — waiting 9 working hours".
      </p>
      <H3>Needs a reviewer</H3>
      <p>
        Nobody has been asked and nobody has reviewed, and the pull request is older than four hours. For the
        top 15 such cards, Limn suggests reviewers from the code owners and the repository's history, and you can
        ask one with <Ui>Assign</Ui>.
      </p>
      <H3>Reviews waiting on people</H3>
      <p>
        The strip above the list names up to eight people with requested reviews they have not done yet, most
        first. Two or more is amber; four or more is red. It is not scored and not counted in the tab's number.
      </p>

      <Illustration
        label="Waiting on review: a stalled review on #1184 and a needs-a-reviewer card on #493 with a suggested reviewer."
        caption="A stalled review and a pull request with no reviewer."
      >
        <PrRow title="#1184 Checkout redesign" repo="acme/web · asked sam 3d ago" status={<Pill tone="red">Stalled review</Pill>} />
        <PrRow title="#493 Idempotency keys" repo="acme/api · nobody asked · 6h" status={<Pill tone="blue">Needs a reviewer</Pill>}>
          <span className="muted">Suggested: priya</span> <span className="mk-btn">Assign</span>
        </PrRow>
      </Illustration>

      <Note>
        The review target is the same figure as Chronology's first-look budget, set per workspace in{' '}
        <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>. It counts working hours
        only.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>Go to the item to open the pull request's Overview and review it.</li>
        <li>
          Use <Ui>Assign</Ui> on a suggestion to request a review from that person on GitHub.
        </li>
        <li>
          A review asked of you is in <DocLink to="pending/my-turn">My turn</DocLink>, not here. Your own pull
          requests that wait on someone are in <DocLink to="pending/waiting-on-others">Waiting on others</DocLink>.
        </li>
      </ul>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Most pull requests wait longest for their first review. This tab shows where that wait is happening and
        who is overloaded, so the team can move reviews to someone with time.
      </p>
    </>
  );
}

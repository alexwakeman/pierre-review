import type { DocMeta } from '../../types';
import { DocLink, Group, H2, H3, Illustration, Kbd, Note, Pill, PrRow, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'My turn',
  summary: 'The pull requests where you owe the next action, and nothing else. A card goes when you act or when you dismiss it.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>My turn</Ui> is the first tab on <Ui>Pending</Ui>. It lists the pull requests where a person is
        waiting on you: a review you were asked for, a reply to your comment, a mention, new code to re-read, or
        your own pull request that needs you. A card appears when that is true and goes when it stops being
        true. Nothing about it is a to-do list you have to keep clean.
      </p>


      <H2 id="the-groups">The groups</H2>
      <p>The tab has fixed groups, always in this order, with the longest wait first in each:</p>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>A card appears when</th>
            <th>It goes when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td rowSpan={5}>
              <Ui>Waiting on you</Ui>
            </td>
            <td>Someone asks you to review a pull request.</td>
            <td>You submit a review.</td>
          </tr>
          <tr>
            <td>Someone @-mentions you on an open pull request.</td>
            <td>You review, comment or push on it.</td>
          </tr>
          <tr>
            <td>Someone replies in a review thread you started, or the code under it changes.</td>
            <td>You reply, or the thread is resolved.</td>
          </tr>
          <tr>
            <td>Someone replies after your comment in a thread someone else started.</td>
            <td>You reply, or the thread is resolved.</td>
          </tr>
          <tr>
            <td>Someone comments on a pull request after your last comment or review there.</td>
            <td>You review, comment or push on it.</td>
          </tr>
          <tr>
            <td>
              <Ui>Re-review</Ui>
            </td>
            <td>Someone pushes to a pull request after your last review or comment.</td>
            <td>You review, comment or push.</td>
          </tr>
          <tr>
            <td rowSpan={5}>
              <Ui>Your PRs</Ui>
            </td>
            <td>The latest build on your open pull request failed.</td>
            <td>The build passes.</td>
          </tr>
          <tr>
            <td>Your pull request conflicts with its base.</td>
            <td>The conflict is resolved.</td>
          </tr>
          <tr>
            <td>Your pull request has an approval and no "changes requested".</td>
            <td>It is merged or closed.</td>
          </tr>
          <tr>
            <td>GitHub will merge your pull request, or wants the branch updated.</td>
            <td>It merges, or stops being ready.</td>
          </tr>
          <tr>
            <td>A review comment on your pull request has had no reply for a day.</td>
            <td>Someone replies or pushes to its file.</td>
          </tr>
          <tr>
            <td>
              <Ui>New PRs</Ui>
            </td>
            <td>
              Someone else opened a pull request you have not touched, since the repository was added. Only with{' '}
              <Ui>Also show new PRs nobody asked you about</Ui> on.
            </td>
            <td>You review, comment or push.</td>
          </tr>
        </tbody>
      </table>
      <p>
        A card whose wait is older than 14 days moves to a closed <Ui>Older</Ui> group at the end. It still
        counts.
      </p>

      <Illustration
        label="My turn with two groups: Waiting on you holds a review request on #612, and Your PRs holds a failing build on #488."
        caption="Two My turn groups."
      >
        <Group first>Waiting on you</Group>
        <PrRow title="#612 Partial refunds" repo="acme/payments · priya asked you · 6h" status={<Pill tone="red">Your turn</Pill>} />
        <Group>Your PRs</Group>
        <PrRow title="#488 Webhook timeouts" repo="acme/api · test failed · 40m" status={<Pill tone="red">CI failing on your PR</Pill>} />
      </Illustration>

      <H3>One card per pull request</H3>
      <p>
        A pull request that holds two jobs for you shows one card: the first in the order of the table above,
        then the oldest. When that job is done, the next one shows. Your own pull request's failing build,
        conflict, readiness to land and unanswered threads are listed here instead of in their usual tab, so
        each is listed once.
      </p>

      <H2 id="card-buttons">The card's buttons</H2>
      <p>Each card leads with the one action its job needs:</p>
      <ul>
        <li>
          <Ui>Start review</Ui> opens the pull request on its Changes tab.
        </li>
        <li>
          <Ui>Reply</Ui> opens the thread with a reply box. A thread card also has a resolve button.
        </li>
        <li>
          <Ui>Answer</Ui> and <Ui>Read it</Ui> open the comment that needs you.
        </li>
        <li>
          <Ui>See the commits</Ui> opens the pull request's Activity tab at the new commits.
        </li>
        <li>
          On <Ui>Your PRs</Ui>, a ready pull request carries the merge buttons (see{' '}
          <DocLink to="pending/ready-to-land">Ready to land</DocLink>) and a conflict carries{' '}
          <Ui>Resolve conflicts</Ui>.
        </li>
      </ul>

      <H2 id="what-does-not-count">What does not put a card here</H2>
      <ul>
        <li>
          <b>Bots.</b> No bot action returns the ball to you, not even a push. Limn's own posts do not either.
        </li>
        <li>
          <b>Side comments.</b> A comment that is not an answer to you, such as a comment in a thread you never
          wrote in, does not bring you back.
        </li>
        <li>
          <b>Drafts.</b> A draft pull request never puts a card here.
        </li>
        <li>
          <b>A red default branch.</b> It is not one person's task. It shows in{' '}
          <DocLink to="pending/needs-fixing">Needs fixing</DocLink> and on the{' '}
          <DocLink to="open-pull-requests/trunk-strip">default branch strip</DocLink>.
        </li>
        <li>
          <b>Opening a pull request.</b> Reading it is not an action. Reviewing, commenting or pushing is.
        </li>
      </ul>
      <p>
        If you approve a pull request after a reply in a thread, that counts as your answer to the reply.
      </p>

      <H2 id="labels">Your turn and In your repos</H2>
      <p>
        A card says <Ui>Your turn</Ui> when it involves you directly: you wrote it, you were asked, you were
        mentioned or you took part. <Ui>In your repos</Ui> marks a new pull request in a repository you
        maintain. Other cards carry the plain label for what they are, such as <Ui>Review or reply</Ui>.
      </p>

      <H2 id="only-yours">Only yours</H2>
      <p>
        <Ui>Only yours</Ui> narrows My turn to the cards that involve you, and <Ui>Not tied to you</Ui> shows the
        rest. Each pill shows its own count.
      </p>

      <H2 id="dismiss">Dismiss a card</H2>
      <p>
        Every card can be dismissed, for an item you cannot act on now, or ever. A dismissal sets the pull
        request down until something new happens on it. Something new comes back as itself: a new reply comes
        back as a reply.
      </p>
      <Steps>
        <li>
          Select the card and press <Kbd>e</Kbd>, or choose <Ui>Dismiss</Ui> in the panel, or the ✕ on the row.
        </li>
        <li>
          Press <Kbd>z</Kbd> or choose <Ui>Undo</Ui> to take it back at once.
        </li>
        <li>
          To bring one back later, open <Ui>Dismissed</Ui> at the foot of the tab and choose <Ui>Bring back</Ui>.
        </li>
      </Steps>
      <Note>
        A dismissal hides the card everywhere: the tab, its count, the notifications and{' '}
        <code>limn status</code>. If the job ends on its own (you acted, or the pull request closed), the
        dismissal ends with it, so a later request starts fresh.
      </Note>

      <H2 id="mute-a-repository">Mute a repository</H2>
      <p>
        To keep a repository out of My turn altogether, mute it in{' '}
        <DocLink to="settings/pending">Settings → Pending</DocLink>. Muted repositories never appear in My turn
        and never notify you. The other tabs still show them: your own failing build in a muted repository goes
        back to Needs fixing. The mute is per workspace.
      </p>

      <H2 id="new-prs">Show new pull requests</H2>
      <p>
        My turn has one setting: <Ui>Also show new PRs nobody asked you about</Ui>, in{' '}
        <DocLink to="settings/pending">Settings → Pending</DocLink> (the <Ui>Customise</Ui> link on the tab
        goes there). With it on, the <Ui>New PRs</Ui> group lists other people's pull requests you have not
        touched. It is off by default.
      </p>

      <Warning>
        Approving from a card (<Kbd>a</Kbd>) submits a real approving review on GitHub under your account, once
        the Undo offer ends.
      </Warning>
    </>
  );
}

import type { DocMeta } from '../../types';
import { DocLink, H2, Note, Steps, Tip, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'My Turn notifications',
  summary: 'Get a browser notification when the ball comes back to you.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn can show a notification from your browser when a new item enters your My turn list: a review
        request, a reply to you, a mention, new commits to re-read, or news about your own pull request. The
        notification names the workspace the items came from. It is off until you switch it on.
      </p>

      <WhoItHelps
        developer="Keep Limn in a background tab and hear about a review request or a reply when it happens, not when you next look."
        manager="Stay responsive to the reviews and questions that wait on you, without watching the board."
      />

      <H2 id="turn-them-on">Turn notifications on</H2>
      <Steps>
        <li>
          Choose the bell at the foot of the sidebar (<Ui>Turn on browser notifications for new My Turn items</Ui>
          ). You can also find it in <Ui>Search or jump</Ui>.
        </li>
        <li>Allow notifications when the browser asks.</li>
      </Steps>
      <p>
        The bell is filled while notifications are on. Choose it again to turn them off. The choice is kept in
        this browser.
      </p>

      <H2 id="what-you-are-told">What you are told about</H2>
      <ul>
        <li>
          Only new items. When you open Limn, the items already waiting do not each send a notification.
        </li>
        <li>
          Only items that involve you. A new pull request in a repository you maintain counts; a pull request
          nobody asked you about, from the <Ui>New PRs</Ui> group, does not.
        </li>
        <li>
          Across every workspace, not only the one on screen. The notification names the workspace.
        </li>
        <li>
          Never for a muted repository, a draft, a dismissed item, or anything a bot did. See{' '}
          <DocLink to="pending/my-turn#what-does-not-count">What does not put a card here</DocLink>.
        </li>
      </ul>
      <p>
        When you switch on <Ui>Also show new PRs nobody asked you about</Ui>, Limn does not notify you about the
        backlog it adds.
      </p>

      <Note>
        Notifications come from the Limn tab in your browser, so Limn must be running and a Limn tab must be
        open. They arrive when Limn's next sync brings the change in, usually within a few minutes.
      </Note>

      <Tip>
        The same switch also lets Limn tell you when an AI review that you started finishes. Reviews started by
        auto review do not notify you; their results wait on the pull request.
      </Tip>
    </>
  );
}

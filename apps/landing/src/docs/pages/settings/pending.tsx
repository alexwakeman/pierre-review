import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, SettingsRow, Steps, Toggle, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Pending settings',
  summary: 'My Turn options and muted repositories.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Pending</Ui> tab changes what the <DocLink to="pending/my-turn">My turn</DocLink> list shows you. It
        has one setting for you everywhere (<Ui>My Turn</Ui>) and one for the current workspace (
        <Ui>Pending mute</Ui>). The other Pending tabs follow fixed rules and have no settings.
      </p>
      <WhoItHelps
        developer="Keep My turn to the pull requests that are really waiting on you, and stop a noisy repository from notifying you."
        manager="Opt in to see every new pull request in your repositories, not only the ones that name you."
      />

      <H2 id="my-turn">My Turn</H2>
      <p>
        My turn lists pull requests where a person is waiting on you, in three groups: <Ui>Waiting on you</Ui>{' '}
        (review requests, mentions and replies to you), <Ui>Re-review</Ui> (someone pushed after your review or
        comment) and <Ui>Your PRs</Ui> (approved, ready to land, failing, conflicting, or with an unanswered thread). An
        item that has waited more than 14 days moves to a closed <Ui>Older</Ui> group at the end. It still counts.
        Draft pull requests never show.
      </p>
      <p>
        The groups and their order are fixed. The one choice is <Ui>Also show new PRs nobody asked you about</Ui>. Turn
        it on to add open pull requests in your repositories that nobody asked you to look at. It applies to every
        workspace and saves as soon as you change it.
      </p>
      <Illustration label="The My Turn setting with its one switch off." caption="The one My Turn choice. It is off until you turn it on.">
        <SettingsRow
          label="Also show new PRs nobody asked you about"
          hint="Open PRs in your repositories that nobody asked you about."
          control={<Toggle on={false} />}
        />
      </Illustration>
      <p>
        On the Pending board, the <Ui>Customise</Ui> link opens this tab directly.
      </p>

      <H2 id="pending-mute">Mute repositories</H2>
      <p>
        A muted repository never appears in My turn and never notifies you. Use it for a repository you are in but do
        not need to act on. Muting changes nothing else: the repository still shows everywhere else, and the other
        Pending tabs (<Ui>Needs fixing</Ui>, <Ui>Waiting on review</Ui>, <Ui>Unanswered threads</Ui>,{' '}
        <Ui>Ready to land</Ui>, <Ui>Dependencies</Ui>) still list it. Your own pull requests in a muted repository show
        there instead.
      </p>
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, then the <Ui>Pending</Ui> tab.
        </li>
        <li>
          Under <Ui>Pending mute</Ui>, tick <Ui>Mute this whole workspace</Ui> to mute every repository in it,
          including ones added later. Or tick single repositories under <Ui>Mute individual repositories</Ui>.
        </li>
        <li>
          Select <Ui>Save</Ui>.
        </li>
      </Steps>
      <Note>
        A mute follows the repository. If you move the repository to another workspace, it stays muted. When the whole
        workspace is muted, the ticks on single repositories are kept and come back if you un-mute the workspace.
      </Note>
      <p>
        Notifications are explained in <DocLink to="pending/notifications">My Turn notifications</DocLink>.
      </p>
    </>
  );
}

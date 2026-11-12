import type { DocMeta } from '../../types';
import { WorkspacesMock } from '../../../components/mock/setup';
import { DocLink, H2, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Group repositories into workspaces',
  summary: 'A workspace is a named group of repositories. Every page in Limn shows one workspace at a time.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A workspace is a named group of repositories, for example one per team or one per product. Every page
        in Limn shows one workspace: its pull requests, its Pending board, its Feed, its Reports and its bots.
        Switching the workspace changes all of them together. Each repository is in exactly one workspace.
      </p>


      <H2 id="the-default-workspace">The Default workspace</H2>
      <p>
        Limn starts with one workspace, <Ui>Default</Ui>. New repositories land there unless you add them to
        another workspace. You can rename Default, but you cannot delete it: when you delete another
        workspace, its repositories and its bot settings move back to Default.
      </p>

      <H2 id="switch-workspace">Switch the workspace</H2>
      <p>
        The workspace picker is at the top of the sidebar. It shows the name of the workspace you are in. Open
        it and choose another workspace. Default is listed first, then the rest by name, each with its number
        of repositories.
      </p>
      <p>
        When another workspace has pull requests waiting on you, the picker shows its count, and the sidebar's{' '}
        <Ui>Needs you</Ui> section names it, so you do not miss work in a workspace you are not looking at.
      </p>

      <H2 id="manage-workspaces">Create, rename and delete workspaces</H2>
      <Steps>
        <li>
          Open the workspace picker and choose <Ui>Manage repos &amp; workspaces</Ui>.
        </li>
        <li>
          To create one, type a name in <Ui>New workspace name…</Ui> and choose <Ui>Create</Ui>.
        </li>
        <li>
          To rename one, choose <Ui>Rename</Ui> beside its name.
        </li>
        <li>
          To delete one, choose <Ui>Delete workspace</Ui> and confirm. Its repositories move to Default.
        </li>
      </Steps>

      <H2 id="move-a-repository">Move a repository</H2>
      <p>
        In the same dialog, each repository has a workspace picker. Choose another workspace to move it there.
        A move takes the repository out of the workspace it was in. The dialog lists the repositories{' '}
        <Ui>In "…"</Ui> (the selected workspace) and <Ui>In other workspaces</Ui>.
      </p>

      <figure className="dx-fig">
        <WorkspacesMock />
        <figcaption>
          <span>Illustration:</span> Manage repos &amp; workspaces. Try moving a repository to the other workspace,
          or marking one external.
        </figcaption>
      </figure>

      <H2 id="external-repositories">External repositories</H2>
      <p>
        Mark a repository <Ui>External</Ui> when your team changes it but does not maintain it, for example
        a shared infrastructure repository where you update your services' configuration. In{' '}
        <Ui>Manage repos &amp; workspaces</Ui>, change its picker from <Ui>Watched</Ui> to <Ui>External</Ui>.
      </p>
      <p>An external repository:</p>
      <ul>
        <li>
          Is part of <DocLink to="implement-story/overview">Implement story</DocLink> and{' '}
          <DocLink to="ai-fix/overview">AI Fix</DocLink>, like any other repository in the workspace.
        </li>
        <li>Links its pull requests to your tickets on This Sprint.</li>
        <li>
          Shows on Open PRs and Pending only the pull requests that are your team's: a pull request whose
          title or branch has one of your tracker's project keys, or one opened by a person who maintains
          (has merged into) one of your watched repositories. Your own pull requests always count. Pull
          requests from other teams stay hidden.
        </li>
        <li>Is left out of Reports, the Timeline, the Feed and Bots Monitoring.</li>
        <li>
          Gets no automatic action: no auto review, auto-posting, auto fix, automatic thread resolving or
          Slack signal. You can still run an AI review or AI Fix on one of its pull requests yourself.
        </li>
      </ul>
      <Note>
        The project-key rule needs the project keys set in your tracker settings. Without them, only the
        maintainer rule applies. See <DocLink to="settings/integrations">Settings → Integrations</DocLink>.
      </Note>

      <H2 id="what-a-workspace-holds">What belongs to a workspace</H2>
      <p>These settings and figures are kept per workspace:</p>
      <ul>
        <li>The repositories, and so every list and count in the app.</li>
        <li>
          Which reviewers are bots, their category and their price. See{' '}
          <DocLink to="settings/bots">Settings → Bots</DocLink>.
        </li>
        <li>
          Auto review, auto-posting and the other AI review switches. See{' '}
          <DocLink to="settings/ai-review">Settings → AI review</DocLink>.
        </li>
        <li>
          The issue tracker, SonarCloud and Slack. See{' '}
          <DocLink to="settings/integrations">Settings → Integrations</DocLink>.
        </li>
        <li>
          Working hours, Chronology budgets and the sprint cadence. See{' '}
          <DocLink to="settings/reports-and-sprint">Settings → Reports and sprint</DocLink>.
        </li>
        <li>
          The repositories muted on My turn. See <DocLink to="pending/my-turn#mute-a-repository">Mute a repository</DocLink>.
        </li>
      </ul>

      <Note>
        Limn never adds figures up across workspaces. A bot's price, for example, is set per workspace, and
        each workspace's reports use its own.
      </Note>

      <Warning>
        Deleting a workspace does not delete its repositories or their data. They move to Default, with the
        workspace's bot settings. Where Default already has a verdict or a price for the same bot, Default's
        is kept.
      </Warning>
    </>
  );
}

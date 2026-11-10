import type { DocMeta } from '../../types';
import { AddReposMock } from '../../../components/mock/setup';
import { DocLink, H2, H3, Note, Steps, Tip, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Add your repositories',
  summary: 'Choose the repositories Limn follows. The first sync brings in two weeks of history quickly, then fills in the rest.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn follows only the repositories you add. Each one you add is synced from GitHub to your computer,
        and every page in the app reads that copy. You can add any repository your GitHub CLI sign-in can
        read: your own, your organisation's, or a public one.
      </p>

      <WhoItHelps
        developer="Add the repositories you review and commit to. My turn then covers all of them."
        manager="Add every repository the team works in, so that Reports and Chronology count all of the team's work."
      />

      <H2 id="the-first-run">The first time you open Limn</H2>
      <p>
        With no repositories yet, Limn opens <Ui>Add the repos you work on</Ui>. It lists the repositories
        you were active in recently, with their open pull requests, and ticks the top five.
      </p>
      <Steps>
        <li>Tick the repositories you want, and clear the ones you do not.</li>
        <li>
          To add one that is not listed, type its name in <Ui>Search repos to add…</Ui> under{' '}
          <Ui>or add any repo by name</Ui>.
        </li>
        <li>
          Choose <Ui>Add selected</Ui>. The sync starts at once and its progress shows in a panel.
        </li>
        <li>
          Choose <Ui>Continue in background</Ui> to start work while the sync runs, or wait for{' '}
          <Ui>Sync complete</Ui>.
        </li>
      </Steps>

      <figure className="dx-fig">
        <AddReposMock />
        <figcaption>
          <span>Illustration:</span> The first-run list of suggested repositories. Try ticking and adding them.
        </figcaption>
      </figure>

      <Note>
        If you choose more than ten repositories, Limn says the first sync will take longer. It still adds all
        of them.
      </Note>

      <H2 id="add-more-later">Add more repositories later</H2>
      <Steps>
        <li>
          Open the workspace picker at the top of the sidebar and choose <Ui>Manage repos &amp; workspaces</Ui>.
          You can also find it with <Ui>Search or jump</Ui> (<code>⌘K</code>).
        </li>
        <li>
          Pick the workspace the repository belongs in, on the left.
        </li>
        <li>
          Type the repository's name in <Ui>Add a repo to …</Ui> and choose it from the results.
        </li>
      </Steps>
      <p>
        A new repository goes into the workspace you have selected. See{' '}
        <DocLink to="getting-started/workspaces">Group repositories into workspaces</DocLink>.
      </p>

      <H2 id="the-first-sync">What the first sync brings in</H2>
      <p>The first sync of a repository runs in two parts, so you can start work quickly:</p>
      <ol>
        <li>
          <b>The last two weeks, first.</b> Open pull requests and recent activity arrive in a fast first pass.
          Most pages are useful after this part.
        </li>
        <li>
          <b>Then up to 90 days of history.</b> Limn fills in the older activity in the background. Reports and
          Chronology become more complete as it does.
        </li>
      </ol>
      <p>
        After that, Limn keeps each repository up to date by itself. It checks busy repositories more often
        than quiet ones, and a pull request you have open in Limn is refreshed every few seconds.
      </p>

      <H3>What shows first on Pending</H3>
      <p>
        So that <DocLink to="pending/my-turn">My turn</DocLink> is not empty on day one, the repositories you
        add on your first run show the replies, mentions and pushes of the week before you added them. A
        repository you add later starts from the time you add it, so its old history does not fill your My
        turn list.
      </p>

      <H2 id="sync-state">See the sync state</H2>
      <ul>
        <li>
          The foot of the sidebar says when Limn last synced, for example <Ui>Synced 2m ago</Ui>, or{' '}
          <Ui>Sync error</Ui>. Choose it to sync every repository now.
        </li>
        <li>
          If GitHub's hourly limit for your account is near, Limn waits instead of failing, and says{' '}
          <Ui>Paused — resuming ~HH:MM</Ui> with the time it will carry on.
        </li>
        <li>
          A red dot beside a repository in the sidebar can mean its last sync failed. See{' '}
          <DocLink to="getting-started/repository-pages">Repository pages</DocLink>.
        </li>
      </ul>

      <Tip>
        If something looks out of date, use <Ui>Deep re-sync</Ui> on that repository in{' '}
        <Ui>Manage repos &amp; workspaces</Ui>. It reads the whole history window again. It is slower, but it
        catches check and thread changes the normal sync can miss for a while.
      </Tip>

      <H2 id="remove-a-repository">Remove a repository</H2>
      <p>
        In <Ui>Manage repos &amp; workspaces</Ui>, choose the remove button at the end of the repository's row
        and confirm.
      </p>
      <Warning>
        Removing a repository deletes everything Limn stored for it on your computer. Nothing changes on GitHub.
        You can add it again, and the sync brings the GitHub data back.
      </Warning>
    </>
  );
}

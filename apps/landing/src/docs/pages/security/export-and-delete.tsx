import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Kbd, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Export and delete your data',
  summary: 'Download everything Limn holds about your account, or erase it.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        All of Limn&rsquo;s data is on your computer, so you control it completely. You can download it as one file,
        remove a single repository, or erase everything. This page shows how, and what each step does not remove.
      </p>

      <H2 id="export">Export your data</H2>
      <p>
        Limn can give you everything it holds about your account as one JSON file: your repositories, their synced
        activity, your workspaces and settings, and the AI results. Saved tokens are not in the file; it says only
        whether one is saved.
      </p>
      <Steps>
        <li>Make sure Limn is running.</li>
        <li>
          In your browser, open <code>http://localhost:4000/api/me/export</code>. If you started Limn on another port,
          use that port instead of 4000.
        </li>
        <li>Your browser saves the file. Its name includes your GitHub login and the date.</li>
      </Steps>

      <H2 id="remove-a-repository">Remove one repository</H2>
      <p>
        Removing a repository deletes all of its locally synced data. Open <Ui>Manage repos &amp; workspaces</Ui> from
        the workspace picker in the sidebar (or from the <Kbd>⌘</Kbd> <Kbd>K</Kbd> menu), point at the repository,
        select its remove button and confirm. See{' '}
        <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
      </p>

      <H2 id="erase-everything">Erase everything</H2>
      <Steps>
        <li>Stop Limn.</li>
        <li>
          Run <code>limn sandbox prune --store</code> to remove every sandbox and Limn&rsquo;s kept copy of your
          repositories from your container runtime.
        </li>
        <li>
          Delete the <code>~/.limn</code> folder (or the folder you set with <code>LIMN_DATA_DIR</code>).
        </li>
      </Steps>
      <p>
        This removes the database, the repository copies, the downloaded AI programs and scoring model, and
        Limn&rsquo;s own Codex sign-in. Settings kept only in your browser, such as the colour scheme, stay until you
        clear the site&rsquo;s data in the browser.
      </p>
      <Warning>This cannot be undone. Export first if you might want the data later.</Warning>

      <H2 id="what-is-not-removed">What is not removed</H2>
      <H3>Your other tools</H3>
      <ul>
        <li>
          Your <code>gh</code> sign-in and your Claude Code login. Sign out of them with <code>gh auth logout</code> and
          Claude Code&rsquo;s own sign-out if you want to.
        </li>
        <li>Your own clones of your repositories. Limn never changes them.</li>
      </ul>
      <H3>What Limn sent elsewhere</H3>
      <ul>
        <li>Comments, reviews, merges and pushes Limn made on GitHub, and messages it posted to Slack.</li>
        <li>
          Work sent to Anthropic or OpenAI, which each keeps under its own terms. See{' '}
          <DocLink to="settings/how-providers-treat-your-work">How Anthropic and OpenAI treat your work</DocLink>.
        </li>
      </ul>

      <H2 id="uninstall">Uninstall Limn</H2>
      <p>
        If you run Limn with <code>npx limn-review</code>, there is nothing to uninstall: stop it and, if you like,
        erase its data as above. If you installed it globally, run <code>npm uninstall -g limn-review</code>.
      </p>
      <Note>
        To stop Limn using Codex without deleting anything else, select <Ui>Sign out</Ui> on the{' '}
        <DocLink to="settings/ai">AI</DocLink> tab.
      </Note>
    </>
  );
}

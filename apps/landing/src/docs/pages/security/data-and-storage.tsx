import type { DocMeta } from '../../types';
import { DocLink, H2, H3, MiniTable, Note, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'What Ensemble stores',
  summary: 'Where Ensemble keeps its data, what it keeps, for how long, and how to move or delete it.',
};

const FOLDER_COLS = [
  { key: 'what', label: 'What' },
  { key: 'why', label: 'Why' },
];
const FOLDER_ROWS = [
  { _key: 'db', what: 'The database', why: 'Synced pull request activity, your settings, AI results' },
  { _key: 'clones', what: 'Repository copies', why: 'The code AI runs and the conflict resolver read' },
  { _key: 'ai', what: 'The AI programs', why: 'The agents you picked in Settings → AI (Claude by default)' },
  { _key: 'codex', what: 'Ensemble’s Codex sign-in', why: 'Kept apart from your own Codex setup' },
  { _key: 'ml', what: 'The scoring model', why: 'Bot comment scoring, if you set it up' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Everything Ensemble keeps is on your computer, in one folder: <code>~/.ensemble</code> (the <code>.ensemble</code> folder
        in your home folder). Nothing is kept anywhere else by Ensemble. This page says what is in the folder, how long
        Ensemble keeps it, and how to move it.
      </p>

      <H2 id="the-ensemble-folder">The ~/.ensemble folder</H2>
      <MiniTable cols={FOLDER_COLS} rows={FOLDER_ROWS} />
      <p>
        Sandboxes for AI Fix and Implement live in your container runtime, not in this folder. Remove leftovers with{' '}
        <code>ensemble sandbox prune</code>.
      </p>

      <H2 id="what-is-in-the-database">What is in the database</H2>
      <ul>
        <li>
          <b>From GitHub:</b> the repositories you added, their pull requests, reviews, comments (with their text),
          review threads, commits, check results and events. Some detail, such as a pull request&rsquo;s description
          and full CI results, is fetched again when you open it rather than stored.
        </li>
        <li>
          <b>From your trackers:</b> the tickets your pull requests link to, once a tracker is set up.
        </li>
        <li>
          <b>From you:</b> your workspaces, settings, dismissals and the Docs library you add.
        </li>
        <li>
          <b>From the AI:</b> each review, fix, plan, chat and summary, with the provider and model that ran it and
          what it used.
        </li>
      </ul>
      <H3>Tokens you give Ensemble</H3>
      <p>
        Tokens for Jira, Linear, Notion, Confluence and SonarCloud, and the Slack webhook, are stored sealed
        (encrypted) in the database. The app never shows them again and never includes them in an export. Your GitHub
        sign-in and your Claude or Codex credentials are not in the database at all.
      </p>

      <H2 id="how-long">How long Ensemble keeps it</H2>
      <p>
        A first sync reads about 90 days of history. Once a day, Ensemble removes every pull request that has had no
        activity for 180 days, with everything attached to it. Repository copies left by finished AI runs are removed
        when Ensemble starts and when a new run begins; an unpushed fix is kept for up to 14 days.
      </p>

      <H2 id="move-the-folder">Move the folder</H2>
      <ul>
        <li>
          Start Ensemble with <code>ENSEMBLE_DATA_DIR</code> set to another folder to keep everything there. The older
          name, <code>LIMN_DATA_DIR</code>, still works.
        </li>
        <li>
          Start Ensemble with <code>--db</code> and a file path to use a different database file.
        </li>
        <li>
          If you used Ensemble under an earlier name, an existing <code>~/.limn</code> (or <code>~/.pierre-review</code>)
          folder is moved to <code>~/.ensemble</code> once, on first start. An existing <code>~/.ensemble</code> is never overwritten.
        </li>
      </ul>
      <Tip>
        To back Ensemble up, stop it and copy the folder. To start again from nothing, stop it and delete the folder.
      </Tip>
      <Warning>
        Deleting <code>~/.ensemble</code> removes your settings, workspaces, Docs library and every AI result, and cannot
        be undone. It does not remove anything Ensemble posted to GitHub, Slack or a tracker. See{' '}
        <DocLink to="security/export-and-delete">Export and delete your data</DocLink>.
      </Warning>
      <Note>
        What the AI provider keeps of the work Ensemble sends is set by the provider. See{' '}
        <DocLink to="settings/how-providers-treat-your-work">How Anthropic and OpenAI treat your work</DocLink>.
      </Note>
      <p>
        The settings that never leave this browser, such as the <Ui>Colour scheme</Ui>, are kept by the browser, not in
        the folder.
      </p>
    </>
  );
}

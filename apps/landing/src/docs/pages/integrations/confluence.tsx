import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Confluence',
  summary:
    'Add Confluence Cloud pages, or a whole space, to the docs library. Limn reads them with an Atlassian API token, keeps them current, and never changes a page.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Many teams keep their specifications, runbooks and decisions in Confluence. Limn can add a Confluence page and
        every page below it, or a whole space, to the workspace&rsquo;s{' '}
        <DocLink to="docs-library/overview">docs library</DocLink>. From there, reviews, story checks and the docs
        chat can use them. Limn reads Confluence only; it never edits, comments on or creates a page.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>Confluence Cloud (an <code>atlassian.net</code> site).</li>
        <li>
          An Atlassian account email and API token, from{' '}
          <ExtLink href="https://id.atlassian.com/manage-profile/security/api-tokens">
            id.atlassian.com → Security → API tokens
          </ExtLink>
          . The token acts as you, so it reads only the spaces and pages you can see.
        </li>
        <li>AI set up in Settings → AI, because Docs needs it.</li>
      </ul>

      <H2 id="set-it-up">Set it up</H2>
      <p>
        If Jira is this workspace&rsquo;s tracker and its email and token are saved, a Confluence page on the{' '}
        <strong>same site</strong> uses the Jira connection, because Atlassian Cloud uses one API token for both.
        Settings → Docs then shows <Ui>Using your Jira connection</Ui>, and there is nothing to set up.
      </p>
      <p>Otherwise, or to use a different token:</p>
      <Steps>
        <li>
          Open <Ui>Settings → Docs</Ui>. Under <Ui>Confluence</Ui>, type the <Ui>Site</Ui>, your <Ui>Email</Ui> and the{' '}
          <Ui>API token</Ui> (or press <Ui>Use a different token</Ui> when the Jira connection is in use).
        </li>
        <li>
          Save, and press <Ui>Test connection</Ui>.
        </li>
      </Steps>
      <Illustration label="Settings → Docs → Confluence using the Jira connection" caption="Confluence in Settings → Docs.">
        <SettingsRow label="Confluence" hint="Pages on acme.atlassian.net use your Jira token." control={<TextBox value="Using your Jira connection" />} />
      </Illustration>
      <Note>The token is stored sealed and is never shown again. A new token replaces the saved one when you save.</Note>

      <H2 id="add-pages">Add pages</H2>
      <Steps>
        <li>
          On the Docs page, press <Ui>+</Ui> and choose <Ui>Confluence</Ui>. You can also paste a Confluence address
          into <Ui>Web page or site</Ui>; Limn notices and switches.
        </li>
        <li>
          Paste a page address. A space&rsquo;s home page, or the space&rsquo;s own address, adds the whole space; any
          other page adds it and every page below it, never its siblings or parents.
        </li>
        <li>
          Limn counts the pages first (&ldquo;This will add 12 pages from Payments handbook.&rdquo;). Press{' '}
          <Ui>Start</Ui>.
        </li>
      </Steps>
      <p>
        The pages become one document, with a chapter per page, up to 100 pages. For a bigger space, add its sections
        as separate documents. A short <code>/wiki/x/…</code> link does not name a page; open the page and copy its
        full address.
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <ul>
        <li>The pages&rsquo; titles, their place in the page tree, their text and their version.</li>
        <li>
          Tables, code blocks, info and warning panels, expand sections, task lists, and status and Jira macros, as
          text.
        </li>
        <li>
          Images and diagrams: Mermaid and PlantUML as their source; draw.io and Gliffy as an outline where Limn can
          read one; others as a named placeholder.
        </li>
        <li>Navigation macros, such as a table of contents, are left out.</li>
      </ul>

      <H2 id="how-often-limn-reads">How often Limn reads</H2>
      <p>
        Limn checks each Confluence document for changes about every three hours while the workspace&rsquo;s library
        is in use, and just before a review or story check reads it. It asks Confluence which pages changed and
        reads only those, then summarises only the sections whose text changed. Press <Ui>Refresh now</Ui> in the
        document&rsquo;s menu to check at once, or <Ui>Rebuild</Ui> to read every page again.
      </p>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>Nothing. Limn never edits, comments on or creates a Confluence page.</p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'm', label: 'What you see' },
          { key: 'f', label: 'What to do' },
        ]}
        rows={[
          { _key: '1', m: 'Add a Confluence API token in Settings', f: 'Save a token in Settings → Docs, or save Jira’s email and token if Jira is on the same site.' },
          {
            _key: '2',
            m: "Can't reach this page in Confluence since …",
            f: 'The page moved, was deleted, or the token lost access. The last good version stays readable; fix access and press Refresh now.',
          },
          { _key: '3', m: 'Only the first 100 pages fit in one document.', f: 'Add the rest of the space as separate sections.' },
        ]}
      />
      <Tip>Limn waits out Confluence&rsquo;s rate limit by itself and tries the check again later; there is nothing to do.</Tip>
      <p>
        Where the token is kept: <DocLink to="security/data-and-storage">Data and storage</DocLink>.
      </p>
    </>
  );
}

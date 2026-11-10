import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Notion',
  summary:
    "Use a Notion database as the workspace's issue tracker, or add Notion pages to the docs library. Limn only reads Notion; it never changes a page.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn uses Notion in two separate ways. A Notion <strong>database</strong> can be the workspace&rsquo;s issue
        tracker, where each page is a ticket. Notion <strong>pages</strong> can be added to the{' '}
        <DocLink to="docs-library/overview">docs library</DocLink>. Each use has its own token in Settings, and you
        can use the same Notion integration for both. Either way, Limn only reads.
      </p>

      <H2 id="create-an-integration">Create a Notion integration</H2>
      <Steps>
        <li>
          Go to <ExtLink href="https://www.notion.so/my-integrations">notion.so/my-integrations</ExtLink> and create an
          internal integration for your Notion workspace.
        </li>
        <li>
          Give it the capabilities <strong>Read content</strong>, <strong>Read comments</strong> and{' '}
          <strong>Read user information</strong>. Limn needs no insert or update capability.
        </li>
        <li>
          Copy its token. A token starts with <code>ntn_</code> (or <code>secret_</code> for an older one).
        </li>
        <li>
          In Notion, share each database or page you want Limn to read with the integration: the page&rsquo;s •••
          menu → <strong>Connections</strong>. Child pages are shared with it too.
        </li>
      </Steps>
      <Note>
        Notion answers &ldquo;not found&rdquo; both for a page that does not exist and for one not shared with the
        integration. If Limn cannot find a page, check the Connections menu first.
      </Note>

      <H2 id="notion-as-an-issue-tracker">Notion as an issue tracker</H2>
      <H3 id="what-you-need">What you need</H3>
      <ul>
        <li>One database that holds your tickets, shared with the integration.</li>
        <li>
          A <strong>Unique ID</strong> property with a prefix, so tickets have keys like <code>ENG-123</code>. Limn
          finds a ticket by that key in the pull request title or branch. A database without a prefixed Unique ID
          cannot be used.
        </li>
        <li>If you plan in sprints: a Sprints database (shared too), a select property or a date range.</li>
      </ul>

      <H3 id="set-up-the-tracker">Set it up</H3>
      <Steps>
        <li>
          Open <Ui>Settings → Integrations</Ui>. Under <Ui>Issue tracker</Ui>, set <Ui>Provider</Ui> to{' '}
          <Ui>Notion</Ui>.
        </li>
        <li>
          Paste the <Ui>Database URL</Ui>: the link of the database that holds your tickets. Save.
        </li>
        <li>
          Under <Ui>Notion as an issue tracker</Ui>, paste the <Ui>Integration token</Ui> and save.
        </li>
        <li>
          Press <Ui>Read database</Ui>. Limn reads the database&rsquo;s properties and suggests a mapping.
        </li>
        <li>
          Check each property in the mapping, then save. Until you do, the section says &ldquo;Not mapped yet. Nothing
          is read until it is.&rdquo;
        </li>
      </Steps>
      <Illustration
        label="The Notion mapping form: keys look like ENG-123, with Status, Assignee, Sprint, Type, Acceptance criteria and Blocked by mapped to database properties"
        caption="The mapping: which database property Limn reads for each part of a ticket."
        title="Settings"
        meta="Notion as an issue tracker"
      >
        <p>Tasks: keys look like ENG-123 (ID).</p>
        <SettingsRow label="Status" control={<TextBox value="Status" />} />
        <SettingsRow label="Assignee" control={<TextBox value="Owner" />} />
        <SettingsRow label="Sprint" hint="The current sprint is the one whose dates include today." control={<TextBox value="Sprint (Sprints)" />} />
        <SettingsRow label="Type" control={<TextBox value="Type" />} />
        <SettingsRow label="Acceptance criteria" control={<TextBox value="From the page" />} />
        <SettingsRow label="Blocked by" control={<TextBox value="Blocked by" />} />
      </Illustration>
      <MiniTable
        cols={[
          { key: 'p', label: 'Mapping' },
          { key: 'w', label: 'What it is for' },
        ]}
        rows={[
          { _key: 's', p: 'Status', w: 'A status property (its To-do, In progress and Complete groups), or a select where you say which option is which.' },
          { _key: 'a', p: 'Assignee', w: 'A people property. Limn uses the first person.' },
          {
            _key: 'sp',
            p: 'Sprint',
            w: 'A relation to a Sprints database (with its date property), a select with the current option, or a date range. None: This Sprint shows open tickets edited lately.',
          },
          { _key: 't', p: 'Type', w: 'A select, used for the issue type.' },
          { _key: 'c', p: 'Acceptance criteria', w: 'A text property, or From the page: a task list or an "Acceptance criteria" heading in the page body.' },
          { _key: 'b', p: 'Blocked by', w: 'A relation to the same database, for the arrows on This Sprint.' },
        ]}
      />

      <H3 id="what-limn-reads-as-a-tracker">What Limn reads</H3>
      <ul>
        <li>For each ticket a pull request names: its properties as mapped, the page body (as text), its blockers and its comments.</li>
        <li>For This Sprint: the pages in the current sprint.</li>
      </ul>
      <p>
        Tickets are read when a pull request arrives and about every 30 minutes while it is open; the sprint about
        every 20 minutes while This Sprint is in use. Notion allows about three requests a second per integration,
        and Limn spaces its calls to stay under that.
      </p>
      <Tip>
        The mapping belongs to one database. Pointing the Database URL at another database clears the mapping, but
        keeps the token.
      </Tip>

      <H2 id="notion-pages-in-docs">Notion pages in Docs</H2>
      <Steps>
        <li>
          Open <Ui>Settings → Docs</Ui>. Under <Ui>Notion</Ui>, paste the <Ui>Integration token</Ui>, save, and press{' '}
          <Ui>Test connection</Ui>.
        </li>
        <li>Share the pages you want with the integration in Notion.</li>
        <li>
          On the Docs page, press <Ui>+</Ui>, choose <Ui>Notion</Ui>, and paste a page address. A top-level page adds
          the whole wiki; any other page adds it and every page below it.
        </li>
      </Steps>
      <p>
        Limn checks the pages for changes about every three hours while the library is in use, and reads only the
        pages that changed. See <DocLink to="docs-library/add-documents">Add documents</DocLink>.
      </p>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>
        Nothing. Limn only reads Notion. It never changes a page, a property or a comment, and the status and the
        assignee in the story view are shown, not changed.
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'm', label: 'What you see' },
          { key: 'f', label: 'What to do' },
        ]}
        rows={[
          { _key: '1', m: 'A page or ticket is not found', f: 'Share it with the integration (••• → Connections).' },
          { _key: '2', m: 'The database is refused at Read database', f: 'Add a Unique ID property with a prefix to the database.' },
          { _key: '3', m: 'No comments show', f: 'Give the integration the Read comments capability.' },
          { _key: '4', m: 'The token is refused', f: 'Paste the integration’s token, starting ntn_ or secret_, not a page link.' },
        ]}
      />
      <p>
        Where tokens are kept: <DocLink to="security/data-and-storage">Data and storage</DocLink>.
      </p>
    </>
  );
}

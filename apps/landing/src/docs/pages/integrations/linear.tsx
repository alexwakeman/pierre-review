import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Linear',
  summary:
    'Connect Linear with a personal API key so story checks, reviews and This Sprint read your issues and the active cycle. Limn only reads Linear.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        With Linear as a workspace&rsquo;s tracker, Limn links each pull request to its Linear issues, reads those
        issues, and shows each team&rsquo;s active cycle on This Sprint. It reads with a personal API key you save
        in Settings, and it never changes anything in Linear.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          Your Linear workspace&rsquo;s address, for example <code>https://linear.app/acme</code>.
        </li>
        <li>
          A personal API key. Create one in Linear under <strong>Settings → Security &amp; access</strong>. It starts
          with <code>lin_api_</code>. Read access is enough. See{' '}
          <ExtLink href="https://linear.app/docs/api-and-webhooks">Linear&rsquo;s API documentation</ExtLink>.
        </li>
        <li>
          Optional, but useful: Linear&rsquo;s GitHub integration, so Linear itself attaches pull requests to issues.
        </li>
      </ul>

      <H2 id="set-it-up">Set it up</H2>
      <Steps>
        <li>
          Open <Ui>Settings → Integrations</Ui>. Under <Ui>Issue tracker</Ui>, set <Ui>Provider</Ui> to{' '}
          <Ui>Linear</Ui>.
        </li>
        <li>
          Type the <Ui>Workspace URL</Ui>.
        </li>
        <li>
          Optional: type your <Ui>Team keys</Ui>, comma-separated, for example <code>ENG, OPS</code>, and choose{' '}
          <Ui>Where to look</Ui>. Without team keys only the pull request title is searched for keys.
        </li>
        <li>Save. The <Ui>Linear API key</Ui> block appears.</li>
        <li>
          Paste your <Ui>Personal API key</Ui>, save, and press <Ui>Check connection</Ui>. The check names the Linear
          workspace the key belongs to.
        </li>
      </Steps>
      <Illustration
        label="The Issue tracker section with Linear chosen: workspace URL, team keys and a saved personal API key"
        caption="Linear in Settings → Integrations."
        title="Settings"
        meta="Integrations"
      >
        <SettingsRow label="Provider" control={<TextBox value="Linear" />} />
        <SettingsRow label="Workspace URL" hint="Tickets link to {base}/issue/KEY-123." control={<TextBox value="https://linear.app/acme" mono />} />
        <SettingsRow label="Team keys" control={<TextBox value="ENG, OPS" mono />} />
        <SettingsRow label="Personal API key" hint="Saved" control={<TextBox value="••••••••" />} />
      </Illustration>
      <Note>
        Limn refuses a value that is not shaped like a Linear key, so a pasted GitHub or Jira token is never saved or
        sent. A key belongs to one Linear workspace: if it is for another workspace than the URL, Limn says so and
        reads nothing.
      </Note>

      <H2 id="how-pull-requests-link-to-issues">How pull requests link to issues</H2>
      <ol>
        <li>
          First, the issues Linear&rsquo;s GitHub integration attached the pull request to. Linear sees the branch,
          the title, &ldquo;Fixes ENG-123&rdquo; in the description and links made in Linear.
        </li>
        <li>
          Then, keys like <code>ENG-123</code> in the title and, with team keys set, the branch name.
        </li>
      </ol>
      <p>
        Both count. Without the integration, linking by key still works. To add an issue by hand, paste its link or
        key in the Story check&rsquo;s <Ui>Add tickets</Ui>.
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <ul>
        <li>
          For each linked issue: the identifier, title, description, state, assignee, project name, sub-issues,
          the issues blocking it, the created and completed dates, and the newest 20 comments.
        </li>
        <li>
          <strong>Acceptance criteria</strong>: the sub-issues (completed ones ticked, cancelled ones left out), else
          a task list in the description, else an &ldquo;Acceptance criteria&rdquo; heading.
        </li>
        <li>
          <strong>Open points</strong>: an &ldquo;Open points&rdquo; or &ldquo;Open questions&rdquo; section of the
          description.
        </li>
        <li>
          <strong>For This Sprint</strong>: each team&rsquo;s active cycle, with its dates.
        </li>
      </ul>
      <p>Linear has no issue types, so story checks and settings treat every issue alike.</p>

      <H3 id="how-often-limn-reads">How often Limn reads</H3>
      <p>
        An open pull request&rsquo;s issues are read when it arrives and about every 30 minutes; its Linear links are
        checked about every 30 minutes too. The cycle is read about every 20 minutes while This Sprint is in use. Limn
        tracks Linear&rsquo;s rate limit for your key and waits before it gets close, so you never see a limit error.
        A workspace with 100 open pull requests stays far inside the limit.
      </p>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>Nothing. Limn does not change issues, states, cycles or comments in Linear.</p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'm', label: 'What you see' },
          { key: 'f', label: 'What to do' },
        ]}
        rows={[
          { _key: '1', m: 'Linear rejected this key. Save a new personal API key in Settings.', f: 'Create a new key in Linear and save it.' },
          {
            _key: '2',
            m: 'The connection check names a different workspace',
            f: 'The key is for another Linear workspace. Use a key from the workspace in the URL.',
          },
          { _key: '3', m: 'An issue cannot be read', f: 'Check that the key’s owner can see that team in Linear.' },
        ]}
      />
      <Tip>Moving the Workspace URL to another Linear workspace removes the saved key, so it is never sent to the wrong workspace.</Tip>
      <p>
        Where the key is kept: <DocLink to="security/data-and-storage">Data and storage</DocLink>.
      </p>
    </>
  );
}

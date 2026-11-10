import type { DocMeta } from '../../types';
import {
  DocLink,
  ExtLink,
  H2,
  H3,
  Illustration,
  MiniTable,
  Note,
  SettingsRow,
  Steps,
  TextBox,
  Tip,
  Ui,
  Warning,
} from '../../kit';

export const meta: DocMeta = {
  title: 'Jira',
  summary:
    'Connect Jira Cloud or Jira Data Center so story checks, reviews and This Sprint read your tickets, and use the two writes Limn makes only when you press.',
};

function JiraSettings(): JSX.Element {
  return (
    <Illustration
      label="Settings, Integrations, Issue tracker set to Jira, with a base URL, project keys, where to look, and the Jira API access email and token"
      caption="The Issue tracker section with Jira chosen."
      title="Settings"
      meta="Integrations"
    >
      <SettingsRow label="Provider" control={<TextBox value="Jira" />} />
      <SettingsRow label="Base URL" hint="Tickets link to {base}/browse/KEY-123." control={<TextBox value="https://acme.atlassian.net" mono />} />
      <SettingsRow label="Project keys" hint="Only keys with these prefixes count." control={<TextBox value="PAY, OPS" mono />} />
      <SettingsRow label="Where to look" control={<TextBox value="PR title and branch name (default)" />} />
      <SettingsRow label="Email" hint="Needed for Jira Cloud." control={<TextBox value="dana@acme.example" />} />
      <SettingsRow label="API token" hint="Saved" control={<TextBox value="••••••••" />} />
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        With Jira as a workspace&rsquo;s issue tracker, Limn links each pull request to the Jira tickets it names,
        reads those tickets, and uses them in the story check, the ticket view, This Sprint and the AI review&rsquo;s
        open points. Limn reads Jira with a token you save in Settings. It writes to Jira in exactly two places, and
        only when you press the button.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>Your Jira site&rsquo;s address, for example <code>https://acme.atlassian.net</code>.</li>
        <li>
          On <strong>Jira Cloud</strong>: your Atlassian account email and an API token. Create the token at{' '}
          <ExtLink href="https://id.atlassian.com/manage-profile/security/api-tokens">
            id.atlassian.com → Security → API tokens
          </ExtLink>
          .
        </li>
        <li>
          On <strong>Jira Data Center or Server</strong>: a personal access token, made from your Jira profile. Leave
          the email empty.
        </li>
      </ul>
      <p>
        The token acts as you. It needs to be able to browse the projects whose tickets you want Limn to read. To
        change a status from Limn, it also needs permission to transition those issues; to update a ticket&rsquo;s
        text, permission to edit them.
      </p>

      <H2 id="set-it-up">Set it up</H2>
      <Steps>
        <li>
          Open <Ui>Settings → Integrations</Ui>. Under <Ui>Issue tracker</Ui>, set <Ui>Provider</Ui> to{' '}
          <Ui>Jira</Ui>.
        </li>
        <li>
          Type the <Ui>Base URL</Ui>.
        </li>
        <li>
          Type your <Ui>Project keys</Ui>, comma-separated, for example <code>PAY, OPS</code>. Only keys with these
          prefixes count as tickets. This Sprint also uses them to find the open sprint.
        </li>
        <li>
          Choose <Ui>Where to look</Ui>: <Ui>PR title and branch name (default)</Ui> or <Ui>PR title only</Ui>.
        </li>
        <li>
          Under <Ui>Jira API access (optional)</Ui>, type your <Ui>Email</Ui> (Cloud only) and{' '}
          <Ui>API token</Ui>, and press <Ui>Check connection</Ui>.
        </li>
        <li>Save. Limn starts reading the tickets of open pull requests in the background.</li>
      </Steps>
      <JiraSettings />
      <Note>
        Without a token, Limn still finds ticket keys and links them to Jira, but it cannot read the tickets: no
        story check, no ticket text and no sprint. Each workspace has its own tracker. If another workspace already
        has Jira set up, use <Ui>Copy from another workspace</Ui>; the token is copied without passing through your
        browser, and later changes in either workspace do not affect the other.
      </Note>

      <H2 id="how-pull-requests-link-to-tickets">How pull requests link to tickets</H2>
      <ul>
        <li>
          Limn looks for keys like <code>PAY-142</code> in the pull request title and, with project keys set, in the
          branch name. Commit messages are never read.
        </li>
        <li>Without project keys, Limn looks in the title only, and is careful about things that look like keys but are not.</li>
        <li>
          You can add a ticket by hand from a pull request&rsquo;s Story check: open <Ui>Add tickets</Ui> and paste
          the ticket&rsquo;s link or key. Board links and issue links both work. See{' '}
          <DocLink to="story-checks/overview#when-the-pull-request-names-no-ticket">Story checks</DocLink>.
        </li>
      </ul>

      <H2 id="choose-the-ticket-fields">Choose the ticket fields</H2>
      <p>
        Jira sites often have several fields called &ldquo;Acceptance Criteria&rdquo;, and each issue type can use a
        different one. Once Limn has read some tickets, <Ui>Ticket fields</Ui> under the Issue tracker section lists
        each issue type with two menus:
      </p>
      <ul>
        <li>
          <Ui>Criteria</Ui>: the field that holds the acceptance criteria. <Ui>Limn picks</Ui> uses the field whose
          name best matches &ldquo;Acceptance Criteria&rdquo;.
        </li>
        <li>
          <Ui>Open points</Ui>: where the ticket&rsquo;s undecided points are. <Ui>Limn picks</Ui> uses a field
          named like &ldquo;Open points&rdquo;, else an &ldquo;Open points&rdquo; section of the description.{' '}
          <Ui>Description only</Ui> reads just that section.
        </li>
      </ul>
      <p>
        A change applies at once to every stored ticket of that type in the workspace. Until any ticket is read, the
        list says &ldquo;No Jira tickets read yet.&rdquo;
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <ul>
        <li>
          For each ticket a pull request names: the title, description, acceptance criteria, issue type, status,
          assignee, the tickets it is blocked by, the created and resolved dates, and the comments.
        </li>
        <li>For This Sprint: the open sprint&rsquo;s tickets in your projects, with their text and dates.</li>
        <li>
          The tickets that sprint tickets link to or mention, even outside the sprint, so the critical path can show
          what the sprint waits on.
        </li>
      </ul>

      <H3 id="how-often-limn-reads">How often Limn reads</H3>
      <MiniTable
        cols={[
          { key: 'w', label: 'What' },
          { key: 'h', label: 'When' },
        ]}
        rows={[
          { _key: 'a', w: "An open pull request's tickets", h: 'When the pull request arrives, then about every 30 minutes' },
          { _key: 'b', w: 'A ticket that could not be found or read', h: 'Again after about 6 hours' },
          { _key: 'c', w: "A merged pull request's tickets", h: 'Kept as they were when it merged' },
          { _key: 'd', w: 'The open sprint', h: 'About every 20 minutes, while someone has opened This Sprint in the last 7 days' },
          { _key: 'e', w: "A pull request's tickets, before its AI review", h: 'Read again, for the latest open points' },
          { _key: 'f', w: "A ticket's comments, before a story check", h: 'Read again' },
        ]}
      />
      <p>
        Opening a page in Limn never calls Jira, so pages stay fast and your Jira rate limit is spent only on
        background reads. Saving the tracker settings starts a read at once. If Jira refuses the token, Limn pauses reading for that workspace for 30
        minutes rather than retry again and again; saving a new token ends the pause at once.
      </p>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>Limn writes to Jira in exactly two places. Both happen only when you press, and neither is ever retried.</p>
      <H3 id="change-a-status">Change a status</H3>
      <p>
        In a ticket&rsquo;s <DocLink to="this-sprint/story-view#change-the-status-in-jira">story view</DocLink>, the
        status chip is a menu. Opening it asks Jira which statuses the ticket can move to; picking one makes that
        transition at once. Limn lists only transitions it can make without Jira&rsquo;s own form.
      </p>
      <H3 id="update-the-ticket">Update the ticket</H3>
      <p>
        When you plan a build with <DocLink to="implement-story/plan">Implement story</DocLink>, the plan can include
        a draft update to the ticket&rsquo;s description and criteria. You can edit it, then press{' '}
        <Ui>Update ticket</Ui>; Limn asks once before it replaces the text in Jira. The criteria go back into the
        same field Limn read them from.
      </p>
      <Warning>
        Both writes are made with the workspace&rsquo;s Jira token, so they show in Jira as made by that
        token&rsquo;s owner. Nothing else in Limn writes to Jira: no background job, no automation and no comment.
      </Warning>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'm', label: 'What you see' },
          { key: 'f', label: 'What to do' },
        ]}
        rows={[
          {
            _key: '1',
            m: 'Jira did not accept the saved token. Check the email and token in Settings.',
            f: 'Create a new API token and save it. On Data Center, leave the email empty.',
          },
          {
            _key: '2',
            m: 'Jira has no such ticket, or the saved token cannot see it.',
            f: "Check that the token's owner can open the ticket in Jira.",
          },
          {
            _key: '3',
            m: 'Jira answered with a redirect. Check the base URL in Settings is the Jira site itself.',
            f: 'Use the address of the Jira site, not a login or a proxy page.',
          },
          { _key: '4', m: 'Your Jira token cannot change this issue.', f: 'Ask a Jira admin for the Transition issues permission, or change it in Jira.' },
          { _key: '5', m: 'Jira offers no other status from here.', f: "The workflow has no transition you can make without Jira's own form." },
          {
            _key: '6',
            m: 'This Sprint shows no sprint',
            f: 'Set Project keys, and check that the project has an open sprint.',
          },
          {
            _key: '7',
            m: 'A pasted ticket is refused',
            f: "Limn reads only this workspace's Jira site. A ticket on another site needs that workspace's tracker.",
          },
        ]}
      />
      <Tip>
        Pointing the Base URL at a different Jira site removes the saved token, so a token is never sent to a site it
        was not made for. Save the token again after you move.
      </Tip>
      <p>
        Confluence pages on the same Atlassian site can use this Jira connection. See{' '}
        <DocLink to="integrations/confluence">Confluence</DocLink>. Where the token is kept is in{' '}
        <DocLink to="security/data-and-storage">Data and storage</DocLink>.
      </p>
    </>
  );
}

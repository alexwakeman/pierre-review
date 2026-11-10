import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, TextBox, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Integrations settings',
  summary: 'The issue tracker, the acceptance criteria field, SonarCloud and Slack.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Integrations</Ui> tab connects the current workspace to the services around your code: one issue
        tracker, SonarCloud and Slack. Every setting here applies to this workspace only. Each service has its own
        guide under Integrations; this page says what each section of the tab holds.
      </p>

      <H2 id="issue-tracker">Issue tracker</H2>
      <p>
        <Ui>Issue tracker</Ui> links each pull request to its tickets. Each workspace has its own tracker, or none.
        Choose a <Ui>Provider</Ui>: <Ui>None</Ui>, <Ui>Jira</Ui>, <Ui>GitHub Issues</Ui>, <Ui>Linear</Ui> or{' '}
        <Ui>Notion</Ui>.
      </p>
      <Illustration label="The issue tracker provider set to Jira, with project keys ENG and PAY." caption="An issue tracker set to Jira.">
        <SettingsRow label="Provider" control={<Pill tone="blue">Jira</Pill>} />
        <SettingsRow label="Project keys" hint="Only keys with these prefixes count." control={<TextBox value="PAY, ENG" mono />} />
        <SettingsRow label="Where to look" control={<Pill tone="grey">PR title and branch name (default)</Pill>} />
      </Illustration>
      <ul>
        <li>
          <Ui>GitHub Issues</Ui>: a pull request&rsquo;s tickets are the issues it closes (&ldquo;Fixes #12&rdquo;) or an
          issue linked in its Development panel. Nothing to set up. When a repository uses GitHub Issues and no choice
          is saved, Limn picks it automatically and says so. See{' '}
          <DocLink to="integrations/github-issues">GitHub Issues</DocLink>.
        </li>
        <li>
          <Ui>Jira</Ui>: enter your Jira site. A ticket key such as PAY-142 is found in the pull request title, and in
          the branch name if you choose. <Ui>Project keys</Ui> stop false matches such as GPT-4 or node-18; without
          them only the title is read. See <DocLink to="integrations/jira">Jira</DocLink>.
        </li>
        <li>
          <Ui>Linear</Ui>: enter your Linear workspace address. Issues that Linear&rsquo;s GitHub integration attached
          to the pull request are always found; other keys count only if their team is in <Ui>Team keys</Ui>. See{' '}
          <DocLink to="integrations/linear">Linear</DocLink>.
        </li>
        <li>
          <Ui>Notion</Ui>: tickets are the pages of one database, found by their Unique ID (such as ENG-123). Paste the
          database link, then map its properties. See <DocLink to="integrations/notion">Notion</DocLink>.
        </li>
      </ul>
      <p>
        <Ui>Where to look</Ui> is <Ui>PR title only</Ui> or <Ui>PR title and branch name (default)</Ui>. The branch is
        read only when you have set keys. Commit messages are never read.
      </p>
      <H3>Reading the tickets</H3>
      <p>
        To show a ticket&rsquo;s title, status, assignee, description and acceptance criteria, Limn needs read access:
      </p>
      <ul>
        <li>
          <Ui>Jira API access (optional)</Ui>: the <Ui>Email</Ui> and an <Ui>API token</Ui> (a Jira Cloud API token, or
          a Data Center personal access token with the email left blank). Select <Ui>Check connection</Ui>.
        </li>
        <li>
          <Ui>Personal API key</Ui> for Linear: create one in Linear under Settings → Security &amp; access. Read
          access is enough.
        </li>
        <li>
          <Ui>Integration token</Ui> for Notion: an internal integration with read content, read comments and read
          user information, shared with the database.
        </li>
        <li>GitHub Issues uses your GitHub sign-in.</li>
      </ul>
      <H3>Ticket fields</H3>
      <p>
        Jira sites often have several fields called &ldquo;Acceptance Criteria&rdquo;, and each issue type can use a
        different one. Once a token is saved, choose the field for each issue type. <Ui>Limn picks</Ui> uses the field
        whose name best matches. <Ui>Open points</Ui> are what the ticket left undecided; a review lists them with the
        code that depends on them, and they never block it. A change applies at once to every stored ticket of that
        type. See <DocLink to="story-checks/acceptance-criteria">Acceptance criteria</DocLink>.
      </p>
      <Note>
        When another workspace already has a tracker, <Ui>Copy from another workspace</Ui> copies its settings here.
      </Note>
      <Note title="What Limn writes to your tracker">
        Limn only reads trackers, with two exceptions on Jira, both made only when you press the button: changing a
        ticket&rsquo;s status, and updating a ticket from a plan.
      </Note>

      <H2 id="sonarcloud">SonarCloud</H2>
      <p>
        Feed SonarCloud&rsquo;s findings into AI Review and AI Fix. Create a token in SonarCloud under My Account →
        Security, then enter the <Ui>Organization key</Ui> and the token. Each repository&rsquo;s project key defaults
        to SonarCloud&rsquo;s own; type one only if yours differs. Select <Ui>Test connection</Ui>: each repository
        shows <Ui>Found</Ui> or <Ui>Not found</Ui>. Limn only reads. See{' '}
        <DocLink to="integrations/sonarcloud">SonarCloud</DocLink>.
      </p>

      <H2 id="slack">Slack</H2>
      <p>
        Sends this workspace&rsquo;s Pending board, a sprint summary, merges and auto reviews to a Slack channel.
      </p>
      <ul>
        <li>
          <Ui>Incoming webhook URL</Ui>: create one at api.slack.com/apps → Incoming Webhooks.
        </li>
        <li>
          <Ui>Cadence</Ui>: <Ui>Off (paused, channel kept)</Ui>, <Ui>Daily</Ui> or <Ui>Twice daily</Ui>, with{' '}
          <Ui>Send at</Ui> and <Ui>And at</Ui>.
        </li>
        <li>
          <Ui>Include a review-bot summary</Ui>: each review bot&rsquo;s comment count, the share your team used and the
          number left untouched.
        </li>
        <li>
          <Ui>Post when an auto review finishes</Ui> and <Ui>Post when a pull request merges</Ui>: off until you switch
          them on. Reviews you start yourself are never posted to Slack.
        </li>
        <li>
          <Ui>Send test</Ui> sends a message now.
        </li>
      </ul>
      <Warning>
        Only one person per channel should set this up. Limn runs on each person&rsquo;s computer, so each Limn posts
        its own copy.
      </Warning>
      <p>
        See <DocLink to="integrations/slack">Slack</DocLink>.
      </p>
      <Note>
        Every token and webhook is stored sealed on your computer and is never shown again. Removing or replacing one
        takes effect when you save.
      </Note>
    </>
  );
}

import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'GitHub Issues',
  summary:
    "Use GitHub Issues as the workspace's tracker, with no extra sign-in. Limn reads the issues each pull request closes, and GitHub Projects iterations or milestones for This Sprint.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        If your team keeps its tickets in GitHub Issues, Limn can use them as the workspace&rsquo;s tracker. There is
        nothing to type in: Limn reads issues with the same <code>gh</code> sign-in it uses for everything else. It
        only reads GitHub Issues; it never changes an issue.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          Your <code>gh</code> sign-in, which Limn already uses. It must be able to read the repositories that hold
          the issues.
        </li>
        <li>
          For GitHub Projects iterations on This Sprint: the <code>read:project</code> scope, which{' '}
          <code>gh auth login</code> does not give by default. Add it with <code>gh auth refresh -s read:project</code>
          .
        </li>
      </ul>

      <H2 id="set-it-up">Set it up</H2>
      <p>
        Often you do not need to. A workspace with no tracker chosen uses GitHub Issues by itself when one of its
        repositories has issues turned on and has linked an issue to a pull request in the last 90 days. Settings
        then shows the choice as <Ui>GitHub Issues (detected)</Ui> and says which repository caused it, for example
        &ldquo;Picked automatically: acme/payments uses GitHub Issues.&rdquo;
      </p>
      <Steps>
        <li>
          Open <Ui>Settings → Integrations</Ui>. Under <Ui>Issue tracker</Ui>, set <Ui>Provider</Ui> to{' '}
          <Ui>GitHub Issues</Ui>.
        </li>
        <li>Save. There are no other fields.</li>
      </Steps>
      <Illustration label="The Issue tracker section with GitHub Issues detected" caption="GitHub Issues needs nothing set up.">
        <SettingsRow label="Provider" control={<TextBox value="GitHub Issues (detected)" />} />
        <p className="muted">Uses the issues each PR closes or links. Nothing to set up.</p>
        <p className="muted">Picked automatically: acme/payments uses GitHub Issues.</p>
      </Illustration>
      <Note>To stop Limn using GitHub Issues, set Provider to <Ui>None</Ui> and save. A saved choice always wins over the automatic one.</Note>

      <H2 id="how-pull-requests-link-to-issues">How pull requests link to issues</H2>
      <p>Linking is exact: a pull request&rsquo;s tickets are the issues GitHub says it closes.</p>
      <ul>
        <li>
          &ldquo;Fixes #12&rdquo; or &ldquo;Closes acme/api#12&rdquo; in the pull request, including issues in other
          repositories.
        </li>
        <li>An issue linked in the pull request&rsquo;s Development panel.</li>
      </ul>
      <p>
        A bare &ldquo;#12&rdquo; is not a ticket, and the title and branch name are not read. You can also add an
        issue by hand: in the Story check, open <Ui>Add tickets</Ui> and paste <code>#12</code>,{' '}
        <code>acme/api#12</code> or the issue&rsquo;s link.
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <ul>
        <li>
          For each linked issue: the title, body, state (Open or Closed), issue type, first assignee, sub-issues,
          the issues it is blocked by, the created and closed dates, and the newest 20 comments.
        </li>
        <li>
          <strong>Acceptance criteria</strong>: the issue&rsquo;s sub-issues, else a task list in the body, else an
          &ldquo;Acceptance criteria&rdquo; heading. Without any, the whole body is the story and the check works
          criteria out from it.
        </li>
        <li>
          <strong>Open points</strong>: an &ldquo;Open points&rdquo; or &ldquo;Open questions&rdquo; section of the
          body.
        </li>
      </ul>

      <H3 id="the-sprint">The sprint</H3>
      <p>This Sprint takes the first of these that exists:</p>
      <ol>
        <li>
          The current iteration of a GitHub Projects board that holds this workspace&rsquo;s issues. The page is
          titled with the iteration&rsquo;s name and dates.
        </li>
        <li>The open milestone due soonest across the workspace&rsquo;s repositories (never an overdue one).</li>
        <li>Open issues edited in the reporting window.</li>
      </ol>
      <Tip>
        If your sign-in lacks <code>read:project</code>, This Sprint uses milestones and shows one line with the
        command to fix it. Nothing about your token is stored; the next read after <code>gh auth refresh</code>{' '}
        finds the iteration.
      </Tip>

      <H2 id="how-often-limn-reads">How often Limn reads</H2>
      <p>
        Limn reads which issues an open pull request closes when the pull request changes, and about every 30
        minutes while it is open. It reads each linked issue about every 30 minutes, and the sprint about every 20
        minutes while This Sprint is in use. These reads use your GitHub API allowance, a point or so each. When the
        allowance runs low, Limn waits rather than fail.
      </p>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>
        One thing, only when you pick it: the assignee. In a ticket&rsquo;s{' '}
        <DocLink to="this-sprint/story-view#assign-the-ticket">story view</DocLink>, the assignee is a menu of the
        people GitHub lets you assign in the issue&rsquo;s repository, and <Ui>Unassigned</Ui>. The person you pick
        becomes the issue&rsquo;s only assignee, set as you. Limn does not change an issue&rsquo;s status or labels:
        the status in the story view is shown, not changed, and a plan&rsquo;s draft ticket update can be copied but
        not written back.
      </p>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'm', label: 'What you see' },
          { key: 'f', label: 'What to do' },
        ]}
        rows={[
          {
            _key: '1',
            m: "Can't read this issue.",
            f: 'The issue is in a private repository your gh sign-in cannot read, or behind an SSO wall. Authorise the sign-in for that organisation.',
          },
          { _key: '2', m: 'A pull request shows no ticket', f: 'Add "Fixes #12" to its description, or link the issue in its Development panel.' },
          { _key: '3', m: 'This Sprint shows a milestone, not your iteration', f: 'Run gh auth refresh -s read:project.' },
        ]}
      />
      <p>
        More about how Limn uses your GitHub sign-in: <DocLink to="integrations/github">GitHub</DocLink>.
      </p>
    </>
  );
}

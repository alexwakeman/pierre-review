import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Note, Steps, Tip, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Troubleshooting',
  summary: 'What to check when sync stalls, a review will not start, sign-in fails or a page stays empty.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Most problems have a short message in the app or the terminal that names the cause. Find the message or the
        symptom below. Limn prints its own log in the terminal where you started it, which is the first place to look
        when something fails without a message.
      </p>

      <H2 id="limn-will-not-start">Limn will not start</H2>
      <H3>&ldquo;GitHub CLI not found or not authenticated.&rdquo;</H3>
      <Steps>
        <li>
          Install the GitHub CLI from <code>cli.github.com</code>.
        </li>
        <li>
          Run <code>gh auth login</code>, then <code>gh auth status</code> to check.
        </li>
        <li>Start Limn again.</li>
      </Steps>
      <H3>The port is already in use</H3>
      <p>
        Another program, or another copy of Limn, is using port 4000. Stop it, or start Limn on another port with{' '}
        <code>npx limn-review --port 4100</code>.
      </p>
      <H3>An old Node.js</H3>
      <p>
        Limn needs Node.js 22 or later. Check with <code>node --version</code>.
      </p>

      <H2 id="sync">Sync is slow or paused</H2>
      <H3>&ldquo;Paused — GitHub rate limit&rdquo;</H3>
      <p>
        GitHub limits how much each account can ask for in an hour. Limn waits instead of failing, and the line says
        when it will carry on. Nothing is lost; the sync resumes by itself. If you also run other tools on the same
        GitHub account, they share the same hourly allowance.
      </p>
      <H3>&ldquo;Waiting for another sync…&rdquo;</H3>
      <p>Limn syncs one repository at a time when you add several. The rest wait their turn.</p>
      <H3>The first sync takes a while</H3>
      <p>
        A new repository syncs the last 14 days first, so you can start work, then fills in the rest of the 90 days in
        the background. A busy repository with thousands of pull requests can take some time. Reports appears once a
        repository has finished its 90 days.
      </p>
      <H3>Something on GitHub has not shown up</H3>
      <p>
        Limn checks GitHub every few seconds for busy repositories and less often for quiet ones. A pull request you
        have open in Limn refreshes every few seconds. To force a full refresh of a repository, use its{' '}
        <Ui>Deep re-sync</Ui> button in <Ui>Manage repos &amp; workspaces</Ui>.
      </p>

      <H2 id="ai-not-ready">The AI features are not ready</H2>
      <H3>&ldquo;Setting up AI…&rdquo; or &ldquo;The download failed.&rdquo;</H3>
      <p>
        Limn downloads Claude and Codex the first time it starts. Wait for it to finish. If it failed, select{' '}
        <Ui>Retry</Ui> on the <DocLink to="settings/ai">AI</DocLink> tab, or run <code>limn ai install</code> in a
        terminal and read its message. <code>limn ai status</code> says whether it is set up. A firewall that blocks
        the npm registry stops the download.
      </p>
      <H3>&ldquo;Sign in to Claude Code or set ANTHROPIC_API_KEY.&rdquo;</H3>
      <p>
        Run <code>claude</code> in a terminal and sign in, or start Limn with an Anthropic API key. Restart Limn if you
        set the key after it started. See <DocLink to="integrations/claude">Claude (Anthropic)</DocLink>.
      </p>
      <H3>Codex reads &ldquo;Not signed in.&rdquo;</H3>
      <p>
        Select <Ui>Sign in with ChatGPT</Ui> on the AI tab, or run <code>limn ai login codex</code>. Your own Codex
        sign-in does not count: Limn uses its own. See <DocLink to="integrations/codex">Codex (OpenAI)</DocLink>.
      </p>
      <H3>The AI tabs and buttons are missing</H3>
      <p>
        Limn was started with the AI features turned off (<code>LIMN_AI_DISABLED=true</code>). Start it without that
        setting.
      </p>

      <H2 id="review-did-not-run">An automatic review did not run</H2>
      <ul>
        <li>
          Check that <Ui>Review new PRs automatically</Ui> is on for that workspace. It covers only pull requests opened
          after you turned it on.
        </li>
        <li>Drafts wait until they are marked ready. Pull requests opened by bots are skipped.</li>
        <li>The workspace may have reached its daily limit of auto reviews (20 by default). The rest run the next day (UTC).</li>
        <li>
          Limn may have used its share of your week: a message says when automatic runs resume. See{' '}
          <DocLink to="settings/ai-usage-and-spend#when-it-runs-out">When Limn&rsquo;s share is used</DocLink>.
        </li>
        <li>A teammate&rsquo;s Limn may already be reviewing that commit with the same provider.</li>
      </ul>
      <p>
        If a review ran but did not post, the AI Review tab says why and keeps the <Ui>Post</Ui> button. When a post
        reports that it is on GitHub but not visible yet, wait: it will show up shortly. Do not post it again.
      </p>

      <H2 id="sandbox">AI Fix or Implement will not start</H2>
      <H3>&ldquo;No container runtime is running on this computer.&rdquo;</H3>
      <Steps>
        <li>
          Install and start a container runtime: Colima on a Mac, Docker Engine or Podman on Linux, Docker Engine in WSL2
          on Windows.
        </li>
        <li>Give it at least 8 GB of memory.</li>
        <li>
          On the <DocLink to="settings/sandbox">Sandbox</DocLink> tab, select <Ui>Check again</Ui>.
        </li>
      </Steps>
      <p>
        To use Podman, start Limn with <code>SANDBOX_CLI=podman</code>. Step-by-step setup:{' '}
        <DocLink to="integrations/sandbox-runtimes">Docker and microsandbox</DocLink>.
      </p>
      <H3>A build in the sandbox cannot download packages</H3>
      <p>
        The sandbox reaches only allowed hosts. Open the session&rsquo;s <Ui>Network</Ui> list and select{' '}
        <Ui>Allow for this session</Ui> or <Ui>Always allow</Ui> on the blocked host.
      </p>
      <H3>The disk is filling up</H3>
      <p>
        Stop Limn and run <code>limn sandbox prune</code>. Add <code>--dry-run</code> to see what it would remove first.
      </p>
      <H3>Sandboxes keep running</H3>
      <p>
        A session with nothing to do closes after 15 minutes, and its sandbox goes with it. To stop them all now, select{' '}
        <Ui>Stop all</Ui> in <Ui>Settings → Sandbox</Ui>.
      </p>

      <H2 id="bot-scoring">Bot comment scoring</H2>
      <p>
        Scoring needs a one-time download of about 240 MB. Select <Ui>Set up (one-time ~240 MB download)</Ui> on the{' '}
        <DocLink to="settings/bots">Bots</DocLink> tab, or run <code>limn ml install</code>; <code>limn ml status</code>{' '}
        checks it. Scoring is slow on purpose so it never slows your computer, and it pauses while your computer is on
        battery, so a backlog of comments can take a while.
      </p>

      <H2 id="empty-pages">A page is empty or missing</H2>
      <ul>
        <li>
          <b>Everything is empty:</b> the current workspace may have no repositories. Add some, or switch workspace.
          See <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
        </li>
        <li>
          <b>Reports is missing:</b> it appears once your first repository has finished syncing 90 days.
        </li>
        <li>
          <b>This Sprint is missing:</b> it appears once a Jira, Linear or Notion tracker is set up, or Limn finds a
          GitHub milestone with a due date or a current Projects iteration.
        </li>
        <li>
          <b>A page you hid:</b> switch it back on in <DocLink to="settings/features">Features</DocLink>.
        </li>
        <li>
          <b>Tickets show no details:</b> the tracker needs read access. See{' '}
          <DocLink to="settings/integrations#issue-tracker">Integrations settings</DocLink>.
        </li>
      </ul>
      <Tip>Reloading the page fixes most display problems after Limn has been restarted.</Tip>
      <Note>
        Still stuck? Copy the message from the terminal and get in touch through the{' '}
        <a className="dx-link" href="/contact">contact form</a>.
      </Note>
    </>
  );
}

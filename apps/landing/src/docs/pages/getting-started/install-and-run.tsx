import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, H3, Illustration, Log, Note, Steps, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Install and run Ensemble',
  summary: 'Run Ensemble with one command, open it in your browser, and keep it up to date.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Ensemble is an npm package that you run on your own computer. One command starts it and opens the app in
        your browser. There is nothing to sign up for. You need Node.js and the GitHub CLI, signed in to the
        GitHub account whose repositories you want to follow.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          <b>Node.js 22 or later.</b> Check with <code>node --version</code>.
        </li>
        <li>
          <b>The GitHub CLI</b> (<code>gh</code>), installed from{' '}
          <ExtLink href="https://cli.github.com">cli.github.com</ExtLink> and signed in. Ensemble reads GitHub with
          the CLI's sign-in. It does not ask for, or store, a GitHub token of its own. See{' '}
          <DocLink to="integrations/github">GitHub</DocLink>.
        </li>
        <li>
          <b>Optional, for the AI features:</b> an Anthropic API key, or a ChatGPT sign-in for Codex. You can add these later. See <DocLink to="integrations/claude">Claude</DocLink>{' '}
          and <DocLink to="integrations/codex">Codex</DocLink>.
        </li>
      </ul>

      <H2 id="start-ensemble">Start Ensemble</H2>
      <Steps>
        <li>
          Sign in to the GitHub CLI, if you have not already: <code>gh auth login</code>.
        </li>
        <li>
          Run <code>npx ensemble-review</code> in a terminal.
        </li>
        <li>
          Wait for the address to show. Ensemble opens your browser at <code>http://localhost:4000/app</code>.
        </li>
        <li>
          Keep the terminal open. Ensemble runs while the command runs. Press <code>Ctrl</code>+<code>C</code> to
          stop it.
        </li>
      </Steps>

      <Illustration
        label="A terminal running npx ensemble-review, which prints the Ensemble banner and the local address."
        caption="The terminal after you start Ensemble."
      >
        <Log lines={['$ npx ensemble-review', '', '  ENSEMBLE', '  ▸ http://localhost:4000/app']} />
      </Illustration>

      <Note title="If your organisation uses single sign-on">
        For an organisation's repositories behind SAML single sign-on, you may need to give the GitHub CLI
        more access (<code>gh auth refresh -h github.com -s read:org</code>) and authorise the CLI for that
        organisation on GitHub.
      </Note>

      <H2 id="what-happens-the-first-time">What happens the first time</H2>
      <ul>
        <li>
          Ensemble makes its data folder, <code>~/.ensemble</code>, and its local database there.
        </li>
        <li>
          It reads your GitHub account through the GitHub CLI and suggests repositories you worked on
          recently. See <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
        </li>
        <li>
          In the background, it downloads Claude, the agent the AI features use (about 110 MB, one time). It does
          this after the app is open, so you do not wait for it. Signing in is the only step you do. To use Codex
          too, or instead, select its <Ui>Download</Ui> in Settings → AI.
        </li>
        <li>
          The model that scores review bot comments is a separate download (about 240 MB). It is downloaded
          only when you choose to set it up. See{' '}
          <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
        </li>
      </ul>

      <H2 id="options">Options</H2>
      <table>
        <thead>
          <tr>
            <th>Option</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>--port 4100</code>
            </td>
            <td>Listen on another port. The default is 4000.</td>
          </tr>
          <tr>
            <td>
              <code>--no-open</code>
            </td>
            <td>Do not open the browser.</td>
          </tr>
          <tr>
            <td>
              <code>--db &lt;path&gt;</code>
            </td>
            <td>Use a database file in another place.</td>
          </tr>
          <tr>
            <td>
              <code>--help</code>
            </td>
            <td>Show every option and command.</td>
          </tr>
        </tbody>
      </table>

      <H3>Commands</H3>
      <ul>
        <li>
          <code>npx ensemble-review status</code> prints your My Turn list in the terminal, with links. Add{' '}
          <code>--sync</code> to read GitHub first, or <code>--watch</code> to repaint it until you stop it.
        </li>
        <li>
          <code>npx ensemble-review ai login codex</code> signs Ensemble in to Codex with your ChatGPT account. Add{' '}
          <code>--device-auth</code> on a machine with no browser.
        </li>
        <li>
          <code>npx ensemble-review ai install claude</code> (or <code>codex</code>) and{' '}
          <code>npx ensemble-review ml install</code> download an AI agent or the comment-scoring model now.{' '}
          <code>npx ensemble-review ai remove claude</code> (or <code>codex</code>) deletes an agent.
        </li>
        <li>
          <code>npx ensemble-review review</code> asks the running Ensemble to review the branch you are on, before you
          push, and prints the result. <code>npx ensemble-review mcp</code> gives the same review to Claude Code or
          Codex as an MCP server. See <DocLink to="ai-review/local-branch">Review a local branch</DocLink>.
        </li>
      </ul>

      <Tip>
        Install it globally with <code>npm install -g ensemble-review</code>, then start it with <code>ensemble</code>.
      </Tip>

      <H2 id="set-up-the-rest">Set up the rest</H2>
      <p>
        Ensemble works as soon as you add repositories. Everything else is optional. Switch on the parts you want, in
        this order:
      </p>
      <Steps>
        <li>
          <b>Add your repositories.</b> Tick the ones Ensemble suggests, or search for any repository. See{' '}
          <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
        </li>
        <li>
          <b>Connect your AI agent</b> for AI Review, AI Fix and the chats. Start Ensemble with{' '}
          <code>ANTHROPIC_API_KEY</code> set, or sign in to Codex with your ChatGPT account in <Ui>Settings → AI</Ui>. See{' '}
          <DocLink to="integrations/claude">Claude</DocLink> and <DocLink to="integrations/codex">Codex</DocLink>.
        </li>
        <li>
          <b>Check the AI budget.</b> On an API key, there is no limit until you set a weekly budget in US dollars. On a
          ChatGPT plan, Ensemble may use 50% of your week for its automatic runs until you change it. See{' '}
          <DocLink to="settings/ai-usage-and-spend#spend-budget">The spend budget</DocLink>.
        </li>
        <li>
          <b>Add the scoring model</b> if your repositories use review bots. It scores each bot comment from nit to
          critical, on your machine. See <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
        </li>
        <li>
          <b>Connect your issue tracker</b> so reviews can check each pull request against its ticket. GitHub Issues
          needs nothing. See <DocLink to="integrations/jira">Jira</DocLink>,{' '}
          <DocLink to="integrations/linear">Linear</DocLink> and{' '}
          <DocLink to="integrations/github-issues">GitHub Issues</DocLink>.
        </li>
        <li>
          <b>Connect Slack</b> for a daily digest of the team&rsquo;s Pending board. See{' '}
          <DocLink to="integrations/slack">Slack</DocLink>.
        </li>
      </Steps>

      <H2 id="update-ensemble">Update Ensemble</H2>
      <p>
        <code>npx</code> can keep an older copy. To run the newest release, run{' '}
        <code>npx ensemble-review@latest</code>. If you installed it globally, run{' '}
        <code>npm install -g ensemble-review@latest</code>. Your data stays in <code>~/.ensemble</code>, and the
        database updates itself the next time Ensemble starts. The{' '}
        <DocLink to="changelog/changelog">Changelog</DocLink> says what each release changed. The version
        these docs describe is shown at the top of every docs page.
      </p>
      <Note title="Coming from Limn">
        Ensemble was called Limn. <code>npx limn-review</code> still works and starts Ensemble. On first start, an
        existing <code>~/.limn</code> folder is moved to <code>~/.ensemble</code>, with all your data.
      </Note>

      <Warning title="If Ensemble does not start">
        If the terminal says the SQLite driver did not install correctly, clear the npx cache and try again:{' '}
        <code>rm -rf ~/.npm/_npx &amp;&amp; npx ensemble-review@latest</code>. If it says the GitHub CLI is not
        found or not signed in, run <code>gh auth login</code>. More fixes are in{' '}
        <DocLink to="troubleshooting/troubleshooting">Troubleshooting</DocLink>.
      </Warning>
    </>
  );
}

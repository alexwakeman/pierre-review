import type { DocMeta } from '../../types';
import { DocLink, H2, H3 } from '../../kit';

export const meta: DocMeta = {
  title: 'Frequently asked questions',
  summary: 'Short answers about cost, privacy, AI providers, teams and what Limn needs to run.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Short answers to the questions people ask most. Each answer links to the page with the full story.
      </p>

      <H2 id="cost-and-licence">Cost and licence</H2>
      <H3>What does Limn cost?</H3>
      <p>
        Nothing, for individuals and for organisations where no more than three people use it. Every feature is
        included. Above three people, ask for a commercial licence. See{' '}
        <DocLink to="licence/licence">The Limn License</DocLink>.
      </p>
      <H3>Do the AI features cost extra?</H3>
      <p>
        Not from Limn. They run on your own Claude or ChatGPT plan, or your own Anthropic API key, so they use your
        plan&rsquo;s limits or your API bill. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
      </p>

      <H2 id="running-limn">Running Limn</H2>
      <H3>What do I need?</H3>
      <p>
        Node.js 22 or later, and the GitHub CLI signed in with <code>gh auth login</code>. Then run{' '}
        <code>npx limn-review</code>. See <DocLink to="getting-started/install-and-run">Install and run Limn</DocLink>.
      </p>
      <H3>Does it work with GitLab or Bitbucket?</H3>
      <p>No. Limn works with repositories on GitHub.com.</p>
      <H3>Does it work with private repositories?</H3>
      <p>Yes, any repository your own GitHub sign-in can read.</p>
      <H3>Do I need the AI features?</H3>
      <p>
        No. Pending, the Timeline, the Feed, Reports, merging and the conflict resolver work without AI. To turn the AI
        features off completely, start Limn with <code>LIMN_AI_DISABLED=true</code>.
      </p>
      <H3>Do I need Docker?</H3>
      <p>
        Only for AI Fix and Implement story, which run in a sandbox. They need a container runtime: Docker, Colima,
        Podman or microsandbox. Everything else runs without one. See{' '}
        <DocLink to="integrations/sandbox-runtimes">Docker and microsandbox</DocLink>.
      </p>
      <H3>Does Limn run when the browser is closed?</H3>
      <p>
        Yes, as long as the Limn program is running. It keeps syncing and running automatic work. When you stop the
        program, everything stops.
      </p>
      <H3>How do I get a newer version?</H3>
      <p>
        Run <code>npx limn-review@latest</code>. Your data in <code>~/.limn</code> is kept. What changed is in the{' '}
        <DocLink to="changelog/changelog">Changelog</DocLink>.
      </p>

      <H2 id="privacy">Privacy</H2>
      <H3>Does my code go to a Limn server?</H3>
      <p>
        No. There is no Limn server. Limn talks to GitHub, to the AI provider you choose and to the services you
        connect, straight from your computer. See <DocLink to="security/runs-on-your-machine">Limn runs on your computer</DocLink>
        .
      </p>
      <H3>Is my code used to train AI models?</H3>
      <p>
        That depends on your account with the provider, not on Limn. Under Anthropic&rsquo;s commercial terms (an API
        key, Team or Enterprise) it is not; on a personal Claude plan it depends on your training setting. See{' '}
        <DocLink to="settings/how-providers-treat-your-work">How Anthropic and OpenAI treat your work</DocLink>.
      </p>
      <H3>Does Limn store my GitHub token?</H3>
      <p>
        No. It asks the GitHub CLI for it when needed and keeps it in memory only. See{' '}
        <DocLink to="security/github-access">GitHub access</DocLink>.
      </p>

      <H2 id="ai">AI</H2>
      <H3>Claude or Codex?</H3>
      <p>
        Either, or both. With both signed in, Limn reviews each pull request with both and merges the results. See{' '}
        <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>
      <H3>Will Limn post on GitHub without asking me?</H3>
      <p>
        Only through switches you control. Auto review is off until you turn it on for a workspace; once it is on, its
        reviews are posted by default, and you can choose to keep them in Limn instead. Reviews you start yourself post
        only when you choose to. See <DocLink to="settings/ai-review">AI review settings</DocLink>.
      </p>
      <H3>Can the AI push code by itself?</H3>
      <p>
        Only if you switch on <code>Push automatically</code> for auto fixes on your own pull requests, or dependency
        automation for bots you trust. Both are off by default. Otherwise you press Push.
      </p>
      <H3>Will automatic reviews use up my plan?</H3>
      <p>
        Limn&rsquo;s automatic runs stop at a share of your week, 50% by default on a subscription. Your own runs are
        never refused.
      </p>

      <H2 id="teams">Teams</H2>
      <H3>Does each person need their own Limn?</H3>
      <p>
        Yes. Limn runs on each person&rsquo;s computer with their own GitHub and AI access. Teammates&rsquo; copies
        coordinate through small status lines on GitHub, so two people do not review the same commit with the same
        provider. See <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
      </p>
      <H3>Can an engineering manager use it without writing code?</H3>
      <p>
        Yes. Pending, This Sprint, Reports and Bots Monitoring are made for following the team&rsquo;s work. See{' '}
        <DocLink to="getting-started/introduction">What Limn is</DocLink>.
      </p>
      <H3>Can I group repositories by team?</H3>
      <p>
        Yes, with workspaces. Each repository belongs to one workspace. See{' '}
        <DocLink to="getting-started/workspaces">Group repositories into workspaces</DocLink>.
      </p>
    </>
  );
}

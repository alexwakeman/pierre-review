import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, H2, H3, Illustration, MiniTable, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Implement a story',
  summary: 'An agent builds the ticket in a sandbox from its story, your docs and your code.',
};

function StartPicture(): JSX.Element {
  return (
    <Illustration
      label="The build tab for ticket PAY-142, Partial refunds. The step line reads Set up, Talk, Build, Push. The start panel says the AI gets a sandbox with every repository in this workspace and the ticket, and plans first. A line says the agent also gets 23 memories from 2 projects, your CLAUDE.md and 3 project skills, with a Change link. A line says the agent also gets the workspace's reference documents. Boxes to approve the plan automatically and to review and fix after the build, then open the pull request, are not ticked. A Start button."
      caption="A new build tab: what the session gets, your memories and skills, the reference documents, the automatic boxes, the model and Start."
      title="PAY-142 Partial refunds"
      meta="Implement"
    >
      <p className="muted">
        <b>Set up</b> · Talk · Build · Push
      </p>
      <p>
        The AI gets a sandbox with every repository in this workspace and the ticket. It plans first. Nothing is built
        until you approve the plan.
      </p>
      <p className="muted">The agent also gets the workspace&rsquo;s reference documents. ⓘ</p>
      <p>
        <Chip>☐ Approve the plan automatically</Chip>
        <Chip>☐ After the build: review and fix, then open the pull request</Chip>
      </p>
      <p className="muted">Runs in Colima on this computer.</p>
      <p className="muted">
        The agent also gets 23 memories from 2 projects, your CLAUDE.md and 3 project skills. ⓘ <u>Change</u>
      </p>
      <p>
        <Chip>Model: Claude Opus 5.5 (most thorough)</Chip> <Btn tone="go">Start</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Implement story hands a ticket to an agent (Claude Code or Codex) that works in a sandbox on your computer. The
        sandbox holds every repository in the workspace, the ticket in full, your own Claude notes and the workspace&rsquo;s
        reference documents, which the agent uses only where they help. The agent first studies the code and proposes a plan; you settle its questions; then
        it builds, tests and reports against each acceptance criterion. You review the changes and push them as new pull
        requests.
      </p>

      <H2 id="where-to-start">Where to start</H2>
      <p>
        Open the ticket's story view: from the <Ui>This Sprint</Ui> tray, a ticket tab, or a pull request's{' '}
        <Ui>Ticket</Ui> tab. See <DocLink to="this-sprint/story-view">The story view</DocLink>.
      </p>
      <ul>
        <li>
          <Ui>Implement</Ui> is offered on a ticket that is not started or in progress and has no pull request.
        </li>
        <li>
          <Ui>Fill gaps</Ui> is offered instead on a ticket that is under way, when its current story check found gaps.
          See <DocLink to="implement-story/fill-gaps">Fill gaps</DocLink>.
        </li>
        <li>
          The caret on the button adds <Ui>Build end to end</Ui>: one press for the whole build. See{' '}
          <DocLink to="implement-story/overview#build-end-to-end">Build end to end</DocLink>.
        </li>
        <li>
          Once a session exists, the button reads <Ui>Open build</Ui> with its state, and the sprint card shows the same
          mark: <Ui>Working…</Ui>, <Ui>Waiting for you</Ui>, <Ui>Ready to push</Ui> or <Ui>Pushed</Ui>.
        </li>
      </ul>
      <p>
        The button opens a build tab, pinned so a reload keeps it. The command menu (<Ui>⌘K</Ui>) offers the same action
        while the ticket's story view is open.
      </p>
      <p>
        While a build runs, a hammer circle in the corner of the window shows its progress. A number on it counts the
        builds waiting for you: a plan to approve, a build to push, a paused review, a failure, or ticket changes to
        check. Open it and select a build to go to its tab.
      </p>

      <H2 id="the-four-steps">The four steps</H2>
      <StartPicture />
      <p>The tab's step line reads <Ui>Set up · Talk · Build · Push</Ui>.</p>
      <Steps>
        <li>
          <b>Set up.</b> Above <Ui>Start</Ui>, one line counts what the agent gets beside the code: your Claude
          memories and the projects they come from, your CLAUDE.md and the skills. <Ui>Change</Ui> opens Settings →
          Sandbox. Press <Ui>Start</Ui>. Limn starts the sandbox. It takes seconds once
          the sandbox image is on your computer; the first time it downloads it, which takes minutes. While the
          repositories load, the line counts them: <Ui>Loading repositories 3/7</Ui> and the repository&rsquo;s name.
        </li>
        <li>
          <b>Talk.</b> The agent reads the story, the code and the data, and submits a plan. Limn checks every piece of
          evidence in it. You answer each point to settle and talk to the agent; it does not change files yet. See{' '}
          <DocLink to="implement-story/plan">Plan the work</DocLink>.
        </li>
        <li>
          <b>Build.</b> <Ui>Approve and start</Ui> switches the agent to building. It writes the code, runs the
          repositories' own tests (integration tests too, against the services you picked) and reports per acceptance
          criterion. You can stop it or message it.
        </li>
        <li>
          <b>Push.</b> You review one diff per pull request and press <Ui>Push</Ui>. Limn pushes a new branch and opens a
          new pull request, a draft by default. Or tick <Ui>After the build: review and fix, then open the pull request</Ui>:
          Limn pushes the branch, reviews it in rounds while the agent answers every point, then opens the pull request,
          ready for review. See <DocLink to="implement-story/push#review-and-fix">Review and fix</DocLink>.
        </li>
      </Steps>
      <p>
        Tick <Ui>Approve the plan automatically</Ui> as well, and <Ui>Start</Ui> is the only press: Limn agrees with every
        change the plan proposes, builds it, reviews it and opens the pull request. The Start panel remembers both boxes.
        See <DocLink to="implement-story/plan#approve-automatically">Approve automatically</DocLink>.
      </p>
      <Warning>
        Nothing is pushed, posted or written to your tracker before you press a button, except the branch commits and the pull request you chose with{' '}
        <Ui>After the build: review and fix, then open the pull request</Ui>. The tracker is written only by{' '}
        <Ui>Update ticket</Ui> on a Jira ticket, which you press yourself, and by <Ui>Build end to end</Ui>, below.
      </Warning>

      <H2 id="build-end-to-end">Build end to end</H2>
      <p>
        <Ui>Build end to end</Ui>, from the caret on <Ui>Implement</Ui> or <Ui>Fill gaps</Ui>, runs the whole build
        from one press. The build tab opens and starts by itself:
      </p>
      <Steps>
        <li>The agent plans. Limn approves the plan, taking every open point as Agree.</li>
        <li>
          The agent builds. Limn reviews the work and the agent fixes it, for up to 4 rounds. It stops early when a round
          finds nothing open.
        </li>
        <li>
          Limn opens the pull request, ready for review. If something is still open after the last round, the pull
          request opens anyway and lists it.
        </li>
        <li>
          On a Jira ticket, Limn updates the description and acceptance criteria the plan changed, and comments on the
          ticket as you, in plain English for anyone who reads the ticket: links to the pull requests, a short summary
          of what changed and why, and the lines removed and added. It never changes the ticket&rsquo;s status. The earlier text is in the ticket&rsquo;s history
          in Jira.
        </li>
      </Steps>
      <p>
        If you are over your AI spend budget, or the AI is not signed in, the tab does not start by itself: it waits with
        a <Ui>Build end to end</Ui> button. <Ui>Set it up myself</Ui> goes back to the usual start. If the ticket update
        fails, the tab says so and <Ui>Update ticket</Ui> stays.
      </p>

      <H2 id="what-the-agent-gets">What the agent gets</H2>
      <MiniTable
        cols={[
          { key: 'w', label: 'In the sandbox' },
          { key: 'd', label: 'Details' },
        ]}
        rows={[
          { _key: 'r', w: 'Every repository in the workspace', d: 'At the same paths as your own clones, which Limn finds through the folders where you use Claude Code, so your Claude notes still apply. A repository outside the workspace is named and left out.' },
          { _key: 't', w: 'The ticket in full', d: 'Description, numbered acceptance criteria and open points.' },
          { _key: 'n', w: 'Your Claude notes', d: 'The notes of each repository’s clone (untick one in Settings → Sandbox), your CLAUDE.md and, if you allow, skills. Copied in; the originals are never changed. Each repository’s own CLAUDE.md and AGENTS.md are in its code. Past sessions are never brought in.' },
          { _key: 'k', w: 'Skills', d: 'Skills your repositories keep in .claude/skills come with the code, and the agent is told where each one is. Your own ~/.claude/skills come only if you allow it in Settings → Sandbox.' },
          { _key: 'd', w: 'Reference documents', d: 'When the workspace has them: the parts of the library that match the story, read only. The agent reads their index first and uses only what helps; the plan says which it used.' },
          { _key: 's', w: 'Services', d: 'The compose services you picked, for integration tests. The agent starts them when it needs them.' },
        ]}
      />
      <p>
        The agent has a shell inside the sandbox, but no GitHub credentials, no Docker access and no way to change your
        own files. Its only way to the network is Limn's allow-list; see{' '}
        <DocLink to="security/ai-and-the-sandbox">AI and the sandbox</DocLink>. Set up the folder, notes and services in{' '}
        <DocLink to="settings/sandbox">Settings → Sandbox</DocLink>.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          A container runtime on this computer. With none, the tab says so in one line with <Ui>How to set up</Ui>. See{' '}
          <DocLink to="integrations/sandbox-runtimes">Docker and microsandbox</DocLink>.
        </li>
        <li>Claude Code or Codex signed in.</li>
        <li>
          A tracker connected to the workspace, so the ticket and its criteria can be read. See{' '}
          <DocLink to="settings/integrations">Settings → Integrations</DocLink>.
        </li>
      </ul>

      <H2 id="limits">Limits</H2>
      <ul>
        <li>Two open sessions on this computer, shared with AI Fix; one of them builds at a time.</li>
        <li>A session with nothing to do closes after an hour. Its changes are kept; <Ui>Resume</Ui> starts it again.</li>
        <li>
          Turns start when you press something. The exception: a build that runs out of steps with work unfinished
          gets up to two automatic continuations, each of which asks your spend budget first. Every turn uses your own
          subscription or key, and the session's <Ui>Spend</Ui> panel shows what it has used.
        </li>
        <li>Settings → AI → Effort reaches the session's turns too.</li>
      </ul>
      <H3>Stop and discard</H3>
      <Note>
        <Ui>Stop</Ui> ends the current turn and keeps the session. <Ui>Discard</Ui> asks{' '}
        <Ui>Stop the agent and remove the sandbox?</Ui> and removes it; nothing is pushed.
      </Note>
    </>
  );
}

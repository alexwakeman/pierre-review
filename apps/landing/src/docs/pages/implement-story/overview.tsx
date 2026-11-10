import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, H2, H3, Illustration, MiniTable, Note, Steps, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Implement a story',
  summary: 'An agent builds the ticket in a sandbox from its story, your docs and your code.',
};

function StartPicture(): JSX.Element {
  return (
    <Illustration
      label="The build tab for ticket PAY-142, Partial refunds. The step line reads Set up, Talk, Build, Push. The start panel says the AI gets a sandbox with every repository in this workspace and the ticket, and plans first. A box to give the agent the reference documents is ticked. A Start with docs button."
      caption="A new build tab: what the session gets, the docs box, the model and Start."
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
      <p>
        <Chip>☑ Give the agent the reference documents</Chip>
      </p>
      <p className="muted">Runs in Colima on this computer.</p>
      <p>
        <Chip>Model: Claude Opus 5.5 (most thorough)</Chip> <Btn tone="go">Start with docs</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Implement story hands a ticket to an agent (Claude Code or Codex) that works in a sandbox on your computer. The
        sandbox holds every repository in the workspace, the ticket in full, your own Claude notes and, if you choose,
        your reference documents. The agent first studies the code and proposes a plan; you settle its questions; then
        it builds, tests and reports against each acceptance criterion. You review the changes and push them as new pull
        requests.
      </p>
      <WhoItHelps
        developer="Start a ticket from a tested first version, across every repository it touches, instead of an empty branch."
        manager="Stories that are clear enough to build get built; stories that are not get their gaps named, with evidence, before anyone writes code."
      />

      <H2 id="where-to-start">Where to start</H2>
      <p>
        Open the ticket's story view: from the <Ui>This Sprint</Ui> tray, a ticket tab, or a pull request's{' '}
        <Ui>Ticket</Ui> tab. See <DocLink to="this-sprint/story-view">The story view</DocLink>.
      </p>
      <ul>
        <li>
          <Ui>Implement</Ui> is offered on a ticket that has not started and has no pull request.
        </li>
        <li>
          <Ui>Fill gaps</Ui> is offered instead on a ticket that is under way, when its current story check found gaps.
          See <DocLink to="implement-story/fill-gaps">Fill gaps</DocLink>.
        </li>
        <li>
          When the workspace has reference documents, the caret on the button adds <Ui>Implement with docs</Ui>.
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

      <H2 id="the-four-steps">The four steps</H2>
      <StartPicture />
      <p>The tab's step line reads <Ui>Set up · Talk · Build · Push</Ui>.</p>
      <Steps>
        <li>
          <b>Set up.</b> Press <Ui>Start</Ui> (or <Ui>Start with docs</Ui>). Limn starts the sandbox. It takes seconds once
          the sandbox image is on your computer; the first time it downloads it, which takes minutes.
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
          new pull request, a draft by default. See <DocLink to="implement-story/push">Push the result</DocLink>.
        </li>
      </Steps>
      <Warning>
        Nothing is pushed, posted or written to your tracker before you press a button. The one tracker write is{' '}
        <Ui>Update ticket</Ui> on a Jira ticket, which you press yourself.
      </Warning>

      <H2 id="what-the-agent-gets">What the agent gets</H2>
      <MiniTable
        cols={[
          { key: 'w', label: 'In the sandbox' },
          { key: 'd', label: 'Details' },
        ]}
        rows={[
          { _key: 'r', w: 'Every repository in the workspace', d: 'At your own folder layout, so your Claude notes still apply. A repository outside the workspace is named and left out.' },
          { _key: 't', w: 'The ticket in full', d: 'Description, numbered acceptance criteria and open points.' },
          { _key: 'n', w: 'Your Claude notes', d: 'The notes you pick in Settings → Sandbox, your CLAUDE.md and, if you allow, skills. Copied in read only. Past sessions are never brought in.' },
          { _key: 'd', w: 'Reference documents', d: 'With docs: the parts of the workspace library that match the story, read only.' },
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

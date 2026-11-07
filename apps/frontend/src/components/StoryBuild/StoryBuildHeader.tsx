import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STORY_BUILD_ACTION_WORDS, type SprintGraphResponse, type StoryBuild, type StoryBuildAction } from '@pierre-review/shared';
import { sprintGraphKey } from '../../hooks/useSprintStories.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { storyBuildActionOf } from '../../lib/storyBuild.js';
import { sessionStatusLine, sessionSteps } from '../../lib/sandboxSession.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { InfoButton } from '../InfoModal.js';
import { TrackerLinkOut } from '../TrackerLinkOut.js';
import { cx } from '../ui/cx.js';
import { PageHeader } from '../ui/PageHeader.js';

// THE BUILD TAB'S HEADER: what the tab does ("Implement" or "Fill gaps", `storyBuildActionOf`), the
// ticket key, "Open ticket", "Open in <tracker>", the title, who runs it, what it cost so far (ONE
// formatter, `useRunCostText` — US$ on an API key, a share of the week on a subscription), the quiet
// step line ("Set up · Talk · Build · Push", the current step in words AND weight — never colour
// alone), the status sentence, and the end slot (Draft, Push all, Stop, Discard).

export function StoryBuildHeader({
  workspaceId,
  ident,
  ticketKey,
  title,
  build,
  error = null,
  offered = null,
  actions,
}: {
  workspaceId: number | null;
  ident: string;
  ticketKey: string;
  title: string | null;
  /** The open session (its `session` drawn from the stream when one is open), or null before a start. */
  build: StoryBuild | null;
  /** The stream's latest error line (a failed boot). */
  error?: string | null;
  /** What the story view offered when it opened the tab (used only with no sprint node in memory). */
  offered?: StoryBuildAction | null;
  actions?: ReactNode;
}): JSX.Element {
  const openStory = useOpenStory();
  const costText = useRunCostText();
  // The ticket's tracker link, from the sprint read already in memory (never a fetch of its own).
  const qc = useQueryClient();
  const node = qc.getQueryData<SprintGraphResponse>(sprintGraphKey(workspaceId))?.nodes.find((n) => n.ident === ident) ?? null;
  const session = build?.session ?? null;
  const steps = sessionSteps(session);
  const cost = session != null ? costText(session.spend.costUsd, session.provider ?? build?.provider ?? null) : null;
  const shownTitle = build?.ticketTitle ?? title ?? (node != null && node.title !== '' ? node.title : null);
  const action = storyBuildActionOf(build, node, offered);
  const fill = action === 'fill_gaps';
  return (
    // THE PAGE HEADER (components/ui/PageHeader.tsx): the ticket's title first, at the one page
    // title position, then what the tab does and the ticket, the steps and the status under it.
    <PageHeader
      inset={false}
      testId="story-build-header"
      title={shownTitle ?? ticketKey}
      info={
      <InfoButton title={fill ? 'Fill the gaps in this ticket' : 'Implement this ticket'}>
        <p>
          Limn starts a sandbox on this computer with every repository in this workspace, the ticket and your Claude notes for
          these folders. The AI there has a full shell, but no GitHub access and no route to the internet except the hosts the
          Network panel shows.
        </p>
        {fill ? (
          <p>It is told what the story check found missing, and works only on those gaps.</p>
        ) : (
          <p>Ask it anything first: a plan, a question, where to look. Nothing changes until you press Start build.</p>
        )}
        <p>
          Start build lets it change the code and run the tests. When it stops, each repository’s changes are shown here. Nothing
          is pushed until you press Push. Each push opens a new pull request, as a draft unless you untick Draft.
        </p>
      </InfoButton>
      }
      actions={actions}
      sub={
        <>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
        <span data-testid="story-build-action" data-action={action} className="font-semibold text-ui-ink">
          {STORY_BUILD_ACTION_WORDS[action]}
        </span>
        <span className="font-mono font-medium text-ui-mute">{ticketKey}</span>
        <button
          type="button"
          className="hit text-meta font-medium text-ui-ink hover:underline"
          onClick={() => openStory({ ident, key: ticketKey, title: shownTitle })}
        >
          Open ticket
        </button>
        {node != null && <TrackerLinkOut url={node.url} provider={node.provider} />}
      </div>
      <ol aria-label="Steps" data-testid="story-build-steps" className="mt-2 flex flex-wrap items-center gap-x-1.5 text-meta">
        {steps.map((s, i) => (
          <li key={s.word} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="decorative-mark text-ui-faint">
                ·
              </span>
            )}
            <span
              aria-current={s.state === 'current' ? 'step' : undefined}
              data-state={s.state}
              className={cx(
                s.state === 'current' ? 'font-semibold text-ui-ink underline underline-offset-4' : s.state === 'done' ? 'text-ui-ink' : 'text-ui-mute',
              )}
            >
              {s.word}
              {s.state === 'done' && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
      {build != null && session != null && (
        <p data-testid="story-build-status" data-phase={session.phase} className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ui-mute">
          <span>{sessionStatusLine(session, error ?? build.error)}</span>
          {session.model != null && (
            <>
              <span aria-hidden className="decorative-mark">
                ·
              </span>
              <AiRunLabel provider={session.provider ?? build.provider} model={session.model} />
            </>
          )}
          {cost != null && (
            <>
              <span aria-hidden className="decorative-mark">
                ·
              </span>
              <span data-testid="story-build-cost">{cost}</span>
            </>
          )}
        </p>
      )}
        </>
      }
    />
  );
}

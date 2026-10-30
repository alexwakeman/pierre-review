import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STORY_BUILD_ACTION_WORDS, type SprintGraphResponse, type StoryBuild } from '@pierre-review/shared';
import { sprintGraphKey } from '../../hooks/useSprintStories.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { storyBuildActionOf, storyBuildStatusLine, storyBuildSteps } from '../../lib/storyBuild.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { InfoButton } from '../InfoModal.js';
import { TrackerLinkOut } from '../TrackerLinkOut.js';
import { cx } from '../ui/cx.js';

// THE BUILD TAB'S HEADER: what the tab does ("Implement" or "Fill gaps", `storyBuildActionOf`), the ticket key, "Open story", "Open in <tracker>", the title, who ran it, what
// it cost so far (ONE formatter, `useRunCostText` — US$ on an API key, a share of the week on a
// subscription), the quiet step line ("Assess · Plan · Docs · Build · Push", the current step in words
// AND weight — never colour alone), the status sentence, and the end slot (Push all, Cancel).

export function StoryBuildHeader({
  workspaceId,
  ident,
  ticketKey,
  title,
  build,
  wantDocs,
  actions,
}: {
  workspaceId: number | null;
  ident: string;
  ticketKey: string;
  title: string | null;
  build: StoryBuild | null;
  /** Before a start: whether the reader ticked "Check against docs" (the step line shows Docs). */
  wantDocs: boolean;
  actions?: ReactNode;
}): JSX.Element {
  const openStory = useOpenStory();
  const costText = useRunCostText();
  // The ticket's tracker link, from the sprint read already in memory (never a fetch of its own).
  const qc = useQueryClient();
  const node = qc.getQueryData<SprintGraphResponse>(sprintGraphKey(workspaceId))?.nodes.find((n) => n.ident === ident) ?? null;
  const steps = storyBuildSteps(build, wantDocs);
  const cost = build != null ? costText(build.totalCostUsd, build.provider ?? null) : null;
  const shownTitle = build?.ticketTitle ?? title ?? (node != null && node.title !== '' ? node.title : null);
  const action = storyBuildActionOf(build, node);
  const fill = action === 'fill_gaps';
  return (
    <header data-testid="story-build-header" className="pt-5 max-md:pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
        <span data-testid="story-build-action" data-action={action} className="font-semibold text-ui-ink">
          {STORY_BUILD_ACTION_WORDS[action]}
        </span>
        <span className="font-mono font-medium text-ui-mute">{ticketKey}</span>
        <button
          type="button"
          className="hit text-meta font-medium text-ui-ink hover:underline"
          onClick={() => openStory({ ident, key: ticketKey, title: shownTitle })}
        >
          Open story
        </button>
        {node != null && <TrackerLinkOut url={node.url} provider={node.provider} />}
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-x-3 gap-y-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 break-words text-display text-ui-ink">
          <span className="min-w-0">{shownTitle ?? ticketKey}</span>
          <InfoButton title={fill ? 'Fill the gaps in this story' : 'Implement this story'}>
            {fill ? (
              <p>
                The story check found criteria the pull requests do not meet yet. The AI plans only those gaps, across up to four
                repositories, and builds each one on its own branch, in plan order. A criterion the check could not judge counts as a
                gap. You can change the plan by chat before anything is built.
              </p>
            ) : (
              <p>
                The AI reads the story and the code, writes a plan across up to four repositories, and builds each one on its own
                branch, in plan order. You can change the plan by chat before anything is built.
              </p>
            )}
            <p>Nothing is pushed until you press Push. Each push opens a new pull request, as a draft unless you untick Draft.</p>
            <p>
              If you ask it to check the docs, the story wins: where the docs say something else, the point is listed as
              changed by the story, never as a fix to the story.
            </p>
            <p>The AI has no shell. It can run the project&rsquo;s own tests only when you tick Run tests.</p>
          </InfoButton>
        </h2>
        {actions != null && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
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
      {build != null && (
        <p data-testid="story-build-status" className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ui-mute">
          <span>{storyBuildStatusLine(build)}</span>
          {build.model != null && (
            <>
              <span aria-hidden className="decorative-mark">
                ·
              </span>
              <AiRunLabel provider={build.provider} model={build.model} />
            </>
          )}
          {cost != null && (
            <>
              <span aria-hidden className="decorative-mark">
                ·
              </span>
              <span>{cost}</span>
            </>
          )}
        </p>
      )}
    </header>
  );
}

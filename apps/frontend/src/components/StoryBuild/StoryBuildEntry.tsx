import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STORY_BUILD_MARK_WORDS, type SprintGraphNode, type SprintGraphResponse, type TicketReviewState } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { sprintGraphKey } from '../../hooks/useSprintStories.js';
import { useStoryBuildFor } from '../../hooks/useStoryBuild.js';
import { useTicketReviewById } from '../../hooks/useTicketReview.js';
import type { CardTicket } from '../../lib/cardTickets.js';
import {
  sprintNodeBuildOf,
  storyBuildActionLabel,
  storyStageOfCategory,
  storyViewBuildEntry,
  storyViewCheck,
  type StoryViewBuildEntry,
} from '../../lib/storyBuild.js';
import { useOpenStoryBuild } from '../../lib/storyBuildTab.js';
import { useFilters } from '../../store/filters.js';
import { BuildIcon, FillGapsIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { useRegisterCommands, type Command } from '../ui/commands.js';

// "IMPLEMENT STORY"'S ENTRY (docs/STORY-BUILD.md § Entry points): the STORY VIEW's primary action —
// "Implement" on a not-started story with no pull request, "Fill gaps" on a started one whose current
// story check found gaps (shared `storyBuildOffered`, the ONE gate), "Open build · <mark>" once a session
// is open. It sits first in the story's action group (TicketStorySection `StoryActions`: the rail's
// actions in the two-column layout, the Story heading row otherwise), in EVERY story view — This
// Sprint's tray, the story tab and the PR view's Story tab — and registers the same action in ⌘K.
// Opens the build tab through `useOpenStoryBuild` (the one opener); never starts anything. Hidden, never
// disabled, unless `me.ai.enabled`.
//
//   INPUTS   This Sprint's tray hands in the board's NODE (`StoryBuildEntryFacts.sprintNode`): the gate
//            reads it as the card did, and nothing is fetched. Elsewhere the view's own facts stand in:
//            the stage from the sprint graph already in memory (never fetched here), else the tracker
//            status CATEGORY (`storyStageOfCategory`); every PR the view lists; the check from the
//            view's ticket-check state and its latest run (the Story section reads that run already —
//            same query key); and the session from ONE cheap DB read, GET /api/story-builds?ident=.
//            Nothing shows until that read answers, so Implement never flashes over an open build.

/** What the story view knows that the Story section does not: the board's node (the tray) and the PR count. */
export interface StoryBuildEntryFacts {
  sprintNode: SprintGraphNode | null;
  /** Every PR the view lists for the ticket (open, merged and closed — the node's `prs`). */
  prTotal: number;
}

const StoryBuildEntryContext = createContext<StoryBuildEntryFacts | null>(null);

export function StoryBuildEntryProvider({ facts, children }: { facts: StoryBuildEntryFacts; children: ReactNode }): JSX.Element {
  return <StoryBuildEntryContext.Provider value={facts}>{children}</StoryBuildEntryContext.Provider>;
}

export function StoryBuildEntry({ ticket, state }: { ticket: CardTicket & { ident: string }; state: TicketReviewState | undefined }): JSX.Element | null {
  const aiOn = useAiCapabilities().enabled;
  const facts = useContext(StoryBuildEntryContext);
  if (!aiOn || facts == null) return null;
  return <Entry ticket={ticket} state={state} facts={facts} />;
}

function Entry({
  ticket,
  state,
  facts,
}: {
  ticket: CardTicket & { ident: string };
  state: TicketReviewState | undefined;
  facts: StoryBuildEntryFacts;
}): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const node = facts.sprintNode != null && facts.sprintNode.ident === ticket.ident ? facts.sprintNode : null;
  const qc = useQueryClient();
  // Without the board's node: the session (one DB read) and the latest check run (already being read by the Story section).
  const buildQ = useStoryBuildFor(node == null ? workspaceId : null, node == null ? ticket.ident : null);
  const runQ = useTicketReviewById(node == null ? (state?.latestRunId ?? null) : null);
  const openBuild = useOpenStoryBuild();

  let entry: StoryViewBuildEntry = null;
  if (node != null) entry = storyViewBuildEntry({ ...node, build: node.build ?? null, check: node.check ?? null });
  else if (buildQ.data != null) {
    const cached = qc.getQueryData<SprintGraphResponse>(sprintGraphKey(workspaceId))?.nodes.find((n) => n.ident === ticket.ident) ?? null;
    entry = storyViewBuildEntry({
      ghost: cached?.ghost ?? false,
      stage: cached != null ? cached.stage : storyStageOfCategory(ticket.statusCategory),
      prs: Array.from({ length: facts.prTotal }),
      build: sprintNodeBuildOf(buildQ.data.build),
      check: storyViewCheck(state, runQ.data),
    });
  }

  const title = ticket.title != null && ticket.title !== '' ? ticket.title : null;
  const open = (): void => {
    openBuild({
      ident: ticket.ident,
      key: ticket.key,
      title,
      ...(entry?.kind === 'offer' ? { offer: { action: entry.action, reviewId: entry.reviewId } } : {}),
    });
  };
  const live = useRef(open);
  live.current = open;

  const words =
    entry == null
      ? null
      : entry.kind === 'open'
        ? { label: `Open ${ticket.key}'s build: ${STORY_BUILD_MARK_WORDS[entry.mark]}`, title: 'Open the build' }
        : storyBuildActionLabel(entry.action, ticket.key);
  const icon = entry?.kind === 'offer' && entry.action === 'fill_gaps' ? <FillGapsIcon size={12} /> : <BuildIcon size={12} />;
  const commandKind = entry == null ? null : entry.kind === 'open' ? `open:${entry.mark}` : entry.action;
  const label = words?.label ?? null;

  // ⌘K: the same action, while this story view is on screen.
  const commands = useMemo<Command[] | null>(() => {
    if (label == null || commandKind == null) return null;
    const fill = commandKind === 'fill_gaps';
    return [
      {
        id: `story-build:${ticket.ident}`,
        group: 'Actions',
        title: title != null ? `${label} · ${title}` : label,
        keywords: fill ? ['build', 'story', 'code', 'gaps', 'fill'] : ['build', 'story', 'code', 'implement'],
        icon: fill ? <FillGapsIcon size={14} /> : <BuildIcon size={14} />,
        run: () => live.current(),
      },
    ];
  }, [label, commandKind, ticket.ident, title]);
  useRegisterCommands(`story-build-entry:${ticket.ident}`, commands);

  if (entry == null || words == null) return null;
  return (
    <Button
      variant="primary"
      size="sm"
      icon={icon}
      data-testid="story-build-entry"
      data-action={entry.kind === 'open' ? 'open' : entry.action}
      aria-label={words.label}
      title={words.title}
      onClick={open}
    >
      {entry.kind === 'open' ? (
        <>
          Open build<span className="font-normal"> · {STORY_BUILD_MARK_WORDS[entry.mark]}</span>
        </>
      ) : entry.action === 'fill_gaps' ? (
        'Fill gaps'
      ) : (
        'Implement'
      )}
    </Button>
  );
}

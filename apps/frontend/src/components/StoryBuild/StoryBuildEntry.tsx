import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  STORY_BUILD_END_TO_END_LABEL,
  STORY_BUILD_MARK_WORDS,
  storyBuildClaimClearable,
  storyBuildClaimLine,
  type SprintGraphNode,
  type SprintGraphResponse,
  type StoryBuildTeamClaim,
  type TicketReviewState,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { sprintGraphKey } from '../../hooks/useSprintStories.js';
import { useClearStoryBuildClaim, useStoryBuildClaim, useStoryBuildFor } from '../../hooks/useStoryBuild.js';
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
import { requestEndToEndStart, useOpenStoryBuild } from '../../lib/storyBuildTab.js';
import { useFilters } from '../../store/filters.js';
import { RocketIcon, WrenchIcon, FillGapsIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import type { MenuEntry } from '../ui/Menu.js';
import { SplitButton } from '../ui/SplitButton.js';
import { useRegisterCommands, type Command } from '../ui/commands.js';

// "IMPLEMENT STORY"'S ENTRY (docs/STORY-BUILD.md § Entry points): the STORY VIEW's primary action —
// "Implement" on a not-started story with no pull request, "Fill gaps" on a started one whose current
// story check found gaps — each a SPLIT BUTTON whose menu adds "Build end to end" (docs/STORY-BUILD.md
// § Build end to end: the tab opens AND starts — the plan approved automatically, the review loop, then the
// Jira ticket updated and commented on) (shared `storyBuildOffered`, the ONE gate), "Open build · <mark>"
// once a session is open. (The reference documents are no longer a choice: every session gets them when
// the library has one, and the agent decides whether they help.) It sits first in the story's action group (TicketStorySection `StoryActions`: the rail's
// actions in the two-column layout, the Story heading row otherwise), in EVERY story view — This
// Sprint's tray, the story tab and the PR view's Story tab — and registers the same action in ⌘K.
// Opens the build tab through `useOpenStoryBuild` (the one opener); only "Build end to end" starts, through
// the tab's own start (`requestEndToEndStart`). Hidden, never disabled, unless `me.ai.enabled`.
//
//   INPUTS   This Sprint's tray hands in the board's NODE (`StoryBuildEntryFacts.sprintNode`): the gate
//            reads it as the card did, and nothing is fetched. Elsewhere the view's own facts stand in:
//            the stage from the sprint graph already in memory (never fetched here), else the tracker
//            status CATEGORY (`storyStageOfCategory`); every PR the view lists; the check from the
//            view's ticket-check state and its latest run (the Story section reads that run already —
//            same query key); and the session from ONE cheap DB read, GET /api/story-builds?ident=.
//            Nothing shows until that read answers, so Implement never flashes over an open build.
//   THE TEAM CLAIM (docs/STORY-BUILD.md § The team claim): only when the gate would offer Implement / Fill
//            gaps, ONE more read — GET /api/story-builds/claim, the ticket branch on GitHub — and a teammate's
//            claim (or the reader's own on another computer) shows "<login> is building this" instead of the
//            button, with Clear once the claim lapsed (at once for the reader's own). The button waits for that
//            read too; a failed read shows the button (the start re-checks on the server).

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

export function StoryBuildEntry({
  ticket,
  state,
}: {
  ticket: CardTicket & { ident: string };
  state: TicketReviewState | undefined;
}): JSX.Element | null {
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

  let inputs: Parameters<typeof storyViewBuildEntry>[0] | null = null;
  if (node != null) inputs = { ...node, build: node.build ?? null, check: node.check ?? null };
  else if (buildQ.data != null) {
    const cached = qc.getQueryData<SprintGraphResponse>(sprintGraphKey(workspaceId))?.nodes.find((n) => n.ident === ticket.ident) ?? null;
    inputs = {
      ghost: cached?.ghost ?? false,
      stage: cached != null ? cached.stage : storyStageOfCategory(ticket.statusCategory),
      prs: Array.from({ length: facts.prTotal }),
      build: sprintNodeBuildOf(buildQ.data.build),
      check: storyViewCheck(state, runQ.data),
    };
  }
  const base: StoryViewBuildEntry = inputs != null ? storyViewBuildEntry(inputs) : null;
  // The team claim: asked only when the gate would offer a build.
  const wantsClaim = base?.kind === 'offer';
  const claimQ = useStoryBuildClaim(workspaceId, ticket.ident, wantsClaim);
  const claimPending = wantsClaim && claimQ.isPending && claimQ.fetchStatus !== 'idle';
  const entry: StoryViewBuildEntry =
    claimPending ? null : wantsClaim && inputs != null && claimQ.data?.claim != null ? storyViewBuildEntry({ ...inputs, claim: claimQ.data.claim }) : base;

  const title = ticket.title != null && ticket.title !== '' ? ticket.title : null;
  const open = (endToEnd = false): void => {
    // "Build end to end": the tab's start state starts the session as it opens (one-shot, in memory).
    if (endToEnd && entry?.kind === 'offer') requestEndToEndStart(ticket.ident);
    openBuild({
      ident: ticket.ident,
      key: ticket.key,
      title,
      ...(entry?.kind === 'offer' ? { offer: { action: entry.action, reviewId: entry.reviewId, ...(endToEnd ? { endToEnd: true } : {}) } } : {}),
    });
  };
  const live = useRef(open);
  live.current = open;
  const canEndToEnd = entry?.kind === 'offer';

  const words =
    entry == null || entry.kind === 'claimed'
      ? null
      : entry.kind === 'open'
        ? { label: `Open ${ticket.key}'s build: ${STORY_BUILD_MARK_WORDS[entry.mark]}`, title: 'Open the build' }
        : storyBuildActionLabel(entry.action, ticket.key);
  const icon = entry?.kind === 'offer' && entry.action === 'fill_gaps' ? <FillGapsIcon size={12} /> : <WrenchIcon size={12} />;
  const commandKind = entry == null || entry.kind === 'claimed' ? null : entry.kind === 'open' ? `open:${entry.mark}` : entry.action;
  const label = words?.label ?? null;

  // ⌘K: the same action, while this story view is on screen.
  const commands = useMemo<Command[] | null>(() => {
    if (label == null || commandKind == null) return null;
    const fill = commandKind === 'fill_gaps';
    const keywords = fill ? ['build', 'story', 'code', 'gaps', 'fill'] : ['build', 'story', 'code', 'implement'];
    const icon = fill ? <FillGapsIcon size={14} /> : <WrenchIcon size={14} />;
    const out: Command[] = [
      { id: `story-build:${ticket.ident}`, group: 'Actions', title: title != null ? `${label} · ${title}` : label, keywords, icon, run: () => live.current() },
    ];
    if (canEndToEnd) {
      const e2e = `${STORY_BUILD_END_TO_END_LABEL}: ${ticket.key}`;
      out.push({
        id: `story-build-e2e:${ticket.ident}`,
        group: 'Actions',
        title: title != null ? `${e2e} · ${title}` : e2e,
        keywords: [...keywords, 'end to end', 'one click', 'automatic'],
        icon: <RocketIcon size={14} />,
        run: () => live.current(true),
      });
    }
    return out;
  }, [label, commandKind, ticket.ident, ticket.key, title, canEndToEnd]);
  useRegisterCommands(`story-build-entry:${ticket.ident}`, commands);

  if (entry?.kind === 'claimed') return <ClaimedLine claim={entry.claim} workspaceId={workspaceId} ident={ticket.ident} />;
  if (entry == null || words == null) return null;
  if (entry.kind === 'open') {
    return (
      <Button
        variant="primary"
        size="sm"
        icon={icon}
        data-testid="story-build-entry"
        data-action="open"
        aria-label={words.label}
        title={words.title}
        onClick={() => open()}
      >
        Open build<span className="font-normal"> · {STORY_BUILD_MARK_WORDS[entry.mark]}</span>
      </Button>
    );
  }
  // "Implement" / "Fill gaps", and beside it the menu with "Build end to end" (it starts as the tab opens).
  const verb = entry.action === 'fill_gaps' ? 'Fill gaps' : 'Implement';
  const items: MenuEntry[] = [
    { id: 'plain', label: verb, icon, onSelect: () => open() },
    {
      id: 'end-to-end',
      label: STORY_BUILD_END_TO_END_LABEL,
      icon: <RocketIcon size={12} />,
      onSelect: () => open(true),
    },
  ];
  return (
    <SplitButton
      icon={icon}
      data-testid="story-build-entry"
      data-action={entry.action}
      aria-label={words.label}
      title={words.title}
      menuLabel={entry.action === 'fill_gaps' ? 'More ways to fill the gaps' : 'More ways to implement'}
      menuTestId="story-build-entry-menu"
      items={items}
      onPrimary={() => open()}
    >
      {verb}
    </SplitButton>
  );
}

/** "<login> is building this", with Clear once the claim lapsed (at once for the reader's own). */
function ClaimedLine({ claim, workspaceId, ident }: { claim: StoryBuildTeamClaim; workspaceId: number | null; ident: string }): JSX.Element {
  const clear = useClearStoryBuildClaim(workspaceId, ident);
  const since = new Date(claim.since);
  const at = Number.isFinite(since.getTime()) ? since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <span className="inline-flex items-center gap-2" data-testid="story-build-claim" data-live={claim.live ? 'true' : 'false'}>
      <span className="text-meta text-ui-mute" title={at != null ? `Since ${at}, on ${claim.repo}` : `On ${claim.repo}`}>
        {storyBuildClaimLine(claim)}
      </span>
      {storyBuildClaimClearable(claim) ? (
        <Button size="sm" data-testid="story-build-claim-clear" busy={clear.isPending} onClick={() => clear.mutate()} title="Free this ticket so it can be built here">
          Clear
        </Button>
      ) : null}
      {clear.error != null ? <span className="text-meta text-ui-danger">{clear.error instanceof Error ? clear.error.message : 'Clear failed.'}</span> : null}
    </span>
  );
}

import { useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { STORY_BUILD_PUSH_DRAFT_DEFAULT, type StoryBuild, type StoryBuildSession } from '@pierre-review/shared';
import {
  storyBuildMutationKey,
  useStoryBuildDiscard,
  useStoryBuildFor,
  useStoryBuildPush,
  useStorySessionInterrupt,
  useStorySessionStream,
} from '../../hooks/useStoryBuild.js';
import { pushAllOffered } from '../../lib/storyBuild.js';
import { planApproveState, pushAllPrCount } from '../../lib/buildPlan.js';
import { mergeSessionViews, sessionCanDiscard, sessionCanStartBuild, sessionClosedForGood, sessionTurnRunning } from '../../lib/sandboxSession.js';
import { parseStoryBuildTabKey, ticketKeyOfIdent, usePinnedTabs, type TabTicketMeta } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { useMe } from '../../hooks/useTriage.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { WrenchIcon, CloseIcon, PullRequestIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { useRegisterCommands, type Command } from '../ui/commands.js';
import { PAGE_GUTTER } from '../ui/PageHeader.js';
import { BuildSection } from './BuildSection.js';
import { PlanPanel } from './PlanPanel.js';
import { StackView } from './StackView.js';
import { SessionView } from './SessionView.js';
import { StartPanel } from './StartPanel.js';
import { AutoPushLine } from './AutoPushOption.js';
import { StoryBuildHeader } from './StoryBuildHeader.js';
import { StoryBuildSection } from './StoryBuildSection.js';

// THE BUILD TAB ("Implement story" as a WORKSPACE SESSION; docs/SANDBOX.md § Sessions, docs/FRONTEND.md
// § The build tab): the active tab's ticket, `story-build:<ident>`, opened ONLY through
// `useOpenStoryBuild` (lib/storyBuildTab.ts). One query holds the ticket's latest session
// (`useStoryBuildFor`) and, while its sandbox runs, ONE SSE stream follows it (`useStorySessionStream`,
// folded by lib/sandboxSession.ts; `mergeSessionViews` puts the two together). Top to bottom: the
// header (steps, status, cost; Draft, Push all, Stop, Discard), then the start state OR the session —
// the boot, then (plan first) the PLAN PANEL, the conversation beside the rail — and the changes with
// Push: per planned pull request (StackView) once a plan was approved, else per repository. Nothing
// changes before the plan is approved (Start build on an older session) and nothing is pushed before Push —
// unless the reader ticked "Push and open the pull request when the build finishes" (`AutoPushLine`, under
// the header: the switch until the build pushed, then the automatic push's outcome).

export function StoryBuildTabView(): JSX.Element | null {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const ident = parseStoryBuildTabKey(activeTab);
  const meta = tabs.find((t) => t.key === activeTab)?.ticketMeta ?? null;
  const workspaceId = useFilters((s) => s.workspaceId);
  // An AI surface (`me.ai.enabled`): with AI off the routes are not registered, so ask nothing.
  const me = useMe();
  const aiOn = useAiCapabilities().enabled;
  if (ident == null) return null;
  return (
    <div data-testid="story-build-tab-view" className={`max-w-6xl pb-10 ${PAGE_GUTTER}`}>
      {workspaceId == null || me.data == null ? (
        <p className="pt-5 text-meta text-ui-mute">Loading…</p>
      ) : !aiOn ? (
        <p className="pt-5 text-meta text-ui-mute">AI is off on this machine.</p>
      ) : (
        <StoryBuildBody
          workspaceId={workspaceId}
          ident={ident}
          ticketKey={meta?.key ?? ticketKeyOfIdent(ident)}
          title={meta?.title ?? null}
          offer={meta?.buildOffer ?? null}
        />
      )}
    </div>
  );
}

function StoryBuildBody({
  workspaceId,
  ident,
  ticketKey,
  title,
  offer,
}: {
  workspaceId: number;
  ident: string;
  ticketKey: string;
  title: string | null;
  /** What the story view offered when it opened this tab (`TabTicketMeta.buildOffer`). */
  offer: TabTicketMeta['buildOffer'];
}): JSX.Element {
  const q = useStoryBuildFor(workspaceId, ident);
  const read = q.data?.build ?? null;
  const live = read?.session?.live === true;
  const stream = useStorySessionStream(workspaceId, ident, read?.id ?? null, live);
  const session = read != null ? mergeSessionViews(read.session, live || stream.done ? stream.session : null) : null;
  const build: StoryBuild | null = read != null ? { ...read, session } : null;
  // A row of the OLD plan/build flow (no `session`) or a failed / discarded session: the start state.
  const closed = build != null && sessionClosedForGood(build);
  // Push as a draft by default (owner decision 2); one toggle for every push of this session.
  const [draft, setDraft] = useState(STORY_BUILD_PUSH_DRAFT_DEFAULT);
  const open = build != null && !closed && session != null ? { build, session } : null;
  // An old-flow row with patches still ready can be pushed from here (its push routes are mounted).
  const oldReady = build != null && build.session == null && build.repos.some((r) => r.include && r.status === 'ready' && r.hasPatch);
  const pushable = open != null && open.build.repos.some((r) => r.hasPatch || r.status === 'pushed');
  // Plan first: after Approve the changes are the planned pull requests (the stack view), not repositories.
  const stacked = open != null && (open.build.prs?.length ?? 0) > 0;

  return (
    <>
      <StoryBuildHeader
        workspaceId={workspaceId}
        ident={ident}
        ticketKey={build?.ticketKey ?? ticketKey}
        title={title}
        build={open != null ? open.build : null}
        error={stream.error}
        offered={offer?.action ?? null}
        actions={open != null ? <HeaderActions build={open.build} session={open.session} draft={draft} setDraft={setDraft} /> : null}
      />
      {q.isLoading && <p className="mt-5 text-meta text-ui-mute">Loading…</p>}
      {q.isError && <p className="mt-5 text-body text-ui-danger">Could not load this session.</p>}
      {open != null && <AutoPushLine build={open.build} />}
      {q.isSuccess && open == null && <StartPanel workspaceId={workspaceId} ident={ident} last={closed ? build : null} offer={offer ?? null} />}
      {open != null && open.session.plan != null && open.session.phase !== 'booting' && <PlanPanel build={open.build} session={open.session} />}
      {open != null && <SessionView build={open.build} session={open.session} partials={stream.partials} />}
      {stacked && open != null ? (
        <StoryBuildSection title="Pull requests" testId="story-build-build">
          <StackView build={open.build} session={open.session} draft={draft} setDraft={setDraft} />
        </StoryBuildSection>
      ) : (
        (pushable || oldReady) &&
        build != null && (
          <StoryBuildSection title="Changes" testId="story-build-build">
            <BuildSection build={build} draft={draft} />
          </StoryBuildSection>
        )
      )}
      <StoryBuildCommands build={open?.build ?? null} session={open?.session ?? null} />
    </>
  );
}

/** The header's end slot: Draft and Push all (repositories with changes), Stop (a turn running), Discard. */
function HeaderActions({
  build,
  session,
  draft,
  setDraft,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  draft: boolean;
  setDraft: (v: boolean) => void;
}): JSX.Element | null {
  const push = useStoryBuildPush(build.workspaceId, build.ident);
  const stop = useStorySessionInterrupt(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  // A planned stack has its own Draft and Push all (the stack view); the header keeps Stop and Discard.
  const stacked = (build.prs?.length ?? 0) > 0;
  const pushAll = !stacked && pushAllOffered(build);
  const anyPushable = !stacked && build.repos.some((r) => r.include && r.status === 'ready' && r.hasPatch);
  const running = sessionTurnRunning(session);
  const discardable = sessionCanDiscard(session);
  if (!anyPushable && !running && !discardable) return null;
  return (
    <>
      {anyPushable && (
        <label className="flex cursor-pointer items-center gap-1.5 text-meta text-ui-ink" title="Open each new pull request as a draft">
          <CheckboxBox checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Draft
        </label>
      )}
      {pushAll && (
        <Button
          variant="primary"
          size="sm"
          icon={<PullRequestIcon size={12} />}
          disabled={busy || running}
          data-story-build-action="push-all"
          onClick={() => push.mutate({ id: build.id, repoId: null, draft })}
        >
          Push all
        </Button>
      )}
      {running && (
        <Button size="sm" variant="secondary" icon={<CloseIcon size={11} />} data-story-build-action="stop-header" disabled={stop.isPending} onClick={() => stop.mutate(build.id)}>
          Stop
        </Button>
      )}
      {discardable && <DiscardButton build={build} live={session.live} />}
    </>
  );
}

/** Discard asks once when the sandbox is running (it ends the agent and removes the sandbox). */
function DiscardButton({ build, live }: { build: StoryBuild; live: boolean }): JSX.Element {
  const discard = useStoryBuildDiscard(build.workspaceId, build.ident);
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-ui-ink">
        <span>{live ? 'Stop the agent and remove the sandbox?' : 'Remove this session?'}</span>
        <Button
          size="sm"
          variant="secondary"
          data-story-build-action="discard-confirm"
          disabled={discard.isPending}
          onClick={() => discard.mutate(build.id, { onSettled: () => setAsking(false) })}
        >
          Discard
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" data-story-build-action="discard" onClick={() => setAsking(true)}>
      Discard
    </Button>
  );
}

/**
 * THE TAB'S ⌘K COMMANDS: Start build, Push all, Stop — each only while its button is on screen, and
 * each PRESSES that button (so the budget confirm and every gate on it still apply).
 */
function StoryBuildCommands({ build, session }: { build: StoryBuild | null; session: StoryBuildSession | null }): null {
  const canBuild = session != null && sessionCanStartBuild(session);
  const canApprove = session != null && planApproveState(session).enabled;
  const stacked = (build?.prs?.length ?? 0) > 0;
  const canPushAll = build != null && (stacked ? pushAllPrCount(build.prs ?? []) >= 2 : pushAllOffered(build));
  const canStop = session != null && sessionTurnRunning(session);
  const key = build?.ticketKey ?? '';
  const commands = useMemo<Command[]>(() => {
    const press = (action: string) => () => {
      const el = document.querySelector<HTMLButtonElement>(`[data-story-build-action="${action}"]`);
      if (el == null || el.disabled) return;
      el.scrollIntoView({ block: 'center' });
      el.click();
    };
    const out: Command[] = [];
    if (canApprove)
      out.push({ id: 'approve', group: 'Actions', title: `Approve the plan for ${key} and start`, keywords: ['plan', 'build', 'implement'], icon: <WrenchIcon size={14} />, run: press('approve') });
    if (canBuild) out.push({ id: 'build', group: 'Actions', title: `Start build of ${key}`, keywords: ['implement', 'build'], icon: <WrenchIcon size={14} />, run: press('build') });
    if (canPushAll)
      out.push({ id: 'push-all', group: 'Actions', title: `Push all of ${key}`, keywords: ['pull request', 'open'], icon: <PullRequestIcon size={14} />, run: press('push-all') });
    if (canStop) out.push({ id: 'stop', group: 'Actions', title: `Stop the agent on ${key}`, keywords: ['cancel', 'interrupt'], icon: <CloseIcon size={14} />, run: press('stop-header') });
    return out;
  }, [canApprove, canBuild, canPushAll, canStop, key]);
  useRegisterCommands('story-build', commands);
  return null;
}

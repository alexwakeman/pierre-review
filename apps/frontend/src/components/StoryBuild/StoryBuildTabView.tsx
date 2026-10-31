import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { STORY_BUILD_PUSH_DRAFT_DEFAULT, type StoryBuild } from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useFollowUpProvider } from '../../hooks/useModelPick.js';
import {
  storyBuildActive,
  storyBuildMutationKey,
  useStoryBuildAccept,
  useStoryBuildCancel,
  useStoryBuildDiscard,
  useStoryBuildFor,
  useStoryBuildPush,
  useStoryBuildStream,
} from '../../hooks/useStoryBuild.js';
import {
  acceptBody,
  pushAllOffered,
  storyBuildCancellable,
  storyBuildClosed,
  storyBuildDiscardable,
  storyBuildErrorText,
  type RepoChoice,
} from '../../lib/storyBuild.js';
import { parseStoryBuildTabKey, ticketKeyOfIdent, usePinnedTabs, type TabTicketMeta } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { useMe } from '../../hooks/useTriage.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { AiRunGate } from '../AiSetup.js';
import { BuildIcon, CloseIcon, PullRequestIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { useRegisterCommands, type Command } from '../ui/commands.js';
import { PAGE_GUTTER } from '../ui/PageHeader.js';
import { BuildDocsSection } from './BuildDocsSection.js';
import { BuildSection } from './BuildSection.js';
import { CoverageSection } from './CoverageSection.js';
import { PlanSection } from './PlanSection.js';
import { StartPanel } from './StartPanel.js';
import { StoryBuildHeader } from './StoryBuildHeader.js';
import { StoryBuildSection } from './StoryBuildSection.js';

// THE BUILD TAB ("Implement story"; docs/STORY-BUILD.md, docs/FRONTEND.md § The build tab): the active
// tab's ticket, `story-build:<ident>`, opened ONLY through `useOpenStoryBuild` (lib/storyBuildTab.ts).
// One query holds the ticket's latest session (`useStoryBuildFor`, a 2 s poll only while something runs)
// and one SSE stream follows it while it runs. Top to bottom: the header (steps, status, cost, Push all,
// Cancel), the start state OR the session — Already done, the Plan (+ design, + chat), the Docs, the
// action bar (Accept plan and build · Discard), and the Build cards. Nothing is built before Accept and
// nothing is pushed before Push.

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
    <div data-testid="story-build-tab-view" className={`max-w-5xl pb-10 ${PAGE_GUTTER}`}>
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
  const build = q.data?.build ?? null;
  const active = storyBuildActive(build);
  const progress = useStoryBuildStream(workspaceId, ident, build?.id ?? null, active);
  const closed = storyBuildClosed(build);
  // The start options live here so the header's step line can show Docs before a start.
  const [wantDiagram, setWantDiagram] = useState(true);
  const [wantDocs, setWantDocs] = useState(true);
  // Push as a draft by default (owner decision 2); one toggle for every push of this session.
  const [draft, setDraft] = useState(STORY_BUILD_PUSH_DRAFT_DEFAULT);
  // The reader's per-repository choices before Accept (include, branch, the tests to run).
  const [choices, setChoices] = useState<ReadonlyMap<number, Partial<RepoChoice>>>(() => new Map());
  const setChoice = useCallback((repoId: number, c: Partial<RepoChoice>) => {
    setChoices((m) => {
      const next = new Map(m);
      next.set(repoId, { ...(m.get(repoId) ?? {}), ...c });
      return next;
    });
  }, []);
  // A new plan revision starts the cards from what the plan says again (keeping branch edits would
  // name branches for repositories the new plan may not have).
  // ⚠ The tests to run are KEPT: each card reports them from its own effect, which React runs BEFORE
  // this parent effect in the same commit, so wiping them here would send Accept with no checks while
  // "Run tests" still reads ticked (a cached checks list never reports again).
  const planRevision = build?.planRevision ?? 0;
  useEffect(
    () =>
      setChoices((m) => {
        const next = new Map<number, Partial<RepoChoice>>();
        for (const [id, c] of m) if (c.checks != null) next.set(id, { checks: c.checks });
        return next;
      }),
    [planRevision, build?.id],
  );

  const headerActions = build != null && !closed ? <HeaderActions build={build} draft={draft} setDraft={setDraft} /> : null;

  return (
    <>
      <StoryBuildHeader
        workspaceId={workspaceId}
        ident={ident}
        ticketKey={build?.ticketKey ?? ticketKey}
        title={title}
        build={closed ? null : build}
        wantDocs={wantDocs}
        offered={offer?.action ?? null}
        actions={headerActions}
      />
      {q.isLoading && <p className="mt-5 text-meta text-ui-mute">Loading…</p>}
      {q.isError && <p className="mt-5 text-body text-ui-danger">Could not load this build.</p>}
      {q.isSuccess && (build == null || closed) && (
        <StartPanel
          workspaceId={workspaceId}
          ident={ident}
          last={closed ? build : null}
          offer={offer ?? null}
          wantDiagram={wantDiagram}
          setWantDiagram={setWantDiagram}
          wantDocs={wantDocs}
          setWantDocs={setWantDocs}
        />
      )}
      {build != null && !closed && (
        <SessionBody build={build} progress={progress} choices={choices} setChoice={setChoice} draft={draft} />
      )}
      <StoryBuildCommands build={build != null && !closed ? build : null} />
    </>
  );
}

function SessionBody({
  build,
  progress,
  choices,
  setChoice,
  draft,
}: {
  build: StoryBuild;
  progress: ReturnType<typeof useStoryBuildStream>;
  choices: ReadonlyMap<number, Partial<RepoChoice>>;
  setChoice: (repoId: number, c: Partial<RepoChoice>) => void;
  draft: boolean;
}): JSX.Element {
  const editable = build.status === 'plan_ready';
  const built = build.repos.some((r) => r.status !== 'planned' && r.status !== 'skipped');
  return (
    <>
      <CoverageSection build={build} />
      <PlanSection build={build} progress={progress} choices={choices} setChoice={setChoice} editable={editable} />
      <BuildDocsSection build={build} editable={editable} />
      {editable && <ActionBar build={build} choices={choices} />}
      {built && (
        <StoryBuildSection title="Build" testId="story-build-build">
          <BuildSection build={build} progress={progress} draft={draft} />
        </StoryBuildSection>
      )}
    </>
  );
}

/** "Accept plan and build" (a BUILD run, gated on `story_build` on the session's provider) · Discard. */
function ActionBar({ build, choices }: { build: StoryBuild; choices: ReadonlyMap<number, Partial<RepoChoice>> }): JSX.Element {
  const accept = useStoryBuildAccept(build.workspaceId, build.ident);
  const discard = useStoryBuildDiscard(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const buildProvider = useFollowUpProvider(build.provider ?? null, 'story_build');
  const ready = acceptBody(build, choices);
  const problem = 'problem' in ready ? ready.problem : null;
  const err = accept.error ?? discard.error;
  return (
    <div data-testid="story-build-actions" className="mt-6 flex flex-wrap items-center gap-2 border-t border-ui-line pt-4">
      <AiRunGate kind="story_build" followUp provider={buildProvider}>
        <Button
          variant="primary"
          data-ai-run
          data-story-build-action="accept"
          icon={<BuildIcon size={13} />}
          disabled={busy || problem != null}
          onClick={() => {
            if ('body' in ready) accept.mutate({ id: build.id, body: ready.body });
          }}
        >
          Accept plan and build
        </Button>
      </AiRunGate>
      <Button variant="ghost" data-story-build-action="discard" disabled={busy} onClick={() => discard.mutate(build.id)}>
        Discard
      </Button>
      {problem != null && <span className="text-meta text-ui-warn">{problem}</span>}
      {err != null && <span className="text-meta text-ui-danger">{storyBuildErrorText(err instanceof ApiError ? err : { message: (err as Error).message })}</span>}
    </div>
  );
}

/** The header's end slot: Draft, Push all (≥ 2 repositories ready), Cancel (a pass running), Discard. */
function HeaderActions({ build, draft, setDraft }: { build: StoryBuild; draft: boolean; setDraft: (v: boolean) => void }): JSX.Element | null {
  const push = useStoryBuildPush(build.workspaceId, build.ident);
  const cancel = useStoryBuildCancel(build.workspaceId, build.ident);
  const discard = useStoryBuildDiscard(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const pushAll = pushAllOffered(build);
  const anyPushable = build.repos.some((r) => r.include && r.status === 'ready' && r.hasPatch);
  // A plan pass is cancelled from the plan's own progress line; the header cancels a build.
  const cancellable = storyBuildCancellable(build) && build.status === 'building';
  const discardable = build.status === 'ready' && storyBuildDiscardable(build);
  if (!anyPushable && !cancellable && !discardable) return null;
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
          disabled={busy}
          data-story-build-action="push-all"
          onClick={() => push.mutate({ id: build.id, repoId: null, draft })}
        >
          Push all
        </Button>
      )}
      {cancellable && (
        <Button size="sm" variant="secondary" icon={<CloseIcon size={11} />} data-story-build-action="cancel" onClick={() => cancel.mutate(build.id)}>
          Cancel
        </Button>
      )}
      {discardable && (
        <Button size="sm" variant="ghost" disabled={busy} data-story-build-action="discard" onClick={() => discard.mutate(build.id)}>
          Discard
        </Button>
      )}
    </>
  );
}

/**
 * THE TAB'S ⌘K COMMANDS: Accept plan, Push all, Cancel — each only while its button is on screen, and
 * each PRESSES that button (so the budget confirm and every gate on it still apply).
 */
function StoryBuildCommands({ build }: { build: StoryBuild | null }): null {
  const canAccept = build?.status === 'plan_ready' && build.plan != null;
  const canPushAll = build != null && pushAllOffered(build);
  const canCancel = build != null && storyBuildCancellable(build);
  const key = build?.ticketKey ?? '';
  const commands = useMemo<Command[]>(() => {
    const press = (action: string) => () => {
      const el = document.querySelector<HTMLButtonElement>(`[data-story-build-action="${action}"]`);
      if (el == null || el.disabled) return;
      el.scrollIntoView({ block: 'center' });
      el.click();
    };
    const out: Command[] = [];
    if (canAccept)
      out.push({ id: 'accept', group: 'Actions', title: `Accept plan and build ${key}`, keywords: ['implement', 'build', 'plan'], icon: <BuildIcon size={14} />, run: press('accept') });
    if (canPushAll)
      out.push({ id: 'push-all', group: 'Actions', title: `Push all of ${key}`, keywords: ['pull request', 'open'], icon: <PullRequestIcon size={14} />, run: press('push-all') });
    if (canCancel) out.push({ id: 'cancel', group: 'Actions', title: `Cancel the build of ${key}`, keywords: ['stop'], icon: <CloseIcon size={14} />, run: press('cancel') });
    return out;
  }, [canAccept, canPushAll, canCancel, key]);
  useRegisterCommands('story-build', commands);
  return null;
}

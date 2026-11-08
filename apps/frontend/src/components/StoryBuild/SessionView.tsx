import { useMemo } from 'react';
import type { SandboxNetworkAllowBody, SandboxSessionRepo, StoryBuild, StoryBuildSession } from '@pierre-review/shared';
import {
  storyBuildMutationKey,
  useStorySessionAllow,
  useStorySessionBuild,
  useStorySessionInterrupt,
  useStorySessionMessage,
  useStorySessionResume,
} from '../../hooks/useStoryBuild.js';
import { storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { RailSection, SharedSessionView, type SessionActions, type SessionWords } from '../sandbox/SessionView.js';

// THE BUILD TAB'S SESSION (docs/SANDBOX.md § Sessions; docs/FRONTEND.md § The build tab): the shared
// session view (components/sandbox/SessionView.tsx) with the story's hooks, words and Ticket panel. The
// per-repository diffs and Push sit under it (BuildSection).

const STORY_WORDS: SessionWords = {
  startBuild: 'Start build',
  startBuildTitle: 'The agent changes the code and runs the tests. The words in the box go with it.',
  readerBuildLabel: 'You · Start build',
  empty: 'The agent has read the ticket and the repositories. Ask it for a plan, a question answered, or where to look first.',
  chatPlaceholder: 'Ask for a plan, a question answered, or where to look first.',
  buildPlaceholder: 'Ask for a change. It is a build turn: the agent may edit and test.',
  resumeNote: 'Resume starts a new sandbox with these changes. The agent does not remember the conversation.',
  gate: { chat: 'story_plan', build: 'story_build' },
};

/** A PLAN-FIRST session (`session.plan` set): the agent plans on its own; the build starts from the plan
 *  panel's "Approve and start", never from the composer. */
const PLAN_WORDS: Pick<SessionWords, 'empty' | 'chatPlaceholder' | 'buildPlaceholder'> = {
  empty: 'The agent is reading the ticket and the code. Its plan shows above once Limn has checked it.',
  chatPlaceholder: 'Ask a question, or tell the agent what to change in the plan.',
  buildPlaceholder: 'Ask for a change. It is a build turn: the agent may edit and test.',
};

function storyActions(build: StoryBuild): SessionActions {
  const { workspaceId, ident, id } = build;
  return {
    busyKey: storyBuildMutationKey(ident),
    useSend() {
      const m = useStorySessionMessage(workspaceId, ident);
      return { run: (text, done) => m.mutate({ id, text }, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useStartBuild() {
      const m = useStorySessionBuild(workspaceId, ident);
      return { run: (text, done) => m.mutate({ id, text }, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useStop() {
      const m = useStorySessionInterrupt(workspaceId, ident);
      return { run: (_v, done) => m.mutate(id, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useResume() {
      const m = useStorySessionResume(workspaceId, ident);
      return { run: (_v, done) => m.mutate(id, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useAllow() {
      const m = useStorySessionAllow(workspaceId, ident);
      return {
        run: (body: SandboxNetworkAllowBody, done) => m.mutate({ id, body }, { onSuccess: done }),
        pending: m.isPending,
        error: m.error,
        succeeded: m.isSuccess,
      };
    },
  };
}

export function SessionView({
  build,
  session,
  partials,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  /** The agent's words still arriving, by message id (the stream fold). */
  partials: ReadonlyMap<string, string>;
}): JSX.Element {
  // Rebuilt only when the session's identity changes (the hooks inside are called in the same order).
  const actions = useMemo(() => storyActions(build), [build]);
  const plan = session.plan;
  const words = useMemo<SessionWords>(
    () =>
      plan == null
        ? STORY_WORDS
        : {
            ...STORY_WORDS,
            ...PLAN_WORDS,
            ...(plan.latest == null && plan.status === 'failed' ? { chatPlaceholder: 'Tell the agent what to change, or ask it to plan again.' } : {}),
          },
    [plan],
  );
  const byId = new Map(build.repos.map((r) => [r.repoId, r] as const));
  const repoStatus = (r: SandboxSessionRepo) => {
    const row = byId.get(r.repoId);
    const changed = row?.filesChanged.length ?? 0;
    return { status: row?.status === 'pushed' ? 'Pushed' : changed > 0 ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'No changes yet' };
  };
  return (
    <SharedSessionView
      session={session}
      partials={partials}
      actions={actions}
      words={words}
      provider={build.provider ?? null}
      testPrefix="story-session"
      actionAttr="data-story-build-action"
      railTop={<TicketPanel session={session} />}
      repoStatus={repoStatus}
    />
  );
}

function TicketPanel({ session }: { session: StoryBuildSession }): JSX.Element {
  const t = session.ticket;
  return (
    <RailSection title="Ticket" testId="story-session-ticket">
      {t.criteria.length === 0 ? (
        <p className="text-meta text-ui-mute">No numbered criteria. The agent has the description.</p>
      ) : (
        <ol className="space-y-1 text-meta text-ui-ink">
          {t.criteria.map((c) => {
            const ref = /^(AC\d+):/.exec(c)?.[1] ?? null;
            return (
              <li key={c} id={ref != null ? storyBuildRefAnchor(ref) : undefined} className="break-words">
                {ref != null ? (
                  <>
                    <span className="font-mono text-ui-mute">{ref}</span>
                    {c.slice(ref.length + 1)}
                  </>
                ) : (
                  c
                )}
              </li>
            );
          })}
        </ol>
      )}
      {t.openPoints.length > 0 && (
        <>
          <h5 className="mt-2 text-meta font-semibold text-ui-ink">Open points ({t.openPoints.length})</h5>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-meta text-ui-ink">
            {t.openPoints.map((p, i) => (
              <li key={i} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </>
      )}
    </RailSection>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  isStoryBuildRunning,
  STORY_BUILD_REPO_RUNNING_STATUSES,
  storyBuildPath,
  type StoryBuild,
  type StoryBuildAcceptBody,
  type StoryBuildChecksPreview,
  type StoryBuildDiffResponse,
  type StoryBuildDocs,
  type StoryBuildDocsDecisions,
  type StoryBuildForTicketResponse,
  type StoryBuildProgress,
  type StoryBuildPushResponse,
  type StoryBuildStartBody,
  type StoryBuildStreamEvent,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { workspaceKey } from './useActivity.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

// "IMPLEMENT STORY" — the build tab's server state (docs/STORY-BUILD.md; docs/FRONTEND.md § The build
// tab). ONE query per ticket (`storyBuildForKey`) holds the latest session; it polls every 2 s only while
// something runs (the fallback), and the session's SSE stream (`useStoryBuildStream`, opened only while
// running, one per tab) refetches it on every step. Every action shares ONE mutation key per ticket
// (`storyBuildMutationKey`, the `aiFixPlanMutationKey` lesson): a tab switch mid-POST must not offer a
// second billed pass.

/** The fallback poll while a pass runs. */
export const STORY_BUILD_POLL_MS = 2_000;

export function storyBuildForKey(workspaceId: number | null, ident: string): [string, string, string] {
  return ['story-build-for', workspaceKey(workspaceId), ident];
}

/** Every action on one ticket's build (start, chat, docs, accept, retry, push, cancel, discard). */
export function storyBuildMutationKey(ident: string): [string, string] {
  return ['story-build-action', ident];
}

/** A pass is in flight somewhere in the session: the plan/build, the docs run, or a repository. */
export function storyBuildActive(b: Pick<StoryBuild, 'status' | 'docsStatus' | 'repos'> | null | undefined): boolean {
  if (b == null) return false;
  if (isStoryBuildRunning(b.status) || b.docsStatus === 'running') return true;
  return b.repos.some((r) => STORY_BUILD_REPO_RUNNING_STATUSES.includes(r.status) || r.status === 'queued');
}

export function useStoryBuildFor(workspaceId: number | null, ident: string | null) {
  return useQuery<StoryBuildForTicketResponse>({
    queryKey: storyBuildForKey(workspaceId, ident ?? ''),
    queryFn: () => api.storyBuildFor(workspaceId as number, ident as string),
    enabled: workspaceId != null && ident != null,
    refetchInterval: (q) => (storyBuildActive(q.state.data?.build) ? STORY_BUILD_POLL_MS : false),
  });
}

/** The board's card marks and the ticket views read through these. */
function invalidateBuild(qc: QueryClient, workspaceId: number | null, ident: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: storyBuildForKey(workspaceId, ident) }),
    qc.invalidateQueries({ queryKey: ['sprint-graph', workspaceKey(workspaceId)] }),
    qc.invalidateQueries({ queryKey: ['sprint-graph-token', workspaceKey(workspaceId)] }),
  ]);
}

/**
 * Live progress over SSE while `active`: each step refetches the session, and the stream's end (a
 * `done`, an error, the server closing it) refetches once more. At most one stream per tab.
 */
export function useStoryBuildStream(
  workspaceId: number | null,
  ident: string,
  buildId: number | null,
  active: boolean,
): StoryBuildProgress | null {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<StoryBuildProgress | null>(null);
  const lastStep = useRef<string | null>(null);
  useEffect(() => {
    if (buildId == null || !active) {
      setProgress(null);
      return;
    }
    const ac = new AbortController();
    const refetch = (): void => void invalidateBuild(qc, workspaceId, ident);
    void sseStream<StoryBuildStreamEvent>(storyBuildPath('stream', { id: buildId }), {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'progress') {
          setProgress(e.progress);
          // A new step (or a new repository) changed what the snapshot says: read it again.
          const step = `${e.progress.phase}:${e.progress.repoId ?? ''}`;
          if (step !== lastStep.current) {
            lastStep.current = step;
            refetch();
          }
          return;
        }
        // `done`: the pass ended (the stream closes next).
        refetch();
      },
    })
      .catch(() => {
        /* aborted or a network error — the 2 s poll still follows the DB */
      })
      .finally(() => {
        if (!ac.signal.aborted) refetch();
      });
    return () => ac.abort();
  }, [buildId, active, workspaceId, ident, qc]);
  return progress;
}

export function useStartStoryBuild(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (body: Omit<StoryBuildStartBody, 'workspaceId' | 'ident'>) => {
      if (workspaceId == null) throw new Error('No workspace yet.');
      return api.startStoryBuild({ ...body, workspaceId, ident });
    },
    onSuccess: () => invalidateBuild(qc, workspaceId, ident),
  });
}

/** Every action that answers "re-read the session" (chat, docs run, accept, retry, cancel, discard). */
function useBuildAction<V>(workspaceId: number | null, ident: string, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: fn,
    onSuccess: () => invalidateBuild(qc, workspaceId, ident),
  });
}

export function useStoryBuildMessage(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; text: string }) => api.sendStoryBuildMessage(v.id, { text: v.text }));
}

export function useStoryBuildDocsRun(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; force?: boolean }) => api.runStoryBuildDocs(v.id, v.force ? { force: true } : {}));
}

export function useStoryBuildAccept(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; body: StoryBuildAcceptBody }) => api.acceptStoryBuild(v.id, v.body));
}

export function useStoryBuildRetry(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; repoId: number }) => api.retryStoryBuildRepo(v.id, v.repoId));
}

export function useStoryBuildCancel(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (id: number) => api.cancelStoryBuild(id));
}

export function useStoryBuildDiscard(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (id: number) => api.discardStoryBuild(id));
}

/**
 * The reader's ticks on the docs points (DB only, no run). Its OWN key: a tick never waits on — or
 * blocks — a billed action. The snapshot is patched at once so the box does not flicker back.
 */
export function useStoryBuildDocsDecisions(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  const key = storyBuildForKey(workspaceId, ident);
  return useMutation({
    // `docs` = the run the reader is looking at: a newer run reuses its ids, so the server refuses a tick
    // aimed at another one (409 DocsMoved) and the settle below re-reads the session.
    mutationFn: (v: { id: number; decisions: StoryBuildDocsDecisions; docs: Pick<StoryBuildDocs, 'planRevision' | 'runId'> }) =>
      api.setStoryBuildDocsDecisions(v.id, { decisions: v.decisions, planRevision: v.docs.planRevision, runId: v.docs.runId ?? null }),
    onMutate: (v) => {
      qc.setQueryData<StoryBuildForTicketResponse>(key, (d) =>
        d?.build != null && d.build.id === v.id ? { ...d, build: { ...d.build, docsDecisions: v.decisions } } : d,
      );
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Push one repository, or every unpushed ready one (`repoId` null). A push opens new pull requests:
 * THE ONE WRITE SET (`invalidateAfterPrWrite`, no one PR id yet) + the ticket's PR list + the sprint.
 */
export function useStoryBuildPush(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (v: { id: number; repoId: number | null; draft: boolean }): Promise<StoryBuildPushResponse> =>
      v.repoId == null ? api.pushStoryBuildAll(v.id, { draft: v.draft }) : api.pushStoryBuildRepo(v.id, v.repoId, { draft: v.draft }),
    onSuccess: () =>
      Promise.all([
        invalidateBuild(qc, workspaceId, ident),
        qc.invalidateQueries({ queryKey: ['ticket-prs'] }),
        invalidateAfterPrWrite(qc, null),
      ]),
  });
}

/** The stored patch — fetched only once the reader opens a repository's diff. */
export function useStoryBuildDiff(buildId: number, repoId: number, enabled: boolean, patchKey: string) {
  return useQuery<StoryBuildDiffResponse>({
    // `patchKey` (the repo row's completion stamp) re-reads the patch after a Retry.
    queryKey: ['story-build-diff', buildId, repoId, patchKey],
    queryFn: () => api.storyBuildRepoDiff(buildId, repoId),
    enabled,
    staleTime: Infinity,
  });
}

/** "Run tests": the checks one repository declares at its base. CLICK-GATED (one GitHub read). */
export function useStoryBuildChecks(buildId: number, repoId: number, enabled: boolean) {
  return useQuery<StoryBuildChecksPreview>({
    queryKey: ['story-build-checks', buildId, repoId],
    queryFn: () => api.storyBuildRepoChecks(buildId, repoId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

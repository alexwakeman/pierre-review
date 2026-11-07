import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  storyBuildPath,
  type StoryBuild,
  type StoryBuildDiffResponse,
  type StoryBuildForTicketResponse,
  type StoryBuildPushResponse,
  type SandboxFolderCheck,
  type SandboxNetworkAllowBody,
  type SandboxRuntimeStatus,
  type SandboxSessionStartBody,
  type SandboxSessionStreamEvent,
  type SandboxWorkspaceSettings,
  type SandboxWorkspaceSettingsBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { workspaceKey } from './useActivity.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';
import { applySessionEvent, EMPTY_SESSION_STREAM, sessionEventNeedsRefetch, type SessionStreamState } from '../lib/sandboxSession.js';

// "IMPLEMENT STORY" — the build tab's server state (docs/STORY-BUILD.md; docs/FRONTEND.md § The build
// tab). ONE query per ticket (`storyBuildForKey`) holds the latest session; the session's SSE stream
// (`useStorySessionStream`, one per tab) is the live path and a slow poll the fallback while it moves.
// Every billed action shares ONE mutation key per ticket (`storyBuildMutationKey`, the
// `aiFixPlanMutationKey` lesson): a tab switch mid-POST must not offer a second billed turn.

/** A session's fallback poll while it boots or a turn runs (the stream is the live path). */
export const SESSION_POLL_MS = 5_000;

export function storyBuildForKey(workspaceId: number | null, ident: string): [string, string, string] {
  return ['story-build-for', workspaceKey(workspaceId), ident];
}

/** Every billed action on one ticket's session (start, message, Start build, Resume, push, discard). */
export function storyBuildMutationKey(ident: string): [string, string] {
  return ['story-build-action', ident];
}

/** The session's sandbox is running (the stream follows it; the poll is only the fallback). A row of the
 *  removed plan/build flow is never active: the boot reconcile settles any it left running. */
export function storyBuildActive(b: Pick<StoryBuild, 'session'> | null | undefined): boolean {
  return b?.session?.live === true;
}

export function useStoryBuildFor(workspaceId: number | null, ident: string | null) {
  return useQuery<StoryBuildForTicketResponse>({
    queryKey: storyBuildForKey(workspaceId, ident ?? ''),
    queryFn: () => api.storyBuildFor(workspaceId as number, ident as string),
    enabled: workspaceId != null && ident != null,
    refetchInterval: (q) => {
      const b = q.state.data?.build;
      // A session: only while something moves (the stream carries the rest; a waiting agent needs no poll).
      if (b?.session == null) return false;
      return b.session.live && b.session.phase !== 'ready' && b.session.phase !== 'built' ? SESSION_POLL_MS : false;
    },
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

/** Every action that answers "re-read the session" (discard). */
function useBuildAction<V>(workspaceId: number | null, ident: string, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: fn,
    onSuccess: () => invalidateBuild(qc, workspaceId, ident),
  });
}

export function useStoryBuildDiscard(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (id: number) => api.discardStoryBuild(id));
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
    // `patchKey` (the repo row's completion stamp) re-reads the patch after a later build turn.
    queryKey: ['story-build-diff', buildId, repoId, patchKey],
    queryFn: () => api.storyBuildRepoDiff(buildId, repoId),
    enabled,
    staleTime: Infinity,
  });
}

// ── THE WORKSPACE SESSION (docs/SANDBOX.md § Sessions) ─────────────────────────────────────────────
//
// The tab follows a live session over ONE SSE stream (`GET …/stream`: a `snapshot`, then the changes;
// `done` when the sandbox closes), folded by lib/sandboxSession.ts. A phase change, a turn's end and
// `done` re-read the query (spend, repositories, the status the board reads). A stream that drops while
// the session is still live is opened again after a pause.

/** How long to wait before opening a dropped stream again. */
export const SESSION_STREAM_RETRY_MS = 3_000;

export function useStorySessionStream(
  workspaceId: number | null,
  ident: string,
  buildId: number | null,
  live: boolean,
): SessionStreamState {
  const qc = useQueryClient();
  // The fold, tagged with the session it belongs to: another session's frames never show on this one.
  const [held, setHeld] = useState<{ id: number | null; s: SessionStreamState }>({ id: null, s: EMPTY_SESSION_STREAM });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (buildId == null || !live) return;
    const ac = new AbortController();
    let sawDone = false;
    const refetch = (): void => void invalidateBuild(qc, workspaceId, ident);
    void sseStream<SandboxSessionStreamEvent>(storyBuildPath('stream', { id: buildId }), {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'done') sawDone = true;
        setHeld((h) => ({ id: buildId, s: applySessionEvent(h.id === buildId ? h.s : EMPTY_SESSION_STREAM, e) }));
        if (sessionEventNeedsRefetch(e)) refetch();
      },
    })
      .catch(() => {
        /* aborted or a network error: the retry below, and the fallback poll, follow the DB */
      })
      .finally(() => {
        if (ac.signal.aborted) return;
        refetch();
        if (!sawDone) window.setTimeout(() => !ac.signal.aborted && setAttempt((n) => n + 1), SESSION_STREAM_RETRY_MS);
      });
    return () => ac.abort();
  }, [buildId, live, attempt, workspaceId, ident, qc]);
  return held.id === buildId ? held.s : EMPTY_SESSION_STREAM;
}

/** Start a session ("Implement" / "Fill gaps"): 409 NoRuntime / TooManySessions say why in one line. */
export function useStartStorySession(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (body: Omit<SandboxSessionStartBody, 'workspaceId' | 'ident'>) => {
      if (workspaceId == null) throw new Error('No workspace yet.');
      return api.startStorySession({ ...body, workspaceId, ident });
    },
    onSuccess: () => invalidateBuild(qc, workspaceId, ident),
    // A refused start may mean the runtime went away: read its status again.
    onError: () => void qc.invalidateQueries({ queryKey: SANDBOX_RUNTIME_KEY }),
  });
}

export function useStorySessionMessage(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; text: string }) => api.sendStorySessionMessage(v.id, { text: v.text }));
}

export function useStorySessionBuild(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (v: { id: number; text?: string }) =>
    api.startStorySessionBuild(v.id, v.text != null && v.text.trim() !== '' ? { text: v.text.trim() } : {}),
  );
}

export function useStorySessionResume(workspaceId: number | null, ident: string) {
  return useBuildAction(workspaceId, ident, (id: number) => api.resumeStorySession(id));
}

/** Stop the running turn. Its OWN key: Stop must never wait behind (or be blocked by) the turn's press. */
export function useStorySessionInterrupt(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.interruptStorySession(id),
    onSuccess: () => invalidateBuild(qc, workspaceId, ident),
  });
}

/** An Allow click on the Network panel (a reader's click, never automatic). Its own key, like Stop. */
export function useStorySessionAllow(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: SandboxNetworkAllowBody }) => api.allowStorySessionHost(v.id, v.body),
    onSuccess: (_r, v) =>
      Promise.all([
        invalidateBuild(qc, workspaceId, ident),
        v.body.scope === 'workspace' && workspaceId != null ? qc.invalidateQueries({ queryKey: sandboxSettingsKey(workspaceId) }) : null,
      ]),
  });
}

// ── the runtime and Settings → Sandbox ──────────────────────────────────────────────────────────

export const SANDBOX_RUNTIME_KEY = ['sandbox-runtime'] as const;

/** The container runtime on this computer (DB-free; the server caches it 10 s). `enabled` gates it to
 *  the surfaces that show it (the start state, Settings → Sandbox). */
export function useSandboxRuntime(enabled = true) {
  return useQuery<SandboxRuntimeStatus>({
    queryKey: SANDBOX_RUNTIME_KEY,
    queryFn: () => api.sandboxRuntime(),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function sandboxSettingsKey(workspaceId: number | null): [string, string] {
  return ['sandbox-settings', workspaceKey(workspaceId)];
}

export function useSandboxSettings(workspaceId: number | null) {
  return useQuery<SandboxWorkspaceSettings>({
    queryKey: sandboxSettingsKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.sandboxSettings(workspaceId),
    staleTime: 60_000,
  });
}

export function useSaveSandboxSettings(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SandboxWorkspaceSettingsBody) => api.setSandboxSettings(workspaceId, body),
    onSuccess: (saved) => {
      qc.setQueryData(sandboxSettingsKey(workspaceId), saved);
      void qc.invalidateQueries({ queryKey: ['sandbox-check', workspaceKey(workspaceId)] });
    },
  });
}

export function useRemoveSandboxHost(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rule: string) => api.removeSandboxAllowedHost(workspaceId, rule),
    onSuccess: (saved) => qc.setQueryData(sandboxSettingsKey(workspaceId), saved),
  });
}

/** The folder check: CLICK-GATED (a bounded walk of a local folder). `folder` undefined = the saved one. */
export function useSandboxFolderCheck(workspaceId: number, folder: string | null | undefined, enabled: boolean) {
  return useQuery<SandboxFolderCheck>({
    queryKey: ['sandbox-check', workspaceKey(workspaceId), folder === undefined ? '(saved)' : (folder ?? '(none)')],
    queryFn: () => api.checkSandboxFolder(workspaceId, folder === undefined ? {} : { folder }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

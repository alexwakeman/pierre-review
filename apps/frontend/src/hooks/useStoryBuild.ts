import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  storyBuildPath,
  type BuildPlanApproveBody,
  type BuildPlanDecisionBody,
  type BuildPlanReplyBody,
  type BuildPlanRevisionResponse,
  type BuildPlanView,
  type StoryBuildPrDiffResponse,
  type StoryBuild,
  type StoryBuildDiffResponse,
  type StoryBuildForTicketResponse,
  type StoryBuildPushBody,
  type StoryBuildPushResponse,
  type SandboxComposeFiles,
  type SandboxFolderCheck,
  type SandboxNetworkAllowBody,
  type SandboxRunningStatus,
  type SandboxRuntimeStatus,
  type SandboxSessionStartBody,
  type SandboxWorkspaceSettings,
  type SandboxWorkspaceSettingsBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useSandboxSessionStream } from './useSandboxSessionStream.js';
import { workspaceKey } from './useActivity.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';
import type { SessionStreamState } from '../lib/sandboxSession.js';
import { autoPushRunning } from '../lib/storyBuild.js';

// "IMPLEMENT STORY" — the build tab's server state (docs/STORY-BUILD.md; docs/FRONTEND.md § The build
// tab). ONE query per ticket (`storyBuildForKey`) holds the latest session; the session's SSE stream
// (`useStorySessionStream`, one per tab) is the live path and a slow poll the fallback while it moves.
// Every billed action shares ONE mutation key per ticket (`storyBuildMutationKey`, the
// `aiFixSessionMutationKey` lesson): a tab switch mid-POST must not offer a second billed turn.

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
      // The automatic push runs on the host after the turn: follow it until it answers (a push or a failure).
      if (b.session.live && autoPushRunning(b)) return SESSION_POLL_MS;
      return b.session.live && b.session.phase !== 'ready' && b.session.phase !== 'plan_ready' && b.session.phase !== 'built' ? SESSION_POLL_MS : false;
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

/** The push body: `branch` ONLY when the reader named one (the rename after BRANCH_EXISTS). */
export function storyBuildPushBody(draft: boolean, branch?: string): StoryBuildPushBody {
  return { draft, ...(branch != null && branch.trim() !== '' ? { branch: branch.trim() } : {}) };
}

/**
 * Push one repository, or every unpushed ready one (`repoId` null). A push opens new pull requests:
 * THE ONE WRITE SET (`invalidateAfterPrWrite`, no one PR id yet) + the ticket's PR list + the sprint.
 * `branch` (one repository only): the new name after BRANCH_EXISTS.
 */
export function useStoryBuildPush(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (v: { id: number; repoId: number | null; draft: boolean; branch?: string }): Promise<StoryBuildPushResponse> =>
      v.repoId == null ? api.pushStoryBuildAll(v.id, { draft: v.draft }) : api.pushStoryBuildRepo(v.id, v.repoId, storyBuildPushBody(v.draft, v.branch)),
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

// ── PLAN FIRST (docs/STORY-BUILD.md § Plan first) ─────────────────────────────────────────────────
//
// The plan rides on the session (`session.plan`, the read and the stream's `plan` frame). Agree / Keep the
// story is a DB write with no model turn: its OWN key (never blocked by, and never blocking, a billed
// press), and its answer is the plan view, laid into the read at once. Reply and Approve are billed turns
// on the session's one key.

/** One earlier revision (the history list), read when the reader opens it. Revisions never change. */
export function useStoryBuildPlanRevision(buildId: number, revision: number | null) {
  return useQuery<BuildPlanRevisionResponse>({
    queryKey: ['story-build-plan', buildId, revision],
    queryFn: revision == null ? skipToken : () => api.storyBuildPlanRevision(buildId, revision),
    staleTime: Infinity,
  });
}

/** Write a plan view into the ticket's read (the decision's answer). */
function seatPlan(qc: QueryClient, workspaceId: number | null, ident: string, plan: BuildPlanView): void {
  qc.setQueryData<StoryBuildForTicketResponse>(storyBuildForKey(workspaceId, ident), (old) => {
    const b = old?.build;
    if (old == null || b == null || b.session == null) return old;
    return { ...old, build: { ...b, session: { ...b.session, plan } } };
  });
}

export function usePlanDecision(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: BuildPlanDecisionBody }) => api.decideStoryBuildPlan(v.id, v.body),
    onSuccess: (plan) => seatPlan(qc, workspaceId, ident, plan),
    // PlanStale (a new revision) or any refusal: the read says what the plan now is.
    onError: () => void qc.invalidateQueries({ queryKey: storyBuildForKey(workspaceId, ident) }),
  });
}

export function usePlanReply(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (v: { id: number; body: BuildPlanReplyBody }) => api.replyStoryBuildPlan(v.id, v.body),
    onSettled: () => invalidateBuild(qc, workspaceId, ident),
  });
}

export function usePlanApprove(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (v: { id: number; body: BuildPlanApproveBody }) => api.approveStoryBuildPlan(v.id, v.body),
    onSettled: () => invalidateBuild(qc, workspaceId, ident),
  });
}

/**
 * Push one planned PR (`prId`), or every ready one in plan order (`prId` null: the Push all route, which
 * pushes the stack on a plan-first session). THE ONE WRITE SET, as `useStoryBuildPush`.
 */
export function useStoryBuildPrPush(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: storyBuildMutationKey(ident),
    mutationFn: (v: { id: number; prId: number | null; draft: boolean; branch?: string }): Promise<StoryBuildPushResponse> =>
      v.prId == null ? api.pushStoryBuildAll(v.id, { draft: v.draft }) : api.pushStoryBuildPr(v.id, v.prId, storyBuildPushBody(v.draft, v.branch)),
    onSettled: () =>
      Promise.all([
        invalidateBuild(qc, workspaceId, ident),
        qc.invalidateQueries({ queryKey: ['ticket-prs'] }),
        invalidateAfterPrWrite(qc, null),
      ]),
  });
}

/**
 * "Push and open the pull request when the build finishes" on or off (`POST …/auto-push`). Its OWN key:
 * a DB write with no model turn, so a running turn never blocks it. 409 once the build pushed: re-read.
 */
export function useStoryBuildAutoPush(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  const setAutoPush = (on: boolean): void => {
    qc.setQueryData<StoryBuildForTicketResponse>(storyBuildForKey(workspaceId, ident), (old) =>
      old?.build == null ? old : { ...old, build: { ...old.build, autoPush: on } },
    );
  };
  return useMutation({
    mutationFn: (v: { id: number; on: boolean }) => api.setStoryBuildAutoPush(v.id, { on: v.on }),
    // Optimistic: the box flips on the click; an error re-reads the stored value.
    onMutate: (v) => setAutoPush(v.on),
    onSuccess: (r) => setAutoPush(r.autoPush),
    onError: () => void qc.invalidateQueries({ queryKey: storyBuildForKey(workspaceId, ident) }),
  });
}

/** One planned PR's patch — fetched only once the reader opens its diff. `patchKey` re-reads it after a
 *  later build turn (the PR's tip changes with its stat). */
export function useStoryBuildPrDiff(buildId: number, prId: number, enabled: boolean, patchKey: string) {
  return useQuery<StoryBuildPrDiffResponse>({
    queryKey: ['story-build-pr-diff', buildId, prId, patchKey],
    queryFn: () => api.storyBuildPrDiff(buildId, prId),
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

export { SESSION_STREAM_RETRY_MS } from './useSandboxSessionStream.js';

export function useStorySessionStream(
  workspaceId: number | null,
  ident: string,
  buildId: number | null,
  live: boolean,
): SessionStreamState {
  const qc = useQueryClient();
  return useSandboxSessionStream(
    buildId != null ? storyBuildPath('stream', { id: buildId }) : null,
    buildId,
    live,
    () => void invalidateBuild(qc, workspaceId, ident),
  );
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

export const SANDBOX_RUNNING_KEY = ['sandbox-running'] as const;

/** This Limn's sandboxes running now. Read when Settings → Sandbox opens and on "Check again": never polled. */
export function useSandboxRunning(enabled = true) {
  return useQuery<SandboxRunningStatus>({
    queryKey: SANDBOX_RUNNING_KEY,
    queryFn: () => api.sandboxRunning(),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** "Stop all": the count it answers replaces the cached one. */
export function useStopAllSandboxes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopAllSandboxes(),
    onSuccess: (r) => qc.setQueryData<SandboxRunningStatus>(SANDBOX_RUNNING_KEY, { running: r.running, problem: r.problem }),
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

/** The clone / notes check: CLICK-GATED (bounded walks of the reader's Claude projects and clones). */
export function useSandboxFolderCheck(workspaceId: number, enabled: boolean) {
  return useQuery<SandboxFolderCheck>({
    queryKey: ['sandbox-check', workspaceKey(workspaceId)],
    queryFn: () => api.checkSandboxFolder(workspaceId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** The compose files Limn can offer: CLICK-GATED (one `git ls-tree` per repository in Limn's clone cache). */
export function useSandboxComposeFiles(workspaceId: number, enabled: boolean) {
  return useQuery<SandboxComposeFiles>({
    queryKey: ['sandbox-compose-files', workspaceKey(workspaceId)],
    queryFn: () => api.sandboxComposeFiles(workspaceId),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

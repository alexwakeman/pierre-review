// THE REVIEW LOOP'S SEAMS (docs/STORY-BUILD.md § The review loop). Everything the driver does outside its own
// tables goes through here, so a test drives the whole state machine with fakes (`setStoryLoopSeamsForTests`):
// the reviews, the story check, the git and GitHub steps, the live session, the spend gate. The defaults are
// the real ones, imported LAZILY (the session manager imports the driver; tracker modules open the DB at
// import time).
import type { AiProviderId, ClaudeReview, SandboxSessionStreamEvent } from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { activeProviderId } from '../../../ai/provider-setting.js';
import type { ReadReviewResponseResult } from '../../../sandbox/workspace/review-response.js';
import type { PushNewBranchArgs } from '../../git-ops.js';
import type { LoopHalfInput, LoopHalfResult } from './branch-review.js';
import type { LoopStoryCheckInput, LoopStoryCheckResult } from './story-check.js';

export type HostTurn = 'started' | 'not_live' | 'busy' | 'build_busy';

export interface LoopSeams {
  now(): Date;
  /** How long a fix waits for the build slot / the session before it pauses, and how often it looks. */
  waitMs: number;
  pollMs: number;
  /** Who reviews the code (the workspace's AI review setting, signed-in providers, locked-out ones dropped). */
  providers(ctx: AgentContext, accountId: number, workspaceId: number): Promise<AiProviderId[]>;
  /** Who runs the story check (the default provider). */
  storyProvider(): AiProviderId;
  automaticAllowed(ctx: AgentContext, accountId: number, what: string, provider: AiProviderId): Promise<boolean>;
  runHalf(ctx: AgentContext, i: LoopHalfInput): Promise<LoopHalfResult>;
  runStoryCheck(ctx: AgentContext, i: LoopStoryCheckInput): Promise<LoopStoryCheckResult>;
  consolidate(
    ctx: AgentContext,
    accountId: number,
    a: ClaudeReview,
    b: ClaudeReview,
  ): Promise<{ summary: string | null; verdict: ClaudeReview['verdict']; how: 'pass' | 'code'; sourceOf: Record<string, 'claude' | 'codex' | 'both'>; mergedFrom: Record<string, number> }>;
  canPush(ctx: AgentContext, accountId: number, repoId: number): Promise<boolean>;
  pushNewBranch(a: PushNewBranchArgs): Promise<{ commitSha: string; treeSha: string }>;
  pushFastForward(a: {
    accountId: number;
    owner: string;
    name: string;
    branch: string;
    pushedSha: string;
    tree: string;
    extraParents?: string[];
    message: string;
    protect: string[];
    destRef: string;
  }): Promise<{ commitSha: string; pushed: boolean }>;
  openPr(a: { accountId: number; owner: string; name: string; branch: string; prBase: string; title: string; body: string; draft: boolean; afterSync?: (n: number) => Promise<void> }): Promise<{ prNumber: number; prUrl: string }>;
  treeOfPatch(accountId: number, owner: string, name: string, baseRef: string, baseSha: string, patch: string): Promise<string>;
  liveBranchSha(accountId: number, owner: string, name: string, branch: string): Promise<string | null>;
  openPrOfBranch(accountId: number, owner: string, name: string, branch: string): Promise<{ prNumber: number; prUrl: string } | null>;
  commitFacts(accountId: number, owner: string, name: string, branch: string, sha: string): Promise<{ tree: string; parents: string[] }>;
  /** The PR was synced: link the ticket, then put the closing review on it. */
  afterPrSync(ctx: AgentContext, a: { accountId: number; repoId: number; prNumber: number; ident: string }): Promise<void>;
  session: {
    hold(buildId: number): void;
    release(buildId: number): void;
    ready(buildId: number): boolean;
    live(buildId: number): boolean;
    provider(buildId: number): AiProviderId | null;
    startFixTurn(buildId: number, text: string): HostTurn;
    /** The layout root, or null when not live. */
    root(buildId: number): string | null;
    copyIn(buildId: number, files: Array<{ path: string; content: string; mode?: number }>): Promise<boolean>;
    readResponse(buildId: number, shown: readonly string[]): Promise<ReadReviewResponseResult>;
    removeResponse(buildId: number): Promise<void>;
    resume(ctx: AgentContext, accountId: number, buildId: number): Promise<string | null>;
    interrupt(ctx: AgentContext, accountId: number, buildId: number): Promise<void>;
    emit(buildId: number, e: SandboxSessionStreamEvent): void;
    notice(buildId: number, text: string): void;
  };
}

const mgr = () => import('../../../sandbox/session/manager.js');
const key = (buildId: number) => `story:${buildId}` as const;

/** The real seams. The session ones read the manager's live map synchronously once it is loaded. */
export function defaultLoopSeams(): LoopSeams {
  let m: Awaited<ReturnType<typeof mgr>> | null = null;
  void mgr().then((x) => (m = x)).catch(() => {});
  const need = async () => (m ??= await mgr());
  return {
    now: () => new Date(),
    waitMs: 10 * 60_000,
    pollMs: 20_000,
    async providers(ctx, accountId, workspaceId) {
      const [{ PAIR_ORDER, resolveAutoReviewProviders }, { automaticRunProviders, isLockedOut, anyUsageLockout }, { preflightFor }] = await Promise.all([
        import('../../../review/claude-review/pair.js'),
        import('../../../ai/usage-lockout.js'),
        import('../../../ai/run-choice.js'),
      ]);
      const { readWorkspaceAutoReview } = await import('../../../review/claude-review/auto-settings.js');
      const ws = await readWorkspaceAutoReview(ctx, accountId, workspaceId).catch(() => null);
      const pair = resolveAutoReviewProviders(ws?.autoReviewProviders ?? null) === 'both';
      const detect = preflightFor(ctx);
      return automaticRunProviders({
        defaultProvider: activeProviderId(),
        pair,
        order: PAIR_ORDER,
        ready: (p) => detect(p, 'review').status === 'ok',
        locked: (p) => anyUsageLockout() && isLockedOut(p),
      });
    },
    storyProvider: () => activeProviderId(),
    async automaticAllowed(ctx, accountId, what, provider) {
      const { automaticRunAllowed } = await import('../../../review/budget-gate.js');
      return automaticRunAllowed(ctx, accountId, what, provider);
    },
    runHalf: async (ctx, i) => (await import('./branch-review.js')).runLoopReviewHalf(ctx, i),
    runStoryCheck: async (ctx, i) => (await import('./story-check.js')).runLoopStoryCheck(ctx, i),
    async consolidate(ctx, accountId, a, b) {
      const { consolidateHalves } = await import('../../../review/claude-review/pair-consolidate.js');
      const r = await consolidateHalves(ctx, accountId, null, a, b);
      return { summary: r.summary, verdict: r.verdict, how: r.how, sourceOf: r.sourceOf, mergedFrom: r.mergedFrom };
    },
    canPush: async (ctx, accountId, repoId) => (await import('../../ai-fix/pr-context.js')).getViewerCanPush(ctx, accountId, repoId),
    pushNewBranch: async (a) => (await import('../../git-ops.js')).pushNewBranch(a),
    pushFastForward: async (a) => (await import('../../git-ops.js')).pushFastForward(a),
    openPr: async (a) => (await import('../../git-ops.js')).openPrForBranch(a),
    treeOfPatch: async (...a) => (await import('../../git-ops.js')).treeOfPatch(...a),
    liveBranchSha: async (...a) => (await import('../../git-ops.js')).liveBranchSha(...a),
    openPrOfBranch: async (...a) => (await import('../../git-ops.js')).openPrOfBranch(...a),
    commitFacts: async (...a) => (await import('../../git-ops.js')).commitFacts(...a),
    async afterPrSync(ctx, a) {
      const { linkTicket } = await import('../push.js');
      await linkTicket(ctx, a.accountId, a.repoId, a.prNumber, a.ident);
    },
    session: {
      hold: (id) => void need().then((x) => x.holdSession(key(id), 'review loop')),
      release: (id) => void need().then((x) => x.releaseSession(key(id))),
      ready: (id) => m?.hostTurnReady(key(id)) ?? false,
      live: (id) => m?.isSessionLive(id) ?? false,
      provider: (id) => m?.liveStoryIo(id)?.provider ?? null,
      startFixTurn: (id, text) => (m ? m.startHostBuildTurn(key(id), text) : 'not_live'),
      root: (id) => m?.liveStoryIo(id)?.root ?? null,
      async copyIn(id, files) {
        const io = (await need()).liveStoryIo(id);
        if (!io) return false;
        await io.copyIn(files);
        return true;
      },
      async readResponse(id, shown) {
        const io = (await need()).liveStoryIo(id);
        if (!io) return { kind: 'unreadable', reason: 'The session closed before the answers could be read.' };
        const { readReviewResponse } = await import('../../../sandbox/workspace/review-response.js');
        return readReviewResponse(io.runtime, io.container, io.root, shown);
      },
      async removeResponse(id) {
        const io = (await need()).liveStoryIo(id);
        if (!io) return;
        const { removeReviewResponse } = await import('../../../sandbox/workspace/review-response.js');
        await removeReviewResponse(io.runtime, io.container, io.root);
      },
      async resume(ctx, accountId, id) {
        const r = await (await need()).resumeSession(ctx, accountId, id);
        return r.status === 'queued' ? null : 'message' in r && typeof r.message === 'string' ? r.message : 'The session could not start again.';
      },
      async interrupt(ctx, accountId, id) {
        await (await need()).interruptSession(ctx, accountId, id).catch(() => {});
      },
      emit: (id, e) => m?.emitStoryEvent(id, e),
      notice: (id, text) => m?.noticeStory(id, text),
    },
  };
}

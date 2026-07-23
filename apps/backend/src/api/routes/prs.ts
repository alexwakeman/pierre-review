import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  AddReviewCommentBody,
  AddReviewCommentResult,
  ApprovePrBody,
  ApprovePrResult,
  CheckLogsResponse,
  CiRerunBody,
  CiRerunResult,
  ClosePrResult,
  CreatePrCommentBody,
  CreatePrCommentResult,
  MarkViewedBody,
  MergePrBody,
  MergePrResult,
  PrFileDiff,
  PrFileDiffStatus,
  PrFilesResponse,
  PrDetail,
  PrMergeOptions,
  RequestReviewersBody,
  RequestReviewersResult,
  ResolveBotThreadsBody,
  SuggestedReviewersResponse,
  UpdateBranchBody,
  UpdateBranchResult,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { getAccessToken, getAccountUserId } from '../../auth/account.js';
import { fetchActionsJobLog } from '../../github/actions-logs.js';
import {
  getMentionCandidates,
  getPrDetail,
  getPrBotBehaviour,
  getPrFilesContext,
  getPrWriteContext,
  getReviewerLogins,
  getResolvableBotThreads,
  getSuggestedReviewersBasis,
  type SuggestionBasis,
  getUsersByLogins,
  markAllViewed,
  markPrClosedLocally,
  markPrMergedLocally,
  markPrViewed,
  stampReviewRequests,
  upsertLocalPrComment,
  upsertLocalReview,
} from '../../db/queries.js';
import { enrichReviewerSuggestions } from '../../github/reviewer-suggest.js';
import {
  buildFileAnchors,
  fallbackAnchor,
  isFindingAnchored,
} from '../../github/diff-anchor.js';
import {
  addIssueComment,
  closePullRequest,
  fetchHeadShaFor,
  fetchMergeability,
  fetchPrFilesWithPatch,
  fetchPrHeadInfo,
  fetchRepoMergeConfig,
  mergePullRequest,
  postInlineComment,
  requestReviewers,
  rerunWorkflowRun,
  submitPrReview,
  updatePullRequestBranch,
} from '../../github/mutations.js';
import { hydratePrDetail } from '../../sync/hydrate-detail.js';
import { resolveThreadsOnGitHub } from '../../bot-triage/resolve.js';
import { accountIdOf } from '../plugins/auth.js';

// GitHub anchors a file in the PR "Files changed" diff by the SHA-256 of its
// path (matches db/queries.ts + hydrate-detail.ts's diffAnchorId).
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

const PR_FILE_STATUSES: readonly PrFileDiffStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'changed',
  'copied',
  'unchanged',
];

// Pass GitHub's REST file status through verbatim when it's one we model, else
// fall back to 'changed' (the catch-all GitHub itself uses).
function normalizeStatus(status: string): PrFileDiffStatus {
  return (PR_FILE_STATUSES as readonly string[]).includes(status)
    ? (status as PrFileDiffStatus)
    : 'changed';
}

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const checkLogsSchema = {
  params: {
    type: 'object',
    required: ['id', 'jobId'],
    properties: {
      id: { type: 'integer' },
      jobId: { type: 'integer', minimum: 1 },
    },
  },
  querystring: {
    type: 'object',
    properties: { tail: { type: 'integer', minimum: 1, maximum: 1000 } },
  },
};

const markViewedSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { sha: { type: 'string' } },
  },
};

const ciRerunSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['runId', 'mode'],
    additionalProperties: false,
    properties: {
      runId: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['failed', 'all'] },
    },
  },
};

const markAllViewedSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { repoIds: { type: 'array', items: { type: 'integer' } } },
  },
};

const commentSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: { body: { type: 'string' } },
  },
};

const approveSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { body: { type: 'string' } },
  },
};

const resolveBotThreadsSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['threadIds'],
    additionalProperties: false,
    properties: {
      // minItems: 1 rejects `{threadIds: []}` with a 400 — a destructive endpoint should
      // never be invoked with an empty selection (defence-in-depth with getResolvableBotThreads).
      threadIds: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 200 },
    },
  },
};

const mergeSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['method'],
    additionalProperties: false,
    properties: { method: { type: 'string', enum: ['merge', 'squash', 'rebase'] } },
  },
};

const updateBranchSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { strategy: { type: 'string', enum: ['rebase', 'merge'] } },
  },
};

const reviewCommentSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['path', 'line', 'body'],
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      line: { type: 'integer' },
      side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
      body: { type: 'string' },
    },
  },
};

const requestReviewersSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    // All three are optional; the handler 400s if the combined set is empty. `userIds`
    // are resolved to logins; `logins` pass through (suggested reviewers we haven't synced);
    // `teamSlugs` become team review requests (CODEOWNERS @org/team).
    properties: {
      userIds: { type: 'array', maxItems: 15, items: { type: 'integer' } },
      logins: { type: 'array', maxItems: 15, items: { type: 'string' } },
      teamSlugs: { type: 'array', maxItems: 15, items: { type: 'string' } },
    },
  },
};

// Build the CORE "Suggested reviewers" set for a PR — served as its OWN live query so it's
// never frozen inside the cached PR detail (it must empty the instant a reviewer is
// requested). Combines the history-USER basis (from synced data) with two best-effort,
// per-repo-cached network sources fetched in parallel:
//   • CODEOWNERS — declared ownership for the touched paths (users + teams).
//   • Team history — which team(s) are usually REQUESTED to review this repo (the behavioural
//     fallback when CODEOWNERS declares no team; repo-level, so it runs even when the PR
//     touches no owned path). See github/team-reviewers.ts.
// Returns empty when the PR doesn't warrant suggestions. Any network failure (no CODEOWNERS,
// org wall, a repo that doesn't use team requests) degrades to just the history-user set.
// Precedence: declared CODEOWNERS owners, then the inferred team(s), then history users, cap 5.
async function buildSuggestedReviewers(
  basis: SuggestionBasis,
  accountId: number,
): Promise<SuggestedReviewersResponse> {
  if (!basis.wants) return { suggestedReviewers: [], users: [] };
  const { owner, name, authorLogin, paths, suggestions, users } = basis;
  const { suggestions: merged, extraUsers } = await enrichReviewerSuggestions({
    accountId,
    owner,
    name,
    authorLogin,
    paths,
    userSuggestions: suggestions,
    knownUserIds: new Set(users.map((u) => u.id)),
    resolveUsers: getUsersByLogins,
  });
  return { suggestedReviewers: merged, users: [...users, ...extraUsers] };
}

export async function prRoutes(app: FastifyInstance): Promise<void> {
  // Bulk "mark all seen": stamp every open PR (optionally scoped to repoIds) viewed
  // at its head, clearing all new-since badges at once. Static path — no :id — so it
  // doesn't collide with /api/prs/:id.
  app.post('/api/prs/mark-all-viewed', { schema: markAllViewedSchema }, async (req) => {
    const { repoIds } = (req.body ?? {}) as { repoIds?: number[] };
    const count = await markAllViewed(
      accountIdOf(req),
      repoIds && repoIds.length > 0 ? repoIds : null,
    );
    return { status: 'ok', count };
  });

  app.get('/api/prs/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const pr = await getPrDetail(id, accountId);
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    // Cloud lean mode: fill in bulky text from GitHub (no-op in local). The client
    // caches the result in IndexedDB keyed by updatedAt so unchanged PRs don't refetch.
    // (Suggested reviewers are NOT here — they're a separate live query, see below — so the
    // cached detail never freezes a stale suggestion.)
    return hydratePrDetail(pr, accountId);
  });

  // PR-scoped bot behaviour (EXPERIMENTAL, CORE, deterministic — no AI): each automated reviewer's
  // touch timeline ON THIS PR + how it compares to that bot's OWN typical (an 84-day account-wide
  // robust baseline). Powers the PrDetail "Bot activity" tab + the Overview chip warn badge.
  // Account-scoped: 404 when the PR isn't the caller's; empty `bots` when no bot touched it.
  app.get('/api/prs/:id/bot-behaviour', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const resp = await getPrBotBehaviour(id, accountIdOf(req));
    if (!resp) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    return resp;
  });

  // Suggested reviewers — its OWN live query (not embedded in the cached PR detail) so it
  // always reflects current state: it empties the instant a reviewer is requested (the assign
  // route stamps review_requests locally), rather than staying frozen until the PR's updatedAt
  // next bumps. Best-effort network enrichment (CODEOWNERS + inferred team) on top of the
  // synced history basis. 404s when the PR isn't the caller's.
  app.get('/api/prs/:id/suggested-reviewers', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const basis = await getSuggestedReviewersBasis(id, accountId);
    if (!basis) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    const result: SuggestedReviewersResponse = await buildSuggestedReviewers(basis, accountId);
    return result;
  });

  // Candidates for an @mention autocomplete, ranked by proximity to this PR
  // (participants first, then repo people), self + bots excluded. Account-scoped:
  // 404 when the PR isn't the caller's.
  app.get('/api/prs/:id/mention-candidates', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const candidates = await getMentionCandidates(id, accountIdOf(req));
    if (!candidates) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    return candidates;
  });

  // Record that the local user has seen this PR up to `sha` (defaults to the
  // current head). Clears "new since last viewed" badges.
  app.post(
    '/api/prs/:id/mark-viewed',
    { schema: markViewedSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { sha } = (req.body ?? {}) as MarkViewedBody;
      const ok = await markPrViewed(id, accountIdOf(req), sha);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Explicit "I've seen this" without opening — same effect as mark-viewed.
  app.post(
    '/api/prs/:id/dismiss',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const ok = await markPrViewed(id, accountIdOf(req));
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Bulk-resolve the review-BOT threads a later commit has likely addressed — Pierre's
  // "clear the bot backlog in one click." NEVER automatic: the client sends the explicit
  // reviewed list of thread ids; the server RE-DERIVES the eligible set (owned + bot-
  // originated + `likely_addressed`), intersects it with that list, and resolves only that
  // — so a stale client can never resolve a thread the server wouldn't itself offer. Each
  // thread is resolved on GitHub + locally stamped; per-thread failures are reported, not fatal.
  app.post(
    '/api/prs/:id/resolve-bot-threads',
    { schema: resolveBotThreadsSchema },
    async (req) => {
      const { id } = req.params as { id: number };
      const { threadIds } = req.body as ResolveBotThreadsBody;
      const accountId = accountIdOf(req);

      // Server RE-DERIVES the eligible set (owned + automated-reviewer-originated +
      // `likely_addressed` + unresolved) ∩ the client's reviewed list, then resolves each via
      // the shared helper (the SAME code path the scope-wide resolve uses). An empty
      // eligible set — PR not owned / no such threads / a fully-stale client list — is a no-op,
      // not an error (the helper short-circuits before any token fetch). Status stays 200 even
      // on partial failure; the body carries per-thread outcomes.
      const eligible = await getResolvableBotThreads(id, accountId, threadIds);
      return resolveThreadsOnGitHub(accountId, eligible);
    },
  );

  // Post a new issue-level (general) PR comment, then optimistically stamp it
  // locally so it shows before the next sync.
  app.post(
    '/api/prs/:id/comment',
    { schema: commentSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { body } = req.body as CreatePrCommentBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await addIssueComment(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
          body,
        );
        const authorId = await getAccountUserId(accountId);
        const rowId = await upsertLocalPrComment(ctx.prId, authorId, gh);
        const result: CreatePrCommentResult = {
          id: rowId,
          authorId,
          body: gh.body,
          createdAt: new Date(gh.createdAt).toISOString(),
          url: gh.url,
        };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Approve the PR. Server re-checks (matching getPrDetail.viewerCanApprove) that
  // the viewer has write+ permission and isn't the author; else 403. On success
  // submits an APPROVE review and stamps it locally. A GitHub 422 (e.g. a
  // self-approve race) bubbles to the 502 catch.
  app.post(
    '/api/prs/:id/approve',
    { schema: approveSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { body } = (req.body ?? {}) as ApprovePrBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      const viewerUserId = await getAccountUserId(accountId);
      const canApprove =
        viewerUserId != null &&
        viewerUserId !== ctx.authorId &&
        ['WRITE', 'MAINTAIN', 'ADMIN'].includes(ctx.viewerPermission ?? '');
      if (!canApprove) {
        reply.status(403);
        return {
          error: 'NotPermitted',
          message:
            'You need write access to this repo and cannot approve your own PR.',
        };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await submitPrReview(token, ctx.owner, ctx.name, ctx.number, {
          event: 'APPROVE',
          body,
        });
        const rowId = await upsertLocalReview(ctx.prId, viewerUserId, gh);
        const result: ApprovePrResult = {
          id: rowId,
          authorId: viewerUserId,
          state: 'approved',
          body: gh.body,
          submittedAt: new Date(gh.submittedAt).toISOString(),
          url: gh.url,
        };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // ---- Merge (CORE / free tier) ----

  // The merge control's options — the repo's enabled merge methods + GitHub's live mergeability.
  // Fetched lazily (only when the control opens) so the hot PR-detail path isn't slowed by a
  // live GitHub call. Ownership-scoped via getPrWriteContext (→ 404).
  app.get('/api/prs/:id/merge-options', async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const ctx = await getPrWriteContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    try {
      const token = await getAccessToken(accountId);
      const [cfg, m] = await Promise.all([
        fetchRepoMergeConfig(token, ctx.owner, ctx.name),
        fetchMergeability(token, ctx.owner, ctx.name, ctx.number),
      ]);
      const allowedMethods = (['merge', 'squash', 'rebase'] as const).filter((meth) =>
        meth === 'merge'
          ? cfg.allowMergeCommit
          : meth === 'squash'
            ? cfg.allowSquashMerge
            : cfg.allowRebaseMerge,
      );
      const conflicts = m.mergeable === false || m.mergeableState === 'dirty';
      const behind = m.mergeableState === 'behind' || m.behindBy > 0;
      const result: PrMergeOptions = {
        allowedMethods: [...allowedMethods],
        defaultMethod: allowedMethods[0] ?? 'merge',
        mergeable: m.mergeable,
        mergeStateStatus: m.mergeableState,
        conflicts,
        behind,
        blocked: m.mergeableState === 'blocked',
        behindBy: m.behindBy,
        baseRef: m.baseRef,
        canUpdateBranch: behind && !conflicts,
        canRebaseUpdate: !config.isCloud,
      };
      return result;
    } catch (err) {
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Merge the PR (native GitHub merge; merge/squash/rebase). Re-checks write+ permission
  // (author allowed — GitHub lets an author merge their own PR) and pre-checks conflicts, then
  // pins the merge to the current head SHA (409 if it moved). Optimistically stamps merged.
  app.post('/api/prs/:id/merge', { schema: mergeSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { method } = req.body as MergePrBody;
    const accountId = accountIdOf(req);

    const ctx = await getPrWriteContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(ctx.viewerPermission ?? '')) {
      reply.status(403);
      return { error: 'NotPermitted', message: 'You need write access to merge this PR.' };
    }

    try {
      const token = await getAccessToken(accountId);
      // Live conflict pre-check — never attempt a merge on a conflicting PR (no free-tier
      // resolution). GitHub would 405 anyway; a 409 here is clearer.
      const m = await fetchMergeability(token, ctx.owner, ctx.name, ctx.number);
      if (m.mergeable === false || m.mergeableState === 'dirty') {
        reply.status(409);
        return {
          error: 'Conflicts',
          conflicts: true,
          message: 'This PR conflicts with the base branch — resolve the conflicts on GitHub.',
        };
      }
      const info = await fetchPrHeadInfo(token, ctx.owner, ctx.name, ctx.number);
      const out = await mergePullRequest(token, ctx.owner, ctx.name, ctx.number, {
        method,
        expectedHeadSha: info.headSha,
      });
      if (!out.ok) {
        const status = out.reason === 'method_disallowed' ? 422 : 409;
        reply.status(status);
        return {
          error:
            out.reason === 'head_moved'
              ? 'HeadMoved'
              : out.reason === 'method_disallowed'
                ? 'MethodNotAllowed'
                : 'NotMergeable',
          message: out.message,
        };
      }
      const viewerUserId = await getAccountUserId(accountId);
      await markPrMergedLocally(id, accountId, viewerUserId);
      const result: MergePrResult = { merged: true, sha: out.sha, state: 'merged' };
      return result;
    } catch (err) {
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Close a PR WITHOUT merging (CORE / free tier). Reversible on GitHub (reopen), so no
  // head-SHA pin. Permitted for anyone with WRITE+ OR the PR author (GitHub's own rule),
  // mirrored by viewerCanClose on the detail payload; re-checked here. Only an OPEN PR can be
  // closed (a merged/closed one → 409). Optimistically stamps state='closed'.
  app.post('/api/prs/:id/close', async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);

    const ctx = await getPrWriteContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    const viewerUserId = await getAccountUserId(accountId);
    const canClose =
      ['WRITE', 'MAINTAIN', 'ADMIN'].includes(ctx.viewerPermission ?? '') ||
      (viewerUserId != null && viewerUserId === ctx.authorId);
    if (!canClose) {
      reply.status(403);
      return {
        error: 'NotPermitted',
        message: 'You need write access or to be the PR author to close this PR.',
      };
    }
    if (ctx.state !== 'open') {
      reply.status(409);
      return {
        error: 'NotOpen',
        message: `This PR is already ${ctx.state}.`,
      };
    }

    try {
      const token = await getAccessToken(accountId);
      const out = await closePullRequest(token, ctx.owner, ctx.name, ctx.number);
      if (!out.ok) {
        reply.status(out.reason === 'not_found' ? 404 : 502);
        return {
          error: out.reason === 'not_found' ? 'NotFound' : 'GitHubError',
          message: out.message,
        };
      }
      await markPrClosedLocally(id, accountId);
      const result: ClosePrResult = { closed: true, state: 'closed' };
      return result;
    } catch (err) {
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Update the PR's branch from the base/trunk before merging. Local: clone-based rebase
  // (default) or merge, aborting on ANY conflict (no free-tier resolution → 409). Cloud: GitHub's
  // native update-branch (merge-only, clone-free). Gated on write+ permission.
  app.post('/api/prs/:id/update-branch', { schema: updateBranchSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { strategy } = (req.body ?? {}) as UpdateBranchBody;
    const accountId = accountIdOf(req);

    const ctx = await getPrWriteContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(ctx.viewerPermission ?? '')) {
      reply.status(403);
      return { error: 'NotPermitted', message: 'You need write access to update this branch.' };
    }

    try {
      const token = await getAccessToken(accountId);
      // Never attempt an update on a conflicting PR — conflict resolution is a Pro feature.
      const m = await fetchMergeability(token, ctx.owner, ctx.name, ctx.number);
      if (m.mergeable === false || m.mergeableState === 'dirty') {
        reply.status(409);
        return {
          error: 'Conflicts',
          conflicts: true,
          message:
            'This PR conflicts with the base branch. Resolving conflicts isn’t available on the free tier — resolve them on GitHub.',
        };
      }
      const info = await fetchPrHeadInfo(token, ctx.owner, ctx.name, ctx.number);

      if (config.isCloud) {
        // Cloud: native update-branch (merge trunk in). No clone/git on the host.
        const out = await updatePullRequestBranch(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
          info.headSha,
        );
        if (!out.ok) {
          reply.status(409);
          return out.reason === 'head_moved'
            ? { error: 'HeadMoved', headMoved: true, message: out.message }
            : { error: 'Conflicts', conflicts: true, message: out.message };
        }
        const result: UpdateBranchResult = { ok: true, headSha: null, strategy: 'merge' };
        return result;
      }

      // Local: clone-based rebase (default) or merge from trunk, autoResolve:false. Dynamic
      // import so the clone/git machinery is only loaded on this path (never in cloud).
      const strat = strategy === 'merge' ? 'merge' : 'rebase';
      const { updatePrBranchFromTrunk } = await import('../../coding/merge.js');
      const out = await updatePrBranchFromTrunk({
        accountId,
        owner: ctx.owner,
        name: ctx.name,
        prNumber: ctx.number,
        headRef: info.headRef,
        headSha: info.headSha,
        trunk: info.baseRef,
        strategy: strat,
      });
      const result: UpdateBranchResult = { ok: true, headSha: out.headSha, strategy: out.strategy };
      return result;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'CONFLICTS_UNRESOLVED') {
        reply.status(409);
        return {
          error: 'Conflicts',
          conflicts: true,
          message:
            'This PR conflicts with the base branch. Resolving conflicts isn’t available on the free tier — resolve them on GitHub.',
        };
      }
      if (code === 'HEAD_MOVED') {
        reply.status(409);
        return { error: 'HeadMoved', headMoved: true, message: (err as Error).message };
      }
      if (code === 'PUSH_DENIED') {
        reply.status(403);
        return { error: 'NotPermitted', message: (err as Error).message };
      }
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Add ONE inline review comment, posted immediately. Validates the requested
  // (path, line, side) lands on an addable diff line; if not, re-anchors to the
  // file's first changed line; if the file has no changes at all, returns a
  // not-anchored result without posting.
  app.post(
    '/api/prs/:id/review-comment',
    { schema: reviewCommentSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { path, line, body } = req.body as AddReviewCommentBody;
      const side: 'LEFT' | 'RIGHT' =
        (req.body as AddReviewCommentBody).side ?? 'RIGHT';
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        // Resolve the LIVE head (not the possibly-stale DB head): commit_id must
        // pin to the same commit whose diff we validate the line against below,
        // or GitHub 422s the line as "not part of the diff".
        const head = await fetchHeadShaFor(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
        );

        // Find the requested file's REST patch (header-less) to validate anchoring.
        const { files } = await fetchPrFilesWithPatch(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
        );
        const file = files.find((f) => f.filename === path);
        const anchors = buildFileAnchors(path, file?.patch ?? null);
        // A single-file AnchorIndex for the pure helpers.
        const index = new Map([[path, anchors]]);

        let finalLine = line;
        let finalSide = side;
        let anchored = true;
        if (!isFindingAnchored(index, path, line, side)) {
          const fb = fallbackAnchor(index, path);
          if (!fb) {
            // The file has no changes in the diff → can't post inline.
            const result: AddReviewCommentResult = {
              commentId: null,
              url: null,
              line,
              side,
              anchored: false,
            };
            return result;
          }
          finalLine = fb.line;
          finalSide = fb.side;
          anchored = false;
        }

        const gh = await postInlineComment(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
          { commitId: head, path, line: finalLine, side: finalSide, body },
        );
        const result: AddReviewCommentResult = {
          commentId: gh.databaseId,
          url: gh.url,
          line: finalLine,
          side: finalSide,
          anchored,
        };
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A 422 means GitHub rejected the line as not part of the diff (e.g. the
        // head shifted between our diff fetch and the post). Surface it as the
        // structured "couldn't place" result so the FE's recovery UX engages
        // (open on GitHub) instead of a generic error toast.
        if (/->\s*422\b/.test(message)) {
          const result: AddReviewCommentResult = {
            commentId: null,
            url: null,
            line,
            side,
            anchored: false,
          };
          return result;
        }
        reply.status(502);
        return { error: 'GitHubError', message };
      }
    },
  );

  // Changes tab: per-file diff patches, loaded on demand. Degrades to an empty
  // list on a GitHub fetch error (never 500s) so the tab fails gracefully.
  app.get('/api/prs/:id/files', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);

    const ctx = await getPrFilesContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }

    try {
      const token = await getAccessToken(accountId);
      const { files, truncated } = await fetchPrFilesWithPatch(
        token,
        ctx.owner,
        ctx.name,
        ctx.number,
      );
      const mapped: PrFileDiff[] = files.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: normalizeStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
        githubUrl: `${ctx.prUrl}/files#diff-${diffAnchorId(f.filename)}`,
        blobUrl: f.blob_url,
      }));
      const result: PrFilesResponse = { files: mapped, truncated };
      return result;
    } catch {
      // Graceful degrade — the Changes tab shows "no files" rather than 500ing.
      const result: PrFilesResponse = { files: [], truncated: false };
      return result;
    }
  });

  // Failed-check logs: the tail of a GitHub Actions job's log, fetched live (never
  // stored). The jobId comes from CheckRun.jobId (parsed from the Actions detailsUrl);
  // only Actions checks have one, so the frontend offers this on failed Actions rows.
  // Degrades to {available:false, reason} on any GitHub error (expired logs, no
  // actions:read, network) instead of 500ing.
  app.get(
    '/api/prs/:id/checks/:jobId/logs',
    { schema: checkLogsSchema },
    async (req, reply) => {
      const { id, jobId } = req.params as { id: number; jobId: number };
      const { tail } = req.query as { tail?: number };
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      const token = await getAccessToken(accountId);
      const result: CheckLogsResponse = await fetchActionsJobLog(
        token,
        ctx.owner,
        ctx.name,
        jobId,
        tail ?? 200,
      );
      return result;
    },
  );

  // Re-trigger a GitHub Actions workflow run for this PR. The `runId` comes from
  // CheckRun.runId (Actions checks only). Server re-checks write access (WRITE/
  // MAINTAIN/ADMIN, matching viewerCanPush — no author exclusion, unlike approve),
  // then queues the rerun via the per-account token (local + cloud). GitHub runs it
  // asynchronously; the refreshed check states arrive on the next sync.
  app.post(
    '/api/prs/:id/ci/rerun',
    { schema: ciRerunSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { runId, mode } = req.body as CiRerunBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      const canRerun = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(
        ctx.viewerPermission ?? '',
      );
      if (!canRerun) {
        reply.status(403);
        return {
          error: 'NotPermitted',
          message: 'You need write access to this repo to re-run CI.',
        };
      }

      try {
        const token = await getAccessToken(accountId);
        await rerunWorkflowRun(token, ctx.owner, ctx.name, runId, mode);
        const result: CiRerunResult = { status: 'queued', runId, mode };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Request reviewers on a PR (powers the Insights "Assign reviewers" action). Server
  // re-checks write access (WRITE/MAINTAIN/ADMIN — push-style, no author exclusion:
  // an author may request reviewers on their own PR). The given user ids are resolved
  // to GitHub logins (the PR author + bots + unknown ids dropped); GitHub itself gates
  // that each login is a repo collaborator. The refreshed request state arrives on the
  // next sync (reviewRequests are re-derived each pass).
  app.post(
    '/api/prs/:id/request-reviewers',
    { schema: requestReviewersSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const {
        userIds = [],
        logins: directLogins = [],
        teamSlugs = [],
      } = req.body as RequestReviewersBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      const canRequest = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(
        ctx.viewerPermission ?? '',
      );
      if (!canRequest) {
        reply.status(403);
        return {
          error: 'NotPermitted',
          message: 'You need write access to this repo to request reviewers.',
        };
      }

      // Drop the PR author from the id set (GitHub rejects self-review requests), then
      // resolve to logins (also drops bots + unknown ids). Union with any direct logins
      // (suggested reviewers we haven't synced as users), deduped.
      const wanted = userIds.filter((uid) => uid !== ctx.authorId);
      const resolved = await getReviewerLogins(wanted); // [{ userId, login }]
      const resolvedLogins = resolved.map((r) => r.login);
      const logins = [...new Set([...resolvedLogins, ...directLogins])];
      const teams = [...new Set(teamSlugs)];
      if (logins.length === 0 && teams.length === 0) {
        reply.status(400);
        return {
          error: 'NoReviewers',
          message: 'None of the selected users or teams can be requested as reviewers.',
        };
      }

      try {
        const token = await getAccessToken(accountId);
        await requestReviewers(token, ctx.owner, ctx.name, ctx.number, logins, teams);
        // Optimistically stamp the request locally (mirrors approve/comment/merge) so the
        // "Requested" row + the suggestion gate reflect it immediately; the next sync
        // re-derives review_requests idempotently. Team handle = `owner/slug` (matches how a
        // CODEOWNERS team + the suggestion render). Only the synced-user ids are stamped;
        // unsynced direct logins land on the next sync.
        await stampReviewRequests(
          ctx.prId,
          resolved.map((r) => r.userId),
          teams.map((slug) => `${ctx.owner}/${slug}`),
        );
        const result: RequestReviewersResult = {
          status: 'ok',
          requestedLogins: logins,
        };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

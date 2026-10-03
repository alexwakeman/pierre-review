import type { FastifyInstance } from 'fastify';
import {
  AI_FIX_MAX_INSTRUCTION_CHARS,
  CLAUDE_REVIEW_MODELS,
  DEFAULT_AI_FIX_MODEL,
  PRODUCT_NAME,
} from '@pierre-review/shared';
import type {
  AiFix,
  AiFixModel,
  AiFixPushBody,
  AiFixPushResult,
  AiFixResponse,
  AiFixSeed,
  AiFixStatus,
  AiFixStreamEvent,
  AiFixSummary,
  GenerateFixBody,
  PrHeadInfo,
} from '@pierre-review/shared';
import type { ApplyAndPushTarget } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { config } from '../../config.js';
import { getFixPrContext, getViewerCanPush } from './pr-context.js';
import {
  getFixStatus,
  requestFixCancel,
  startFix,
  subscribeFixStream,
} from './manager.js';
import {
  getFixById,
  getLatestFix,
  listFixHistory,
  markFixPushed,
  parseChangeReport,
  parseFilesChanged,
  parseReviewItems,
  parseTrigger,
  type AiFixRow,
} from './persist.js';

// AI Fix's agentic-fixer routes (CORE, free, LOCAL ONLY — the fixer left the plugin with Claude
// Review). ⚠ THE PATHS KEEP THEIR HISTORICAL `/api/pro/` PREFIX (`/api/pro/prs/:id/ai-fix*`,
// `/api/pro/ai-fixes/:fixId*`) so the SPA client did not move; nothing about them is paid. They
// are registered only by `registerAgenticRoutes` (review/agentic.ts), which refuses in cloud and
// under LIMN_AI_DISABLED — and in cloud the auth plugin's `isProPath` 402 is a second guard on the
// prefix anyway. The PR summary (`/api/pro/prs/:id/summary*`) is Pro and STAYED in the plugin.
// Every handler resolves accountId =
// ctx.accountIdOf(req) and verifies PR ownership.

const AIFIX_ENABLED = config.aiEnabled;

function tsToIso(v: Date | number | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(Number(v));
  return d.toISOString();
}

// The model a fix run uses. Validated HERE, in the handler, and not by an ajv body schema:
// Fastify's ajv runs with `removeAdditional`, so a schema that did not declare every key would
// silently strip `seed` / `instruction` / `sourceReviewId` (the contact-form honeypot landmine).
// The body has no schema at all, so `model` may be any JSON value — hence the `typeof`.
//   absent / null            → DEFAULT_AI_FIX_MODEL
//   a string on the offered list → that model
//   anything else (a retired id such as the old Opus, a typo, a number) → null ⇒ 400
function resolveFixModel(raw: unknown): AiFixModel | null {
  if (raw == null) return DEFAULT_AI_FIX_MODEL;
  if (typeof raw !== 'string') return null;
  return (CLAUDE_REVIEW_MODELS as readonly string[]).includes(raw)
    ? (raw as AiFixModel)
    : null;
}

function rowToAiFix(row: AiFixRow): AiFix {
  return {
    id: row.id,
    prId: row.prId,
    status: row.status,
    model: row.model,
    seed: row.seed,
    summary: row.summary,
    commitMessage: row.commitMessage,
    patch: row.patch,
    filesChanged: parseFilesChanged(row.filesChanged),
    baseSha: row.baseSha,
    // Null on an unparseable blob too: this getter loads the whole AI Fix tab and must not throw.
    // A row from a REMOVED seed ('comments' / 'ci_analysis') reads like any other, as history.
    trigger: parseTrigger(row.trigger),
    reviewItems: parseReviewItems(row.reviewItems),
    changeReport: parseChangeReport(row.changeReport),
    sourceReviewId: row.sourceReviewId,
    costUsd: row.costUsd,
    numTurns: row.numTurns,
    error: row.error,
    pushedBranch: row.pushedBranch,
    pushedPrNumber: row.pushedPrNumber,
    pushedPrUrl: row.pushedPrUrl,
    pushedAt: tsToIso(row.pushedAt),
    createdAt: tsToIso(row.createdAt) ?? new Date(0).toISOString(),
    finishedAt: tsToIso(row.finishedAt),
  };
}

function rowToSummary(row: AiFixRow): AiFixSummary {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    seed: row.seed,
    commitMessage: row.commitMessage,
    filesChanged: parseFilesChanged(row.filesChanged),
    pushedBranch: row.pushedBranch,
    pushedPrNumber: row.pushedPrNumber,
    pushedPrUrl: row.pushedPrUrl,
    pushedAt: tsToIso(row.pushedAt),
    createdAt: tsToIso(row.createdAt) ?? new Date(0).toISOString(),
    finishedAt: tsToIso(row.finishedAt),
  };
}

// A safe git branch name derived from the PR's head ref.
function suggestBranch(headRef: string): string {
  const base = headRef.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'pr'}-ai-fix`;
}

export function registerAiFixRoutes(app: FastifyInstance, ctx: AgentContext): void {
  const parseId = (raw: string): number | null => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  };

  // ---- The agentic fixer (aiFix) ----

  // GET latest fix + history + auth + write access + live head/fork info.
  app.get<{ Params: { id: string } }>(
    '/api/pro/prs/:id/ai-fix',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });

      const pr = await getFixPrContext(ctx, accountId, prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });

      if (!AIFIX_ENABLED) {
        const resp: AiFixResponse = {
          enabled: false,
          auth: 'none',
          viewerCanPush: false,
          headInfo: null,
          fix: null,
          history: [],
        };
        return reply.send(resp);
      }

      const auth = ctx.llm.detectAuth();
      const viewerCanPush = await getViewerCanPush(ctx, accountId, pr.repoId);
      const latest = await getLatestFix(ctx, accountId, prId);
      const history = await listFixHistory(ctx, accountId, prId);

      let headInfo: PrHeadInfo | null = null;
      try {
        const h = await ctx.github.fetchPrHeadInfo(
          accountId,
          pr.owner,
          pr.name,
          pr.number,
        );
        headInfo = {
          ...h,
          canPushSameBranch:
            viewerCanPush && (!h.isFork || h.maintainerCanModify),
          suggestedBranch: suggestBranch(h.headRef),
        };
      } catch {
        headInfo = null;
      }

      const resp: AiFixResponse = {
        enabled: true,
        auth: auth.status,
        authMessage: auth.status === 'none' ? auth.message : undefined,
        viewerCanPush,
        headInfo,
        fix: latest ? rowToAiFix(latest) : null,
        history: history.map(rowToSummary),
      };
      return reply.send(resp);
    },
  );

  // Start a fix run.
  app.post<{ Params: { id: string }; Body?: GenerateFixBody }>(
    '/api/pro/prs/:id/ai-fix',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });
      if (!AIFIX_ENABLED)
        return reply.code(404).send({ error: 'AiFixDisabled' });

      const body = req.body ?? ({} as GenerateFixBody);
      const model = resolveFixModel((body as { model?: unknown }).model);
      if (model == null) {
        return reply.code(400).send({
          error: 'ModelNotOffered',
          message: 'That model is no longer offered.',
        });
      }
      // Two entry points. The removed ones get a sentence a stale tab can show, not a run.
      const rawSeed = (body as { seed?: unknown }).seed ?? 'plain';
      if (rawSeed === 'comments' || rawSeed === 'ci_analysis') {
        return reply.code(400).send({
          error: 'SeedRemoved',
          message: 'That kind of fix is no longer offered. Reload the page.',
        });
      }
      if (rawSeed !== 'review' && rawSeed !== 'plain') {
        return reply.code(400).send({ error: 'UnknownSeed', message: 'Unknown fix type.' });
      }
      const seed: AiFixSeed = rawSeed;

      let instruction: string | undefined;
      let sourceReviewId: number | null = null;
      if (seed === 'plain') {
        const raw = (body as { instruction?: unknown }).instruction;
        instruction = typeof raw === 'string' ? raw.trim() : '';
        if (instruction === '') {
          return reply.code(400).send({
            error: 'InstructionRequired',
            message: 'Say what to fix.',
          });
        }
        if (instruction.length > AI_FIX_MAX_INSTRUCTION_CHARS) {
          return reply.code(400).send({
            error: 'InstructionTooLong',
            message: `Keep the instruction under ${AI_FIX_MAX_INSTRUCTION_CHARS.toLocaleString('en-US')} characters.`,
          });
        }
      } else {
        const raw = (body as { sourceReviewId?: unknown }).sourceReviewId;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
          return reply.code(400).send({
            error: 'ReviewRequired',
            message: 'Pick a Claude review to fix from.',
          });
        }
        sourceReviewId = raw;
      }

      const res = await startFix(ctx, {
        accountId,
        prId,
        model,
        seed,
        instruction,
        // The SERVER builds the review seed from the stored run (manager.ts `loadReviewSeed`,
        // which also checks it is THIS PR's succeeded review). No review text travels in the body.
        sourceReviewId,
        trigger: 'manual',
      });

      switch (res.status) {
        case 'queued':
          return reply.code(202).send({ fixId: res.fixId, status: 'queued' });
        case 'already_running':
          return reply.code(409).send({ error: 'AlreadyRunning' });
        case 'busy':
          return reply.code(409).send({ error: 'Busy' });
        case 'no_auth':
          return reply
            .code(400)
            .send({ error: 'NoClaudeAuth', message: res.message });
        case 'credits_exhausted':
          return reply.code(402).send({
            error: 'CreditsExhausted',
            message: 'Out of monthly agentic AI credits — resets on the 1st.',
          });
        case 'no_head':
          return reply.code(400).send({ error: 'NoHead' });
        case 'no_instruction':
          return reply.code(400).send({ error: 'InstructionRequired', message: 'Say what to fix.' });
        case 'review_unavailable':
          return reply.code(409).send({
            error: 'ReviewUnavailable',
            message: 'That review is not available. Run a Claude review on this PR first.',
          });
        case 'nothing_to_fix':
          return reply.code(409).send({
            error: 'NothingToFix',
            message: 'The review found nothing to fix.',
          });
        default:
          return reply.code(404).send({ error: 'not found' });
      }
    },
  );

  // Poll status.
  app.get<{ Params: { id: string } }>(
    '/api/pro/prs/:id/ai-fix/status',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });
      const status = await getFixStatus(ctx, accountId, prId);
      return reply.send(status);
    },
  );

  // SSE progress stream.
  app.get<{ Params: { id: string } }>(
    '/api/pro/prs/:id/ai-fix/stream',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });

      // Ownership BEFORE hijack (can't 404 cleanly after).
      const pr = await getFixPrContext(ctx, accountId, prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (e: AiFixStreamEvent): void => {
        if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
      };

      let closed = false;
      const hb = setInterval(() => {
        if (!raw.writableEnded) raw.write(': hb\n\n');
      }, 15000);
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsub();
        if (!raw.writableEnded) raw.end();
      };
      // Subscribe BEFORE the snapshot so a terminal 'done' can't slip through the gap.
      const unsub = subscribeFixStream(prId, (e) => {
        send(e);
        if (e.type === 'done') cleanup();
      });
      req.raw.on('close', cleanup);

      const snap = await getFixStatus(ctx, accountId, prId);
      send({
        type: 'snapshot',
        status: snap.status,
        fixId: snap.fixId,
        progress: snap.progress,
      });
      if (snap.status !== 'running' && snap.status !== 'queued') {
        send({ type: 'done', status: snap.status, fixId: snap.fixId });
        cleanup();
      }
    },
  );

  // Cancel a running/queued fix.
  app.post<{ Params: { id: string } }>(
    '/api/pro/prs/:id/ai-fix/cancel',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });
      // Ownership.
      const pr = await getFixPrContext(ctx, accountId, prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });
      const cancelled = requestFixCancel(ctx, prId);
      return reply.send({ status: cancelled ? 'cancelling' : 'idle' });
    },
  );

  // Get a specific fix (scoped).
  app.get<{ Params: { fixId: string } }>(
    '/api/pro/ai-fixes/:fixId',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const fixId = parseId(req.params.fixId);
      if (fixId == null) return reply.code(404).send({ error: 'not found' });
      const row = await getFixById(ctx, accountId, fixId);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const pr = await getFixPrContext(ctx, accountId, row.prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });
      return reply.send(rowToAiFix(row));
    },
  );

  // Push a completed fix, as-is. Synchronous, never force-pushes: onto the PR's own head branch
  // (refused with HeadMoved if that branch moved since the fix was generated) or onto a NEW
  // branch with a PR opened against the base. There is no trunk step before it — the rebase /
  // merge / "let Claude resolve conflicts" paths and the on-mount trunk check were removed, and
  // a fix that conflicts with the trunk pushes as it is and shows as conflicted on GitHub.
  app.post<{ Params: { fixId: string }; Body?: AiFixPushBody }>(
    '/api/pro/ai-fixes/:fixId/push',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const fixId = parseId(req.params.fixId);
      if (fixId == null) return reply.code(404).send({ error: 'not found' });
      if (!AIFIX_ENABLED)
        return reply.code(404).send({ error: 'AiFixDisabled' });

      const body = req.body ?? ({ target: 'new' } as AiFixPushBody);
      // A tab still running the OLD bundle sends `strategy: 'merge' | 'rebase'` from buttons that
      // no longer exist. Refuse it loudly instead of quietly doing a plain push the reader did not
      // click. `strategy: 'plain'` (the old bundle's Push button) and no strategy both push as-is;
      // an old `autoResolve` / `model` is ignored.
      const strategy = (body as { strategy?: unknown }).strategy;
      if (strategy != null && strategy !== 'plain') {
        return reply.code(400).send({
          error: 'UnsupportedStrategy',
          message: 'Reload the page to push this fix.',
        });
      }

      const row = await getFixById(ctx, accountId, fixId);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (row.status !== 'succeeded' || !row.patch || !row.baseSha)
        return reply.code(409).send({ error: 'NotPushable' });

      const pr = await getFixPrContext(ctx, accountId, row.prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });

      const viewerCanPush = await getViewerCanPush(ctx, accountId, pr.repoId);
      if (!viewerCanPush)
        return reply.code(403).send({ error: 'NoWriteAccess' });

      const commitMessage = row.commitMessage ?? 'AI fix';

      // Build the push target (the PR's head branch, or a new branch + PR).
      let target: ApplyAndPushTarget;
      if (body.target === 'existing') {
        const head = await ctx.github
          .fetchPrHeadInfo(accountId, pr.owner, pr.name, pr.number)
          .catch(() => null);
        if (!head) return reply.code(400).send({ error: 'HeadUnavailable' });
        target = { kind: 'existing', headRef: head.headRef };
      } else {
        const branch = (body.branch ?? '').trim();
        if (!branch) return reply.code(400).send({ error: 'BranchRequired' });
        // This body lands on GitHub, where it is read by people who have never seen this app —
        // so it names the PRODUCT, not the npm package. Nothing detects on this string (the
        // provenance marker is `review/post-seam.ts`'s hidden comment, on reviews, not PRs).
        const prBody = `${row.summary ?? ''}\n\n---\nAutomated fix for #${pr.number}, generated by ${PRODUCT_NAME} AI Fix.`;
        target = {
          kind: 'new',
          branch,
          base: pr.baseRefName ?? pr.defaultBranch ?? 'main',
          title: commitMessage,
          body: prBody,
        };
      }

      try {
        const result = await ctx.coding.applyAndPush({
          accountId,
          owner: pr.owner,
          name: pr.name,
          prNumber: pr.number,
          baseSha: row.baseSha,
          patch: row.patch,
          commitMessage,
          target,
        });
        await markFixPushed(ctx, fixId, {
          pushedBranch: result.pushedBranch,
          pushedPrNumber: result.prNumber,
          pushedPrUrl: result.prUrl,
        });
        const resp: AiFixPushResult = result;
        return reply.send(resp);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'HEAD_MOVED')
          return reply.code(409).send({ error: 'HeadMoved', message });
        if (code === 'PUSH_DENIED' || code === 'APPLY_FAILED')
          return reply.code(422).send({ error: code, message });
        ctx.log.warn({ err }, 'ai-fix push failed');
        return reply.code(500).send({ error: 'PushFailed', message });
      }
    },
  );
}

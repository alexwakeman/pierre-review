import type { FastifyInstance } from 'fastify';
import {
  AI_FIX_MAX_INSTRUCTION_CHARS,
  CLAUDE_REVIEW_MODELS,
  DEFAULT_AI_FIX_MODEL,
} from '@pierre-review/shared';
import type {
  AiFix,
  AiFixModel,
  AiFixPickerPreview,
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
import type { AgentContext } from '../../review/agent-context.js';
import { config } from '../../config.js';
import { getFixPrContext, getViewerCanPush } from './pr-context.js';
import {
  getFixStatus,
  loadFixPreview,
  requestFixCancel,
  startFix,
  subscribeFixStream,
} from './manager.js';
import { pushFix } from './push.js';
import { getLatestSucceededReviewId } from '../../review/claude-review/persist.js';
import {
  getFixById,
  getLatestFix,
  listFixHistory,
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
// The longest `include` list the start route takes (far above any real review's item count).
const MAX_INCLUDE_KEYS = 500;

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
      let include: string[] | null = null;
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
        // The fix picker's selection: picker keys. Absent ⇒ the server's defaults. Anything but an
        // array of short strings is a 400; an unknown key is ignored (it selects nothing).
        const inc = (body as { include?: unknown }).include;
        if (inc !== undefined) {
          if (
            !Array.isArray(inc) ||
            inc.length > MAX_INCLUDE_KEYS ||
            !inc.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 200)
          ) {
            return reply.code(400).send({ error: 'BadSelection', message: 'Pick what to fix again.' });
          }
          include = inc as string[];
        }
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
        selection: include ? { kind: 'keys', keys: include } : undefined,
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
            message: include ? 'Nothing is ticked.' : 'The review found nothing to fix.',
          });
        default:
          return reply.code(404).send({ error: 'not found' });
      }
    },
  );

  // The fix picker: every item a review-seeded fix would include, with stable keys and defaults.
  // DB-only (no GitHub call, no model).
  app.get<{ Params: { id: string }; Querystring: { sourceReviewId?: string } }>(
    '/api/pro/prs/:id/ai-fix/preview',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(404).send({ error: 'not found' });
      if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
      // No id ⇒ the PR's latest SUCCEEDED review (a failed newer run never hides it); a malformed
      // id is still a 400.
      const raw = req.query.sourceReviewId;
      const given = raw != null && raw !== '';
      const picked = given ? parseId(raw) : null;
      if (given && (picked == null || picked <= 0))
        return reply.code(400).send({ error: 'ReviewRequired', message: 'Pick a Claude review to fix from.' });
      const pr = await getFixPrContext(ctx, accountId, prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });
      const reviewId = picked ?? (await getLatestSucceededReviewId(ctx, prId, accountId));
      if (reviewId == null)
        return reply.code(409).send({
          error: 'ReviewUnavailable',
          message: 'Run a Claude review on this PR first.',
        });
      const preview = await loadFixPreview(ctx, { accountId, prId, reviewId });
      if (!preview)
        return reply.code(409).send({
          error: 'ReviewUnavailable',
          message: 'That review is not available. Run a Claude review on this PR first.',
        });
      const resp: AiFixPickerPreview = preview;
      return reply.send(resp);
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

      const out = await pushFix(ctx, {
        accountId,
        fixId,
        target: body.target === 'existing' ? 'existing' : 'new',
        branch: body.branch,
      });
      if (out.ok) {
        const resp: AiFixPushResult = out.result;
        return reply.send(resp);
      }
      switch (out.code) {
        case 'not_found':
          return reply.code(404).send({ error: 'not found' });
        case 'not_pushable':
          return reply.code(409).send({ error: 'NotPushable' });
        case 'no_write':
          return reply.code(403).send({ error: 'NoWriteAccess' });
        case 'head_unavailable':
          return reply.code(400).send({ error: 'HeadUnavailable' });
        case 'branch_required':
          return reply.code(400).send({ error: 'BranchRequired' });
        case 'HEAD_MOVED':
          return reply.code(409).send({ error: 'HeadMoved', message: out.message });
        case 'PUSH_DENIED':
        case 'APPLY_FAILED':
          return reply.code(422).send({ error: out.code, message: out.message });
        default:
          return reply.code(500).send({ error: 'PushFailed', message: out.message });
      }
    },
  );
}

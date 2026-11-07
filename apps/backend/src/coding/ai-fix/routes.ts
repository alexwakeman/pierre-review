import { mergeWire, readMergeState } from '../../sandbox/session/fix-merge.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AI_FIX_MAX_INSTRUCTION_CHARS,
  AI_FIX_SESSION_API,
  aiRunProvider,
  DEFAULT_AI_FIX_MODEL,
  SANDBOX_MESSAGE_MAX,
} from '@pierre-review/shared';
import type {
  AiFix,
  AiFixModel,
  AiProviderId,
  AiFixPickerPreview,
  AiFixPushBody,
  AiFixPushResult,
  AiFixResponse,
  AiFixSeed,
  AiFixStreamEvent,
  AiFixSummary,
  GenerateFixBody,
  PrHeadInfo,
  SandboxSessionStreamEvent,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { anyProviderPreflight, preflightFor, resolveManualRunChoice, type ManualRunChoiceOptions } from '../../ai/run-choice.js';
import { config } from '../../config.js';
import { getFixPrContext, getViewerCanPush } from './pr-context.js';
import {
  approvePlan,
  discardFix,
  getFixStatus,
  loadFixPreview,
  requestFixCancel,
  sendFixSessionMessage,
  startFix,
  startPlan,
  subscribeFixStream,
  type FixActionResult,
} from './manager.js';
import { planStateOf } from './plan.js';
import { pushFix } from './push.js';
import { requestModelOf } from '../../ai/provider.js';
import { resolveSandboxAgentChoice } from '../../sandbox/drivers/index.js';
import { allowFixHost, fixSessionWire, resumeFixSession, subscribeFixSession } from '../../sandbox/session/fix.js';
import type { ResumeResult } from '../../sandbox/session/manager.js';
import { getLatestSucceededReviewId } from '../../review/claude-review/persist.js';
import {
  getFixById,
  getLatestFix,
  listFixHistory,
  parseChangeReport,
  parseChecks,
  parseFilesChanged,
  parseReviewItems,
  parseTrigger,
  type AiFixRow,
} from './persist.js';

// AI Fix's agentic-fixer routes (CORE, free, LOCAL ONLY — the fixer left the plugin with Claude
// Review). ⚠ THE PATHS KEEP THEIR HISTORICAL `/api/pro/` PREFIX (`/api/pro/prs/:id/ai-fix*`,
// `/api/pro/ai-fixes/:fixId*`) so the SPA client did not move; nothing about them is paid. They
// are registered only by `registerAgenticRoutes` (review/agentic.ts), which refuses in cloud and
// under LIMN_AI_DISABLED.
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

// The model and provider a fix run uses — THE PER-RUN CHOICE (ai/run-choice.ts). Validated HERE, in
// the handler, and not by an ajv body schema: Fastify's ajv runs with `removeAdditional`, so a schema
// that did not declare every key would silently strip `seed` / `instruction` / `sourceReviewId` (the
// contact-form honeypot landmine). The body has no schema at all, so `model` may be any JSON value.
//   model absent / null      → DEFAULT_AI_FIX_MODEL's depth
//   a picker model (either provider's) → that depth, on the provider that offers it
//   anything else (a retired id such as the old Opus, a typo, a number) ⇒ 400 ModelNotOffered
//   provider absent          → the model's own provider when it is Codex's, else the default
//   a model of the other provider, or a provider not signed in ⇒ 400 with one sentence

function rowToAiFix(row: AiFixRow): AiFix {
  // THE WORKSPACE SESSION the fix ran in (null on a row of the removed shell-less fixer). Never throws.
  let wire: ReturnType<typeof fixSessionWire> = { session: null, leftOut: [] };
  try {
    wire = fixSessionWire(row);
  } catch {
    /* an unreadable session_json reads as no session */
  }
  return {
    session: wire.session,
    leftOut: wire.leftOut,
    unattended: row.unattended === true,
    merge: mergeWire(readMergeState(row.mergeJson ?? null)),
    id: row.id,
    prId: row.prId,
    status: row.status,
    model: row.model,
    provider: aiRunProvider(row.provider, row.model),
    effort: row.effort ?? null,
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
    plan: planStateOf(row),
    checks: parseChecks(row.checks),
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
    provider: aiRunProvider(row.provider, row.model),
    effort: row.effort ?? null,
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

type ParsedStartBody =
  | {
      model: AiFixModel;
      provider: AiProviderId;
      seed: AiFixSeed;
      instruction: string | undefined;
      sourceReviewId: number | null;
      include: string[] | null;
    }
  | { error: string; message: string };

// The start body, validated in the handler (no ajv schema — see resolveFixModel). Shared by the
// fix start and the "Plan first" start, which take the same body.
function parseStartBody(
  rawBody: GenerateFixBody | undefined,
  kind: 'fix' | 'plan',
  detect: ManualRunChoiceOptions['detect'],
): ParsedStartBody {
  const body = rawBody ?? ({} as GenerateFixBody);
  const choice = resolveManualRunChoice(
    { model: (body as { model?: unknown }).model, provider: (body as { provider?: unknown }).provider },
    kind,
    { defaultModel: DEFAULT_AI_FIX_MODEL, detect },
  );
  if (!choice.ok) return { error: choice.error, message: choice.message };
  const { model, provider } = choice;
  // `checks` ("Run tests", removed) from an older tab is IGNORED: tests run in the sandbox.
  // Two entry points. The removed ones get a sentence a stale tab can show, not a run.
  const rawSeed = (body as { seed?: unknown }).seed ?? 'plain';
  if (rawSeed === 'comments' || rawSeed === 'ci_analysis') {
    return { error: 'SeedRemoved', message: 'That kind of fix is no longer offered. Reload the page.' };
  }
  if (rawSeed !== 'review' && rawSeed !== 'plain') return { error: 'UnknownSeed', message: 'Unknown fix type.' };
  const seed: AiFixSeed = rawSeed;

  if (seed === 'plain') {
    const raw = (body as { instruction?: unknown }).instruction;
    const instruction = typeof raw === 'string' ? raw.trim() : '';
    if (instruction === '') return { error: 'InstructionRequired', message: 'Say what to fix.' };
    if (instruction.length > AI_FIX_MAX_INSTRUCTION_CHARS) {
      return {
        error: 'InstructionTooLong',
        message: `Keep the instruction under ${AI_FIX_MAX_INSTRUCTION_CHARS.toLocaleString('en-US')} characters.`,
      };
    }
    return { model, provider, seed, instruction, sourceReviewId: null, include: null };
  }
  // Absent / null ⇒ THE CI-ONLY SEED (no AI review: the CI check's fixable items at the current
  // head — manager.ts `loadCiOnlySeed`). Anything else must be a positive integer id.
  const rawId = (body as { sourceReviewId?: unknown }).sourceReviewId;
  const raw = rawId ?? null;
  if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)) {
    return { error: 'ReviewRequired', message: 'Pick an AI review to fix from.' };
  }
  // The fix picker's selection: picker keys. Absent ⇒ the server's defaults. Anything but an
  // array of short strings is a 400; an unknown key is ignored (it selects nothing).
  const inc = (body as { include?: unknown }).include;
  let include: string[] | null = null;
  if (inc !== undefined) {
    if (
      !Array.isArray(inc) ||
      inc.length > MAX_INCLUDE_KEYS ||
      !inc.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 200)
    ) {
      return { error: 'BadSelection', message: 'Pick what to fix again.' };
    }
    include = inc as string[];
  }
  return { model, provider, seed, instruction: undefined, sourceReviewId: raw, include };
}

/** One session action's answer: 202 `{ fixId, status: 'queued' }`, or the refusal it maps to. */
function sendFixAction(reply: FastifyReply, res: FixActionResult | ResumeResult) {
  switch (res.status) {
    case 'queued':
      return reply.code(202).send({ fixId: res.id, status: 'queued' });
    case 'not_found':
      return reply.code(404).send({ error: 'not found' });
    case 'not_live':
      return reply.code(409).send({ error: 'NotLive', message: res.message });
    case 'agent_busy':
      return reply.code(409).send({ error: 'AgentBusy', message: 'The agent is still working on the last message. Wait, or press Stop.' });
    case 'build_busy':
      return reply.code(409).send({ error: 'BuildBusy', message: 'Another session is building. One build runs at a time.' });
    case 'not_ready':
      return reply.code(409).send({ error: 'NotReady', message: res.message });
    case 'no_runtime':
      return reply.code(409).send({ error: 'NoRuntime', message: res.message });
    case 'too_many':
      return reply.code(409).send({ error: 'TooManySessions', message: res.message });
    case 'not_resumable':
      return reply.code(409).send({ error: 'NotResumable', message: res.message });
  }
}

/** The text of a message body: trimmed, 1..SANDBOX_MESSAGE_MAX, or the 400 to send. */
function messageText(body: unknown): { text: string } | { error: string; message: string } {
  const raw = (body as { text?: unknown } | undefined)?.text;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { error: 'MessageRequired', message: 'Write a message first.' };
  if (text.length > SANDBOX_MESSAGE_MAX) return { error: 'MessageTooLong', message: `Keep the message under ${SANDBOX_MESSAGE_MAX.toLocaleString('en-US')} characters.` };
  return { text };
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

      // A picker surface: ready when ANY provider can run a fix (the start names its own provider).
      const auth = anyProviderPreflight(preflightFor(ctx), 'fix', ctx.llm.detectAuth('fix'));
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

  // Start a fix run — or, with "Plan first", a read-only planning pass over the SAME body
  // (manager.ts startPlan; docs/CLAUDE-REVIEW.md § AI Fix "Plan mode"). Manual only: the auto path
  // calls startReviewFix and never plans.
  for (const mode of ['fix', 'plan'] as const) {
    app.post<{ Params: { id: string }; Body?: GenerateFixBody }>(
      mode === 'fix' ? '/api/pro/prs/:id/ai-fix' : '/api/pro/prs/:id/ai-fix/plan',
      async (req, reply) => {
        const accountId = ctx.accountIdOf(req);
        const prId = parseId(req.params.id);
        if (prId == null) return reply.code(404).send({ error: 'not found' });
        if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });

        const parsed = parseStartBody(req.body, mode, preflightFor(ctx));
        if ('error' in parsed) return reply.code(400).send(parsed);

        const input = {
          accountId,
          prId,
          model: parsed.model,
          provider: parsed.provider,
          seed: parsed.seed,
          instruction: parsed.instruction,
          // The SERVER builds the review seed from the stored run (manager.ts `loadReviewSeed`,
          // which also checks it is THIS PR's succeeded review). No review text travels in the body.
          sourceReviewId: parsed.sourceReviewId,
          trigger: 'manual' as const,
          selection: parsed.include ? { kind: 'keys' as const, keys: parsed.include } : undefined,
        };
        const res = mode === 'fix' ? await startFix(ctx, input) : await startPlan(ctx, input);

        switch (res.status) {
          case 'queued':
            return reply.code(202).send({ fixId: res.fixId, status: 'queued' });
          case 'already_running':
            return reply.code(409).send({ error: 'AlreadyRunning' });
          case 'no_runtime':
            return reply.code(409).send({ error: 'NoRuntime', message: res.message });
          case 'too_many':
            return reply.code(409).send({ error: 'TooManySessions', message: res.message });
          case 'build_busy':
            return reply.code(409).send({ error: 'BuildBusy', message: 'Another session is building. One build runs at a time.' });
          case 'over_budget':
            // Unattended starts only; a reader's click is never refused by the budget.
            return reply.code(409).send({ error: 'OverBudget', message: 'Your AI spend budget is reached.' });
          case 'no_auth':
            return reply.code(400).send({ error: 'NoClaudeAuth', message: res.message });
          case 'no_head':
            return reply.code(400).send({ error: 'NoHead' });
          case 'no_instruction':
            return reply.code(400).send({ error: 'InstructionRequired', message: 'Say what to fix.' });
          case 'review_unavailable':
            return reply.code(409).send({
              error: 'ReviewUnavailable',
              message: 'That review is not available. Run an AI review on this PR first.',
            });
          case 'nothing_to_fix':
            return reply.code(409).send({
              error: 'NothingToFix',
              message: parsed.include
                ? 'Nothing is ticked.'
                : parsed.sourceReviewId == null
                  ? 'The CI check found nothing this PR can fix.'
                  : 'The review found nothing to fix.',
            });
          default:
            return reply.code(404).send({ error: 'not found' });
        }
      },
    );
  }

  // ---- The session: messages, Start fix, discard, resume, network, stream ----
  // Every id-route reads the row through the ACCOUNT-SCOPED getter (another account's ⇒ 404) and the PR
  // through `getFixPrContext` BEFORE touching the in-memory session.
  const ownedFix = async (accountId: number, rawId: string): Promise<AiFixRow | null> => {
    const fixId = parseId(rawId);
    if (fixId == null) return null;
    const row = await getFixById(ctx, accountId, fixId);
    if (!row) return null;
    return (await getFixPrContext(ctx, accountId, row.prId)) ? row : null;
  };

  // One more turn in the SAME session (chat before Start fix; a build turn after). `…/plan/message` is the
  // older bundle's name for it.
  for (const path of [AI_FIX_SESSION_API.message, AI_FIX_SESSION_API.planMessage]) {
    app.post<{ Params: { fixId: string } }>(path, async (req, reply) => {
      if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
      const accountId = ctx.accountIdOf(req);
      const row = await ownedFix(accountId, req.params.fixId);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const m = messageText(req.body);
      if ('error' in m) return reply.code(400).send(m);
      return sendFixAction(reply, await sendFixSessionMessage(ctx, { accountId, fixId: row.id, text: m.text }));
    });
  }

  // "Start fix" (Plan first): the session switches to build mode and fixes. 409 PlanNotReady when the
  // session is not waiting in chat.
  app.post<{ Params: { fixId: string } }>(AI_FIX_SESSION_API.planApprove, async (req, reply) => {
    if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
    const accountId = ctx.accountIdOf(req);
    const row = await ownedFix(accountId, req.params.fixId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const raw = (req.body as { text?: unknown } | undefined)?.text;
    if (raw !== undefined && typeof raw !== 'string') return reply.code(400).send({ error: 'BadRequest', message: '`text` must be a string.' });
    const extra = (raw ?? '').trim();
    if (extra.length > SANDBOX_MESSAGE_MAX) return reply.code(400).send({ error: 'MessageTooLong', message: `Keep the message under ${SANDBOX_MESSAGE_MAX.toLocaleString('en-US')} characters.` });
    const res = await approvePlan(ctx, { accountId, fixId: row.id, text: extra === '' ? null : extra });
    if (res.status === 'not_ready') return reply.code(409).send({ error: 'PlanNotReady', message: res.message });
    return sendFixAction(reply, res);
  });

  // Discard: the session closes, nothing is pushed (`…/plan/discard` is the older name). DB + teardown.
  for (const path of [AI_FIX_SESSION_API.discard, AI_FIX_SESSION_API.planDiscard]) {
    app.post<{ Params: { fixId: string } }>(path, async (req, reply) => {
      if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
      const accountId = ctx.accountIdOf(req);
      const row = await ownedFix(accountId, req.params.fixId);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const out = await discardFix(ctx, { accountId, fixId: row.id });
      if (out.status === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (out.status === 'not_ready') return reply.code(409).send({ error: 'NotReady', message: 'Wait for the push to finish.' });
      return reply.send({ status: 'discarded' });
    });
  }

  // Resume: a closed, unpushed fix with stored changes boots again with them (its own provider and model).
  app.post<{ Params: { fixId: string } }>(AI_FIX_SESSION_API.resume, async (req, reply) => {
    if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
    const accountId = ctx.accountIdOf(req);
    const row = await ownedFix(accountId, req.params.fixId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const provider = aiRunProvider(row.provider, row.model);
    const auth = preflightFor(ctx)(provider, 'fix');
    if (auth.status !== 'ok') return reply.code(400).send({ error: 'NoClaudeAuth', message: auth.message });
    const choice = resolveSandboxAgentChoice({ provider, model: requestModelOf(row.model) });
    return sendFixAction(reply, await resumeFixSession(ctx, accountId, row.id, choice));
  });

  // An Allow click (the reader's, never automatic).
  app.post<{ Params: { fixId: string } }>(AI_FIX_SESSION_API.networkAllow, async (req, reply) => {
    if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
    const accountId = ctx.accountIdOf(req);
    const row = await ownedFix(accountId, req.params.fixId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { rule?: unknown; scope?: unknown };
    if (typeof b.rule !== 'string' || b.rule.trim() === '' || b.rule.length > 260 || (b.scope !== 'session' && b.scope !== 'workspace')) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Name a host and a scope.' });
    }
    const r = await allowFixHost(ctx, accountId, row.id, b.rule, b.scope);
    if (r.status === 'allowed') return reply.send({ rule: r.rule, scope: b.scope });
    if (r.status === 'refused') return reply.code(400).send({ error: 'NetworkRule', message: r.reason });
    return sendFixAction(reply, r);
  });

  // SSE: one snapshot of the session, then every change while the sandbox runs; `done` when it closes.
  // ⚠ A GET, so its request's close IS the client going away. Ownership BEFORE hijack.
  app.get<{ Params: { fixId: string } }>(AI_FIX_SESSION_API.sessionStream, async (req, reply) => {
    if (!AIFIX_ENABLED) return reply.code(404).send({ error: 'AiFixDisabled' });
    const accountId = ctx.accountIdOf(req);
    const row = await ownedFix(accountId, req.params.fixId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    let unsub: (() => void) | null = null;
    const hb = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub?.();
      if (!raw.writableEnded) raw.end();
    };
    const send = (e: SandboxSessionStreamEvent): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    req.raw.on('close', cleanup);
    // Subscribe BEFORE the snapshot, buffering, so a frame between the two is never lost.
    const held: SandboxSessionStreamEvent[] = [];
    let ready = false;
    unsub = subscribeFixSession(row.id, accountId, (e) => {
      if (!ready) return void held.push(e);
      send(e);
      if (e.type === 'done') cleanup();
    });
    const fresh = (await getFixById(ctx, accountId, row.id).catch(() => null)) ?? row;
    const wire = (() => {
      try {
        return fixSessionWire(fresh);
      } catch {
        return null;
      }
    })();
    if (wire?.session) send({ type: 'snapshot', session: wire.session });
    ready = true;
    for (const e of held) {
      send(e);
      if (e.type === 'done') return cleanup();
    }
    if (unsub == null) {
      send({ type: 'done' });
      cleanup();
    }
  });

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
        return reply.code(400).send({ error: 'ReviewRequired', message: 'Pick an AI review to fix from.' });
      const pr = await getFixPrContext(ctx, accountId, prId);
      if (!pr) return reply.code(404).send({ error: 'not found' });
      const reviewId = picked ?? (await getLatestSucceededReviewId(ctx, prId, accountId));
      // No succeeded AI review: THE CI-ONLY preview (the CI check's fixable items at the current
      // head, `sourceReviewId: null`) — unless there are none, which is the old 409.
      if (reviewId == null) {
        const ciOnly = await loadFixPreview(ctx, { accountId, prId, reviewId: null });
        if (ciOnly == null || ciOnly.items.length === 0)
          return reply.code(409).send({
            error: 'ReviewUnavailable',
            message: 'Run an AI review on this PR first.',
          });
        const resp: AiFixPickerPreview = ciOnly;
        return reply.send(resp);
      }
      const preview = await loadFixPreview(ctx, { accountId, prId, reviewId });
      if (!preview)
        return reply.code(409).send({
          error: 'ReviewUnavailable',
          message: 'That review is not available. Run an AI review on this PR first.',
        });
      const resp: AiFixPickerPreview = preview;
      return reply.send(resp);
    },
  );

  // "Run tests" was REMOVED with the shell-less fixer: tests run inside the sandbox now. An older tab
  // that asks gets one line (kept one release, then this route goes).
  app.get<{ Params: { id: string } }>('/api/pro/prs/:id/ai-fix/checks', async (_req, reply) =>
    reply.code(404).send({ error: 'ChecksRemoved', message: 'Tests now run inside the sandbox.' }),
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
      const cancelled = await requestFixCancel(ctx, accountId, prId);
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

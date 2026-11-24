import type { FastifyInstance } from 'fastify';
import { SPRINT_PATHS_MODEL, type ClaudeReviewModel, type ReleaseBlockersRunResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../agent-context.js';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import { either, providerName } from '../../ai/prompt-tools.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { cheapUsage } from '../cheap-usage.js';
import { estimateCostUsd } from '../pricing.js';
import type { CompleteFn } from '../story-labels/manager.js';
import { RELEASE_BLOCKERS_MAX_TOKENS, RELEASE_BLOCKERS_SYSTEM, releaseBlockersPrompt } from './prompt.js';
import { validateReleaseBlockers } from './validate.js';

// POST /api/releases/blockers?workspace=<id> — "Explain what's blocking" on This Sprint → Releases
// (docs/RELEASES.md § Explain what's blocking; docs/API.md § Releases; docs/CLAUDE-REVIEW.md § Release
// blockers). Registered ONLY through `registerAgenticRoutes` (AI off: it 404s). A READER'S PRESS — never
// refused by the spend gate (the SPA asks first, through `AiRunGate kind="complete"`).
//
//   • ONE one-shot completion (`cheapComplete`, through ai/provider.ts; the writing rules are added at its
//     door) on the STANDARD role — the sprint builder's model on Claude, Codex's own depth there. A
//     one-shot, not an agent: everything it needs is already in the release check (no tool to call).
//   • THE INPUT is the check the server holds (db/release-check.ts `getReleases`, DB + memory only →
//     releases/blockers-input.ts). No GitHub or tracker read.
//   • THE ANSWER is validated against that input (./validate.ts): only its tickets and pull requests may
//     be cited; ONE retry on a refused answer, then a 502 (nothing stored).
//   • ONE RUN PER (account, workspace), claimed SYNCHRONOUSLY; a second press while one runs is a 409.
//   • Spend recorded (`recordAiUsage`, feature 'release_blockers'), also for a refused answer.
//   • Stored per workspace with the input's hash (db/release-blocker-reports.ts); GET /api/releases carries it.
// Rate tier: ai + ai_hourly (`tierFor`).

const MODEL: ClaudeReviewModel = SPRINT_PATHS_MODEL;
export const RELEASE_BLOCKERS_FEATURE = 'release_blockers';

let completeOverride: CompleteFn | null = null;
/** Tests inject a fake completion (never a real model call); null restores `cheapComplete`. */
export function setReleaseBlockersCompleteForTests(fn: CompleteFn | null): void {
  completeOverride = fn;
}

const running = new Set<string>();

export function registerReleaseBlockersRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post('/api/releases/blockers', async (req, reply): Promise<ReleaseBlockersRunResponse | { error: string; message: string }> => {
    if (!config.aiEnabled) {
      reply.status(404);
      return { error: 'not_found', message: 'AI is switched off here.' };
    }
    const auth = ctx.llm.detectAuth('complete');
    if (auth.status !== 'ok') {
      reply.status(503);
      return { error: 'no_credential', message: either('No Claude login or API key found.', auth.message ?? 'Codex is not signed in.') };
    }
    const accountId = ctx.accountIdOf(req);
    const q = req.query as { workspace?: string };
    const { workspaceId } = await resolveWorkspaceScope(accountId, q.workspace);
    const key = `${accountId}:${workspaceId}`;
    // ⚠ CLAIMED SYNCHRONOUSLY after the last await above — no await between the check and the claim.
    if (running.has(key)) {
      reply.status(409);
      return { error: 'busy', message: 'Already explaining. It will show here when it is done.' };
    }
    running.add(key);
    try {
      const [{ getReleases }, { releaseBlockersInput }, { storeReleaseBlockersReport, getReleaseBlockersReport }] = await Promise.all([
        import('../../db/release-check.js'),
        import('../../releases/blockers-input.js'),
        import('../../db/release-blocker-reports.js'),
      ]);
      const releases = await getReleases(accountId, workspaceId);
      if (releases.check == null) {
        reply.status(409);
        return { error: 'not_ready', message: 'Set up Releases first.' };
      }
      const input = releaseBlockersInput(releases.check);
      if (!input.explainable) {
        reply.status(409);
        return releases.check.repos.some((r) => r.checking)
          ? { error: 'checking', message: 'The check is still running. Try again when it ends.' }
          : { error: 'nothing_blocked', message: 'Nothing newer is blocked.' };
      }
      const complete = completeOverride ?? (await import('../llm.js')).cheapComplete;
      let costUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const nonce = pickReviewNonce([input.text]);
        const out = await complete({
          model: MODEL,
          role: 'standard',
          system: RELEASE_BLOCKERS_SYSTEM,
          prompt: releaseBlockersPrompt(input.text, nonce),
          maxTokens: RELEASE_BLOCKERS_MAX_TOKENS,
        });
        const u = cheapUsage(out, MODEL, (i, o) => estimateCostUsd(MODEL, { inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheCreationTokens: 0 }));
        costUsd += u.costUsd;
        inputTokens += u.inputTokens ?? 0;
        outputTokens += u.outputTokens ?? 0;
        await ctx
          .recordAiUsage({ accountId, seam: 'summary', feature: RELEASE_BLOCKERS_FEATURE, ...u })
          .catch((err) => ctx.log.warn({ err }, 'release blockers: usage record failed'));
        const v = validateReleaseBlockers(out.text, input);
        if (!v.ok) {
          ctx.log.info({ accountId, reason: v.reason, attempt }, 'release blockers: answer refused by validation');
          continue;
        }
        const writtenAt = new Date();
        await storeReleaseBlockersReport(accountId, workspaceId, {
          inputHash: input.hash,
          report: v.report,
          model: u.model,
          provider: u.provider,
          costUsd,
          inputTokens,
          outputTokens,
          writtenAt,
        });
        const stored = await getReleaseBlockersReport(accountId, workspaceId);
        return { workspaceId, blockers: { explainable: true, report: stored?.report ?? null, stale: false } };
      }
      reply.status(502);
      return { error: 'refused', message: `${providerName()} named work that is not in the check, so the answer was not kept. Try again.` };
    } catch (err) {
      if (err instanceof AiRuntimeMissingError) {
        reply.status(503);
        return { error: 'runtime', message: err.message };
      }
      ctx.log.warn({ accountId, err: String(err).slice(0, 200) }, 'release blockers: completion failed');
      reply.status(502);
      return { error: 'failed', message: `${providerName()} could not answer. Try again.` };
    } finally {
      running.delete(key);
    }
  });
}

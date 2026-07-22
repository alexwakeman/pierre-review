import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema, runTransaction, isPg } from '../db/client.js';
import * as hostQueries from '../db/queries.js';
import { recordAiUsage, getAiUsageSummary } from '../db/usage.js';
import { aiCreditStatus } from '../db/credits.js';
import { reviewEvents, registerLearningsProvider } from '../review/events.js';
import { registerScheduledJob } from '../sync/scheduled-jobs.js';
import { registerPrDetailEnricher } from '../pr/detail-enricher.js';
import { cheapComplete } from '../review/llm.js';
import { detectClaudeAuth } from '../review/auth.js';
import {
  hasUserAnthropicKey,
  setUserAnthropicKey,
  getEffectiveReviewBudget,
  setUserReviewBudget,
  MAX_REVIEW_BUDGET_USD,
} from '../review/local-settings.js';
import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  createPullRequest,
  fetchPrHeadInfo,
  fetchPrUnifiedDiff,
} from '../github/mutations.js';
import { fetchActionsJobLog } from '../github/actions-logs.js';
import { applyAndPush } from '../coding/git-ops.js';
import { registerRetentionHandler } from '../db/retention.js';
import { runPluginMigrations } from './migrate.js';
import { setProCapabilities } from './contract.js';
import type { ProContext, ProPlugin } from './contract.js';

// Boot binding for the optional @pierre/pro plugin. The plugin lives in a PRIVATE
// git submodule at packages/pro (often absent — a pure-OSS checkout never has it).
// It is deliberately NOT a declared dependency, so `pnpm install` succeeds without
// it; we resolve it by FILESYSTEM PATH rather than a bare specifier (no package.json
// coupling). Submodule absent → no entry file on disk → clean OSS no-op.

export async function bindProPlugin(app: FastifyInstance): Promise<void> {
  if (!config.proEnabled) return; // master gate (Pro is local-only for now)

  // here = apps/backend/{src|dist}/pro/bind.{ts|js} → repo root is four levels up.
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(here), '../../../..');
  // PRO_PLUGIN_PATH is an explicit entry-file override, tried FIRST. The cloud Docker image
  // flattens the release layout (backend runs from /app/dist/…), so the repo-relative
  // packages/pro paths below don't exist there — the image sets PRO_PLUGIN_PATH=/app/pro/index.js
  // to point straight at the copied-in built plugin. It reveals nothing about Pro (just a path).
  const entry = [
    process.env.PRO_PLUGIN_PATH, // explicit override (cloud/Docker image)
    join(repoRoot, 'packages/pro/dist/index.js'), // built plugin (node)
    join(repoRoot, 'packages/pro/src/index.ts'), // source (tsx dev)
  ]
    .filter((p): p is string => Boolean(p))
    .find(existsSync);
  if (!entry) {
    app.log.debug('pro plugin submodule absent — OSS mode');
    return;
  }

  const mod = await import(pathToFileURL(entry).href).catch((err) => {
    app.log.warn({ err }, 'pro plugin present but failed to load — OSS mode');
    return null;
  });
  if (!mod) return;

  const plugin = (mod.default ?? mod) as ProPlugin;
  if (plugin?.apiVersion !== 12 || typeof plugin.register !== 'function') {
    app.log.warn(
      { apiVersion: plugin?.apiVersion },
      'pro contract mismatch — skipped',
    );
    return;
  }

  const ctx: ProContext = {
    log: app.log,
    host: {
      version: process.env.npm_package_version ?? '0.0.0',
      deploymentMode: config.deploymentMode,
      isCloud: config.isCloud,
    },
    accountIdOf,
    db,
    schema,
    runTransaction,
    isPg,
    registerMigrations: (sqliteFolder, pgFolder) =>
      runPluginMigrations(sqliteFolder, pgFolder),
    registerRetention: (handler) => registerRetentionHandler(handler),
    llm: {
      complete: cheapComplete,
      detectAuth: () => {
        const r = detectClaudeAuth();
        return r.status === 'ok'
          ? { status: 'ok' }
          : { status: 'none', message: r.message };
      },
    },
    queries: {
      getInsights: (accountId, repoIds) =>
        hostQueries.getInsights({ accountId, repoIds: repoIds ?? null }),
      getRepoAnalytics: (accountId, repoId) =>
        hostQueries.getRepoAnalytics(accountId, repoId),
      getOpenPrs: (args) =>
        hostQueries.getOpenPrs({
          accountId: args.accountId,
          repoIds: args.repoIds ?? null,
          userIds: null,
        }),
      getActivity: (accountId, repoIds) =>
        hostQueries.getActivity(accountId, repoIds ?? null),
      getTeamInsights: (accountId, window, repoIds) =>
        hostQueries.getTeamInsights(accountId, window, repoIds),
      getTeamMetricsDetail: (accountId, window, repoIds) =>
        hostQueries.getTeamMetricsDetail(accountId, window, repoIds),
      getAiUsage: (accountId, sinceMs) => getAiUsageSummary(accountId, sinceMs),
      getBotAnalytics: (accountId, window, repoIds) =>
        hostQueries.getBotAnalytics(accountId, window, repoIds ?? null),
      getBotReviewComments: (accountId, window, repoIds) =>
        hostQueries.getBotReviewComments(accountId, window, repoIds ?? null),
    },
    recordAiUsage: (row) => recordAiUsage(row),
    aiCredits: {
      check: async (accountId) => {
        const account = await getAccountById(accountId);
        // Fail closed on a missing account (should never happen for a live request): block
        // spend rather than risk unmetered generation.
        if (!account)
          return { allowanceCredits: 0, usedCredits: 0, remainingCredits: 0, blocked: true };
        return aiCreditStatus(account, Date.now());
      },
    },
    reviewEvents,
    registerLearningsProvider,
    registerScheduledJob,
    registerPrDetailEnricher,
    // AI Fix infra (per-account, cloud-ready). The host owns the security-sensitive
    // clone/agent/push machinery; the plugin only drives it with prompts/model.
    github: {
      fetchPrDiff: async (accountId, owner, name, number) =>
        fetchPrUnifiedDiff(await getAccessToken(accountId), owner, name, number),
      fetchPrHeadInfo: async (accountId, owner, name, number) =>
        fetchPrHeadInfo(await getAccessToken(accountId), owner, name, number),
      fetchCheckLogs: async (accountId, owner, name, jobId, tail) =>
        fetchActionsJobLog(
          await getAccessToken(accountId),
          owner,
          name,
          jobId,
          tail,
        ),
      openPullRequest: async (accountId, prArgs) =>
        createPullRequest(await getAccessToken(accountId), prArgs),
    },
    coding: {
      // Lazy-import the agent module (it pulls in the Claude Agent SDK) so the SDK
      // only loads when a fix actually runs, not at every backend boot.
      generateFix: async (fixArgs) =>
        (await import('../coding/agent.js')).runCodingAgent(fixArgs),
      applyAndPush: (pushArgs) => applyAndPush(pushArgs),
      // Trunk-conflict handling lives in coding/merge.ts; also lazy so the SDK loads
      // only when a resolution actually runs.
      mergePreview: async (a) =>
        (await import('../coding/merge.js')).mergePreview(a),
      rebaseResolve: async (a) =>
        (await import('../coding/merge.js')).rebaseResolve(a),
      mergeResolveAndPush: async (a) =>
        (await import('../coding/merge.js')).mergeResolveAndPush(a),
      pushResolved: async (a) =>
        (await import('../coding/merge.js')).pushResolved(a),
    },
    // Claude Review infra: diff prep + the SDK run + the GitHub review POST. Lazy so the
    // Agent SDK (agent.js) loads only when a review actually runs, not at every boot.
    review: {
      prepareReview: async (a) => (await import('../review/prepare.js')).prepareReview(a),
      runReview: async (a) => (await import('../review/agent.js')).runReview(a),
      postReview: async (a) => (await import('../review/post-seam.js')).postReview(a),
      postFinding: async (a) => (await import('../review/post-seam.js')).postFinding(a),
      getLocalKeyStatus: () => ({
        hasUserKey: hasUserAnthropicKey(),
        reviewBudgetUsd: getEffectiveReviewBudget(),
        reviewBudgetMax: MAX_REVIEW_BUDGET_USD,
      }),
      setLocalKey: (k) => {
        setUserAnthropicKey(k ?? '');
        return { hasUserKey: hasUserAnthropicKey(), auth: detectClaudeAuth().status };
      },
      setReviewBudget: (usd) => {
        setUserReviewBudget(usd);
        return { reviewBudgetUsd: getEffectiveReviewBudget() };
      },
    },
  };

  try {
    setProCapabilities(await plugin.register(app, ctx));
    app.log.info('pro plugin active');
  } catch (err) {
    app.log.warn({ err }, 'pro register() failed — OSS mode');
  }
}

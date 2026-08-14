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
  createIssue,
  createPullRequest,
  fetchPrHeadInfo,
  fetchPrUnifiedDiff,
} from '../github/mutations.js';
import { ghRestGetContentDir, ghRestGetContentRaw } from '../github/client.js';
import { fetchCompareDiff } from '../github/compare.js';
import { fetchActionsJobLog } from '../github/actions-logs.js';
import { applyAndPush, commitFilesAndOpenPr } from '../coding/git-ops.js';
import { registerRetentionHandler } from '../db/retention.js';
import { registerAccountErasureHandler } from '../db/erase-account.js';
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
  //
  // The dist/src ORDER flips by environment, and that matters: `packages/pro/dist` is built only
  // for the --with-pro release image, is gitignored, and nothing in the dev loop refreshes it.
  // A leftover dist therefore used to SHADOW the source under `pnpm dev` and freeze the plugin at
  // whenever it was last built — every route added afterwards 404s, with the plugin otherwise
  // looking healthy (capabilities on, older routes serving). Dev prefers source; production, where
  // no .ts loader exists, prefers the build.
  const distEntry = join(repoRoot, 'packages/pro/dist/index.js'); // built plugin (node)
  const srcEntry = join(repoRoot, 'packages/pro/src/index.ts'); // source (tsx dev)
  const entry = [
    process.env.PRO_PLUGIN_PATH, // explicit override (cloud/Docker image)
    ...(process.env.NODE_ENV === 'production' ? [distEntry, srcEntry] : [srcEntry, distEntry]),
  ]
    .filter((p): p is string => Boolean(p))
    .find(existsSync);
  if (!entry) {
    app.log.debug('pro plugin submodule absent — OSS mode');
    return;
  }
  // Which entry bound is the first thing you need when a Pro route unexpectedly 404s.
  app.log.info({ entry }, 'pro plugin entry resolved');

  const mod = await import(pathToFileURL(entry).href).catch((err) => {
    app.log.warn({ err }, 'pro plugin present but failed to load — OSS mode');
    return null;
  });
  if (!mod) return;

  const plugin = (mod.default ?? mod) as ProPlugin;
  // ⚠ THE RUNTIME GATE. This literal is the twin of `ProPlugin['apiVersion']` in contract.ts —
  // bump them together. A half-bump here silently degrades a CORRECT plugin to OSS mode (the warn
  // below is the only trace; capabilities go dark and every /api/pro/* route 404s).
  if (plugin?.apiVersion !== 16 || typeof plugin.register !== 'function') {
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
    registerAccountErasure: (handler) => registerAccountErasureHandler(handler),
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
      // The scope-bearing getters pass `scope` straight through: BotScopeWire is structurally the
      // host's BotScope, and the plugin only ever holds one the host produced (per-request via
      // resolveWorkspaceScope, or workspaceScopeForRepo / defaultWorkspaceId below).
      getActivity: (accountId, scope) => hostQueries.getActivity(accountId, scope),
      getWorkspaceInsights: (accountId, window, scope) =>
        hostQueries.getWorkspaceInsights(accountId, window, scope),
      getWorkspaceMetricsDetail: (accountId, window, repoIds) =>
        hostQueries.getWorkspaceMetricsDetail(accountId, window, repoIds),
      workspaceScopeForRepo: (accountId, repoId) =>
        hostQueries.workspaceScopeForRepo(accountId, repoId),
      // The account's Default workspace, for the two account-wide crons (no request → no
      // `?workspace=`). ensureDefaultWorkspace creates the row if it is missing, so a cron can
      // never fail on an account that has somehow never been through a scoped request.
      defaultWorkspaceId: (accountId) => hostQueries.ensureDefaultWorkspace(accountId),
      getAiUsage: (accountId, sinceMs) => getAiUsageSummary(accountId, sinceMs),
      getBotAnalytics: (accountId, window, scope) =>
        hostQueries.getBotAnalytics(accountId, window, scope),
      getBotReviewComments: (accountId, window, scope) =>
        hostQueries.getBotReviewComments(accountId, window, scope),
      getHumanReviewComments: (accountId, window, scope) =>
        hostQueries.getHumanReviewComments(accountId, window, scope),
      getAdvisorFindings: (accountId, window, scope) =>
        hostQueries.getAdvisorFindings(accountId, window, scope),
      getBotEffectPanel: (accountId, scope, botUserId, anchorMs) =>
        hostQueries.getBotEffectPanel(accountId, scope, botUserId, anchorMs),
    },
    recordAiUsage: (row) => recordAiUsage(row),
    aiCredits: {
      check: async (accountId) => {
        const account = await getAccountById(accountId);
        // Fail closed on a missing account (should never happen for a live request): block
        // BOTH seams rather than risk unmetered generation.
        if (!account)
          return {
            summaryTurnsUsed: 0,
            summaryTurnLimit: 0,
            summaryTurnsRemaining: 0,
            summaryBlocked: true,
            agentCreditsUsed: 0,
            agentAllowanceCredits: 0,
            agentCreditsRemaining: 0,
            agentBlocked: true,
            blocked: true,
          };
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
      // Advisor repo-file reads: status-returning, never throwing (a 404 is the ordinary
      // "no config yet"). `ref` rides the contents-API query string.
      readRepoFile: async (accountId, a) =>
        ghRestGetContentRaw(
          await getAccessToken(accountId),
          `/repos/${a.owner}/${a.name}/contents/${a.path}`,
          a.ref,
        ),
      listRepoDir: async (accountId, a) =>
        ghRestGetContentDir(
          await getAccessToken(accountId),
          `/repos/${a.owner}/${a.name}/contents/${a.path}`,
          a.ref,
        ),
      openIssue: async (accountId, a) =>
        createIssue(await getAccessToken(accountId), a.owner, a.name, a.title, a.body),
      // Two-sha compare (apiVersion 16). `accountId` is passed THROUGH so a rate-limited
      // compare feeds that account's budget — the same discipline sync/commit-files.ts uses.
      // Never throws; see github/compare.ts.
      fetchCompareDiff: async (accountId, a) =>
        fetchCompareDiff(await getAccessToken(accountId), { ...a, accountId }),
    },
    coding: {
      // Lazy-import the agent module (it pulls in the Claude Agent SDK) so the SDK
      // only loads when a fix actually runs, not at every backend boot.
      generateFix: async (fixArgs) =>
        (await import('../coding/agent.js')).runCodingAgent(fixArgs),
      applyAndPush: (pushArgs) => applyAndPush(pushArgs),
      commitFilesAndOpenPr: (prArgs) => commitFilesAndOpenPr(prArgs),
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

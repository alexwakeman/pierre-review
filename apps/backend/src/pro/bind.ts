import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema, runTransaction, isPg } from '../db/client.js';
import * as hostQueries from '../db/queries.js';
import { reviewEvents, registerLearningsProvider } from '../review/events.js';
import { cheapComplete } from '../review/llm.js';
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
  const entry = [
    join(repoRoot, 'packages/pro/dist/index.js'), // built plugin (node)
    join(repoRoot, 'packages/pro/src/index.ts'), // source (tsx dev)
  ].find(existsSync);
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
  if (plugin?.apiVersion !== 1 || typeof plugin.register !== 'function') {
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
    llm: { complete: cheapComplete },
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
    },
    reviewEvents,
    registerLearningsProvider,
  };

  try {
    setProCapabilities(await plugin.register(app, ctx));
    app.log.info('pro plugin active');
  } catch (err) {
    app.log.warn({ err }, 'pro register() failed — OSS mode');
  }
}

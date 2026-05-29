import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getGraphqlClient } from '../github/client.js';
import { REPO_ACTIVITY_QUERY, type RepoActivityResponse } from '../github/queries.js';
import { ensureCommitFiles } from './commit-files.js';
import { createUserResolver, persistPr, upsertRepo } from './upsert.js';

const { syncState } = schema;

export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

const consoleLogger: Logger = {
  info: (m, ...a) => console.log(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

export interface SyncRepoOptions {
  owner: string;
  name: string;
  mode: 'full' | 'incremental';
  // Stop paginating once a PR's updatedAt falls before this instant.
  since: Date | null;
  log?: Logger;
}

export interface SyncRepoResult {
  repoId: number;
  prCount: number;
  pages: number;
  rateLimitRemaining: number;
  rateLimitCost: number;
}

export async function syncRepo(opts: SyncRepoOptions): Promise<SyncRepoResult> {
  const { owner, name, mode, since } = opts;
  const log = opts.log ?? consoleLogger;
  const client = getGraphqlClient();
  const resolver = createUserResolver();

  let cursor: string | null = null;
  let repoId: number | null = null;
  let prCount = 0;
  let pages = 0;
  let totalCost = 0;
  let lastRemaining = 0;

  try {
    let stop = false;
    do {
      const resp: RepoActivityResponse = await client(REPO_ACTIVITY_QUERY, {
        owner,
        name,
        cursor,
      });
      pages += 1;
      totalCost += resp.rateLimit.cost;
      lastRemaining = resp.rateLimit.remaining;

      if (!resp.repository) {
        const err = new Error(`Repository ${owner}/${name} not found or inaccessible`);
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      repoId ??= upsertRepo(owner, name, resp.repository.id);

      const { nodes, pageInfo } = resp.repository.pullRequests;
      for (const pr of nodes) {
        if (since && new Date(pr.updatedAt) < since) {
          stop = true;
          break;
        }

        // Only fetch changed-files for commits that could plausibly have
        // addressed an open thread (after its last comment).
        const unresolved = pr.reviewThreads.nodes.filter(
          (t) => !t.isResolved && t.comments.nodes.length > 0,
        );
        let shas: string[] = [];
        if (unresolved.length > 0) {
          const threshold = Math.min(
            ...unresolved.map((t) =>
              Date.parse(t.comments.nodes.at(-1)!.createdAt),
            ),
          );
          shas = pr.commits.nodes
            .filter((c) => Date.parse(c.commit.committedDate) > threshold)
            .map((c) => c.commit.oid);
        }
        const commitFilesBySha = await ensureCommitFiles(owner, name, shas);

        persistPr(pr, repoId, resolver, commitFilesBySha);
        prCount += 1;
      }

      cursor = pageInfo.endCursor;
      if (stop || !pageInfo.hasNextPage) break;
    } while (cursor);

    if (repoId === null) {
      throw new Error(`Repository ${owner}/${name} returned no data`);
    }

    const now = new Date();
    const statePatch =
      mode === 'full'
        ? { lastFullSyncAt: now, lastIncrementalSyncAt: now }
        : { lastIncrementalSyncAt: now };
    db.insert(syncState)
      .values({ repoId, ...statePatch, lastSyncStatus: 'ok', lastSyncError: null })
      .onConflictDoUpdate({
        target: syncState.repoId,
        set: { ...statePatch, lastSyncStatus: 'ok', lastSyncError: null },
      })
      .run();

    log.info(
      `sync ${owner}/${name} [${mode}] done: ${prCount} PRs over ${pages} page(s), cost ${totalCost}, ${lastRemaining} remaining`,
    );

    return {
      repoId,
      prCount,
      pages,
      rateLimitRemaining: lastRemaining,
      rateLimitCost: totalCost,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (repoId !== null) {
      db.update(syncState)
        .set({ lastSyncStatus: 'error', lastSyncError: message })
        .where(eq(syncState.repoId, repoId))
        .run();
    }
    log.error(`sync ${owner}/${name} failed: ${message}`);
    throw err;
  }
}

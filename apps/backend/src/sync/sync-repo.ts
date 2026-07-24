import { performance } from 'node:perf_hooks';
import { db, schema } from '../db/client.js';
import {
  getGraphqlClientFor,
  graphqlChecksHint,
  graphqlTolerant,
  isSamlBlock,
  summarizeGraphqlErrors,
  withGithubRetry,
} from '../github/client.js';
import { clearSamlBlock, recordSamlBlock } from './auth-notices.js';
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

export interface SyncProgressUpdate {
  percent: number;
  prsProcessed: number;
  pages: number;
}

export interface SyncRepoOptions {
  owner: string;
  name: string;
  // The account that owns this repo; stamped onto every persisted row.
  accountId: number;
  // The owning account's GitHub token (gh CLI token in local mode, the account's
  // decrypted OAuth token in cloud). Never module-cached — passed per sync.
  token: string;
  mode: 'full' | 'incremental';
  // Stop paginating once a PR's updatedAt falls before this instant.
  since: Date | null;
  // Resume the PR-page walk from this cursor (the `after` value). Used by the
  // two-phase first sync: phase 2 continues from where phase 1 stopped instead of
  // re-walking the foreground pages. null/undefined starts from the newest PR.
  startCursor?: string | null;
  // Whether to write the authoritative syncState timestamps when the walk
  // completes. Phase 1 of a two-phase sync passes false so the repo stays "not
  // fully synced" until phase 2 finishes the deep backfill. Defaults to true.
  commitState?: boolean;
  // Max concurrent commit-file REST fetches per page (see ensureCommitFiles).
  commitFileConcurrency?: number;
  log?: Logger;
  // Called as pages/PRs are processed so callers can surface live progress.
  onProgress?: (p: SyncProgressUpdate) => void;
  // Polled between pages and PRs; when it returns true the walk bails out WITHOUT
  // recording the run as complete (no syncState timestamp), so a cancelled initial
  // backfill leaves the repo "never synced". Drives user-initiated cancel.
  shouldCancel?: () => boolean;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export interface SyncRepoResult {
  repoId: number;
  prCount: number;
  pages: number;
  rateLimitRemaining: number;
  rateLimitCost: number;
  // Whether the walk bailed out early on a cancel request (so the caller skips a
  // follow-on phase).
  cancelled: boolean;
  // The cursor a follow-on phase should resume from to continue past where this
  // walk stopped — the `after` of the page that hit the `since` cutoff (so its
  // older PRs aren't skipped), or the final page's cursor if the walk reached the
  // end. Pass it back as `startCursor`.
  endCursor: string | null;
}

export async function syncRepo(opts: SyncRepoOptions): Promise<SyncRepoResult> {
  const { owner, name, accountId, mode, since, onProgress } = opts;
  const commitState = opts.commitState ?? true;
  const log = opts.log ?? consoleLogger;
  const client = getGraphqlClientFor(opts.token);
  const resolver = createUserResolver();
  // Set if any page's fetch is SAML-forbidden (token not authorized for the owner's org) — the
  // owner org is then flagged for the "Reconnect GitHub" banner (see sync/auth-notices.ts).
  let samlBlocked = false;

  let cursor: string | null = opts.startCursor ?? null;
  // The `after` value used to fetch the page currently being processed. When we
  // stop at the `since` cutoff mid-page, this (not the page's endCursor) is what a
  // follow-on phase resumes from, so the cutoff page's older PRs aren't skipped.
  let pageStartCursor: string | null = cursor;
  let repoId: number | null = null;
  let prCount = 0;
  let pages = 0;
  let totalCost = 0;
  let lastRemaining = 0;
  // Per-stage wall-clock accumulators, so the final log attributes the 2-3 min:
  // page fetch (network/GraphQL) vs commit-file REST fan-out vs DB persist. This
  // is the baseline that tells us which stage to optimise next.
  let graphqlMs = 0;
  let commitFilesMs = 0;
  let persistMs = 0;
  const timingSummary = (): string =>
    `graphql ${(graphqlMs / 1000).toFixed(1)}s / commit-files ` +
    `${(commitFilesMs / 1000).toFixed(1)}s / persist ${(persistMs / 1000).toFixed(1)}s`;
  // Time-walked progress: PRs arrive newest-first and we stop at `since`, so the
  // span [since .. newest] is the work and the current PR's updatedAt marks how
  // far through it we are.
  let newestMs: number | null = null;
  const sinceMs = since?.getTime() ?? null;
  const reportProgress = (currentMs: number | null): void => {
    if (!onProgress) return;
    let percent = 0;
    if (newestMs != null && sinceMs != null && newestMs > sinceMs && currentMs != null) {
      percent = clamp01((newestMs - currentMs) / (newestMs - sinceMs));
    }
    onProgress({ percent, prsProcessed: prCount, pages });
  };

  try {
    let stop = false;
    let cancelled = false;
    do {
      if (opts.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      pageStartCursor = cursor;
      const tPage = performance.now();
      // Tolerate partial errors so a forbidden sub-field (e.g. `statusCheckRollup` check runs on
      // a private repo the token can't reach, or a token minted before its scope covered checks)
      // doesn't abort the whole sync — the PRs, reviews, comments and review REQUESTS still
      // persist; only CI check detail is dropped (the `ciStatus` rollup, when readable, is kept).
      // Retry the page fetch on a TRANSIENT GitHub fault (a 502/timeout from the edge —
      // the fat query on a big repo routinely 502s) so one hiccup can't abort the whole
      // multi-page backfill. Partial-data (forbidden sub-field) responses are handled
      // inside graphqlTolerant and are NOT retried.
      const resp: RepoActivityResponse = await withGithubRetry(
        () =>
          graphqlTolerant<RepoActivityResponse>(
            client,
            REPO_ACTIVITY_QUERY,
            { owner, name, cursor },
            (errors) => {
              if (isSamlBlock(errors)) samlBlocked = true;
              log.warn(
                `sync ${owner}/${name}: partial GraphQL — continuing without forbidden fields${graphqlChecksHint(errors)}. ${summarizeGraphqlErrors(errors)}`,
              );
            },
          ),
        {
          onRetry: (attempt, delayMs, err) =>
            log.warn(
              `sync ${owner}/${name}: transient GitHub error on page ${pages + 1} ` +
                `(attempt ${attempt}, retrying in ${delayMs}ms): ` +
                `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
            ),
        },
      );
      graphqlMs += performance.now() - tPage;
      pages += 1;
      // `rateLimit` is a top-level sibling of `repository`, so it survives a partial
      // (forbidden-subfield) response — but guard it so a genuinely rateLimit-less partial
      // (e.g. a NOT_FOUND payload salvaged by graphqlTolerant) can't NPE before the
      // `!resp.repository` 404 below gets to fire.
      totalCost += resp.rateLimit?.cost ?? 0;
      lastRemaining = resp.rateLimit?.remaining ?? lastRemaining;

      if (!resp.repository) {
        // A SAML wall forbids the whole `repository` node → flag the owner's org for the
        // "Reconnect GitHub" banner (an authorization gap the user can self-fix), then fail
        // this repo's sync as usual.
        if (samlBlocked) recordSamlBlock(accountId, owner);
        const err = new Error(`Repository ${owner}/${name} not found or inaccessible`);
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
      // Repository read cleanly (no SAML error anywhere in this response) → the token IS
      // authorized for this owner's org; clear any prior flag so the "Reconnect" banner
      // self-dismisses on recovery. Guard on !samlBlocked so a partial SAML error can't
      // erroneously self-dismiss. Idempotent per page.
      if (!samlBlocked) clearSamlBlock(accountId, owner);

      if (repoId == null) {
        repoId = await upsertRepo(
          owner,
          name,
          resp.repository.id,
          resp.repository.defaultBranchRef?.name ?? null,
          accountId,
          resp.repository.viewerPermission ?? null,
        );
      }

      const { nodes, pageInfo } = resp.repository.pullRequests;

      // First select the in-window PRs on this page and gather every commit SHA
      // whose changed files we need (commits that could plausibly have addressed
      // an open thread, i.e. landed after its last comment).
      const pagePrs: { pr: (typeof nodes)[number]; updatedMs: number }[] = [];
      const pageShas: string[] = [];
      for (const pr of nodes) {
        if (opts.shouldCancel?.()) {
          cancelled = true;
          break;
        }
        const updatedMs = new Date(pr.updatedAt).getTime();
        if (since && updatedMs < since.getTime()) {
          stop = true;
          break;
        }
        newestMs ??= updatedMs;

        const unresolved = pr.reviewThreads.nodes.filter(
          (t) => !t.isResolved && t.comments.nodes.length > 0,
        );
        if (unresolved.length > 0) {
          const threshold = Math.min(
            ...unresolved.map((t) => Date.parse(t.comments.nodes.at(-1)!.createdAt)),
          );
          for (const c of pr.commits.nodes) {
            if (Date.parse(c.commit.committedDate) > threshold) pageShas.push(c.commit.oid);
          }
        }
        pagePrs.push({ pr, updatedMs });
      }

      // Fetch the whole page's commit files in one saturated pool (replacing the
      // old per-PR serial waves), then persist each in-window PR. persistPr only
      // reads the SHAs its own commits need, so a page-wide superset map is fine.
      // Skip entirely if a cancel arrived mid-gather — don't do network/DB work
      // we're about to throw away.
      if (!cancelled && pagePrs.length > 0) {
        const tFiles = performance.now();
        const commitFilesBySha = await ensureCommitFiles(
          owner,
          name,
          pageShas,
          opts.token,
          opts.commitFileConcurrency,
        );
        commitFilesMs += performance.now() - tFiles;

        for (const { pr, updatedMs } of pagePrs) {
          if (opts.shouldCancel?.()) {
            cancelled = true;
            break;
          }
          const tPersist = performance.now();
          await persistPr(pr, repoId, resolver, commitFilesBySha, accountId);
          persistMs += performance.now() - tPersist;
          prCount += 1;
          reportProgress(updatedMs);
        }
      }

      cursor = pageInfo.endCursor;
      if (cancelled || stop || !pageInfo.hasNextPage) break;
    } while (cursor);

    // Cancelled mid-walk: return WITHOUT writing a syncState timestamp, so the
    // repo stays "never synced" (an initial backfill) and the cancel endpoint can
    // safely delete it. Already-persisted PRs are harmless (idempotent) and get
    // cleaned up with the repo, or resumed on the next sync for an existing repo.
    if (cancelled) {
      log.info(
        `sync ${owner}/${name} cancelled after ${prCount} PRs / ${pages} page(s) — timing: ${timingSummary()}`,
      );
      return {
        repoId: repoId ?? -1,
        prCount,
        pages,
        rateLimitRemaining: lastRemaining,
        rateLimitCost: totalCost,
        cancelled: true,
        endCursor: pageStartCursor,
      };
    }

    // Reached the cutoff / last page — the walk is complete.
    reportProgress(sinceMs);

    if (repoId === null) {
      throw new Error(`Repository ${owner}/${name} returned no data`);
    }

    // commitState=false (a two-phase foreground pass) deliberately does NOT stamp
    // the repo as synced — the authoritative timestamp is written by the deeper
    // pass that follows, so planSync keeps treating the repo as not-yet-fully-
    // synced (and the cancel endpoint as an initial backfill) until then.
    if (commitState) {
      const now = new Date();
      const statePatch =
        mode === 'full'
          ? { lastFullSyncAt: now, lastIncrementalSyncAt: now }
          : { lastIncrementalSyncAt: now };
      await db
        .insert(syncState)
        .values({ repoId, ...statePatch, lastSyncStatus: 'ok', lastSyncError: null })
        .onConflictDoUpdate({
          target: syncState.repoId,
          set: { ...statePatch, lastSyncStatus: 'ok', lastSyncError: null },
        })
        .execute();
    }

    const phase = commitState ? mode : `${mode} foreground`;
    log.info(
      `sync ${owner}/${name} [${phase}] done: ${prCount} PRs over ${pages} page(s), ` +
        `cost ${totalCost}, ${lastRemaining} remaining — timing: ${timingSummary()}`,
    );

    // Resume point for a follow-on phase: re-fetch the cutoff page (so its older
    // PRs aren't skipped) if we stopped there, else the final cursor.
    return {
      repoId,
      prCount,
      pages,
      rateLimitRemaining: lastRemaining,
      rateLimitCost: totalCost,
      cancelled: false,
      endCursor: stop ? pageStartCursor : cursor,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (repoId !== null) {
      // UPSERT, not a bare UPDATE. A FIRST backfill that fails has no syncState row yet
      // (phase 1 runs commitState:false → never inserts; phase 2 inserts only on success),
      // so an UPDATE would match zero rows and the failure would VANISH — the repo sits
      // half-loaded, reports status 'idle' with lastSyncError null, and the user just sees
      // "nothing loaded". Insert-or-update records the error either way, WITHOUT stamping the
      // sync timestamps (they stay null), so the repo is still treated as never-fully-synced
      // and gets retried on the next scheduled tick.
      await db
        .insert(syncState)
        .values({ repoId, lastSyncStatus: 'error', lastSyncError: message })
        .onConflictDoUpdate({
          target: syncState.repoId,
          set: { lastSyncStatus: 'error', lastSyncError: message },
        })
        .execute();
    }
    log.error(`sync ${owner}/${name} failed: ${message}`);
    throw err;
  }
}

import type { SonarSnapshot } from '@pierre-review/shared';
import type { JiraTransport } from '../tracker/jira/fetch.js';
import { sonarClient } from './client.js';
import { gatherSonarForPr, type SonarGatherResult } from './gather.js';
import { readSonarAccessForPr, sonarConfigured, type SonarDb } from './settings.js';
import { readSonarSnapshot, upsertSonarSnapshot } from './store.js';

// TAKING A SNAPSHOT — the ONE place that calls SonarCloud for a PR. Two callers: a Claude Review
// run (before it builds the prompt) and the "Refresh" button (`POST /api/prs/:id/sonar/refresh`).
// Every other reader goes through store.ts.
//
// REUSE: a head already read successfully is not read again unless forced (the button); a failed
// read is retried once it is RETRY_AFTER_MS old, and "no analysis of this commit yet" once it is
// NOT_ANALYZED_RETRY_MS old — SonarCloud's PR analysis often finishes AFTER the push a review
// starts on, so the auto post and AI Fix read again (gather.ts § 1b ties every read to the commit).
// ⚠ A read that finds SonarCloud's latest analysis is of ANOTHER commit never replaces an earlier
// successful read of this head (a Refresh in an older review's tab must not wipe its findings).
//
// ⚠ NEVER THROWS. Not set up ⇒ null and nothing stored; every other outcome is a stored, named state.
// Concurrent calls for one (account, PR, head) share ONE gather.

export const RETRY_AFTER_MS = 10 * 60 * 1000;
export const NOT_ANALYZED_RETRY_MS = 2 * 60 * 1000;

const inFlight = new Map<string, Promise<SonarSnapshot | null>>();

export interface EnsureSonarOpts {
  force?: boolean;
  transport?: JiraTransport;
  now?: () => number;
  log?: { warn: (msg: string) => void };
  /** Is `sha` GitHub's test merge commit of `headSha` (its second parent)? Default: a GitHub REST read. */
  isMergeOfHead?: (a: { accountId: number; owner: string; name: string; sha: string; headSha: string }) => Promise<boolean>;
}

/**
 * The default merge-commit check: GET the commit from GitHub with the ACCOUNT's token; true only
 * for a two-parent commit whose second parent is the head. Never throws.
 */
export async function githubIsMergeOfHead(a: {
  accountId: number;
  owner: string;
  name: string;
  sha: string;
  headSha: string;
}): Promise<boolean> {
  try {
    if (!/^[0-9a-f]{7,64}$/i.test(a.sha)) return false;
    const [{ getAccessToken }, { ghRestGetFor }] = await Promise.all([
      import('../auth/account.js'),
      import('../github/client.js'),
    ]);
    const token = await getAccessToken(a.accountId);
    const c = await ghRestGetFor<{ parents?: Array<{ sha?: string }> }>(
      token,
      `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.name)}/commits/${a.sha}`,
    );
    const parents = Array.isArray(c?.parents) ? c.parents : [];
    return parents.length === 2 && (parents[1]?.sha ?? '').toLowerCase() === a.headSha.toLowerCase();
  } catch {
    return false;
  }
}

export async function ensureSonarSnapshot(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string,
  opts: EnsureSonarOpts = {},
): Promise<SonarSnapshot | null> {
  const key = `${accountId}:${prId}:${headSha}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = takeSnapshot(c, accountId, prId, headSha, opts)
    .catch((err: unknown) => {
      try {
        opts.log?.warn(`sonar pr ${prId}: snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        /* a log must never turn a SonarCloud failure into a review failure */
      }
      return null;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function takeSnapshot(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string,
  opts: EnsureSonarOpts,
): Promise<SonarSnapshot | null> {
  const now = opts.now ?? Date.now;
  const access = await readSonarAccessForPr(c, accountId, prId);
  if (!sonarConfigured(access) || access == null || access.organization == null) return null;

  const existing = await readSonarSnapshot(c, accountId, prId, headSha);
  if (existing && !opts.force) {
    const age = now() - Date.parse(existing.fetchedAt);
    const wait = existing.state === 'not_analyzed' ? NOT_ANALYZED_RETRY_MS : RETRY_AFTER_MS;
    if (existing.state === 'ok' || age < wait) return existing;
  }

  let result: SonarGatherResult;
  if (access.token.state !== 'ok') {
    result = {
      state: 'token_unreadable',
      message: 'The saved SonarCloud token cannot be read on this server. Save it again in Settings.',
      qualityGate: null,
      issues: [],
      totalIssues: 0,
      totalHotspots: 0,
    };
  } else {
    result = await gatherSonarForPr(sonarClient(access.token.token, opts.transport), {
      accountId,
      organization: access.organization,
      projectKey: access.projectKey,
      prNumber: access.prNumber,
      headSha,
      isAnalysisOfHead: (sha) =>
        (opts.isMergeOfHead ?? githubIsMergeOfHead)({ accountId, owner: access.owner, name: access.name, sha, headSha }),
      now,
    });
  }
  // SonarCloud's latest analysis is of another commit: an earlier good read of THIS head stands.
  if (result.otherCommit != null && existing?.state === 'ok') return existing;
  await upsertSonarSnapshot(c, accountId, prId, headSha, access.projectKey, result, new Date(now()));
  return readSonarSnapshot(c, accountId, prId, headSha);
}

/**
 * AI Fix's step before it reads the stored snapshot: make sure the PR's CURRENT head has been read
 * (a reuse when it already has; a re-read when "not analysed yet" has gone stale), waiting at most
 * `waitMs`. A slower read carries on in the background and lands for the next open. Never throws.
 */
export async function freshenSonarForPrHead(
  c: SonarDb,
  accountId: number,
  prId: number,
  waitMs: number,
  opts: EnsureSonarOpts = {},
): Promise<void> {
  try {
    const { sonarPrHead } = await import('./store.js');
    const head = await sonarPrHead(c, accountId, prId);
    if (!head) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ensureSonarSnapshot(c, accountId, prId, head, opts),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    /* the stored read that follows answers whatever is there */
  }
}

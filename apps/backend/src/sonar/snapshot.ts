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
// read (no analysis yet, an outage) is retried once it is RETRY_AFTER_MS old — SonarCloud's PR
// analysis often finishes AFTER the push that a review starts on.
//
// ⚠ NEVER THROWS. Not set up ⇒ null and nothing stored; every other outcome is a stored, named state.
// Concurrent calls for one (account, PR, head) share ONE gather.

export const RETRY_AFTER_MS = 10 * 60 * 1000;

const inFlight = new Map<string, Promise<SonarSnapshot | null>>();

export interface EnsureSonarOpts {
  force?: boolean;
  transport?: JiraTransport;
  now?: () => number;
  log?: { warn: (msg: string) => void };
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
    if (existing.state === 'ok' || age < RETRY_AFTER_MS) return existing;
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
      now,
    });
  }
  await upsertSonarSnapshot(c, accountId, prId, headSha, access.projectKey, result, new Date(now()));
  return readSonarSnapshot(c, accountId, prId, headSha);
}

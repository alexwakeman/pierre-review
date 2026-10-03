// Claude Review's three live CI reads (commit checks, job log, failed step) respect the account's
// rate budget: while a hard limit is KNOWN (`isLimited`) none of them asks GitHub, and a
// rate-limited reply to the job-log read is fed to the budget (`noteLimited`) like the other two.
//
//   pnpm --filter @pierre-review/backend test ci-reads-rate-limit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchActionsJobLog } from './actions-logs.js';
import { fetchActionsJobFailedStep, fetchCommitChecks } from './commit-checks.js';
import { isLimited, noteLimited } from './rate-budget.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function installFetch(answer: () => Response): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => answer());
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
}

const SHA = 'a'.repeat(40);

describe('CI reads while the account is rate-limited', () => {
  it('a known limit skips all three reads without a request', async () => {
    const accountId = 9101;
    noteLimited(accountId, new Date(Date.now() + 60_000));
    const f = installFetch(() => new Response('{}', { status: 200 }));

    expect(await fetchCommitChecks('tok', { owner: 'o', name: 'n', sha: SHA, accountId })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    expect(await fetchActionsJobFailedStep('tok', { owner: 'o', name: 'n', jobId: 5, accountId })).toBeNull();
    const log = await fetchActionsJobLog('tok', 'o', 'n', 5, {}, { accountId });
    expect(log.available).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('a rate-limited job-log reply is noted against the account', async () => {
    const accountId = 9102;
    expect(isLimited(accountId)).toBe(false);
    installFetch(
      () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded for installation.' }), {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
          },
        }),
    );
    const log = await fetchActionsJobLog('tok', 'o', 'n', 5, {}, { accountId });
    expect(log.available).toBe(false);
    expect(log.reason).toMatch(/rate limit/i);
    expect(isLimited(accountId)).toBe(true);
  });

  it('a plain 403 (no permission) is not a rate limit', async () => {
    const accountId = 9103;
    installFetch(
      () => new Response(JSON.stringify({ message: 'Must have admin rights to Repository.' }), { status: 403 }),
    );
    const log = await fetchActionsJobLog('tok', 'o', 'n', 5, {}, { accountId });
    expect(log.reason).toMatch(/permission/i);
    expect(isLimited(accountId)).toBe(false);
  });
});

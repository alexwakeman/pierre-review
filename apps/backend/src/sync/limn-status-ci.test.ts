// LIMN'S OWN STATUS LINES ARE NOT CI (shared limn-status.ts; docs/CLAUDE-REVIEW.md § Team claims).
//
// With team claims on, an auto review posts `limn/review-claude` / `limn/review-codex` on the PR's
// head. GitHub folds them into the check rollup, so every CI read takes them out again:
//   • the predicate and the rollup fold (pure);
//   • the PR head's stored CI status (`ciStatusFromHead` — My Turn's ci_failing card, the CI-failure
//     feed and dependency auto-merge's red-CI gate all read that column);
//   • the checks list (`checkRunsFrom`): Limn's lines stay LISTED, flagged `limnOwned`;
//   • trunk status's failing set (`failingChecksFrom`);
//   • the auto-merge runner's / dependency back-off's LIVE rollup (`fetchPrHeadCheckRollup`);
//   • the CI review's failing set (`fetchCommitChecks`).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isLimnStatusContext, rollupStateWithoutLimn } from '@pierre-review/shared';

// Never the reader's database: sync/upsert.ts opens the client at import.
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'limn-status-ci-')), 't.sqlite');

const gqlAnswer = vi.fn();
vi.mock('../github/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github/client.js')>()),
  getGraphqlClientFor: () => gqlAnswer,
}));

const status = (context: string, state: string) => ({ __typename: 'StatusContext' as const, context, state, targetUrl: null });
const run = (name: string, conclusion: string | null, st = 'COMPLETED') => ({
  __typename: 'CheckRun' as const,
  name,
  status: st,
  conclusion,
  detailsUrl: null,
});

describe('isLimnStatusContext', () => {
  it('matches only the limn/ prefix', () => {
    expect(isLimnStatusContext('limn/review-claude')).toBe(true);
    expect(isLimnStatusContext('limn/review-codex')).toBe(true);
    expect(isLimnStatusContext('ci/limn/build')).toBe(false);
    expect(isLimnStatusContext('Limn/review')).toBe(false);
    expect(isLimnStatusContext('build')).toBe(false);
    expect(isLimnStatusContext(null)).toBe(false);
  });
});

describe('rollupStateWithoutLimn', () => {
  it("keeps GitHub's answer when no Limn line is there, or no contexts arrived", () => {
    expect(rollupStateWithoutLimn('FAILURE', [{ name: 'build', state: 'failure' }])).toBe('FAILURE');
    expect(rollupStateWithoutLimn('PENDING', null)).toBe('PENDING');
  });
  it('a head red or pending ONLY because of a Limn line reads green', () => {
    expect(
      rollupStateWithoutLimn('PENDING', [
        { name: 'build', state: 'success' },
        { name: 'limn/review-claude', state: 'pending' },
      ]),
    ).toBe('SUCCESS');
    expect(
      rollupStateWithoutLimn('FAILURE', [
        { name: 'build', state: 'success' },
        { name: 'limn/review-codex', state: 'failure' },
      ]),
    ).toBe('SUCCESS');
  });
  it('real CI still decides: failure, error, pending, expected', () => {
    const limn = { name: 'limn/review-claude', state: 'pending' as const };
    expect(rollupStateWithoutLimn('FAILURE', [limn, { name: 'a', state: 'failure' }])).toBe('FAILURE');
    expect(rollupStateWithoutLimn('ERROR', [limn, { name: 'a', state: 'error' }])).toBe('ERROR');
    expect(rollupStateWithoutLimn('PENDING', [limn, { name: 'a', state: 'pending' }])).toBe('PENDING');
    expect(rollupStateWithoutLimn('EXPECTED', [limn, { name: 'a', state: 'success' }])).toBe('EXPECTED');
  });
  it('only Limn lines ⇒ no CI at all (null), never "success"', () => {
    expect(rollupStateWithoutLimn('PENDING', [{ name: 'limn/review-claude', state: 'pending' }])).toBeNull();
  });
  it('a remaining context in an unmodelled state keeps GitHub’s answer (never guesses green)', () => {
    expect(
      rollupStateWithoutLimn('PENDING', [
        { name: 'limn/review-claude', state: 'pending' },
        { name: 'odd', state: 'unknown' },
      ]),
    ).toBe('PENDING');
  });
});

describe('the PR head as sync stores it', () => {
  it('ciStatusFromHead: a head failing only on a Limn line is stored as success (no ci_failing card, no red-CI back-off)', async () => {
    const { ciStatusFromHead } = await import('./upsert.js');
    const head = {
      oid: 'abc',
      statusCheckRollup: {
        state: 'FAILURE',
        contexts: { nodes: [run('build', 'SUCCESS'), status('limn/review-claude', 'FAILURE')] },
      },
    };
    expect(ciStatusFromHead(head)).toBe('success');
    // A real failure beside it is still a failure.
    head.statusCheckRollup.contexts.nodes.push(run('test', 'FAILURE'));
    expect(ciStatusFromHead(head)).toBe('failure');
    // No Limn line: GitHub's rollup as before.
    expect(ciStatusFromHead({ oid: 'x', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [run('b', null, 'IN_PROGRESS')] } } })).toBe(
      'pending',
    );
  });

  it('checkRunsFrom still LISTS a Limn line, flagged limnOwned (the PR details pane shows it)', async () => {
    const { checkRunsFrom } = await import('./upsert.js');
    const runs = checkRunsFrom({
      oid: 'abc',
      statusCheckRollup: { state: 'PENDING', contexts: { nodes: [run('build', 'SUCCESS'), status('limn/review-codex', 'PENDING')] } },
    });
    expect(runs.map((r) => [r.name, r.limnOwned ?? false])).toEqual([
      ['build', false],
      ['limn/review-codex', true],
    ]);
  });

  it('trunk status: failingChecksFrom never lists a Limn line', async () => {
    const { failingChecksFrom } = await import('./branch-status.js');
    const out = failingChecksFrom([run('lint', 'FAILURE'), status('limn/review-claude', 'FAILURE'), null]);
    expect(out.map((c) => c.name)).toEqual(['lint']);
  });
});

describe('live CI reads', () => {
  it("fetchPrHeadCheckRollup (auto-merge runner, dependency auto-merge's red-CI back-off) recomputes without Limn", async () => {
    const { fetchPrHeadCheckRollup } = await import('../github/mutations.js');
    gqlAnswer.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'FAILURE',
                    contexts: { nodes: [run('build', 'SUCCESS'), status('limn/review-claude', 'ERROR')] },
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(await fetchPrHeadCheckRollup('t', 'acme', 'api', 1)).toBe('SUCCESS');
    gqlAnswer.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'FAILURE',
                    contexts: { nodes: [run('build', 'FAILURE'), status('limn/review-claude', 'SUCCESS')] },
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(await fetchPrHeadCheckRollup('t', 'acme', 'api', 1)).toBe('FAILURE');
  });

  it("fetchCommitChecks (the CI review's failing set) drops Limn lines and their effect on the rollup", async () => {
    const { fetchCommitChecks } = await import('../github/commit-checks.js');
    const sha = 'a'.repeat(40);
    gqlAnswer.mockResolvedValueOnce({
      repository: {
        object: {
          __typename: 'Commit',
          oid: sha,
          statusCheckRollup: {
            state: 'PENDING',
            contexts: { nodes: [run('build', 'FAILURE'), status('limn/review-claude', 'PENDING')] },
          },
        },
      },
    });
    const r = await fetchCommitChecks('t', { owner: 'acme', name: 'api', sha });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks.map((c) => c.name)).toEqual(['build']);
    expect(r.rollupState).toBe('FAILURE');
  });
});

// The pure mappers behind the default-branch strip's failing-check detail and PR references.
//
// No DB, no network: everything asserted here is a pure function over a hand-built GraphQL
// fragment, which is why they are exported. Four things are worth pinning down because each has a
// silent failure mode:
//   1. TWO-PHASE COST. A green trunk must issue no second query at all, and the phase-2 query must
//      carry its shas as VARIABLES (never interpolated into the query text).
//   2. THE PARTIAL-RESPONSE POLICY. `graphqlTolerant` returns partial data with forbidden fields
//      NULLED, so "GitHub says there is nothing" and "we never received the field" look identical
//      in JSON but demand opposite writes. Getting this backwards is the bug class that hides for
//      weeks: a red commit silently loses its caret on every tick.
//   3. THE FAILURE FILTER + DEDUPE, which reuse the PR side's mapper so trunk and PR failures are
//      the same object.
//   4. DETERMINISM of the PR pick: a re-sync must never flip the stored number.
import { describe, expect, it } from 'vitest';
import type { GraphqlClient } from '../github/client.js';
import {
  buildCommitChecksQuery,
  COMMIT_CHECKS_ALIAS_CAP,
  type CommitChecksResponse,
  type GqlAssociatedPr,
  type GqlBranchCheckContext,
  type GqlBranchCommit,
} from '../github/branch-queries.js';
import {
  detailTargetShas,
  failingChecksFrom,
  failingChecksToWrite,
  fetchFailingChecks,
  MAX_FAILING_CHECKS_PER_COMMIT,
  pickAssociatedPrNumber,
  prNumberToWrite,
} from './branch-status.js';
import type { BranchCheckRun } from '@pierre-review/shared';

const commit = (over: Partial<GqlBranchCommit> = {}): GqlBranchCommit => ({
  oid: 'sha1',
  messageHeadline: 'a commit',
  committedDate: '2026-07-20T12:00:00Z',
  ...over,
});

const rollup = (state: string | null | undefined): Pick<GqlBranchCommit, 'statusCheckRollup'> => ({
  statusCheckRollup: { state },
});

const checkRun = (over: Record<string, unknown> = {}): GqlBranchCheckContext =>
  ({
    __typename: 'CheckRun',
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: null,
    ...over,
  }) as GqlBranchCheckContext;

const statusContext = (over: Record<string, unknown> = {}): GqlBranchCheckContext =>
  ({
    __typename: 'StatusContext',
    context: 'ci/circleci',
    state: 'FAILURE',
    targetUrl: null,
    ...over,
  }) as GqlBranchCheckContext;

describe('failingChecksFrom', () => {
  it('keeps only failure + error, dropping success/neutral/skipped/pending/unknown', () => {
    const names = failingChecksFrom([
      checkRun({ name: 'ok', conclusion: 'SUCCESS' }),
      checkRun({ name: 'timed-out', conclusion: 'TIMED_OUT' }),
      checkRun({ name: 'startup', conclusion: 'STARTUP_FAILURE' }),
      checkRun({ name: 'needs-action', conclusion: 'ACTION_REQUIRED' }),
      checkRun({ name: 'cancelled', conclusion: 'CANCELLED' }),
      checkRun({ name: 'skipped', conclusion: 'SKIPPED' }),
      // Not COMPLETED ⇒ pending, whatever the conclusion field says.
      checkRun({ name: 'still-running', status: 'IN_PROGRESS', conclusion: 'FAILURE' }),
      checkRun({ name: 'weird', conclusion: 'SOMETHING_NEW' }),
      statusContext({ context: 'third-party-error', state: 'ERROR' }),
      statusContext({ context: 'third-party-ok', state: 'SUCCESS' }),
      statusContext({ context: 'third-party-pending', state: 'PENDING' }),
    ]).map((c) => c.name);
    expect(names).toEqual([
      'timed-out',
      'startup',
      'needs-action',
      'third-party-error',
    ]);
  });

  it('maps a StatusContext through context/state/targetUrl with no workflow or Actions ids', () => {
    const [only] = failingChecksFrom([
      statusContext({ targetUrl: 'https://ci.example/build/7' }),
    ]);
    expect(only).toEqual<BranchCheckRun>({
      name: 'ci/circleci',
      state: 'failure',
      url: 'https://ci.example/build/7',
      runId: null,
      jobId: null,
      workflowName: null,
    });
  });

  it('extracts the workflow name and the Actions run/job ids, tolerating a null workflowRun', () => {
    const [withWorkflow, withoutWorkflow] = failingChecksFrom([
      checkRun({
        name: 'unit',
        detailsUrl: 'https://github.com/acme/app/actions/runs/12/job/34',
        checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
      }),
      // A non-Actions check suite: workflowRun is genuinely null, and nothing may require it.
      checkRun({ name: 'external', checkSuite: { workflowRun: null } }),
    ]);
    expect(withWorkflow).toMatchObject({ workflowName: 'CI', runId: 12, jobId: 34 });
    expect(withoutWorkflow).toMatchObject({ workflowName: null, runId: null, jobId: null });
  });

  it('dedupes same-named checks keeping the NEWEST Actions run', () => {
    // `contexts` returns every check suite on the commit and does NOT collapse to latest-per-name,
    // so a re-run contributes a second same-named CheckRun (upsert.ts documents the hazard).
    const out = failingChecksFrom([
      checkRun({ detailsUrl: 'https://github.com/a/b/actions/runs/100/job/1' }),
      checkRun({ detailsUrl: 'https://github.com/a/b/actions/runs/205/job/9' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ runId: 205, jobId: 9 });
  });

  it('skips null nodes (a partial response nulls individual entries)', () => {
    expect(failingChecksFrom([null, checkRun(), null]).map((c) => c.name)).toEqual(['build']);
  });

  it('caps the stored array', () => {
    const many = Array.from({ length: MAX_FAILING_CHECKS_PER_COMMIT + 5 }, (_, i) =>
      checkRun({ name: `check-${i}` }),
    );
    expect(failingChecksFrom(many)).toHaveLength(MAX_FAILING_CHECKS_PER_COMMIT);
  });
});

describe('detailTargetShas (phase-2 targeting)', () => {
  it('asks for nothing when trunk is green — the whole cost argument', () => {
    const green = [
      commit({ oid: 'a', ...rollup('SUCCESS') }),
      commit({ oid: 'b', ...rollup('EXPECTED') }),
      // No rollup at all (no CI ran on this commit) is not a failure either.
      commit({ oid: 'c' }),
    ];
    expect(detailTargetShas(green)).toEqual([]);
  });

  it('targets failure, error and pending commits only', () => {
    const shas = detailTargetShas([
      commit({ oid: 'fail', ...rollup('FAILURE') }),
      commit({ oid: 'ok', ...rollup('SUCCESS') }),
      commit({ oid: 'err', ...rollup('ERROR') }),
      // PENDING matters: GitHub reports the rollup as pending while other checks run even after
      // one has already failed — the amber-with-a-real-failure case.
      commit({ oid: 'amber', ...rollup('PENDING') }),
    ]);
    expect(shas).toEqual(['fail', 'err', 'amber']);
  });

  it('caps the alias count, keeping the newest (history is newest-first)', () => {
    const all = Array.from({ length: COMMIT_CHECKS_ALIAS_CAP + 6 }, (_, i) =>
      commit({ oid: `c${i}`, ...rollup('FAILURE') }),
    );
    const shas = detailTargetShas(all);
    expect(shas).toHaveLength(COMMIT_CHECKS_ALIAS_CAP);
    expect(shas[0]).toBe('c0');
  });
});

describe('buildCommitChecksQuery', () => {
  it('declares one GitObjectID variable per sha and aliases by INDEX, not by data', () => {
    const q = buildCommitChecksQuery(2);
    expect(q).toContain('$s0: GitObjectID!');
    expect(q).toContain('$s1: GitObjectID!');
    expect(q).toContain('c0: object(oid: $s0)');
    expect(q).toContain('c1: object(oid: $s1)');
    // Both union arms are mandatory or the mapper has nothing to switch on.
    expect(q).toContain('... on CheckRun');
    expect(q).toContain('... on StatusContext');
    // The cost of the second phase must be observable at runtime, not estimated.
    expect(q).toContain('rateLimit');
  });
});

describe('fetchFailingChecks', () => {
  // A stand-in for @octokit/graphql: records the request and replays a canned response. The cast
  // is the narrow price of not needing a live client for a request-shape assertion.
  const fakeClient = (
    resp: CommitChecksResponse,
  ): {
    client: GraphqlClient;
    calls: { query: string; variables: Record<string, unknown> }[];
  } => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const fn = (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return Promise.resolve(resp);
    };
    return { client: fn as unknown as GraphqlClient, calls };
  };

  it('sends the shas as VARIABLES, never interpolated into the query text', async () => {
    const { client, calls } = fakeClient({ repository: {} });
    await fetchFailingChecks(client, 'acme', 'app', ['deadbeef', 'cafebabe']);
    const call = calls[0]!;
    expect(calls).toHaveLength(1);
    expect(call.variables).toEqual({
      owner: 'acme',
      name: 'app',
      s0: 'deadbeef',
      s1: 'cafebabe',
    });
    expect(call.query).not.toContain('deadbeef');
    expect(call.query).not.toContain('cafebabe');
  });

  it('records an EMPTY list for a commit whose contexts arrived with no failures', async () => {
    const { client } = fakeClient({
      repository: {
        c0: {
          statusCheckRollup: {
            state: 'PENDING',
            contexts: { nodes: [checkRun({ conclusion: 'SUCCESS' })] },
          },
        },
      },
    });
    const { bySha } = await fetchFailingChecks(client, 'acme', 'app', ['s']);
    // Present-but-empty is a POSITIVE answer ("nothing failing right now"), so the key exists.
    expect(bySha.has('s')).toBe(true);
    expect(bySha.get('s')).toEqual([]);
  });

  it('omits a commit whose contexts were NOT received, in all three shapes', async () => {
    const { client } = fakeClient({
      repository: {
        // The rollup arrived but the checks themselves were forbidden.
        c0: { statusCheckRollup: { state: 'FAILURE', contexts: null } },
        // The whole rollup was nulled.
        c1: { statusCheckRollup: null },
        // The sha resolved to nothing at all.
        c2: null,
      },
    });
    const { bySha } = await fetchFailingChecks(client, 'acme', 'app', ['a', 'b', 'c']);
    expect(bySha.size).toBe(0);
  });
});

describe('failingChecksToWrite (partial-response policy)', () => {
  const found: BranchCheckRun[] = [
    { name: 'build', state: 'failure', url: null, runId: null, jobId: null, workflowName: null },
  ];

  it('clears the column on a POSITIVE green rollup', () => {
    expect(failingChecksToWrite(commit(rollup('SUCCESS')), new Map())).toBeNull();
    expect(failingChecksToWrite(commit(rollup('EXPECTED')), new Map())).toBeNull();
  });

  it('leaves the column ALONE when no rollup was received', () => {
    // This is the bug the policy exists to prevent: a token that can read most of the query but
    // not the rollup would otherwise NULL yesterday's good detail on every single tick.
    expect(failingChecksToWrite(commit(rollup(null)), new Map())).toBeUndefined();
    expect(failingChecksToWrite(commit(), new Map())).toBeUndefined();
  });

  it('leaves the column ALONE when the detail fetch produced nothing for that sha', () => {
    // Past the alias cap, or `contexts` forbidden — either way we learned nothing about it.
    expect(failingChecksToWrite(commit(rollup('FAILURE')), new Map())).toBeUndefined();
  });

  it('writes the failures we did receive, and clears when the received list was empty', () => {
    const withFailures = new Map([['sha1', found]]);
    expect(failingChecksToWrite(commit(rollup('FAILURE')), withFailures)).toEqual(found);
    // A re-run turned everything green while the rollup still reads pending: clearing is correct
    // here precisely BECAUSE the response carried the contexts.
    const emptied = new Map<string, BranchCheckRun[]>([['sha1', []]]);
    expect(failingChecksToWrite(commit(rollup('PENDING')), emptied)).toBeNull();
  });
});

describe('prNumberToWrite (same policy)', () => {
  it('leaves the column alone when associatedPullRequests was not received', () => {
    expect(prNumberToWrite(commit(), 'acme/app', 'main')).toBeUndefined();
    expect(
      prNumberToWrite(commit({ associatedPullRequests: null }), 'acme/app', 'main'),
    ).toBeUndefined();
    expect(
      prNumberToWrite(
        commit({ associatedPullRequests: { nodes: null } }),
        'acme/app',
        'main',
      ),
    ).toBeUndefined();
  });

  it('writes null for a received-but-empty list — a direct push to trunk', () => {
    expect(
      prNumberToWrite(commit({ associatedPullRequests: { nodes: [] } }), 'acme/app', 'main'),
    ).toBeNull();
  });

  it('writes the picked number when the selection arrived', () => {
    expect(
      prNumberToWrite(
        commit({ associatedPullRequests: { nodes: [{ number: 7, merged: true }] } }),
        'acme/app',
        'main',
      ),
    ).toBe(7);
  });
});

describe('pickAssociatedPrNumber', () => {
  const withPrs = (nodes: (GqlAssociatedPr | null)[]): GqlBranchCommit =>
    commit({ associatedPullRequests: { nodes } });

  it('returns null for a direct push (no connection, empty, or all-null nodes)', () => {
    expect(pickAssociatedPrNumber(commit(), 'acme/app', 'main')).toBeNull();
    expect(pickAssociatedPrNumber(withPrs([]), 'acme/app', 'main')).toBeNull();
    expect(pickAssociatedPrNumber(withPrs([null, null]), 'acme/app', 'main')).toBeNull();
  });

  it('returns the only candidate', () => {
    expect(pickAssociatedPrNumber(withPrs([{ number: 42 }]), 'acme/app', 'main')).toBe(42);
  });

  it('prefers the PR merged into THIS default branch, regardless of array order', () => {
    const merged = { number: 90, merged: true, baseRefName: 'main' };
    const open = { number: 12, merged: false, baseRefName: 'main' };
    // Both orderings: the ranking is ours precisely so a re-sync cannot flip the answer.
    expect(pickAssociatedPrNumber(withPrs([open, merged]), 'acme/app', 'main')).toBe(90);
    expect(pickAssociatedPrNumber(withPrs([merged, open]), 'acme/app', 'main')).toBe(90);
  });

  it('falls back to merged-anywhere, then to the LOWEST number, in both orderings', () => {
    const a = { number: 30, merged: true, baseRefName: 'release/2' };
    const b = { number: 20, merged: true, baseRefName: 'release/1' };
    expect(pickAssociatedPrNumber(withPrs([a, b]), 'acme/app', 'main')).toBe(20);
    expect(pickAssociatedPrNumber(withPrs([b, a]), 'acme/app', 'main')).toBe(20);
    const open = { number: 5, merged: false, baseRefName: 'main' };
    expect(pickAssociatedPrNumber(withPrs([open, a]), 'acme/app', 'main')).toBe(30);
  });

  it('drops a candidate from another repository in the network', () => {
    // `associatedPullRequests` spans forks; a foreign number would resolve against the WRONG repo
    // at read time, so it is dropped rather than stored.
    const fork = { number: 3, merged: true, repository: { nameWithOwner: 'fork/app' } };
    const own = { number: 8, merged: false, repository: { nameWithOwner: 'acme/app' } };
    expect(pickAssociatedPrNumber(withPrs([fork, own]), 'acme/app', 'main')).toBe(8);
    expect(pickAssociatedPrNumber(withPrs([fork]), 'acme/app', 'main')).toBeNull();
  });

  it('accepts a candidate whose nameWithOwner was nulled by a partial response', () => {
    const nulled = { number: 11, merged: true, repository: { nameWithOwner: null } };
    expect(pickAssociatedPrNumber(withPrs([nulled]), 'acme/app', 'main')).toBe(11);
  });

  it('ranks without throwing when the default branch name is unknown', () => {
    const merged = { number: 4, merged: true, baseRefName: 'main' };
    const open = { number: 2, merged: false, baseRefName: 'main' };
    expect(pickAssociatedPrNumber(withPrs([open, merged]), 'acme/app', null)).toBe(4);
  });

  it('ignores an entry whose number was nulled', () => {
    expect(
      pickAssociatedPrNumber(withPrs([{ merged: true }, { number: 6 }]), 'acme/app', 'main'),
    ).toBe(6);
  });
});

// LIMN'S OWN STATUS LINES ARE NOT CI — the follow-ups (limn-status-ci.test.ts is the base):
//   • never guess green: a contexts page that is not complete keeps GitHub's state;
//   • mergeability: GitHub's UNSTABLE that only Limn's lines caused reads CLEAN (written so by sync
//     and by the liveness sweep), never "checks failing";
//   • commit history: the trunk snapshot and the PR CI-history backfill recompute a commit's state
//     without Limn's lines (sync/limn-ci.ts), and query nothing extra for a commit without one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mergeStateWithoutLimn, rollupStateWithoutLimn } from '@pierre-review/shared';

// Never the reader's database: sync/upsert.ts opens the client at import.
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'limn-ci-')), 't.sqlite');

const status = (context: string, state: string) => ({ __typename: 'StatusContext' as const, context, state, targetUrl: null });
const run = (name: string, conclusion: string | null, st = 'COMPLETED') => ({
  __typename: 'CheckRun' as const,
  name,
  status: st,
  conclusion,
  detailsUrl: null,
});

describe('never guess green', () => {
  it('a contexts page that is NOT complete keeps GitHub’s state (a failing check may sit past it)', async () => {
    const page = [
      { name: 'build', state: 'success' as const },
      { name: 'limn/review-claude', state: 'pending' as const },
    ];
    expect(rollupStateWithoutLimn('FAILURE', page, false)).toBe('FAILURE');
    expect(rollupStateWithoutLimn('PENDING', page, true)).toBe('SUCCESS');
    const { ciStatusFromHead } = await import('./upsert.js');
    expect(
      ciStatusFromHead({
        oid: 'x',
        statusCheckRollup: {
          state: 'FAILURE',
          contexts: { nodes: [run('build', 'SUCCESS'), status('limn/review-claude', 'PENDING')], pageInfo: { hasNextPage: true } },
        },
      }),
    ).toBe('failure');
  });
});

describe('mergeability', () => {
  it('mergeStateWithoutLimn: UNSTABLE only Limn’s lines caused reads CLEAN; anything else passes through', () => {
    expect(mergeStateWithoutLimn('unstable', 'success')).toBe('clean');
    expect(mergeStateWithoutLimn('unstable', 'none')).toBe('clean');
    expect(mergeStateWithoutLimn('UNSTABLE', 'success')).toBe('clean');
    expect(mergeStateWithoutLimn('unstable', 'failure')).toBe('unstable');
    expect(mergeStateWithoutLimn('unstable', 'pending')).toBe('unstable');
    expect(mergeStateWithoutLimn('unstable', 'unknown')).toBe('unstable');
    expect(mergeStateWithoutLimn('unstable', null)).toBe('unstable');
    expect(mergeStateWithoutLimn('blocked', 'success')).toBe('blocked');
    expect(mergeStateWithoutLimn(undefined, 'success')).toBeUndefined();
  });

  it('ciWithoutLimnForMergeState: Limn’s lines alone ⇒ no other CI; otherwise the head’s CI', async () => {
    const { ciWithoutLimnForMergeState } = await import('./upsert.js');
    expect(
      ciWithoutLimnForMergeState({
        oid: 'x',
        statusCheckRollup: { state: 'PENDING', contexts: { nodes: [status('limn/review-claude', 'PENDING')] } },
      }),
    ).toBe('none');
    expect(
      ciWithoutLimnForMergeState({
        oid: 'x',
        statusCheckRollup: { state: 'PENDING', contexts: { nodes: [run('b', 'SUCCESS'), status('limn/review-claude', 'PENDING')] } },
      }),
    ).toBe('success');
    // Not every check was read: never "no other CI".
    expect(
      ciWithoutLimnForMergeState({
        oid: 'x',
        statusCheckRollup: {
          state: 'PENDING',
          contexts: { nodes: [status('limn/review-claude', 'PENDING')], pageInfo: { hasNextPage: true } },
        },
      }),
    ).toBe('pending');
  });
});

describe('commit history', () => {
  it('needsLimnRecompute: only SUCCESS / PENDING with a Limn line beside it', async () => {
    const { needsLimnRecompute, carriesLimnLine } = await import('./limn-ci.js');
    const marked = { status: { contexts: [{ context: 'ci/build' }, { context: 'limn/review-codex' }] } };
    expect(carriesLimnLine(marked)).toBe(true);
    expect(carriesLimnLine({ status: null })).toBe(false);
    expect(needsLimnRecompute('SUCCESS', marked)).toBe(true);
    expect(needsLimnRecompute('PENDING', marked)).toBe(true);
    // Limn never posts failure or error: those states are never its doing.
    expect(needsLimnRecompute('FAILURE', marked)).toBe(false);
    expect(needsLimnRecompute('SUCCESS', { status: { contexts: [{ context: 'ci/build' }] } })).toBe(false);
  });

  it('trunk: withoutLimnStates recomputes only Limn-marked commits (no query otherwise)', async () => {
    const { withoutLimnStates } = await import('./branch-status.js');
    const client = vi.fn();
    const node = (oid: string, state: string, contexts: string[]) => ({
      oid,
      messageHeadline: 'm',
      committedDate: '2026-10-01T00:00:00Z',
      statusCheckRollup: { state },
      status: { contexts: contexts.map((context) => ({ context })) },
    });
    const plain = [node('a1', 'SUCCESS', ['ci/build'])];
    expect(await withoutLimnStates(client as any, 'acme', 'api', plain)).toEqual({ nodes: plain, cost: 0 });
    expect(client).not.toHaveBeenCalled();
    client.mockResolvedValueOnce({
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        c0: {
          oid: 'b1',
          statusCheckRollup: { state: 'PENDING', contexts: { nodes: [run('build', 'SUCCESS'), status('limn/review-claude', 'PENDING')] } },
        },
        c1: { oid: 'b2', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [status('limn/review-claude', 'SUCCESS')] } } },
      },
    });
    const r = await withoutLimnStates(client as any, 'acme', 'api', [
      node('b1', 'PENDING', ['limn/review-claude']),
      node('b2', 'SUCCESS', ['limn/review-claude']),
      node('b3', 'FAILURE', ['limn/review-claude']),
    ]);
    expect(client).toHaveBeenCalledTimes(1);
    // Green CI beside a pending Limn line ⇒ SUCCESS; only Limn's line ⇒ no CI; a failure stands.
    expect(r.nodes.map((n) => n.statusCheckRollup?.state ?? null)).toEqual(['SUCCESS', null, 'FAILURE']);
  });

  it('PR CI-history backfill: a Limn-marked commit is held back for the recompute, never synthesized raw', async () => {
    const { fetchCommitStates } = await import('./backfill-ci-history.js');
    const client = vi.fn().mockResolvedValueOnce({
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        c0: { oid: 's0', statusCheckRollup: { state: 'SUCCESS' }, status: { contexts: [{ context: 'limn/review-claude' }] } },
        c1: { oid: 's1', statusCheckRollup: { state: 'FAILURE' }, status: { contexts: [{ context: 'limn/review-claude' }] } },
        c2: { oid: 's2', statusCheckRollup: { state: 'SUCCESS' }, status: { contexts: [{ context: 'ci/build' }] } },
      },
    });
    const r = await fetchCommitStates(client as any, 'acme', 'api', ['s0', 's1', 's2']);
    expect([...r.bySha.entries()]).toEqual([
      ['s1', 'failure'],
      ['s2', 'success'],
    ]);
    expect(r.limnShas).toEqual(['s0']);
  });
});

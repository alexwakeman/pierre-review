import { describe, expect, it } from 'vitest';
import { GraphqlResponseError } from '@octokit/graphql';
import {
  graphqlChecksHint,
  graphqlTolerant,
  isSamlBlock,
  summarizeGraphqlErrors,
  type GraphqlClient,
} from './client.js';

// GitHub answers HTTP 200 with { data: <partial>, errors: [...] } when a token may read most
// of a query but is FORBIDDEN one sub-field — e.g. CI check runs on a private repo the token
// can't reach. @octokit/graphql throws GraphqlResponseError (carrying the partial `data`).
// graphqlTolerant must salvage that data so one un-permitted field doesn't wipe the whole PR
// detail / sync page.

function gqlError(data: unknown, errors: unknown[]): GraphqlResponseError<unknown> {
  return new GraphqlResponseError(
    { method: 'POST', url: '/graphql' } as never,
    {} as never,
    { data, errors } as never,
  );
}

// A client that always throws `err`, shaped as GraphqlClient for the call site.
function throwingClient(err: unknown): GraphqlClient {
  return (() => {
    throw err;
  }) as unknown as GraphqlClient;
}

describe('graphqlTolerant', () => {
  it('returns partial data (and reports the errors) when a sub-field is forbidden', async () => {
    const data = {
      repository: {
        pullRequest: {
          body: 'the author description',
          headCommit: { nodes: [{ commit: { statusCheckRollup: null } }] },
        },
      },
    };
    const err = gqlError(data, [
      {
        type: 'FORBIDDEN',
        path: ['repository', 'pullRequest', 'headCommit', 'nodes', 0, 'commit', 'statusCheckRollup'],
        message: 'Resource not accessible by integration',
      },
    ]);
    let reported: unknown = null;
    const out = await graphqlTolerant<typeof data>(
      throwingClient(err),
      'query',
      { owner: 'o', name: 'n', number: 1 },
      (e) => {
        reported = e;
      },
    );
    expect(out).toBe(data);
    expect(out.repository.pullRequest.body).toBe('the author description');
    expect(reported).not.toBeNull();
  });

  it('rethrows when there is NO usable partial data (e.g. rate limit)', async () => {
    const err = gqlError(null, [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }]);
    await expect(graphqlTolerant(throwingClient(err), 'q', {})).rejects.toBe(err);
  });

  it('rethrows a non-GraphQL error (auth / network)', async () => {
    const err = new Error('401 Bad credentials');
    await expect(graphqlTolerant(throwingClient(err), 'q', {})).rejects.toBe(err);
  });

  it('passes the result straight through on success', async () => {
    const client = ((_q: string, _v: unknown) =>
      Promise.resolve({ ok: true })) as unknown as GraphqlClient;
    const out = await graphqlTolerant<{ ok: boolean }>(client, 'q', {});
    expect(out).toEqual({ ok: true });
  });
});

describe('summarizeGraphqlErrors', () => {
  it('renders a compact type@path: message line', () => {
    const s = summarizeGraphqlErrors([
      { type: 'FORBIDDEN', path: ['repository', 'pullRequest'], message: 'nope' },
    ]);
    expect(s).toContain('FORBIDDEN@repository.pullRequest: nope');
  });
});

describe('graphqlChecksHint', () => {
  it('hints at CI-checks access when a checks field is forbidden', () => {
    const hint = graphqlChecksHint([
      {
        type: 'FORBIDDEN',
        path: ['repository', 'pullRequest', 'headCommit', 'nodes', 0, 'commit', 'statusCheckRollup'],
        message: 'Resource not accessible by integration',
      },
    ]);
    expect(hint).toContain('CI checks');
    expect(hint).toContain('re-authorize');
  });

  it('stays SILENT for a NOT_FOUND (so a deleted PR is not mislabelled a checks problem)', () => {
    const hint = graphqlChecksHint([
      { type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve to a node' },
    ]);
    expect(hint).toBe('');
  });

  it('gives the SAML re-auth hint (which wins over the checks hint)', () => {
    const hint = graphqlChecksHint([
      {
        type: 'FORBIDDEN',
        path: ['repository'],
        message:
          'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.',
      },
    ]);
    expect(hint).toContain('SAML');
    expect(hint).toContain('re-authorize');
  });
});

describe('isSamlBlock', () => {
  it('detects the SAML enforcement error by message', () => {
    expect(
      isSamlBlock([
        { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' },
      ]),
    ).toBe(true);
  });
  it('detects the machine-readable saml_failure extension (even with a bland message)', () => {
    expect(
      isSamlBlock([{ type: 'FORBIDDEN', extensions: { saml_failure: true }, message: 'Forbidden' }]),
    ).toBe(true);
  });
  it('is false for an ordinary forbidden/checks error', () => {
    expect(
      isSamlBlock([{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }]),
    ).toBe(false);
  });
});

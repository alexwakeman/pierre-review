import { graphql } from '@octokit/graphql';
import { getGithubToken } from './auth.js';

let token: string | null = null;

function authToken(): string {
  token ??= getGithubToken();
  return token;
}

export type GraphqlClient = typeof graphql;

let graphqlClient: GraphqlClient | null = null;

export function getGraphqlClient(): GraphqlClient {
  graphqlClient ??= graphql.defaults({
    headers: { authorization: `token ${authToken()}` },
  });
  return graphqlClient;
}

// REST GET helper, used for per-commit changed-files (no GraphQL path for it).
export async function ghRestGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `token ${authToken()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub REST ${path} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// REST POST helper. Used to submit a PR review — inline line comments REQUIRE the
// REST reviews endpoint (`gh pr review` can't post them). Surfaces GitHub's error
// body (e.g. 403 missing write scope, 422 bad line anchor) for the UI.
export async function ghRestPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `token ${authToken()}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub REST POST ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.json() as Promise<T>;
}

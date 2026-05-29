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
